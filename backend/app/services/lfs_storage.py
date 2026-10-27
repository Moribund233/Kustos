"""LFS 存储后端抽象层"""
import os
from abc import ABC, abstractmethod
from pathlib import Path
import uuid

import aiofiles
import aiofiles.os


class LFSStorageBackend(ABC):
    """LFS 存储后端抽象基类"""

    @abstractmethod
    async def upload(self, oid: str, data: bytes) -> str:
        """
        上传对象

        Args:
            oid: 对象 ID (sha256:xxx)
            data: 文件数据

        Returns:
            str: 存储路径
        """

    @abstractmethod
    async def download(self, oid: str) -> bytes:
        """
        下载对象

        Args:
            oid: 对象 ID

        Returns:
            bytes: 文件数据

        Raises:
            FileNotFoundError: 对象不存在
        """

    @abstractmethod
    async def delete(self, oid: str) -> bool:
        """
        删除对象

        Args:
            oid: 对象 ID

        Returns:
            bool: 是否成功删除
        """

    @abstractmethod
    async def exists(self, oid: str) -> bool:
        """
        检查对象是否存在

        Args:
            oid: 对象 ID

        Returns:
            bool: 是否存在
        """

    @abstractmethod
    async def size(self, oid: str) -> int:
        """
        对象字节数（供 LFS verify 端点做 size 比对）

        Args:
            oid: 对象 ID

        Returns:
            int: 对象大小（字节）

        Raises:
            FileNotFoundError: 对象不存在
        """


class LocalFSStorage(LFSStorageBackend):
    """本地文件系统存储

    存储路径带 **repo 维度**::

        {base_path}/{repo_id}/objects/ab/cd/{oid}      # 新布局（写入一律走这里）
        {base_path}/{repo_id}/ab/cd/{oid}              # 旧布局（读兼容期回退）

    引入本类时即已按 repo 分目录，因此不存在「全局共享目录」的历史数据；
    旧布局的读回退只覆盖 ``objects/`` 段落位前写入的存量对象，
    ``scripts/migrate_lfs_layout.py`` 可幂等迁移，迁移完成后删除回退。
    """

    def __init__(self, base_path: str, repo_id: uuid.UUID):
        self.base_path = Path(base_path) / str(repo_id)

    @staticmethod
    def _hash_hex(oid: str) -> str:
        # 移除 sha256: 前缀
        hash_hex = oid.split(":", 1)[-1] if ":" in oid else oid
        if len(hash_hex) < 4:
            hash_hex = hash_hex.ljust(4, "0")
        return hash_hex

    def _get_path(self, oid: str) -> Path:
        """新布局: {base}/{repo_id}/objects/ab/cd/abcdef..."""
        hash_hex = self._hash_hex(oid)
        return self.base_path / "objects" / hash_hex[:2] / hash_hex[2:4] / hash_hex

    def _get_legacy_path(self, oid: str) -> Path:
        """旧布局: {base}/{repo_id}/ab/cd/abcdef...（仅读/删兼容）"""
        hash_hex = self._hash_hex(oid)
        return self.base_path / hash_hex[:2] / hash_hex[2:4] / hash_hex

    def _resolve(self, oid: str) -> Path:
        """读取目标：新布局优先，miss 回退旧布局（迁移窗口内下载不失败）"""
        path = self._get_path(oid)
        if path.exists():
            return path
        legacy = self._get_legacy_path(oid)
        return legacy if legacy.exists() else path

    async def upload(self, oid: str, data: bytes) -> str:
        # 写一律走新布局（兼容期内不写旧路径）
        path = self._get_path(oid)
        await aiofiles.os.makedirs(path.parent, exist_ok=True)
        async with aiofiles.open(path, "wb") as f:
            await f.write(data)
        return str(path)

    async def download(self, oid: str) -> bytes:
        path = self._resolve(oid)
        if not path.exists():
            raise FileNotFoundError(f"LFS object not found: {oid}")
        async with aiofiles.open(path, "rb") as f:
            return await f.read()

    async def delete(self, oid: str) -> bool:
        # 新旧布局一并清理，避免迁移窗口内残留可读副本
        deleted = False
        for path in {self._get_path(oid), self._get_legacy_path(oid)}:
            if path.exists():
                await aiofiles.os.remove(path)
                deleted = True
        return deleted

    async def exists(self, oid: str) -> bool:
        return self._resolve(oid).exists()

    async def size(self, oid: str) -> int:
        path = self._resolve(oid)
        if not path.exists():
            raise FileNotFoundError(f"LFS object not found: {oid}")
        return path.stat().st_size


class S3Storage(LFSStorageBackend):
    """S3/MinIO 存储"""

    def __init__(
        self,
        bucket: str,
        endpoint: str,
        access_key: str,
        secret_key: str,
        region: str = "us-east-1",
        repo_id: uuid.UUID | None = None,
    ):
        self.bucket = bucket
        self.endpoint = endpoint
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        #: 对象键必须带 repo 维度，否则跨仓 oid 即可寻址
        if repo_id is None:
            raise ValueError("S3Storage requires repo_id (repo-scoped object keys)")
        self.repo_id = repo_id
        self._session = None

    async def _get_client(self):
        if self._session is None:
            try:
                import aioboto3
                self._session = aioboto3.Session()
            except ImportError:
                raise ImportError("aioboto3 is required for S3 storage. Install with: pip install aioboto3")
        return self._session.client(
            "s3",
            endpoint_url=self.endpoint,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            region_name=self.region,
        )

    def _get_key(self, oid: str) -> str:
        hash_hex = oid.split(":", 1)[-1] if ":" in oid else oid
        return f"lfs/{self.repo_id}/objects/{hash_hex[:2]}/{hash_hex[2:4]}/{hash_hex}"

    async def upload(self, oid: str, data: bytes) -> str:
        client = await self._get_client()
        key = self._get_key(oid)
        async with client as s3:
            await s3.put_object(Bucket=self.bucket, Key=key, Body=data)
        return key

    async def download(self, oid: str) -> bytes:
        client = await self._get_client()
        key = self._get_key(oid)
        async with client as s3:
            try:
                response = await s3.get_object(Bucket=self.bucket, Key=key)
                return await response["Body"].read()
            except client.exceptions.NoSuchKey:
                raise FileNotFoundError(f"LFS object not found: {oid}")

    async def delete(self, oid: str) -> bool:
        from botocore.exceptions import ClientError
        client = await self._get_client()
        key = self._get_key(oid)
        async with client as s3:
            try:
                await s3.delete_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError as e:
                if e.response['Error']['Code'] == 'NoSuchKey':
                    return False
                raise

    async def exists(self, oid: str) -> bool:
        from botocore.exceptions import ClientError
        client = await self._get_client()
        key = self._get_key(oid)
        async with client as s3:
            try:
                await s3.head_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError as e:
                if e.response['Error']['Code'] == '404':
                    return False
                raise

    async def size(self, oid: str) -> int:
        from botocore.exceptions import ClientError
        client = await self._get_client()
        key = self._get_key(oid)
        async with client as s3:
            try:
                head = await s3.head_object(Bucket=self.bucket, Key=key)
                return int(head["ContentLength"])
            except ClientError as e:
                if e.response['Error']['Code'] in ('404', 'NoSuchKey'):
                    raise FileNotFoundError(f"LFS object not found: {oid}")
                raise