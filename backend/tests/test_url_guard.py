"""请求级 base_url 白名单（防 SSRF）单元测试"""
import pytest

from app.utils.url_guard import UrlNotAllowed, parse_allowlist, validate_outbound_url


def test_none_or_empty_skips_validation():
    assert validate_outbound_url(None, []) == ""
    assert validate_outbound_url("  ", []) == ""
    assert validate_outbound_url("", ["https://api.openai.com"]) == ""


def test_empty_allowlist_rejects_all_overrides():
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("https://api.openai.com/v1", [])


def test_origin_match_ignores_path():
    allow = ["https://api.openai.com/v1"]
    got = validate_outbound_url("https://api.openai.com/v1/chat/completions", allow)
    assert got == "https://api.openai.com/v1/chat/completions"


def test_origin_does_not_match_other_host():
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url(
            "https://evil.example.com/v1", ["https://api.openai.com/v1"]
        )


def test_port_is_part_of_identity():
    allow = ["http://127.0.0.1:11434"]
    assert validate_outbound_url("http://127.0.0.1:11434/v1", allow)
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("http://127.0.0.1:9999/v1", allow)


def test_scheme_mismatch_rejected():
    allow = ["https://api.openai.com"]
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("http://api.openai.com/v1", allow)


def test_userinfo_forbidden():
    allow = ["https://api.openai.com"]
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("https://user:pass@api.openai.com/v1", allow)


def test_non_http_scheme_rejected():
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("file:///etc/passwd", ["file:///etc"])
    with pytest.raises(UrlNotAllowed):
        validate_outbound_url("ftp://127.0.0.1:21", ["http://127.0.0.1:21"])


def test_parse_allowlist_ignores_invalid_entries():
    assert parse_allowlist("") == []
    assert parse_allowlist(None) == []
    got = parse_allowlist(
        "https://a.com, bad, http://127.0.0.1:11434 ; ftp://x\nhttps://b.com,"
    )
    assert "https://a.com" in got and "https://b.com" in got
    assert "http://127.0.0.1:11434" in got
    assert "bad" not in got and "ftp://x" not in got
