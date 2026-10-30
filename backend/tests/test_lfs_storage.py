"""LFS 存储后端测试"""
import os
import uuid
import pytest
import tempfile
import shutil
from app.services.lfs.lfs_storage import LocalFSStorage, LFSStorageBackend


@pytest.fixture
def temp_lfs_path():
    """创建临时 LFS 存储目录"""
    path = tempfile.mkdtemp()
    yield path
    shutil.rmtree(path)


@pytest.fixture
def local_storage(temp_lfs_path):
    """创建本地存储实例"""
    return LocalFSStorage(temp_lfs_path, repo_id=uuid.uuid4())


class TestLocalFSStorage:
    @pytest.mark.asyncio
    async def test_upload_and_download(self, local_storage: LocalFSStorage):
        oid = "sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"
        data = b"Hello, LFS world!"
        await local_storage.upload(oid, data)
        result = await local_storage.download(oid)
        assert result == data

    @pytest.mark.asyncio
    async def test_upload_large_file(self, local_storage: LocalFSStorage):
        oid = "sha256:large_file_test"
        data = os.urandom(1024 * 1024)  # 1MB
        await local_storage.upload(oid, data)
        result = await local_storage.download(oid)
        assert result == data

    @pytest.mark.asyncio
    async def test_delete(self, local_storage: LocalFSStorage):
        oid = "sha256:delete_test"
        data = b"Delete me"
        await local_storage.upload(oid, data)
        assert await local_storage.exists(oid) is True
        await local_storage.delete(oid)
        assert await local_storage.exists(oid) is False

    @pytest.mark.asyncio
    async def test_exists_true(self, local_storage: LocalFSStorage):
        oid = "sha256:exists_test"
        await local_storage.upload(oid, b"exists")
        assert await local_storage.exists(oid) is True

    @pytest.mark.asyncio
    async def test_exists_false(self, local_storage: LocalFSStorage):
        assert await local_storage.exists("sha256:nonexistent") is False

    @pytest.mark.asyncio
    async def test_download_nonexistent(self, local_storage: LocalFSStorage):
        with pytest.raises(FileNotFoundError):
            await local_storage.download("sha256:nonexistent")

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, local_storage: LocalFSStorage):
        # Should not raise
        await local_storage.delete("sha256:nonexistent")

    @pytest.mark.asyncio
    async def test_storage_path_structure(self, local_storage: LocalFSStorage):
        oid = "sha256:abcdef1234567890"
        await local_storage.upload(oid, b"data")
        # 验证新布局: base/{repo_id}/objects/前2位/2-4位/完整oid（repo 维度 + objects 段）
        expected_path = local_storage.base_path / "objects" / "ab" / "cd" / "abcdef1234567890"
        assert os.path.exists(expected_path)
        # 路径必须带仓库维度：换一个 repo_id 的实例取不到该对象
        other = LocalFSStorage(str(local_storage.base_path.parent),
                               repo_id=uuid.uuid4())
        assert await other.exists(oid) is False

    @pytest.mark.asyncio
    async def test_legacy_layout_read_fallback(self, local_storage: LocalFSStorage):
        """迁移窗口内：旧布局 {base}/{repo_id}/ab/cd/oid 仍可读，新写入走新布局"""
        oid = "sha256:legacy_object"
        hash_hex = oid.split(":", 1)[-1]
        legacy = local_storage.base_path / hash_hex[:2] / hash_hex[2:4] / hash_hex
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_bytes(b"legacy bytes")

        # 读回退
        assert await local_storage.exists(oid) is True
        assert await local_storage.download(oid) == b"legacy bytes"
        assert await local_storage.size(oid) == len(b"legacy bytes")

        # 写一律落新布局（不写旧路径）
        await local_storage.upload(oid, b"new bytes")
        new = local_storage.base_path / "objects" / hash_hex[:2] / hash_hex[2:4] / hash_hex
        assert new.exists() and new.read_bytes() == b"new bytes"
        # 新布局优先
        assert await local_storage.download(oid) == b"new bytes"

        # 删除把新旧布局一并清理
        assert await local_storage.delete(oid) is True
        assert await local_storage.exists(oid) is False
        assert not legacy.exists()

    @pytest.mark.asyncio
    async def test_size(self, local_storage: LocalFSStorage):
        oid = "sha256:size_local"
        await local_storage.upload(oid, b"1234")
        assert await local_storage.size(oid) == 4
        with pytest.raises(FileNotFoundError):
            await local_storage.size("sha256:size_absent_local")


class TestStorageInterface:
    def test_implements_interface(self, local_storage: LocalFSStorage):
        assert isinstance(local_storage, LFSStorageBackend)


class TestS3KeyLayout:
    """S3 对象键布局（纯函数，不依赖 S3 服务）"""

    @pytest.fixture
    def s3_storage(self):
        from app.services.lfs.lfs_storage import S3Storage
        return S3Storage(
            bucket="test-lfs", endpoint="http://localhost:9000",
            access_key="a", secret_key="s", repo_id=uuid.uuid4(),
        )

    def test_key_includes_repo_dimension(self, s3_storage):
        """对象键必须带 repo 维度，否则跨仓 oid 即可寻址"""
        key = s3_storage._get_key("sha256:abcdef")
        assert key == (f"lfs/{s3_storage.repo_id}/objects/"
                       f"ab/cd/abcdef")

    def test_requires_repo_id(self):
        from app.services.lfs.lfs_storage import S3Storage
        with pytest.raises(ValueError, match="repo_id"):
            S3Storage(bucket="b", endpoint="http://x", access_key="a", secret_key="s")


class TestS3Storage:
    """S3 存储测试 (需要运行中的 S3/MinIO)"""
    pytestmark = pytest.mark.skipif(
        not os.environ.get("S3_ENDPOINT"),
        reason="S3 not configured"
    )

    @pytest.fixture
    def s3_storage(self):
        from app.services.lfs.lfs_storage import S3Storage
        return S3Storage(
            bucket=os.environ.get("S3_BUCKET", "test-lfs"),
            endpoint=os.environ.get("S3_ENDPOINT"),
            access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
            secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
            repo_id=uuid.uuid4(),
        )

    @pytest.mark.asyncio
    async def test_upload_and_download(self, s3_storage):
        oid = "sha256:s3_test_object"
        data = b"S3 storage test"
        await s3_storage.upload(oid, data)
        result = await s3_storage.download(oid)
        assert result == data

    @pytest.mark.asyncio
    async def test_exists(self, s3_storage):
        oid = "sha256:s3_exists_test"
        assert await s3_storage.exists(oid) is False
        await s3_storage.upload(oid, b"data")
        assert await s3_storage.exists(oid) is True

    @pytest.mark.asyncio
    async def test_delete(self, s3_storage):
        oid = "sha256:s3_delete_test"
        await s3_storage.upload(oid, b"data")
        await s3_storage.delete(oid)
        assert await s3_storage.exists(oid) is False