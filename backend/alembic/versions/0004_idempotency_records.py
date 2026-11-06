"""idempotency records

新增 ``idempotency_records``：客户端在请求头携带 ``Idempotency-Key`` 时，
服务端把首次执行的结果存下来，同一键再次到达直接重放，不产生第二个副作用。

桌面端的离线 outbox 要能"自动补发"而不是只能存草稿，前提就是这张表——没有
幂等键，重发一条评论会真的创建两条。

作用域是 ``(user_id, scope, key)``：键由客户端自选，跨用户撞车是常态；``scope``
为 ``METHOD path``，避免同一键被复用到别的端点。``fingerprint`` 是请求体摘要，
同键不同体时服务端报冲突而不是重放，避免掩盖客户端 bug。

Revision ID: 0004_idempotency_records
Revises: 0003_user_devices
Create Date: 2026-11-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0004_idempotency_records'
down_revision: Union[str, Sequence[str], None] = '0003_user_devices'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'idempotency_records',
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('scope', sa.String(length=255), nullable=False),
        sa.Column('key', sa.String(length=255), nullable=False),
        sa.Column('fingerprint', sa.String(length=64), nullable=False),
        sa.Column('status_code', sa.Integer(), nullable=False),
        sa.Column('response_body', sa.JSON(), nullable=True),
        sa.Column('resource_id', sa.Text(), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'scope', 'key', name='uq_idempotency_user_scope_key'),
    )
    op.create_index(op.f('ix_idempotency_records_id'), 'idempotency_records', ['id'], unique=False)
    op.create_index(op.f('ix_idempotency_records_user_id'), 'idempotency_records', ['user_id'], unique=False)
    op.create_index('ix_idempotency_created_at', 'idempotency_records', ['created_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_idempotency_created_at', table_name='idempotency_records')
    op.drop_index(op.f('ix_idempotency_records_user_id'), table_name='idempotency_records')
    op.drop_index(op.f('ix_idempotency_records_id'), table_name='idempotency_records')
    op.drop_table('idempotency_records')
