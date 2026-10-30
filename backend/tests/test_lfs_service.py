"""LFS 服务层测试"""
import pytest
import uuid
import tempfile
import shutil
from unittest.mock import AsyncMock, patch

from app.services.lfs.lfs_service import LFSService
from app.services.lfs.lfs_storage import LocalFSStorage


@pytest.fixture
def temp_lfs_path():
    path = tempfile.mkdtemp()
    yield path
    shutil.rmtree(path)


@pytest.fixture
def lfs_service(temp_lfs_path):
    storage = LocalFSStorage(temp_lfs_path, repo_id=uuid.uuid4())
    return LFSService(storage)


class TestLFSService:
    @pytest.mark.asyncio
    async def test_upload_object(self, lfs_service: LFSService):
        oid = "sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"
        data = b"Hello, LFS!"
        result = await lfs_service.upload(oid, data)
        assert result["oid"] == oid
        assert result["size"] == len(data)

    @pytest.mark.asyncio
    async def test_download_object(self, lfs_service: LFSService):
        oid = "sha256:download_test"
        data = b"Download me"
        await lfs_service.upload(oid, data)
        result = await lfs_service.download(oid)
        assert result == data

    @pytest.mark.asyncio
    async def test_delete_object(self, lfs_service: LFSService):
        oid = "sha256:delete_test"
        await lfs_service.upload(oid, b"data")
        result = await lfs_service.delete(oid)
        assert result is True
        assert await lfs_service.exists(oid) is False

    @pytest.mark.asyncio
    async def test_exists(self, lfs_service: LFSService):
        oid = "sha256:exists_test"
        assert await lfs_service.exists(oid) is False
        await lfs_service.upload(oid, b"data")
        assert await lfs_service.exists(oid) is True

    @pytest.mark.asyncio
    async def test_verify_valid(self, lfs_service: LFSService):
        oid = "sha256:verify_test"
        data = b"Verify me"
        await lfs_service.upload(oid, data)
        result = await lfs_service.verify(oid, data)
        assert result is True

    @pytest.mark.asyncio
    async def test_verify_invalid(self, lfs_service: LFSService):
        oid = "sha256:verify_invalid"
        await lfs_service.upload(oid, b"original")
        result = await lfs_service.verify(oid, b"different")
        assert result is False

    @pytest.mark.asyncio
    async def test_verify_upload_ok(self, lfs_service: LFSService):
        oid = "sha256:verify_upload_ok"
        await lfs_service.upload(oid, b"123456")
        assert await lfs_service.verify_upload(oid, 6) is True
        # 不带 size 只校验存在性
        assert await lfs_service.verify_upload(oid) is True

    @pytest.mark.asyncio
    async def test_verify_upload_size_mismatch(self, lfs_service: LFSService):
        oid = "sha256:verify_upload_bad"
        await lfs_service.upload(oid, b"123456")
        assert await lfs_service.verify_upload(oid, 99) is False

    @pytest.mark.asyncio
    async def test_verify_upload_missing(self, lfs_service: LFSService):
        assert await lfs_service.verify_upload("sha256:absent", 1) is False

    @pytest.mark.asyncio
    async def test_size(self, lfs_service: LFSService):
        oid = "sha256:size_test"
        await lfs_service.upload(oid, b"size-check")
        assert await lfs_service.size(oid) == 10
        with pytest.raises(FileNotFoundError):
            await lfs_service.size("sha256:size_absent")
