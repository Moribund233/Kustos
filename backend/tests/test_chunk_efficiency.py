"""块级索引效率验证（可量化指标）

对比维度：
1. 索引体量：chunk 行数/字节 vs 旧整文件模型（每文件一行）的字节
2. 单命中读取成本：旧模型 = 整文件字节；chunk 模型 = 命中块字节 → token_gain
3. 构建耗时（asyncio 计时）

输出表格到 stdout（pytest -s 查看），断言保持宽松以允许降级路径。
"""
import os
import shutil
import time

import pytest
from sqlalchemy import func, select
from statistics import median

from app.models.repo_search_chunk import RepoSearchChunk
from app.services.search.search_service import SearchService


def _gen_module(base: str, nfuncs: int, marker: str, marker_at: int = 0) -> str:
    parts = [f"# {base}: generated module with {nfuncs} functions\nimport os\n"]
    for i in range(nfuncs):
        doc = f'"""{marker if i == marker_at else f"fn {i}: computes"}\n    aggregation for base {base}\n"""'
        parts.append(
            f"def fn_{base}_{i:04d}(a, b):\n"
            f"    {doc}\n"
            f"    total = 0\n"
            f"    for x in range(a):\n"
            f"        total += x if b else -x\n"
            f"    return total\n\n"
        )
    return "".join(parts)


def _gen_huge(base: str) -> str:
    body = []
    body.append(f"# {base}: single huge function (triggers chunk splitting)\n")
    body.append("def mega_worker(start, step):\n")
    body.append("    acc = 0\n")
    for i in range(900):
        body.append(f"    acc += start + step * {i}\n")
    body.append("    return acc\n")
    return "".join(body)


def _build_corpus() -> dict:
    files = {}
    for n in range(4):
        files[f"src/module_{n}.py"] = _gen_module(f"m{n}", 180, f"MARKER_{n}", marker_at=0)
    files["src/huge.py"] = _gen_huge("huge")
    files["src/util.js"] = (
        "// util\n"
        "export function mainEntry() {\n"
        "  return internal();\n"
        "}\n"
        "function internal() {\n"
        "  return 42;\n"
        "}\n"
    )
    files["src/runner.go"] = (
        "package main\n\n"
        "func main() {\n"
        "\tprintln(run(1))\n"
        "}\n\n"
        "func run(x int) int {\n"
        "\treturn x + 1\n"
        "}\n"
    )
    return files


@pytest.mark.asyncio
async def test_chunk_index_efficiency(async_db, async_test_repo):
    from tests.test_search_service import _make_bare_repo

    search_service = SearchService()

    files = _build_corpus()
    tmp, bare, _ = _make_bare_repo(files)
    try:
        t0 = time.perf_counter()
        count = await search_service.rebuild_index(async_db, async_test_repo.id, bare)
        rebuild_s = time.perf_counter() - t0

        rows = (await async_db.execute(
            select(RepoSearchChunk).where(RepoSearchChunk.repository_id == async_test_repo.id)
        )).scalars().all()
        chunk_bytes = sum(r.size for r in rows)

        legacy_bytes = sum(len(c.encode("utf-8")) for c in files.values())

        gains = []
        reads_legacy = 0
        reads_chunk = 0
        hits = 0
        queries = ["MARKER_0", "MARKER_1", "MARKER_2", "MARKER_3", "main", "mega_worker"]
        tq0 = time.perf_counter()
        for q in queries:
            res = await search_service.search_code(async_db, async_test_repo.id, bare, q)
            for hit in res.results:
                file_bytes = len(files[hit.file].encode("utf-8"))
                c = hit.chunk
                block_bytes = 0
                if c is not None:
                    src_lines = files[hit.file].splitlines()
                    span = src_lines[c.start_line - 1 : c.end_line]
                    block_bytes = len("\n".join(span).encode("utf-8"))
                else:
                    block_bytes = len(hit.content.encode("utf-8"))
                hits += 1
                reads_legacy += file_bytes
                reads_chunk += block_bytes
                gains.append(file_bytes / block_bytes if block_bytes else 1.0)
        query_s = time.perf_counter() - tq0

        gains_sorted = sorted(gains)
        p95 = gains_sorted[int(len(gains_sorted) * 0.95) - 1] if gains_sorted else 0.0
        print("\n===== 块级索引效率报告 =====")
        print(f"文件数: {count}   chunk 行数: {len(rows)}")
        print(f"旧整文件模型存储: {legacy_bytes / 1024:.1f} KB  |  chunk 模型存储: {chunk_bytes / 1024:.1f} KB")
        print(f"索引构建时间: {rebuild_s * 1000:.0f} ms   |  查询(6条)时间: {query_s * 1000:.0f} ms")
        print(f"命中总数: {hits}  命中平均读取: legacy={reads_legacy / hits / 1024:.1f} KB/次  chunk={reads_chunk / hits / 1024:.1f} KB/次")
        print(f"token_gain(整块/命中块): mean={sum(gains) / len(gains) if gains else 0:.1f}x  median={median(gains) if gains else 0:.1f}x  p95={p95:.1f}x")
        print("=====" + "=" * (len("块级索引效率报告") + 4) + "\n")

        assert len(rows) > 0
        assert gains, "应产生命中"
        assert median(gains) > 2, f"中位 token_gain 应 > 2，实际 {median(gains):.1f}"
        # gap-fill 保证全量可检索 -> 存储不膨胀过大（允许降级路径，留 3x 余量）
        assert chunk_bytes <= legacy_bytes * 3
    finally:
        shutil.rmtree(tmp, ignore_errors=True)