"""
提交哈希唯一约束与 branch_id 可空回归

覆盖：
- ② (repository_id, hash) 复合唯一：跨仓同 hash 各存一行；同仓同 hash 冲突 409；
- ③ 分支删除**保留**提交行（branch_id 置 NULL）：
  * 对账删分支（post-receive 全量对账）不丢仓库级历史；
  * API 删带提交的分支不再 FK 违约（旧 schema 下 500）；
  * 分支重建后再推送同一提交 → 重新挂靠（branch_id 回填）。
"""
from app.services import branch_service
import pytest
from sqlalchemy import select

from app.models import Branch, Commit, Repository

ZERO = "0" * 40


# ============================== 助手（async / sync 两套） ==============================

async def _arepo(adb, test_user, name: str) -> Repository:
    repo = Repository(
        name=name, path=f"t34/{name}", description="commit schema t3/t4",
        is_public=True, owner_id=test_user.id, default_branch="main",
    )
    adb.add(repo)
    await adb.commit()
    await adb.refresh(repo)
    return repo


async def _abranch(adb, repo: Repository, name: str, **flags) -> Branch:
    branch = Branch(repository_id=repo.id, name=name, **flags)
    adb.add(branch)
    await adb.commit()
    await adb.refresh(branch)
    return branch


async def _acommit(adb, repo: Repository, branch: Branch, sha: str) -> Commit:
    row = Commit(
        hash=sha, repository_id=repo.id, branch_id=branch.id,
        author_name="A", author_email="a@example.com",
        committer_name="A", committer_email="a@example.com",
        commit_message="msg",
    )
    adb.add(row)
    await adb.commit()
    await adb.refresh(row)
    return row


def _srepo(db, test_user, name: str) -> Repository:
    repo = Repository(
        name=name, path=f"t34/{name}", description="commit schema t3/t4",
        is_public=True, owner_id=test_user.id, default_branch="master",
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


def _sbranch(db, repo: Repository, name: str) -> Branch:
    branch = Branch(repository_id=repo.id, name=name)
    db.add(branch)
    db.commit()
    db.refresh(branch)
    return branch


def _scommit(db, repo: Repository, branch, sha: str) -> Commit:
    row = Commit(
        hash=sha, repository_id=repo.id,
        branch_id=branch.id if branch is not None else None,
        author_name="A", author_email="a@example.com",
        committer_name="A", committer_email="a@example.com",
        commit_message="msg",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ============================== ② 复合唯一 ==============================

class TestCompositeHashUnique:
    async def test_same_hash_two_repos_both_inserted(self, test_user, async_db):
        """跨仓共享提交（fork 场景）：同 hash 各仓各存一行，互不挤掉"""
        sha = "c" * 40
        repo_a = await _arepo(async_db, test_user, "hash-a")
        repo_b = await _arepo(async_db, test_user, "hash-b")
        branch_a = await _abranch(async_db, repo_a, "main")
        branch_b = await _abranch(async_db, repo_b, "main")

        await _acommit(async_db, repo_a, branch_a, sha)
        row_b = await _acommit(async_db, repo_b, branch_b, sha)  # 不应 IntegrityError

        rows = (
            await async_db.execute(select(Commit).where(Commit.hash == sha))
        ).scalars().all()
        assert len(rows) == 2, f"同 hash 应两仓各一行，实际 {len(rows)}"
        assert {r.repository_id for r in rows} == {repo_a.id, repo_b.id}
        assert row_b.branch_id == branch_b.id

    async def test_same_hash_same_repo_conflicts(self, test_user, async_db):
        """同仓同 hash 仍唯一（复合唯一语义保留冲突）"""
        from sqlalchemy.exc import IntegrityError

        sha = "d" * 40
        repo = await _arepo(async_db, test_user, "hash-dup")
        branch = await _abranch(async_db, repo, "main")
        await _acommit(async_db, repo, branch, sha)

        dup = Commit(
            hash=sha, repository_id=repo.id, branch_id=branch.id,
            author_name="B", author_email="b@example.com",
            committer_name="B", committer_email="b@example.com",
            commit_message="dup",
        )
        async_db.add(dup)
        with pytest.raises(IntegrityError):
            await async_db.commit()
        await async_db.rollback()

    async def test_create_commit_service_scoped_by_repo(self, test_user, async_db):
        """create_commit 的哈希冲突检查按仓库 scope（跨仓同 hash 不再误报 409）"""
        from app.core.exception import ConflictException
        from app.services import commit_service

        sha = "e" * 40
        repo_a = await _arepo(async_db, test_user, "svc-hash-a")
        repo_b = await _arepo(async_db, test_user, "svc-hash-b")
        branch_a = await _abranch(async_db, repo_a, "main")
        branch_b = await _abranch(async_db, repo_b, "main")

        base = {
            "hash": sha, "author_name": "A", "author_email": "a@example.com",
            "commit_message": "m",
        }
        await commit_service.create_commit(
            {**base, "repository_id": repo_a.id, "branch_id": branch_a.id}, async_db
        )
        with pytest.raises(ConflictException):
            await commit_service.create_commit(
                {**base, "repository_id": repo_a.id, "branch_id": branch_a.id}, async_db
            )
        row = await commit_service.create_commit(
            {**base, "repository_id": repo_b.id, "branch_id": branch_b.id}, async_db
        )
        assert row.repository_id == repo_b.id


# ============================== ③ 删分支保留提交行 ==============================

class TestBranchDeleteKeepsCommits:
    async def test_delete_branch_keeps_commit_rows(self, test_user, async_db):
        """API 删分支：提交行保留（branch_id=NULL），仓库级历史不丢"""
        from app.services import branch_service

        repo = await _arepo(async_db, test_user, "del-keeps")
        branch = await _abranch(async_db, repo, "doomed")
        sha = "f" * 40
        await _acommit(async_db, repo, branch, sha)

        await branch_service.delete_branch(repo.id, "doomed", async_db)

        assert (
            await async_db.execute(
                select(Branch).where(
                    Branch.repository_id == repo.id, Branch.name == "doomed"
                )
            )
        ).scalar_one_or_none() is None
        kept = (
            await async_db.execute(select(Commit).where(Commit.hash == sha))
        ).scalar_one()
        assert kept.branch_id is None, "分支删除不得连带删除提交行（批3残留③）"
        assert kept.repository_id == repo.id

    async def test_delete_branch_with_commits_no_fk_violation(
        self, test_user, async_db
    ):
        """旧 schema（branch_id NOT NULL）下删已推送分支必 FK 违约 → 应正常完成"""
        from app.services import branch_service

        repo = await _arepo(async_db, test_user, "del-fk")
        branch = await _abranch(async_db, repo, "pushed")
        await _acommit(async_db, repo, branch, "1" * 40)
        await _acommit(async_db, repo, branch, "2" * 40)

        result = await branch_service.delete_branch(repo.id, "pushed", async_db)
        assert "successfully" in result["message"]

        remaining = (
            await async_db.execute(
                select(Commit).where(Commit.repository_id == repo.id)
            )
        ).scalars().all()
        assert len(remaining) == 2
        assert all(r.branch_id is None for r in remaining)

    async def test_repo_scoped_queries_unaffected(self, test_user, async_db):
        """仓库级查询仍返回孤儿提交；分支级查询不再包含（分支已删）"""
        from app.services import commit_service

        repo = await _arepo(async_db, test_user, "del-queries")
        keep_branch = await _abranch(async_db, repo, "keep")
        gone_branch = await _abranch(async_db, repo, "gone")
        await _acommit(async_db, repo, keep_branch, "3" * 40)
        await _acommit(async_db, repo, gone_branch, "4" * 40)

        await branch_service.delete_branch(repo.id, "gone", async_db)

        repo_commits = await commit_service.get_commits(repo.id, async_db)
        assert len(repo_commits) == 2, "仓库级历史应含已删分支的提交"

        branch_commits = await commit_service.get_commits_by_branch(
            keep_branch.id, async_db
        )
        assert len(branch_commits) == 1
        assert branch_commits[0].hash == "3" * 40

    def test_branch_deletion_via_api_no_500(self, test_client, db, test_user):
        """HTTP 层：owner 删除带提交的分支 → 200（回归 FK 违约 500）"""
        import pygit2

        from app.services.token_service import create_access_token
        from app.utils.git_utils import get_repository_storage_path, init_bare_repo

        repo = _srepo(db, test_user, "del-http")
        path = get_repository_storage_path(repo.path)
        init_bare_repo(path)
        bare = pygit2.Repository(path)
        blob = bare.create_blob(b"x\n")
        bld = bare.TreeBuilder()
        bld.insert("a.txt", blob, pygit2.GIT_FILEMODE_BLOB)
        tree = bld.write()
        sig = pygit2.Signature("T", "t@example.com")
        oid = bare.create_commit("refs/heads/main", sig, sig, "c1", tree, [])
        bare.create_commit("refs/heads/doomed", sig, sig, "c2", tree, [oid])

        branch = _sbranch(db, repo, "doomed")
        _scommit(db, repo, branch, str(oid))

        headers = {"Authorization": "Bearer " + create_access_token({
            "sub": str(test_user.id), "username": test_user.username,
            "is_admin": test_user.is_admin,
        })}
        r = test_client.delete(
            f"/api/v1/repositories/{repo.id}/branches/doomed", headers=headers
        )
        assert r.status_code == 200, r.text


# ============================== ③ 对账删分支（post-receive） ==============================

class TestReconcileKeepsCommits:
    @pytest.fixture(autouse=True)
    def _secret(self, monkeypatch):
        monkeypatch.setenv("KUSTOS_GIT_HOOK_SECRET", "test-git-hook-secret")

    def _post_receive(self, test_client, repo_path: str, ref: str, old: str, new: str):
        return test_client.post(
            "/api/v1/git-internal/post-receive",
            json={
                "repo_path": repo_path,
                "updates": [{"ref": ref, "old": old, "new": new, "is_force": False}],
            },
            headers={"X-Git-Hook-Secret": "test-git-hook-secret"},
        )

    @staticmethod
    def _bare_with_commit(path: str, ref: str = "refs/heads/main") -> str:
        import os

        import pygit2

        from app.utils.git_utils import init_bare_repo

        os.makedirs(os.path.dirname(path), exist_ok=True)
        init_bare_repo(path)
        bare = pygit2.Repository(path)
        blob = bare.create_blob(b"keep\n")
        bld = bare.TreeBuilder()
        bld.insert("k.txt", blob, pygit2.GIT_FILEMODE_BLOB)
        tree = bld.write()
        sig = pygit2.Signature("T", "t@example.com")
        return str(bare.create_commit(ref, sig, sig, "c", tree, []))

    def test_reconcile_branch_removed_keeps_commit_history(
        self, test_client, db, test_user
    ):
        """磁盘删分支 → 对账删分支行，但提交行保留（branch_id=NULL）

        注意：孤儿提交用**不在本次推送集合内**的 hash（否则会被「重建挂靠」
        逻辑挂到新分支——那是另一条路径，由 reattach 用例覆盖）。
        """
        from app.utils.git_utils import get_repository_storage_path

        repo = _srepo(db, test_user, "reconcile-keep")
        path = get_repository_storage_path(repo.path)
        sha_on_disk = self._bare_with_commit(path)
        # doomed 分支存在于 DB、磁盘上不存在 → 对账删除；其提交为仓内独有 hash
        branch = _sbranch(db, repo, "doomed")
        orphan_sha = "9" * 40
        _scommit(db, repo, branch, orphan_sha)

        r = self._post_receive(
            test_client, repo.path, "refs/heads/main", ZERO, sha_on_disk
        )
        assert r.status_code == 200, r.text
        assert r.json()["branches_removed"] == 1

        db.expire_all()  # 跨 session（HTTP 异步 session 已提交）→ 失效本地缓存
        kept = (
            db.execute(select(Commit).where(Commit.hash == orphan_sha))
        ).scalar_one_or_none()
        assert kept is not None, "对账删分支不得连带删除提交行（批3残留③）"
        assert kept.branch_id is None

    def test_repush_reattaches_orphan_commit(self, test_client, db, test_user):
        """分支重建后再推送同一提交 → 孤儿行（branch_id=NULL）重新挂靠"""
        from app.utils.git_utils import get_repository_storage_path

        repo = _srepo(db, test_user, "reconcile-reattach")
        path = get_repository_storage_path(repo.path)
        sha = self._bare_with_commit(path)
        # 孤儿行：分支已删、提交保留
        _scommit(db, repo, None, sha)
        # 重建 main 分支行 + 再推送
        _sbranch(db, repo, "main")

        r = self._post_receive(test_client, repo.path, "refs/heads/main", ZERO, sha)
        assert r.status_code == 200, r.text

        db.expire_all()
        refreshed = (
            db.execute(select(Commit).where(Commit.hash == sha))
        ).scalar_one()
        assert refreshed.branch_id is not None, "重建分支后应重新挂靠孤儿提交"
        attached = (
            db.execute(select(Branch).where(Branch.id == refreshed.branch_id))
        ).scalar_one()
        assert attached.name == "main"
