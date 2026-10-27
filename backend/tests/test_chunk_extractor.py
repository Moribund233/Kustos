"""块级切分单元测试（第一步：tree-sitter → 正则 → 整文件 三级降级 + 间隙补齐）"""
import pytest

from app.services.indexing.chunker import chunk_file


def _total_lines(content: str) -> int:
    return len(content.splitlines()) or 1


class TestChunkFile:
    def test_returns_function_chunks_for_python(self):
        content = "def foo():\n    return 1\n\ndef bar():\n    return 2\n"
        chunks = chunk_file("app.py", content)
        assert chunks
        funcs = {c.symbol: c for c in chunks if c.symbol}
        assert "foo" in funcs and "bar" in funcs
        assert all(c.kind == "function" for c in funcs.values())

    def test_spans_stay_in_bounds(self):
        content = "def foo():\n    return 1\n\nx = 1\n"
        total = _total_lines(content)
        for c in chunk_file("app.py", content):
            assert 1 <= c.start_line <= c.end_line <= total

    def test_full_coverage_via_gap_fill(self):
        """间隙补齐：顶层 import / 常量等未被声明覆盖的行也要有 chunk"""
        content = "import os\n\ndef foo():\n    return 1\n\nVAL = 42\n"
        chunks = chunk_file("app.py", content)
        total = _total_lines(content)
        covered = sorted((c.start_line, c.end_line) for c in chunks)
        cursor = 1
        for start, end in covered:
            assert start <= cursor, f"行 {cursor} 未被任何 chunk 覆盖"
            cursor = max(cursor, end + 1)
        assert cursor > total

    def test_whitespace_only_returns_empty(self):
        assert chunk_file("app.py", "\n\n\n") == []

    def test_nested_class_methods_do_not_overlap(self):
        """容器 chunk 剔除内部声明区间：类块不再包含方法体，且无重叠"""
        content = (
            "class A:\n"
            "    def m1(self):\n        return 1\n\n"
            "    def m2(self):\n        return 2\n"
        )
        chunks = chunk_file("a.py", content)
        spans = sorted((c.start_line, c.end_line) for c in chunks)
        for (_, prev_end), (next_start, _) in zip(spans, spans[1:]):
            assert next_start > prev_end, f"chunk 重叠: {spans}"
        assert {"A", "m1", "m2"} <= {c.symbol for c in chunks if c.symbol}
        assert all("return 1" not in c.content for c in chunks if c.symbol == "A")


class TestFallbackPaths:
    def test_whole_file_fallback_for_unknown_language(self, monkeypatch):
        monkeypatch.setattr("app.services.indexing.chunker._TS_AVAILABLE", False)
        content = "hello world\nsecond line\n"
        chunks = chunk_file("notes.txt", content)
        assert len(chunks) == 1
        assert chunks[0].start_line == 1 and chunks[0].end_line == 2
        assert chunks[0].kind == "block"

    def test_regex_fallback_split_python(self, monkeypatch):
        monkeypatch.setattr("app.services.indexing.chunker._TS_AVAILABLE", False)
        content = "def foo():\n    pass\n\ndef bar():\n    return 2\n"
        chunks = chunk_file("app.py", content)
        by = {c.symbol: c for c in chunks if c.symbol}
        assert by["foo"].start_line == 1
        assert by["bar"].start_line == 4


class TestTreesitterSpans:
    def test_symbol_spans_precise(self):
        pytest.importorskip("tree_sitter_python")
        content = "def foo():\n    return 1\n\ndef bar():\n    return 2\n"
        chunks = chunk_file("app.py", content)
        by = {c.symbol: c for c in chunks if c.symbol}
        assert by["foo"].start_line == 1
        assert by["foo"].end_line == 2
        assert by["bar"].start_line == 4
        assert by["bar"].end_line == 5
