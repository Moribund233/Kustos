"""pgvector 向量列类型（PostgreSQL-only）。

不依赖 ``pgvector`` Python 包（用 UserDefinedType 直接发 ``vector(dim)``），
因此无需为模型侧新增依赖；仅要求 PostgreSQL 安装 pgvector 扩展。
"""
from __future__ import annotations

from sqlalchemy.types import UserDefinedType

VECTOR_DIM = 1536


class PgVector(UserDefinedType):
    """pgvector 的 ``vector(dim)`` 类型"""
    cache_ok = True

    def __init__(self, dim: int = VECTOR_DIM):
        self.dim = dim

    def get_col_spec(self, **kw) -> str:
        return f"vector({self.dim})"

    def bind_processor(self, dialect):
        def _to_literal(value):
            if value is None:
                return None
            return "[" + ",".join(repr(float(x)) for x in value) + "]"
        return _to_literal

    def result_processor(self, dialect, coltype):
        def _from_literal(value):
            if value is None:
                return None
            s = value.strip()
            if s.startswith("[") and s.endswith("]"):
                s = s[1:-1]
            if not s:
                return []
            return [float(x) for x in s.split(",")]
        return _from_literal
