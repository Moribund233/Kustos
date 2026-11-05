"""为「已部署实例」的端到端用例预置夹具。

用例跑在真实实例上，账号、仓库、协作文件与房间成员关系都必须先存在，
否则 UI 只能看到空态。这里用后端公开 API 把夹具准备好，并把结果写成
JSON 交给 Playwright 读；脚本幂等，重复执行不会重复建资源。

只依赖标准库，避免为了跑 E2E 再装一套 Python 依赖。

用法：
    KUSTOS_E2E_BASE_URL=http://<host>:<port> python e2e/live/bootstrap.py
    python e2e/live/bootstrap.py --base-url http://<host>:<port>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# 两个互不相同的账号：一个持有仓库（写权限），一个以 developer 身份加入。
ACCOUNT_A = {
    "username": "e2e_editor",
    "email": "e2e_editor@example.com",
    "password": "E2e-Passw0rd-A",
    "full_name": "E2E Editor",
}
ACCOUNT_B = {
    "username": "e2e_guest",
    "email": "e2e_guest@example.com",
    "password": "E2e-Passw0rd-B",
    "full_name": "E2E Guest",
}

REPO_NAME = "e2e-live"
REPO_DESCRIPTION = "端到端用例专用仓库（实时编辑与聊天）"
SEED_PATH = "docs/notes.md"

# 协作网关从 Git 取初始文档，因此内容必须真的提交进仓库，而不是只在库里写一行。
SEED_CONTENT = """# E2E 协作笔记

这份文件由端到端用例的预置脚本写入，供两个浏览器会话同时编辑。
"""

STATE_FILE = Path(__file__).with_name(".state.json")


class ApiError(RuntimeError):
    """接口返回非 2xx 时抛出，保留状态码与响应体便于定位。"""

    def __init__(self, status: int, body: str, where: str) -> None:
        super().__init__(f"{where} -> HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body


def request(
    base_url: str,
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    token: str | None = None,
    expect: tuple[int, ...] = (200, 201),
) -> Any:
    """发一次 JSON 请求。

    Args:
        base_url: 实例根地址
        method: HTTP 方法
        path: 以 `/` 开头的接口路径
        body: 请求体，None 表示无请求体
        token: Bearer 令牌
        expect: 视为成功的状态码集合

    Returns:
        解析后的 JSON；响应为空时返回 None

    Raises:
        ApiError: 状态码不在 `expect` 内
    """
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if exc.code in expect:
            return json.loads(detail) if detail else None
        raise ApiError(exc.code, detail, f"{method} {path}") from exc


def login(base_url: str, username: str, password: str) -> dict[str, Any]:
    """登录并返回令牌与用户信息。"""
    return request(
        base_url,
        "POST",
        "/api/v1/auth/login",
        body={"username": username, "password": password},
    )


def ensure_account(base_url: str, account: dict[str, str]) -> dict[str, Any]:
    """确保账号存在且能登录，返回其登录信息。

    注册端点对已存在的用户名返回 409，此时直接登录即可。
    """
    try:
        user = request(base_url, "POST", "/api/v1/users", body=account)
        print(f"  注册 {account['username']} ({user['id']})")
    except ApiError as exc:
        if exc.status != 409:
            raise
        print(f"  {account['username']} 已存在，复用")
    return login(base_url, account["username"], account["password"])


def ensure_repo(base_url: str, token: str, username: str) -> dict[str, Any]:
    """确保账号名下存在目标仓库；返回仓库对象。"""
    repos = request(base_url, "GET", "/api/v1/repositories?page=1&limit=100", token=token)
    items = repos.get("items", []) if isinstance(repos, dict) else []
    for repo in items:
        if repo.get("name") == REPO_NAME:
            return repo
    repo = request(
        base_url,
        "POST",
        "/api/v1/repositories",
        token=token,
        body={
            "name": REPO_NAME,
            "description": REPO_DESCRIPTION,
            "is_public": True,
            "default_branch": "main",
        },
    )
    print(f"  创建仓库 {repo.get('path')} ({repo.get('id')})")
    return repo


def ensure_seed_file(base_url: str, token: str, repo_id: str) -> str:
    """确保协作文件已提交到默认分支，返回文件路径。

    内容已存在时不重写：重复提交会改动协作网关加载到的初始文本，
    让上一轮用例留下的草稿与实际文件内容对不上。
    """
    try:
        blob = request(
            base_url,
            "GET",
            f"/api/v1/repositories/{repo_id}/blob?path={SEED_PATH}&ref=main",
            token=token,
        )
        if blob and blob.get("content"):
            print(f"  {SEED_PATH} 已存在，跳过写入")
            return SEED_PATH
    except ApiError as exc:
        if exc.status not in (404, 400):
            raise
    request(
        base_url,
        "PUT",
        f"/api/v1/repositories/{repo_id}/contents/{SEED_PATH}",
        token=token,
        body={"content": SEED_CONTENT, "message": "docs: 提交端到端用例的协作文件", "branch": "main"},
    )
    print(f"  写入 {SEED_PATH}")
    return SEED_PATH


def ensure_repo_member(base_url: str, token: str, repo_id: str, user_id: str) -> None:
    """确保第二个账号是仓库 developer（协作编辑的写权限来源）。"""
    members = request(base_url, "GET", f"/api/v1/repositories/{repo_id}/members", token=token)
    for member in members if isinstance(members, list) else []:
        if (member.get("user") or {}).get("id") == user_id:
            print("  仓库成员关系已存在")
            return
    request(
        base_url,
        "POST",
        f"/api/v1/repositories/{repo_id}/members",
        token=token,
        body={"user_id": user_id, "role": "developer"},
    )
    print("  加入仓库成员（developer）")


def ensure_room(base_url: str, token: str, repo_id: str, user_id: str) -> dict[str, Any]:
    """取仓库频道并在需要时把第二个账号加入，返回房间对象。"""
    room = request(base_url, "GET", f"/api/v1/repositories/{repo_id}/room", token=token)
    members = request(base_url, "GET", f"/api/v1/rooms/{room['id']}/members", token=token)
    already = any((m.get("user") or {}).get("id") == user_id for m in members if isinstance(m, dict))
    if already:
        print(f"  频道 {room['name']} 已包含测试账号")
        return room
    request(
        base_url,
        "POST",
        f"/api/v1/rooms/{room['id']}/members",
        token=token,
        body={"user_id": user_id, "role": "member"},
        expect=(200, 201),
    )
    print(f"  频道 {room['name']} 加入测试账号")
    return room


def main() -> int:
    parser = argparse.ArgumentParser(description="为已部署实例预置 E2E 夹具")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("KUSTOS_E2E_BASE_URL"),
        help="实例根地址（也可用环境变量 KUSTOS_E2E_BASE_URL）",
    )
    args = parser.parse_args()

    if not args.base_url:
        parser.error("需要 --base-url 或环境变量 KUSTOS_E2E_BASE_URL 指向已部署实例")

    base = args.base_url
    print(f"预置夹具到 {base}")
    print("账号：")
    session_a = ensure_account(base, ACCOUNT_A)
    session_b = ensure_account(base, ACCOUNT_B)

    token_a = session_a["token"]
    print("仓库：")
    repo = ensure_repo(base, token_a, ACCOUNT_A["username"])
    ensure_seed_file(base, token_a, repo["id"])
    ensure_repo_member(base, token_a, repo["id"], session_b["id"])
    print("频道：")
    room = ensure_room(base, token_a, repo["id"], session_b["id"])

    state = {
        "baseUrl": base,
        "repoId": repo["id"],
        "repoName": repo.get("name"),
        "repoPath": repo.get("path"),
        "defaultBranch": repo.get("default_branch") or "main",
        "seedPath": SEED_PATH,
        "roomId": room["id"],
        "roomName": room.get("name"),
        "users": {
            "a": {**ACCOUNT_A, "id": session_a["id"]},
            "b": {**ACCOUNT_B, "id": session_b["id"]},
        },
    }
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"夹具已写入 {STATE_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
