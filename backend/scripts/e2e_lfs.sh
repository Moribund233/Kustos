#!/usr/bin/env bash
# =============================================================================
# E2E：LFS 仓库级 ACL + 短时效 transfer token（真实 gateway → app）
#
# 运行环境：需 curl / git / git-lfs，网关端口 18090（prod 栈已起）。
# 可在 WSL 或 Windows Git Bash 中执行；WSL 侧若未装 git-lfs 会在开头显式失败。
#
# 覆盖「验收清单」：
#   1. git-lfs 经 /{owner}/{repo}.git/info/lfs/batch 上传（网关重写 → 应用路径入口）
#   2. 私仓非成员 batch 被拒 403；未认证 401
#   3. 传输端点只认 LFS transfer token（access token 401）
#   4. 新 clone 经 git lfs pull 取回，sha256 一致（存储与 repo 隔离正确）
#   5. 只读成员：可下载、batch 上传 403（矩阵口径）
# =============================================================================
set -uo pipefail

BASE=${LFS_E2E_BASE:-http://127.0.0.1:18090}
STAMP=$(date +%s)
UNAME=lfse2e;        UPASS=LfsE2ePass1234;      UEMAIL=lfse2e@example.com
RNAME=lfsreader;     RPASS=LfsReaderPass1234;   RMAIL=lfsreader@example.com
ONAME=lfsoutsider;   OPASS=LfsOutsiderPass1234; OMAIL=lfsoutsider@example.com
REPO_NAME="lfs-e2e-$STAMP"

# 不弹凭据框、不交互（凭据全部内嵌在 URL 中）
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_CONFIG_NOSYSTEM=0

fail() { echo "E2E_FAIL: $1"; exit 1; }
pass() { echo "E2E_OK: $1"; }

# JSON 字符串字段提取（无 python 依赖；只用于字符串值）
jget() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

git lfs version >/dev/null 2>&1 || fail "git-lfs not installed (wsl: sudo apt install git-lfs)"

# ---- 1. 注册（容忍已存在）+ 登录 ----
register() {
    curl -s -o /dev/null -X POST "$BASE/api/v1/users" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$1\",\"email\":\"$3\",\"password\":\"$2\"}"
}
register "$UNAME" "$UPASS" "$UEMAIL"
register "$RNAME" "$RPASS" "$RMAIL"
register "$ONAME" "$OPASS" "$OMAIL"

TOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$UNAME\",\"password\":\"$UPASS\"}" | jget token)
[ -n "$TOKEN" ] || fail "owner login"
RTOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$RNAME\",\"password\":\"$RPASS\"}" | jget token)
[ -n "$RTOKEN" ] || fail "reader login"
OTOKEN=$(curl -s -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ONAME\",\"password\":\"$OPASS\"}" | jget token)
[ -n "$OTOKEN" ] || fail "outsider login"
pass "login (owner/reader/outsider)"

# ---- 2. 创建私有仓库 ----
REPO_JSON=$(curl -s -X POST "$BASE/api/v1/repositories" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$REPO_NAME\",\"description\":\"e2e lfs\",\"is_public\":false}")
REPO_ID=$(printf '%s' "$REPO_JSON" | jget id)
[ -n "$REPO_ID" ] || { printf '%s\n' "$REPO_JSON"; fail "create repo"; }
REPO_PATH=$(curl -s "$BASE/api/v1/repositories/$REPO_ID" \
    -H "Authorization: Bearer $TOKEN" | jget path)
[ -n "$REPO_PATH" ] || fail "repo path"
pass "repo $REPO_PATH ($REPO_ID)"

# ---- 3. 授权负面：未认证 401 / 非成员（私仓）403 ----
C=$(http_code -X POST "$BASE/$REPO_PATH.git/info/lfs/batch" \
    -H 'Content-Type: application/json' -d '{"operation":"download","objects":[]}')
[ "$C" = 401 ] || fail "anonymous batch expected 401, got $C"
pass "anonymous batch -> 401"

C=$(http_code -X POST "$BASE/$REPO_PATH.git/info/lfs/batch" \
    -H "Authorization: Bearer $OTOKEN" -H 'Content-Type: application/json' \
    -d '{"operation":"download","objects":[]}')
[ "$C" = 403 ] || fail "outsider batch on private repo expected 403, got $C"
pass "outsider batch on private repo -> 403"

# ---- 4. git clone + git lfs push（上传走网关重写入口）----
WORK=$(mktemp -d)
trap 'cd /; rm -rf "$WORK"' EXIT
PUSH_URL="http://$UNAME:$UPASS@127.0.0.1:18090/$REPO_PATH.git"

git init -q -b master "$WORK/local"
cd "$WORK/local"
git config user.name "LFS E2E"
git config user.email "$UEMAIL"
git lfs install

printf '*.bin filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
head -c 2000000 /dev/urandom > big.bin
EXPECT_SHA=$(sha256sum big.bin | cut -d' ' -f1)
git add .gitattributes big.bin
git commit -qm "lfs e2e payload"

# 指针文件内容（确认 git-lfs 真的接管了）
POINTER=$(git cat-file -p HEAD:big.bin)
OID=$(printf '%s\n' "$POINTER" | sed -n 's/^oid \(sha256:[0-9a-f]*\).*/\1/p')
SIZE=$(printf '%s\n' "$POINTER" | sed -n 's/^size \([0-9]*\).*/\1/p')
[ "$OID" = "sha256:$EXPECT_SHA" ] || fail "lfs pointer oid mismatch: [$OID]"
[ "$SIZE" = 2000000 ] || fail "lfs pointer size mismatch: [$SIZE]"
pass "lfs pointer committed (oid=${OID:0:20}…, size=$SIZE)"

if git push -q "$PUSH_URL" master 2>push.err; then
    pass "git lfs push accepted"
else
    cat push.err
    fail "git lfs push rejected"
fi

# ---- 5. 服务端对象可见（download batch → transfer token → 下载比对）----
DL=$(curl -s -X POST "$BASE/$REPO_PATH.git/info/lfs/batch" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"operation\":\"download\",\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}")
HREF=$(printf '%s' "$DL" | sed -n 's/.*"href":"\([^"]*\)".*/\1/p' | head -1)
XAUTH=$(printf '%s' "$DL" | sed -n 's/.*"header":{"Authorization":"\([^"]*\)"}.*/\1/p' | head -1)
[ -n "$HREF" ] && [ -n "$XAUTH" ] || { printf '%s\n' "$DL"; fail "download batch actions"; }
case "$HREF" in
    "http://127.0.0.1:18090/api/v1/repositories/$REPO_ID/lfs/objects/"*) ;;
    *) fail "href must be absolute & gateway-scoped (Host 丢端口的老问题): $HREF" ;;
esac
pass "download batch issued transfer token (href repo-scoped)"

# 5a. 传输端点只认 LFS token：access token 一律 401
C=$(http_code -H "Authorization: Bearer $TOKEN" "$HREF")
[ "$C" = 401 ] || fail "transfer endpoint with access token expected 401, got $C"
pass "transfer endpoint rejects access token -> 401"

# 5b. transfer token 下载，内容一致
if curl -s -H "Authorization: $XAUTH" "$HREF" -o "$WORK/dl.bin"; then
    GOT_SHA=$(sha256sum "$WORK/dl.bin" | cut -d' ' -f1)
    [ "$GOT_SHA" = "$EXPECT_SHA" ] || fail "downloaded object sha256 mismatch"
    pass "transfer token download -> sha256 match"
else
    fail "transfer token download failed"
fi

# ---- 6. 新 clone 经 git lfs pull 取回 ----
GIT_LFS_SKIP_SMUDGE=1 git clone -q "$PUSH_URL" "$WORK/clone2"
cd "$WORK/clone2"
git lfs install
git lfs pull 2>pull.err || { cat pull.err; fail "git lfs pull failed"; }
CLONE_SHA=$(sha256sum big.bin | cut -d' ' -f1)
[ "$CLONE_SHA" = "$EXPECT_SHA" ] || fail "cloned file sha256 mismatch"
pass "git lfs pull -> sha256 match"

# ---- 7. 只读成员：可下载、不可上传 ----
READER_ID=$(curl -s "$BASE/api/v1/users/me" -H "Authorization: Bearer $RTOKEN" | jget id)
[ -n "$READER_ID" ] || fail "reader id"
MEM=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "$BASE/api/v1/repositories/$REPO_ID/members" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"user_id\":\"$READER_ID\",\"role\":\"readonly\"}")
case "$MEM" in 200|201) ;; *) fail "add readonly member -> $MEM";; esac

C=$(http_code -X POST "$BASE/$REPO_PATH.git/info/lfs/batch" \
    -H "Authorization: Bearer $RTOKEN" -H 'Content-Type: application/json' \
    -d "{\"operation\":\"upload\",\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}")
[ "$C" = 403 ] || fail "readonly upload batch expected 403, got $C"
pass "readonly member upload batch -> 403"

C=$(http_code -X POST "$BASE/$REPO_PATH.git/info/lfs/batch" \
    -H "Authorization: Bearer $RTOKEN" -H 'Content-Type: application/json' \
    -d "{\"operation\":\"download\",\"objects\":[{\"oid\":\"$OID\",\"size\":$SIZE}]}")
[ "$C" = 200 ] || fail "readonly download batch expected 200, got $C"
pass "readonly member download batch -> 200"

cd /
echo "=== ALL LFS E2E CHECKS PASSED ==="
