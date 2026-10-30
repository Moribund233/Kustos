"""LFS 业务逻辑层

只负责对象本身（上传/下载/删除/校验）；**授权与 HTTP 形状
（batch 响应、transfer token）在 controller 层**——服务层不接触凭证，
也不拼 href（收口后的分层约定）。
"""
from typing import Any

from app.services.lfs.lfs_storage import LFSStorageBackend


class LFSService:
    """LFS 服务"""

    def __init__(self, storage: LFSStorageBackend):
        self.storage = storage

    async def upload(self, oid: str, data: bytes) -> dict[str, Any]:
        """
        上传 LFS 对象

        Args:
            oid: 对象 ID (sha256:xxx)
            data: 文件数据

        Returns:
            dict: 上传结果
        """
        await self.storage.upload(oid, data)
        return {"oid": oid, "size": len(data)}

    async def download(self, oid: str) -> bytes:
        """
        下载 LFS 对象

        Args:
            oid: 对象 ID

        Returns:
            bytes: 文件数据
        """
        return await self.storage.download(oid)

    async def delete(self, oid: str) -> bool:
        """
        删除 LFS 对象

        Args:
            oid: 对象 ID

        Returns:
            bool: 是否成功删除
        """
        return await self.storage.delete(oid)

    async def exists(self, oid: str) -> bool:
        """
        检查对象是否存在

        Args:
            oid: 对象 ID

        Returns:
            bool: 是否存在
        """
        return await self.storage.exists(oid)

    async def size(self, oid: str) -> int:
        """
        对象字节数

        Args:
            oid: 对象 ID

        Returns:
            int: 对象大小（字节）

        Raises:
            FileNotFoundError: 对象不存在
        """
        return await self.storage.size(oid)

    async def verify(self, oid: str, data: bytes) -> bool:
        """
        验证对象完整性

        Args:
            oid: 对象 ID
            data: 验证数据

        Returns:
            bool: 数据是否匹配
        """
        try:
            stored = await self.storage.download(oid)
            return stored == data
        except FileNotFoundError:
            return False

    async def verify_upload(self, oid: str, size: int | None = None) -> bool:
        """
        上传后校验（LFS ``verify`` 传输动作）：对象已落盘且大小一致

        Args:
            oid: 对象 ID
            size: 客户端声明的大小；None 时只校验存在性

        Returns:
            bool: 是否通过
        """
        if not await self.storage.exists(oid):
            return False
        if size is None:
            return True
        try:
            stored_size = await self.storage.size(oid)
        except FileNotFoundError:
            return False
        return stored_size == int(size)
