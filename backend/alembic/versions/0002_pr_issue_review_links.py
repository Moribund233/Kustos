"""pr issue links and review requests

补齐两个此前只在产品侧存在、后端缺失的能力：

1. ``pull_request_issue_links``：PR ↔ Issue 关联（合并即关闭 Issue 的依据）
2. ``pr_review_requests``：评审请求（requested reviewer），与已提交的
   ``pr_reviews`` 分开存，state 由评审推导

Revision ID: 0002_pr_issue_review_links
Revises: 0001_initial
Create Date: 2026-10-28

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0002_pr_issue_review_links'
down_revision: Union[str, Sequence[str], None] = '0001_initial'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'pull_request_issue_links',
        sa.Column('pull_request_id', sa.Uuid(), nullable=False),
        sa.Column('issue_id', sa.Uuid(), nullable=False),
        sa.Column('created_by', sa.Uuid(), nullable=True),
        sa.Column('closes_on_merge', sa.Boolean(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
        sa.ForeignKeyConstraint(['issue_id'], ['issues.id'], ),
        sa.ForeignKeyConstraint(['pull_request_id'], ['pull_requests.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('pull_request_id', 'issue_id', name='uq_pr_issue_link'),
    )
    op.create_index(op.f('ix_pull_request_issue_links_id'), 'pull_request_issue_links', ['id'], unique=False)
    op.create_index(op.f('ix_pull_request_issue_links_issue_id'), 'pull_request_issue_links', ['issue_id'], unique=False)

    op.create_table(
        'pr_review_requests',
        sa.Column('pull_request_id', sa.Uuid(), nullable=False),
        sa.Column('reviewer_id', sa.Uuid(), nullable=False),
        sa.Column('requested_by', sa.Uuid(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['pull_request_id'], ['pull_requests.id'], ),
        sa.ForeignKeyConstraint(['requested_by'], ['users.id'], ),
        sa.ForeignKeyConstraint(['reviewer_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('pull_request_id', 'reviewer_id', name='uq_pr_review_request'),
    )
    op.create_index(op.f('ix_pr_review_requests_id'), 'pr_review_requests', ['id'], unique=False)
    op.create_index(op.f('ix_pr_review_requests_reviewer_id'), 'pr_review_requests', ['reviewer_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_pr_review_requests_reviewer_id'), table_name='pr_review_requests')
    op.drop_index(op.f('ix_pr_review_requests_id'), table_name='pr_review_requests')
    op.drop_table('pr_review_requests')
    op.drop_index(op.f('ix_pull_request_issue_links_issue_id'), table_name='pull_request_issue_links')
    op.drop_index(op.f('ix_pull_request_issue_links_id'), table_name='pull_request_issue_links')
    op.drop_table('pull_request_issue_links')
