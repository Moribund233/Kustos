#!/usr/bin/env bash
# =============================================================================
# E2E：push 事件接入端到端验证（在 WSL 内执行，走真实 gateway/git-cgi/app）
#
# 覆盖「验证清单」：
#   1. git push 成功且 pre-receive 放行
#   2. branches 表出现新分支、commits 表出现提交（post-receive 对账）
#   3. push webhook 触发（产生 delivery 记录，目标端点故意不可达）
#   4. 保护分支 push --force 被拒（pre-receive 裁决）
#   5. 保护分支删支被拒
# =============================================================================
set -uo pipefail

BASE=http://127.0.0.1:8000
UNAME=hookuser
UPASS='HookPass123!'
UEMAIL=hookuser@example.com
REPO_NAME=hook-e2e-$(date +%s)
PSQL() { docker exec -i kustos-postgres psql -U kustos -d kustos -Atc "$1"; }

fail() { echo "E2E_FAIL: $1"; exit 1; }
pass() { echo "E2E_OK: $1"; }

jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d[sys.argv[1]])" "$1"; }

# ---- 1. 注册（容忍已存在）+ 登录 ----
curl -s -o /dev/null -X POST "$BASE/api/v1/users" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$UNAME\",\"email\":\"$UEMAIL\",\"password\":\"$UPASS\"}"
TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$UNAME\",\"password\":\"$UPASS\"}" | jget token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "None" ] || fail "login"
pass "login"

# ---- 2. 创建仓库（容忍已存在）----
REPO_JSON=$(curl -s -X POST "$BASE/api/v1/repositories" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"e2e\",\"is_public\":false}")
REPO_ID=$(printf '%s' "$REPO_JSON" | jget id 2>/dev/null || true)
if [ -z "$REPO_ID" ] || [ "$REPO_ID" = "None" ]; then
    REPO_ID=$(curl -s "$BASE/api/v1/repositories" -H "Authorization: Bearer $TOKEN" \
        | python3 -c "
import json,sys
items = json.load(sys.stdin)
items = items.get('items', items) if isinstance(items, dict) else items
print(next(r['id'] for r in items if r['path'].endswith('/$REPO_NAME')))")
fi
REPO_PATH=$(curl -s "$BASE/api/v1/repositories/$REPO_ID" -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('path') or '$UNAME/$REPO_NAME')")
[ -n "$REPO_ID" ] || fail "create repo"
pass "repo $REPO_PATH ($REPO_ID)"

# ---- 3. 创建 push webhook（URL 通过 SSRF 校验但必 NXDOMAIN，用于验证触发留痕）----
E2E_HOOK_URL="http://kustos-e2e-invalid.example.invalid/hook"
WH_JSON=$(curl -s -X POST "$BASE/api/v1/repositories/$REPO_ID/webhooks" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"url\":\"$E2E_HOOK_URL\",\"events\":[\"push\"],\"secret\":\"e2e\"}")
WH_ID=$(printf '%s' "$WH_JSON" | jget id 2>/dev/null || true)
[ -n "$WH_ID" ] && [ "$WH_ID" != "None" ] || { echo "$WH_JSON"; fail "webhook create"; }
pass "webhook created ($WH_ID)"

# ---- 4. 本地仓库 + 首次 push ----
WORK=$(mktemp -d)
cd "$WORK"
git init -q -b master local
cd local
git config user.name "Hook Tester"
git config user.email hook@example.com
echo "r1" > file.txt
git add file.txt
git commit -qm "first commit via e2e"
PUSH_URL="http://$UNAME:$UPASS@127.0.0.1:8000/$REPO_PATH.git"
if git push -q "$PUSH_URL" master 2>push.err; then
    pass "first push accepted"
else
    cat push.err
    fail "first push rejected (pre-receive/hook error)"
fi

# ---- 5. 等待 post-receive 回调 + webhook 投递 ----
sleep 4

BRANCHES=$(PSQL "SELECT b.name FROM branches b JOIN repositories r ON r.id=b.repository_id WHERE r.path='$REPO_PATH' ORDER BY 1" | tr '\n' ' ')
echo "  branches in DB: [$BRANCHES]"
case "$BRANCHES" in *master*) pass "branches reconciled (master present)";;
    *) echo "--- push.err ---"; cat push.err 2>/dev/null; echo "--- git-cgi logs ---"; docker logs kustos-git-cgi --tail 20 2>&1; fail "branches not synced";;
esac

COMMIT_MSG=$(PSQL "SELECT c.commit_message FROM commits c JOIN repositories r ON r.id=c.repository_id WHERE r.path='$REPO_PATH' LIMIT 1")
echo "  commit row: [$COMMIT_MSG]"
[ "$COMMIT_MSG" = "first commit via e2e" ] || fail "commit not synced"
pass "commit synced"

DELIVERY=$(PSQL "SELECT count(*) FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE w.url LIKE '%kustos-e2e-invalid%'")
echo "  webhook deliveries: $DELIVERY"
[ "$DELIVERY" -ge 1 ] || fail "push webhook not triggered"
pass "push webhook triggered (delivery=$DELIVERY)"

# ---- 6. 保护分支 → 快进放行 / 强推被拒 ----
curl -s -o /dev/null -X PUT "$BASE/api/v1/repositories/$REPO_ID/branches/master/protect" \
    -H "Authorization: Bearer $TOKEN"
PROT=$(PSQL "SELECT is_protected FROM branches b JOIN repositories r ON r.id=b.repository_id WHERE r.path='$REPO_PATH' AND b.name='master'")
[ "$PROT" = "t" ] || fail "branch not protected"
pass "branch protected"

echo "r2" >> file.txt
git commit -qam "second commit"
if git push "$PUSH_URL" master 2>ff.err; then
    pass "fast-forward push to protected branch allowed"
else
    cat ff.err; fail "fast-forward push wrongly rejected"
fi
FF_TIP=$(git rev-parse HEAD)

# 真正的强推：重写历史
git reset -q --hard HEAD~1
echo "r3" > file.txt
git commit -qam "rewritten history"
if git push --force "$PUSH_URL" master 2>force.err; then
    fail "force push to protected branch NOT rejected"
fi
grep -q "force push is not allowed on protected branch: master" force.err || { cat force.err; fail "force rejection message missing"; }
pass "force push rejected with reason"

# ---- 7. 删除保护分支被拒 ----
if git push -q "$PUSH_URL" :master 2>del.err; then
    fail "deleting protected branch NOT rejected"
fi
grep -q "protected branch cannot be deleted: master" del.err || { cat del.err; fail "delete rejection message missing"; }
pass "protected branch deletion rejected"

# ---- 8. branches.commit_hash 同步 tip ----
DB_TIP=$(PSQL "SELECT b.commit_hash FROM branches b JOIN repositories r ON r.id=b.repository_id WHERE r.path='$REPO_PATH' AND b.name='master'")
echo "  branch tip: db=$DB_TIP local=$FF_TIP"
[ "$DB_TIP" = "$FF_TIP" ] || fail "branches.commit_hash not synced"
pass "branch tip (commit_hash) synced"

# ---- 9. require_code_review 分支禁直推（真实 hook 链路）----
curl -s -o /dev/null -X PUT "$BASE/api/v1/repositories/$REPO_ID/branches/master/protect" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"require_code_review": true, "require_status_checks": false}'
# 强推测试后本地历史与远端分叉，先对齐远端再制造一次可送达 pre-receive 的直推
git fetch -q "$PUSH_URL" master && git reset -q --hard FETCH_HEAD
echo "r4" >> file.txt
git commit -qam "direct push attempt"
if git push "$PUSH_URL" master 2>review.err; then
    fail "direct push to review-required branch NOT rejected"
fi
grep -q "requires a pull request" review.err || { cat review.err; fail "review-required rejection message missing"; }
pass "direct push to require_code_review branch rejected"

cd /
rm -rf "$WORK"
echo "=== ALL E2E CHECKS PASSED ==="
