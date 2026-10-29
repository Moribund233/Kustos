"""
分支名带 `/` 时的路由匹配测试。

分支名允许 `feature/demo` 这类层级命名；路径参数若按单段匹配，保护/默认分支
接口会 404。这里通过 HTTP 端点确认 `:path` 参数能命中。
"""

from tests.test_authz_probe import (
    _ensure_branch_row,
    _headers,
    _victim_private_repo,
    repo_owner,
)


def test_protect_and_default_branch_with_slash(test_client, db):
    repo, _ = _victim_private_repo(db)
    _ensure_branch_row(db, repo, "feature/demo")
    headers = _headers(repo_owner(db, repo))
    base = f"/api/v1/repositories/{repo.id}/branches/feature%2Fdemo"

    protected = test_client.put(
        f"{base}/protect",
        json={"require_code_review": True, "require_status_checks": True},
        headers=headers,
    )
    assert protected.status_code == 200, protected.text[:300]
    assert protected.json()["is_protected"] is True

    checked = test_client.get(f"{base}/protection", headers=headers)
    assert checked.status_code == 200, checked.text[:300]
    assert checked.json()["is_protected"] is True

    unprotect = test_client.put(f"{base}/unprotect", headers=headers)
    assert unprotect.status_code == 200, unprotect.text[:300]

    default = test_client.put(f"{base}/default", headers=headers)
    assert default.status_code == 200, default.text[:300]
