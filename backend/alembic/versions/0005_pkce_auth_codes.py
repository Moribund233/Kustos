"""pkce authorization codes

新增 ``pkce_authorization_codes``：桌面端 PKCE 授权码流的临时凭证表。

桌面端在 SSO/2FA 环境下无法在应用内输密码，只能被迫开浏览器。PKCE 让登录
交给系统浏览器，桌面端凭一次性授权码 + 自己生成的 code_verifier 换令牌。

服务端**只存** ``SHA256(verifier)``：即使授权码在深链回跳中泄漏，没有
verifier 也换不出令牌。``redirect_uri`` 与 ``client_id`` 一并绑定，换令牌时
必须一致，防止授权码被引导到任意地址。

Revision ID: 0005_pkce_auth_codes
Revises: 0004_idempotency_records
Create Date: 2026-11-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0005_pkce_auth_codes'
down_revision: Union[str, Sequence[str], None] = '0004_idempotency_records'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'pkce_authorization_codes',
        sa.Column('code', sa.String(length=128), nullable=False),
        sa.Column('client_id', sa.String(length=64), nullable=False),
        sa.Column('redirect_uri', sa.String(length=500), nullable=False),
        sa.Column('code_challenge', sa.String(length=128), nullable=False),
        sa.Column('code_challenge_method', sa.String(length=16), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_pkce_authorization_codes_id'), 'pkce_authorization_codes', ['id'], unique=False)
    op.create_index(op.f('ix_pkce_authorization_codes_user_id'), 'pkce_authorization_codes', ['user_id'], unique=False)
    op.create_index('ix_pkce_codes_code', 'pkce_authorization_codes', ['code'], unique=True)
    op.create_index('ix_pkce_codes_expires_at', 'pkce_authorization_codes', ['expires_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_pkce_codes_expires_at', table_name='pkce_authorization_codes')
    op.drop_index('ix_pkce_codes_code', table_name='pkce_authorization_codes')
    op.drop_index(op.f('ix_pkce_authorization_codes_user_id'), table_name='pkce_authorization_codes')
    op.drop_index(op.f('ix_pkce_authorization_codes_id'), table_name='pkce_authorization_codes')
    op.drop_table('pkce_authorization_codes')
