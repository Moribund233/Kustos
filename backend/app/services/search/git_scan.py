"""搜索域 · Git 对象扫描

搜索内容一律来自 **Git 对象**（pygit2 读 ref 的 tree/blob）——Kustos 存的是
bare 仓库，没有工作树，不能扫文件系统。

本模块负责：遍历 tree/blob、文本判定、RRF 融合，以及**按 ref 现场扫描
符号/引用**（索引只覆盖默认分支，不得跨 ref 静默给错答案）。
"""
from typing import Iterable, List, Optional, Tuple, Dict
import os
import pygit2

from app.core.exception import NotFoundException, ValidationException
from app.services.indexing.chunker import analyze_file
from app.services.search.config import _index_limits, _max_file_bytes, symbol_scan_limits
from app.services.search.dto import SearchResult, SymbolHit, SymbolLookup, UsageHit


TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".css", ".scss", ".html", ".md",
    ".json", ".yaml", ".yml", ".toml", ".sql", ".sh", ".rb",
    ".php", ".swift", ".kt", ".vue", ".svelte", ".txt", ".xml",
    ".ini", ".cfg", ".env",
}


def _head_commit(repo: pygit2.Repository) -> Optional[pygit2.Commit]:
    if repo.head_is_unborn:
        return None
    try:
        return repo.head.peel(pygit2.Commit)
    except Exception:
        return None


def _default_branch(repo_path: str) -> str:
    try:
        repo = pygit2.Repository(repo_path)
        if not repo.head_is_unborn:
            return repo.head.shorthand
    except Exception:
        pass
    return "main"


def _is_text_path(path: str) -> bool:
    _, ext = os.path.splitext(path)
    return ext.lower() in TEXT_EXTENSIONS


def _iter_text_blobs(
    repo: pygit2.Repository, tree: pygit2.Tree, prefix: str = "",
    max_file_bytes: Optional[int] = None,
) -> Iterable[Tuple[str, str]]:
    """递归遍历 tree，产出 (路径, 文本内容)；跳过二进制 / 超大 / 非文本文件"""
    if max_file_bytes is None:
        max_file_bytes = _max_file_bytes()
    for entry in tree:
        path = f"{prefix}{entry.name}"
        if entry.type == pygit2.GIT_OBJECT_TREE:
            yield from _iter_text_blobs(repo, repo[entry.id], path + "/", max_file_bytes)
        elif entry.type == pygit2.GIT_OBJECT_BLOB and _is_text_path(path):
            blob = repo[entry.id]
            if blob.size > max_file_bytes:
                continue
            data = blob.data
            if b"\x00" in data:
                continue
            yield path, data.decode("utf-8", "replace")


def _iter_text_paths(
    repo: pygit2.Repository, tree: pygit2.Tree, prefix: str = "",
    max_file_bytes: Optional[int] = None,
) -> Iterable[Tuple[str, int]]:
    """递归遍历 tree，产出 (路径, 字节大小)；仅文本且未超单文件上限"""
    if max_file_bytes is None:
        max_file_bytes = _max_file_bytes()
    for entry in tree:
        path = f"{prefix}{entry.name}"
        if entry.type == pygit2.GIT_OBJECT_TREE:
            yield from _iter_text_paths(repo, repo[entry.id], path + "/", max_file_bytes)
        elif entry.type == pygit2.GIT_OBJECT_BLOB and _is_text_path(path):
            size = repo[entry.id].size
            if size <= max_file_bytes:
                yield path, size


def _list_text_paths(
    repo_path: str, max_files: Optional[int] = None, max_bytes: Optional[int] = None
) -> Tuple[Optional[str], List[str], bool]:
    """列出默认分支 HEAD 的文本文件路径（不读内容，仅取路径与大小）。

    未显式传参时读 ``search.index_max_files`` / ``index_max_bytes``（默认=模块常量）。

    Returns:
        (commit_id, paths, truncated)；truncated=True 表示超过构建上限，应跳过索引。
    """
    if max_files is None or max_bytes is None:
        max_files, max_bytes = _index_limits()
    try:
        repo = pygit2.Repository(repo_path)
    except Exception:
        return None, [], False
    commit = _head_commit(repo)
    if commit is None:
        return None, [], False
    paths: List[str] = []
    total = 0
    truncated = False
    for path, size in _iter_text_paths(repo, commit.tree):
        if len(paths) >= max_files or total + size > max_bytes:
            truncated = True
            break
        paths.append(path)
        total += size
    return str(commit.id), paths, truncated


def _read_text_blobs(
    repo_path: str, paths: List[str], max_file_bytes: Optional[int] = None
) -> Tuple[Optional[str], List[Tuple[str, str]]]:
    """按路径批量读取默认分支 HEAD 内容（供分批全量重建）"""
    if max_file_bytes is None:
        max_file_bytes = _max_file_bytes()
    try:
        repo = pygit2.Repository(repo_path)
    except Exception:
        return None, []
    commit = _head_commit(repo)
    if commit is None:
        return None, []
    out: List[Tuple[str, str]] = []
    for path in paths:
        try:
            entry = commit.tree[path]
        except KeyError:
            continue
        if entry.type != pygit2.GIT_OBJECT_BLOB:
            continue
        blob = repo[entry.id]
        if blob.size > max_file_bytes or b"\x00" in blob.data:
            continue
        out.append((path, blob.data.decode("utf-8", "replace")))
    return str(commit.id), out


def _batched(items: List, size: int) -> Iterable[List]:
    """把列表切分为每批最多 size 个元素的批次"""
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _path_prefix(path: Optional[str]) -> Optional[str]:
    """目录前缀过滤（如 ``'src'`` → ``'src/'``）；空值返回 None"""
    if path and path.strip("./"):
        return path.strip("/").rstrip("/") + "/"
    return None


def _rrf_fuse(
    ranked_lists: List[List[SearchResult]], max_results: int, k: int = 60
) -> List[SearchResult]:
    """Reciprocal Rank Fusion：融合多路检索结果（按 (file, chunk) 归并）。"""
    scores: Dict[tuple, float] = {}
    first: Dict[tuple, SearchResult] = {}
    for ranked in ranked_lists:
        for rank, item in enumerate(ranked):
            key = (item.file, item.chunk.chunk_index) if item.chunk else (item.file, item.line)
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
            first.setdefault(key, item)
    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [first[key] for key, _ in ordered[:max_results]]


def _test_path_clauses(col):
    """测试文件路径的 LIKE 子句（供 ``exclude_tests`` 过滤）"""
    return [
        col.like("tests/%"),
        col.like("%/tests/%"),
        col.like("test\\_%", escape="\\"),
        col.like("%/test\\_%", escape="\\"),
        col.like("%\\_test.%", escape="\\"),
        col.like("%.spec.%"),
    ]


def _is_test_path(path: str) -> bool:
    """``_test_path_clauses`` 的 Python 孪生：判断路径是否属于测试文件（ref 扫描用）"""
    p = path.replace("\\", "/")
    return (
        p.startswith("tests/")
        or "/tests/" in p
        or p.startswith("test_")
        or "/test_" in p
        or "_test." in p
        or ".spec." in p
    )


def _resolve_ref(repo_path: str, ref: str) -> pygit2.Commit:
    """把 ref（分支/标签/SHA）解析为提交；无法解析时明确报错而非回落索引"""
    try:
        repo = pygit2.Repository(repo_path)
        return repo.revparse_single(ref).peel(pygit2.Commit)
    except Exception:
        raise NotFoundException(detail="Ref not found", error_code="search_ref_not_found")


def _needs_ref_scan(repo_path: Optional[str], ref: Optional[str]) -> bool:
    """是否需要按 ref 现场扫描：仅当 ref 非空且**不是**默认分支时。

    默认分支走块级索引（与既有行为一致）；非默认分支必须现场扫描，否则会把默认
    分支的定义当作该分支的答案返回。
    """
    if not ref or not ref.strip():
        return False
    if not repo_path:
        raise ValidationException(
            detail="按 ref 查找符号需要仓库路径",
            error_code="search_ref_scan_requires_repo",
        )
    return ref.strip() != _default_branch(repo_path)


def _scan_analyses(
    repo_path: str, ref: str, path: Optional[str], exclude_tests: bool
) -> Tuple[List[Tuple[str, object]], bool]:
    """遍历该 ref 的 tree，逐文件切块并提取引用；返回 (分析结果列表, 是否被截断)"""
    max_files, max_bytes = symbol_scan_limits()
    commit = _resolve_ref(repo_path, ref)
    repo = pygit2.Repository(repo_path)
    prefix = _path_prefix(path)
    analyses: List[Tuple[str, object]] = []
    total = 0
    partial = False
    for file_path, content in _iter_text_blobs(repo, commit.tree):
        if prefix and not file_path.startswith(prefix):
            continue
        if exclude_tests and _is_test_path(file_path):
            continue
        if len(analyses) >= max_files or total + len(content) > max_bytes:
            partial = True
            break
        total += len(content)
        analyses.append((file_path, analyze_file(file_path, content)))
    return analyses, partial


def _enclosing_chunk(chunks, line: int):
    """取包含该行的符号块（引用点所在上下文），无则 None"""
    for c in chunks:
        if c.start_line <= line <= c.end_line:
            return c
    return None


def _scan_definitions_at_ref(
    repo_path: str, ref: str, name: str, max_results: int,
    path: Optional[str], exclude_tests: bool,
) -> "SymbolLookup[SymbolHit]":
    """按 ref 现场查找符号定义（索引未覆盖该 ref 时的正确路径）"""
    analyses, partial = _scan_analyses(repo_path, ref, path, exclude_tests)
    hits = [
        SymbolHit(
            file=file_path, symbol=c.symbol, kind=c.kind,
            start_line=c.start_line, end_line=c.end_line,
        )
        for file_path, analysis in analyses
        for c in analysis.chunks
        if c.symbol == name
    ]
    return SymbolLookup(hits=hits[:max_results], source="ref_scan", partial=partial)


def _scan_usages_at_ref(
    repo_path: str, ref: str, name: str, max_results: int,
    path: Optional[str], exclude_tests: bool,
) -> "SymbolLookup[UsageHit]":
    """按 ref 现场查找标识符引用，并附引用点所在符号块"""
    analyses, partial = _scan_analyses(repo_path, ref, path, exclude_tests)
    hits: List[UsageHit] = []
    for file_path, analysis in analyses:
        for r in analysis.refs:
            if r.name != name:
                continue
            owner = _enclosing_chunk(analysis.chunks, r.line)
            hits.append(UsageHit(
                file=file_path, line=r.line,
                symbol=owner.symbol if owner else None,
                kind=owner.kind if owner else None,
                start_line=owner.start_line if owner else None,
                end_line=owner.end_line if owner else None,
            ))
            if len(hits) >= max_results:
                return SymbolLookup(hits=hits, source="ref_scan", partial=partial)
    return SymbolLookup(hits=hits, source="ref_scan", partial=partial)


def _extract_all_snapshot(repo_path: str) -> Tuple[Optional[str], int]:
    """仅取默认分支 HEAD 提交与文件数（用于陈旧检测，避免重复读取全部内容）"""
    try:
        repo = pygit2.Repository(repo_path)
    except Exception:
        return None, 0
    commit = _head_commit(repo)
    if commit is None:
        return None, 0
    return str(commit.id), 0


def head_commit(repo_path: str) -> Optional[str]:
    """默认分支 HEAD 提交 sha（廉价：只读引用，不遍历 tree）；空仓/不可读 → ``None``"""
    sha, _ = _extract_all_snapshot(repo_path)
    return sha

