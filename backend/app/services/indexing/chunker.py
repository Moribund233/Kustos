"""代码块级切分（块级索引的符号识别与区间提取）

把源码文件切分为「符号级 chunk」`(path, symbol, start_line, end_line)`，
索引只存 chunk 而非整文件，Agent 检索到 `file:12-34` 即可按区间取内容，
避免「定位一行、读整个文件」的整文件 token 浪费。

切分策略（按优先级降级）：
1. **tree-sitter**：按各语言语法解析，识别声明/容器节点给出精确行区间与符号名
   （`_DECL_NODE_TYPES` 覆盖主要语言的 function/class/... 节点类型）；
2. **正则符号分段**：无 grammar / 解析失败时，复用 repository_browser_service
   的 `_SYMBOL_PATTERNS` 定位声明起始行，段终点为下一个声明行之前；
3. **整文件**：两者都不适用时退化为单块（file:1-N），永远正确。

无论走哪条路径，最后都会做「间隙补齐」：未被任何声明覆盖的顶层代码
（import、模块级常量/路由注册等）作为 symbol=None 的 block chunk 保留，
保证全量代码仍可检索，避免相对整文件索引的漏检回归。

``analyze_file`` 在切块的同一遍解析里顺带提取标识符引用（``Ref``），供符号/引用图
（find-definition / find-usages）使用；未覆盖语言回退到标识符正则。容器声明
（class / impl / namespace 等）的区间会剔除其内部声明，避免父子 chunk 重叠导致
「方法内命中却返回整个类」的 token 浪费。

约束：
- ``MAX_CHUNK_LINES`` / ``MAX_CHUNK_BYTES``：超限声明按其行数切分小段；
- ``MAX_CHUNKS_PER_FILE``：防备病态文件产生过多块；
- ``MAX_REFS_PER_FILE``：防备病态文件产生过多引用。
"""
import bisect
import importlib
import os
import re
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

from app.core.config import get_config_value

MAX_CHUNK_LINES = 400
MAX_CHUNK_BYTES = 64 * 1024
MAX_CHUNKS_PER_FILE = 200
MAX_REFS_PER_FILE = 4000
MIN_REF_LEN = 2

try:
    from tree_sitter import Language, Parser

    _TS_AVAILABLE = True
except Exception:  # pragma: no cover - 环境无 tree-sitter 时走兜底
    Language = None
    Parser = None
    _TS_AVAILABLE = False

# grammar -> (wheel 模块, Language 工厂函数)；语法编译进 wheel，离线可用。
# 未覆盖的语言（如 swift/scala/kotlin/c#）走正则/整文件兜底，正确性不受影响。
_TS_LANGUAGE_MODULES: Dict[str, Tuple[str, str]] = {
    "python": ("tree_sitter_python", "language"),
    "javascript": ("tree_sitter_javascript", "language"),
    "typescript": ("tree_sitter_typescript", "language_typescript"),
    "tsx": ("tree_sitter_typescript", "language_tsx"),
    "go": ("tree_sitter_go", "language"),
    "rust": ("tree_sitter_rust", "language"),
    "java": ("tree_sitter_java", "language"),
    "c": ("tree_sitter_c", "language"),
    "cpp": ("tree_sitter_cpp", "language"),
    "ruby": ("tree_sitter_ruby", "language"),
    "php": ("tree_sitter_php", "language_php"),
}


@dataclass
class Chunk:
    """代码块：path + 符号信息 + 1-based 闭区间行号 + 原始文本"""
    path: str
    symbol: Optional[str]
    kind: Optional[str]
    start_line: int
    end_line: int
    content: str


@dataclass
class Ref:
    """标识符引用（符号/引用图的边）：name + 1-based 行号"""
    name: str
    line: int


@dataclass
class FileAnalysis:
    """单文件分析结果：符号块 + 标识符引用"""
    chunks: List[Chunk] = field(default_factory=list)
    refs: List[Ref] = field(default_factory=list)


# 扩展名 -> tree-sitter grammar 名称（未收录的语言走兜底路径）
TS_LANGUAGE_MAP: Dict[str, str] = {
    ".py": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".cs": "csharp",
    ".kt": "kotlin", ".kts": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".scala": "scala", ".sc": "scala",
}

# grammar -> {节点类型: 符号类型}；收集声明/容器节点作为 chunk 边界。
# 未收录的节点类型不影响正确性——其行区间会落入「间隙补齐」的 block chunk。
_DECL_NODE_TYPES: Dict[str, Dict[str, str]] = {
    "python": {
        "function_definition": "function",
        "class_definition": "class",
    },
    "javascript": {
        "function_declaration": "function",
        "generator_function_declaration": "function",
        "class_declaration": "class",
        "method_definition": "function",
    },
    "typescript": {
        "function_declaration": "function",
        "generator_function_declaration": "function",
        "class_declaration": "class",
        "method_definition": "function",
        "interface_declaration": "interface",
        "type_alias_declaration": "type",
        "enum_declaration": "enum",
        "module": "namespace",
    },
    "tsx": {
        "function_declaration": "function",
        "generator_function_declaration": "function",
        "class_declaration": "class",
        "method_definition": "function",
        "interface_declaration": "interface",
        "type_alias_declaration": "type",
        "enum_declaration": "enum",
        "module": "namespace",
    },
    "go": {
        "function_declaration": "function",
        "method_declaration": "function",
        "type_spec": "type",
    },
    "rust": {
        "function_item": "function",
        "struct_item": "class",
        "enum_item": "enum",
        "trait_item": "interface",
        "impl_item": "impl",
        "mod_item": "namespace",
    },
    "java": {
        "method_declaration": "function",
        "constructor_declaration": "function",
        "class_declaration": "class",
        "interface_declaration": "interface",
        "enum_declaration": "enum",
    },
    "c": {
        "function_definition": "function",
        "struct_specifier": "class",
        "union_specifier": "class",
        "enum_specifier": "enum",
    },
    "cpp": {
        "function_definition": "function",
        "class_specifier": "class",
        "struct_specifier": "struct",
        "enum_specifier": "enum",
        "namespace_definition": "namespace",
    },
    "csharp": {
        "method_declaration": "function",
        "constructor_declaration": "function",
        "class_declaration": "class",
        "struct_declaration": "struct",
        "interface_declaration": "interface",
        "enum_declaration": "enum",
        "namespace_declaration": "namespace",
    },
    "kotlin": {
        "function_declaration": "function",
        "class_declaration": "class",
        "object_declaration": "class",
        "interface_declaration": "interface",
    },
    "ruby": {
        "method": "function",
        "class": "class",
        "module": "namespace",
    },
    "php": {
        "function_definition": "function",
        "method_declaration": "function",
        "class_declaration": "class",
        "interface_declaration": "interface",
        "trait_declaration": "class",
    },
    "swift": {
        "function_declaration": "function",
        "class_declaration": "class",
        "struct_declaration": "struct",
        "enum_declaration": "enum",
        "protocol_declaration": "interface",
    },
    "scala": {
        "function_definition": "function",
        "class_definition": "class",
        "trait_definition": "interface",
        "object_definition": "class",
    },
}


def chunk_file(path: str, content: str, language: Optional[str] = None) -> List[Chunk]:
    """将源码内容切分为符号级 chunk 列表（analyze_file 的便捷入口，只要 chunk）。"""
    return analyze_file(path, content, language).chunks


def analyze_file(path: str, content: str, language: Optional[str] = None) -> FileAnalysis:
    """单文件分析：一次解析同时产出符号级 chunk 与标识符引用。

    切分策略按优先级降级（tree-sitter → 正则 → 整文件），并做间隙补齐保证全量可检索；
    引用提取随 tree-sitter 解析一起完成，未覆盖语言回退到标识符正则。

    Args:
        path: 文件路径（用于按扩展名识别语言）
        content: 文件文本内容
        language: 可选的语言标识符（同 repository_browser_service 的 LANGUAGE_MAP 值）；
                  缺省按扩展名推断

    Returns:
        FileAnalysis(chunks=[...], refs=[...])；空白文件返回空
    """
    if not content or not content.strip():
        return FileAnalysis()

    ext = os.path.splitext(path)[1].lower()
    grammar = (language or "").strip().lower() or TS_LANGUAGE_MAP.get(ext)

    chunks: List[Chunk] = []
    refs: List[Ref] = []
    used_ts = False
    if grammar and _TS_AVAILABLE:
        try:
            chunks, refs = _extract_treesitter(path, content, grammar)
            used_ts = bool(chunks)
        except Exception:  # noqa: BLE001 - 解析失败回退正则/整文件
            chunks, refs = [], []
    if not chunks:
        chunks = _extract_decl_chunks_regex(path, content, grammar)
    if not chunks:
        chunks = _whole_file_chunk(path, content)
    if not used_ts and grammar:
        refs = _extract_refs_regex(path, content)

    chunks = _limit_chunk_sizes(chunks)
    chunks = _fill_gaps(path, content, chunks)
    chunks.sort(key=lambda c: (c.start_line, c.end_line))
    refs.sort(key=lambda r: (r.line, r.name))
    max_chunks = int(get_config_value("search", "chunk_max_chunks_per_file", MAX_CHUNKS_PER_FILE))
    max_refs = int(get_config_value("search", "chunk_max_refs_per_file", MAX_REFS_PER_FILE))
    return FileAnalysis(chunks=chunks[:max_chunks], refs=refs[:max_refs])


# =============================================================================
# tree-sitter 路径
# =============================================================================

_lang_locals = threading.local()


def _language_for(grammar: str):
    """按 grammar 名称返回当前线程的 tree-sitter Language 对象。

    语言 wheel 已编译进镜像，离线可用。Language 是 tree-sitter C capsule 的包装，
    跨线程共享同一实例解析会段错误（C 层非线程安全），因此用 thread-local 缓存，
    每个 worker 线程持有自己的一份，既保持 rebuild_index 的并发切块又避免崩溃。
    """
    if not _TS_AVAILABLE:
        return None
    spec = _TS_LANGUAGE_MODULES.get(grammar)
    if not spec:
        return None
    cache = getattr(_lang_locals, "cache", None)
    if cache is None:
        cache = _lang_locals.cache = {}
    if grammar in cache:
        return cache[grammar]
    module_name, accessor = spec
    lang = None
    try:
        module = importlib.import_module(module_name)
        fn = getattr(module, accessor, None) or getattr(module, "language", None)
        if fn is not None:
            raw = fn()
            if not isinstance(raw, Language):
                raw = Language(raw)
            lang = raw
    except Exception:  # pragma: no cover - 未覆盖的语法/缺 wheel 时回退
        lang = None
    cache[grammar] = lang
    return lang


def _extract_treesitter(
    path: str, content: str, grammar: str
) -> Tuple[List[Chunk], List[Ref]]:
    """一次 tree-sitter 解析同时提取符号块与标识符引用。

    遍历时以 ``endswith("_identifier")`` 等启发式识别标识符节点（跨语言通用），
    行号由字节偏移 + 换行位置二分推导（避开会段错误的 start_point）。
    """
    decl_types = _DECL_NODE_TYPES.get(grammar)
    if not decl_types:
        return [], []
    language = _language_for(grammar)
    if language is None:
        return [], []
    parser = Parser()
    parser.language = language
    encoded = content.encode("utf-8")
    tree = parser.parse(encoded)
    root = tree.root_node
    if root.type == "ERROR":
        return [], []

    newlines = _newline_offsets(encoded)
    chunks: List[Chunk] = []
    ref_keys = set()
    refs: List[Ref] = []
    stack = [root]
    while stack:
        node = stack.pop()
        kind = decl_types.get(node.type)
        if kind is not None:
            chunk = _node_to_chunk(path, content, encoded, node, kind)
            if chunk is not None:
                chunks.append(chunk)
        elif _is_identifier_type(node.type):
            name = encoded[node.start_byte:node.end_byte].decode("utf-8", "replace")
            if len(name) >= MIN_REF_LEN:
                line = _line_of_byte(newlines, node.start_byte)
                key = (name, line)
                if key not in ref_keys:
                    ref_keys.add(key)
                    refs.append(Ref(name=name[:256], line=line))
        stack.extend(node.children)
    return _carve_nested_chunks(chunks), refs


def _carve_nested_chunks(chunks: List[Chunk]) -> List[Chunk]:
    """从容器声明（class/impl/namespace 等）的区间中剔除其内部更小的声明区间。

    否则一个类 chunk 会与它的所有方法 chunk 重叠——方法内命中会同时命中类 chunk，
    使返回的检索块退化成整个类（token 浪费）。剔除后各 chunk 互不重叠，容器仅保留
    头部/尾部等自身代码；被剔出的行由内部声明或后续「间隙补齐」覆盖。
    """
    if len(chunks) < 2:
        return chunks
    spans = [(c.start_line, c.end_line) for c in chunks]
    out: List[Chunk] = []
    for i, c in enumerate(chunks):
        inner = [
            spans[j] for j in range(len(chunks))
            if j != i and spans[j][0] >= c.start_line and spans[j][1] <= c.end_line
        ]
        if not inner:
            out.append(c)
            continue
        src_lines = c.content.splitlines()
        for seg_start, seg_end in _complement_ranges(
            _merge_ranges(inner), c.start_line, c.end_line
        ):
            part = src_lines[seg_start - c.start_line: seg_end - c.start_line + 1]
            out.append(Chunk(
                path=c.path, symbol=c.symbol, kind=c.kind,
                start_line=seg_start, end_line=seg_end,
                content="\n".join(part),
            ))
    return out


_REF_NODE_TYPES = {
    "identifier", "name", "word",
    "shorthand_property_identifier", "shorthand_property_identifier_pattern",
}


def _is_identifier_type(node_type: str) -> bool:
    """标识符节点的跨语言启发式判定（identifier / *_identifier / name）"""
    return node_type in _REF_NODE_TYPES or node_type.endswith("_identifier")


def _newline_offsets(encoded: bytes) -> List[int]:
    """返回所有换行字节的偏移（升序），供二分求行号"""
    offsets: List[int] = []
    idx = encoded.find(b"\n")
    while idx != -1:
        offsets.append(idx)
        idx = encoded.find(b"\n", idx + 1)
    return offsets


def _line_of_byte(newlines: List[int], byte_offset: int) -> int:
    """字节偏移 → 1-based 行号（newlines 为换行偏移列表）"""
    return bisect.bisect_left(newlines, byte_offset) + 1


def _node_to_chunk(path, content, encoded, node, kind) -> Optional[Chunk]:
    # 行号由字节偏移自行推导：tree-sitter 0.25/0.26 的 node.start_point 在较大
    # 文件上会触发 native 段错误，start_byte/end_byte 则稳定可靠。bytes.count
    # 走 C 层 memchr，开销可忽略。
    start_byte = node.start_byte
    body = encoded[start_byte:node.end_byte].decode("utf-8", "replace")
    start_line = encoded.count(b"\n", 0, start_byte) + 1
    body_lines = body.splitlines()
    end_line = start_line + max(len(body_lines), 1) - 1
    if start_line > end_line:
        return None
    return Chunk(
        path=path,
        symbol=_node_name(node, encoded),
        kind=kind,
        start_line=start_line,
        end_line=end_line,
        content=body,
    )


_IDENTIFIER_TYPES = {
    "identifier", "type_identifier", "property_identifier",
    "name", "type", "unit", "method_name", "constructor_name",
}


def _node_name(node, encoded) -> Optional[str]:
    """提取声明节点的符号名（优先 'name' 字段，其次首个标识符子节点）"""
    field = node.child_by_field_name("name")
    if field is not None:
        text = _node_text(field, encoded)
        if text:
            return text[:256]
    for child in node.children:
        if child.type in _IDENTIFIER_TYPES:
            text = _node_text(child, encoded)
            if text:
                return text[:256]
    return None


def _node_text(node, encoded) -> Optional[str]:
    try:
        text = encoded[node.start_byte:node.end_byte].decode("utf-8", "replace").strip().strip("\"'")
    except Exception:  # noqa: BLE001
        return None
    return text or None


# =============================================================================
# 正则兜底路径（复用 repository_browser_service 的符号模式）
# =============================================================================

def _extract_decl_chunks_regex(path: str, content: str, grammar: Optional[str]) -> List[Chunk]:
    if not grammar:
        return []
    try:
        from app.services.repository.repository_browser_service import _COMMENT_PREFIXES, _SYMBOL_PATTERNS
    except Exception:  # noqa: BLE001 - 依赖不可用时退回整文件
        return []
    patterns = _SYMBOL_PATTERNS.get(grammar)
    if not patterns:
        return []

    found: List[Tuple[int, str, str]] = []
    for line_no, line in enumerate(content.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith(_COMMENT_PREFIXES):
            continue
        for pattern, sym_type in patterns:
            match = pattern.match(stripped)
            if match:
                found.append((line_no, match.group(1), sym_type))
                break
    if not found:
        return []

    all_lines = content.splitlines()
    total = len(all_lines)
    chunks: List[Chunk] = []
    for i, (line_no, name, sym_type) in enumerate(found):
        end_line = found[i + 1][0] - 1 if i + 1 < len(found) else total
        if end_line < line_no:
            end_line = line_no
        chunks.append(Chunk(
            path=path,
            symbol=name,
            kind=sym_type,
            start_line=line_no,
            end_line=end_line,
            content="\n".join(all_lines[line_no - 1:end_line]),
        ))
    return chunks


_IDENT_TOKEN_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")

# 各语言通用关键字/字面量（引用兜底时过滤，避免把语法关键字当成符号引用）
_REF_KEYWORDS = frozenset({
    "def", "class", "function", "return", "if", "else", "elif", "for", "while",
    "import", "from", "as", "var", "let", "const", "new", "public", "private",
    "protected", "static", "void", "int", "float", "double", "bool", "char",
    "true", "false", "null", "none", "self", "this", "package", "func", "struct",
    "interface", "type", "enum", "namespace", "using", "end", "module", "trait",
    "impl", "fn", "pub", "async", "await", "yield", "break", "continue", "try",
    "except", "finally", "raise", "with", "lambda", "pass", "in", "is", "not",
    "and", "or", "switch", "case", "default", "do", "goto", "sizeof", "typedef",
    "export", "extends", "implements", "throw", "catch", "delete", "typeof",
})


def _extract_refs_regex(path: str, content: str) -> List[Ref]:
    """无 tree-sitter 时的引用兜底：标识符词法切分 + 关键字过滤 + 每行去重。"""
    refs: List[Ref] = []
    seen = set()
    for line_no, line in enumerate(content.splitlines(), 1):
        for match in _IDENT_TOKEN_RE.finditer(line):
            name = match.group(0)
            if len(name) < MIN_REF_LEN or name.lower() in _REF_KEYWORDS:
                continue
            key = (name, line_no)
            if key in seen:
                continue
            seen.add(key)
            refs.append(Ref(name=name[:256], line=line_no))
            if len(refs) >= int(get_config_value("search", "chunk_max_refs_per_file", MAX_REFS_PER_FILE)):
                return refs
    return refs


def _whole_file_chunk(path: str, content: str) -> List[Chunk]:
    total = len(content.splitlines()) or 1
    return [Chunk(
        path=path, symbol=None, kind="block", start_line=1, end_line=total, content=content
    )]


# =============================================================================
# 后处理：限长 + 间隙补齐（保证全量可检索）
# =============================================================================

def _limit_chunk_sizes(chunks: List[Chunk]) -> List[Chunk]:
    max_lines = int(get_config_value("search", "chunk_max_lines", MAX_CHUNK_LINES))
    max_bytes = int(get_config_value("search", "chunk_max_bytes", MAX_CHUNK_BYTES))
    out: List[Chunk] = []
    for chunk in chunks:
        src_lines = chunk.content.splitlines()
        oversized = len(src_lines) > max_lines or len(chunk.content.encode("utf-8")) > max_bytes
        if not oversized:
            out.append(chunk)
            continue
        for offset in range(0, len(src_lines), max_lines):
            part = src_lines[offset:offset + max_lines]
            if not part:
                continue
            out.append(Chunk(
                path=chunk.path,
                symbol=chunk.symbol,
                kind=chunk.kind,
                start_line=chunk.start_line + offset,
                end_line=chunk.start_line + offset + len(part) - 1,
                content="\n".join(part),
            ))
    return out


def _fill_gaps(path: str, content: str, chunks: List[Chunk]) -> List[Chunk]:
    """把未被任何声明 chunk 覆盖的行区间补为 symbol=None 的 block chunk。

    保证顶层 import / 常量 / 路由注册等代码仍可被检索到（不劣于整文件索引）。
    """
    total = len(content.splitlines())
    if total <= 0:
        return chunks
    spans = sorted((c.start_line, c.end_line) for c in chunks)
    gaps = _complement_ranges(_merge_ranges(spans), 1, total)
    if not gaps:
        return chunks
    lines = content.splitlines()
    for start, end in gaps:
        chunks.append(Chunk(
            path=path,
            symbol=None,
            kind="block",
            start_line=start,
            end_line=end,
            content="\n".join(lines[start - 1:end]),
        ))
    return chunks


def _merge_ranges(spans: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not spans:
        return []
    sorted_spans = sorted(spans)
    merged: List[List[int]] = [list(sorted_spans[0])]
    for start, end in sorted_spans[1:]:
        if start <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def _complement_ranges(
    covered: List[Tuple[int, int]], start: int, end: int
) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    cursor = start
    for s, e in covered:
        if s > cursor:
            out.append((cursor, s - 1))
        cursor = max(cursor, e + 1)
    if cursor <= end:
        out.append((cursor, end))
    return out