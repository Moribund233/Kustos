"""协作文档标识（docKey）的构造与解析。

docKey 形如 ``repository_id:branch:path``，是 Yjs 网关与 app 之间唯一的文档
标识。路径本身可能含冒号，因此只按前两段切分，剩余部分整体作为路径。
"""

from typing import Tuple
from uuid import UUID

from app.core.exception import ValidationException


def make_doc_key(repository_id: str, branch: str, path: str) -> str:
    """文档标识: 仓库:分支:路径"""
    return f"{repository_id}:{branch}:{path}"


def parse_doc_key(doc_key: str) -> Tuple[UUID, str, str]:
    """
    解析 docKey 为 (repository_id, branch, path)

    Raises:
        ValidationException: 格式非法
    """
    parts = str(doc_key or "").split(":")
    if len(parts) < 3 or not parts[0].strip() or not parts[1].strip():
        raise ValidationException(
            detail="docKey 格式非法, 应为 repository_id:branch:path",
            error_code="collab_invalid_dockey",
        )
    try:
        repository_id = UUID(parts[0].strip())
    except (ValueError, AttributeError, TypeError):
        raise ValidationException(
            detail="docKey 中 repository_id 非法",
            error_code="collab_invalid_repository_id",
        )
    branch = parts[1].strip()
    path = ":".join(parts[2:]).strip().lstrip("/")
    if not branch or not path:
        raise ValidationException(
            detail="docKey 中 branch/path 不能为空",
            error_code="collab_dockey_missing_parts",
        )
    return repository_id, branch, path


def draft_branch_name(branch: str) -> str:
    """协作草稿分支名: 每个工作分支对应一个草稿分支

    协作保存一律落草稿分支, 工作分支只在显式发布时产生提交。
    """
    return f"collab/draft-{branch}"
