"""
安全审计脚本纯函数测试
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from security_audit import check_cors, check_csrf, check_ssrf


def test_check_cors_dev_wildcard_is_warn():
    result = check_cors(["*"], production=False)
    assert result["status"] == "warn"


def test_check_cors_prod_wildcard_is_error():
    result = check_cors(["*"], production=True)
    assert result["status"] == "error"


def test_check_cors_whitelist_is_ok():
    result = check_cors(["https://git.example.com"])
    assert result["status"] == "ok"
    assert "git.example.com" in result["detail"]


def test_check_csrf_bearer_is_ok():
    assert check_csrf(cookie_auth_detected=False)["status"] == "ok"


def test_check_csrf_cookie_warns():
    assert check_csrf(cookie_auth_detected=True)["status"] == "warn"


def test_check_ssrf_guard_ok():
    assert check_ssrf(webhook_url_uses_guard=True)["status"] == "ok"


def test_check_ssrf_guard_missing_is_error():
    assert check_ssrf(webhook_url_uses_guard=False)["status"] == "error"