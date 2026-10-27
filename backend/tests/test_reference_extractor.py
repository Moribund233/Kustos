"""符号/引用提取单元测试（第二步：tree-sitter 引用 + 正则兜底）"""
import pytest

from app.services.indexing.chunker import analyze_file


class TestReferenceExtraction:
    def test_python_refs_include_definition_and_call(self):
        content = "def foo():\n    return bar()\n\ndef bar():\n    return 1\n"
        refs = analyze_file("a.py", content).refs
        by_name: dict = {}
        for r in refs:
            by_name.setdefault(r.name, []).append(r.line)
        assert 1 in by_name.get("foo", [])   # 定义
        assert 2 in by_name.get("bar", [])   # 调用
        assert 4 in by_name.get("bar", [])   # 定义

    def test_refs_lines_in_bounds(self):
        content = "def foo():\n    return 1\n"
        total = len(content.splitlines())
        for r in analyze_file("a.py", content).refs:
            assert 1 <= r.line <= total

    def test_regex_fallback_refs(self, monkeypatch):
        monkeypatch.setattr("app.services.indexing.chunker._TS_AVAILABLE", False)
        content = "def foo():\n    return bar()\n"
        names = {r.name for r in analyze_file("a.py", content).refs}
        assert "foo" in names and "bar" in names

    def test_no_refs_for_plain_text(self):
        assert analyze_file("notes.txt", "hello world\n").refs == []

    def test_chunks_still_extracted(self):
        content = "def foo():\n    return 1\n\ndef bar():\n    return 2\n"
        analysis = analyze_file("a.py", content)
        assert {c.symbol for c in analysis.chunks if c.symbol} >= {"foo", "bar"}
