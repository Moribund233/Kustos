"""user devices

新增 ``user_devices``：登录设备登记。refresh 家族的吊销单元此前只有
family_id，用户无法辨认"这一条会话是哪台机器"，也就无法定向登出某台设备。

同用户同 ``device_id`` 唯一，重新登录覆盖既有记录；``family_id`` 加索引
供"按 family 定向吊销"与刷新时回填 ``last_seen_at`` 使用。

Revision ID: 0003_user_devices
Revises: 0002_pr_issue_review_links
Create Date: 2026-11-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0003_user_devices'
down_revision: Union[str, Sequence[str], None] = '0002_pr_issue_review_links'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'user_devices',
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('device_id', sa.String(length=64), nullable=False),
        sa.Column('device_name', sa.String(length=128), nullable=False),
        sa.Column('platform', sa.String(length=32), nullable=True),
        sa.Column('family_id', sa.String(length=64), nullable=False),
        sa.Column('last_ip', sa.String(length=64), nullable=True),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_user_devices_id'), 'user_devices', ['id'], unique=False)
    op.create_index(op.f('ix_user_devices_user_id'), 'user_devices', ['user_id'], unique=False)
    op.create_index('uq_user_devices_device', 'user_devices', ['user_id', 'device_id'], unique=True)
    op.create_index('ix_user_devices_family', 'user_devices', ['family_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_user_devices_family', table_name='user_devices')
    op.drop_index('uq_user_devices_device', table_name='user_devices')
    op.drop_index(op.f('ix_user_devices_user_id'), table_name='user_devices')
    op.drop_index(op.f('ix_user_devices_id'), table_name='user_devices')
    op.drop_table('user_devices')
