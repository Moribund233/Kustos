import uuid
from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


def _get_or_create_user(db: Session):
    from app.models.user import User
    user = db.query(User).first()
    if user is None:
        user = User(
            username="autotest_user",
            email="autotest@example.com",
            password="hashed",
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


async def _async_get_or_create_user(db: AsyncSession):
    from app.models.user import User
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            username="async_autotest_user",
            email="async_autotest@example.com",
            password="hashed",
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user


def create_test_user(db: Session, username: str = "otheruser", is_admin: bool = False):
    """创建独立测试用户（与 fixture 的 test_user 区分，用于"非本人"场景）"""
    from app.models.user import User

    user = User(
        username=username,
        email=f"{username}@example.com",
        password="hashed_password_string",
        full_name=username.title(),
        is_active=True,
        is_admin=is_admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def create_test_repo(
    db: Session,
    name: str = "test-repo",
    owner_id: Optional[uuid.UUID] = None,
    path: Optional[str] = None,
    is_public: bool = True,
) -> "Repository":
    from app.models.repository import Repository

    if owner_id is None:
        owner_id = _get_or_create_user(db).id

    if path is None:
        path = name

    repo = Repository(
        name=name,
        path=path,
        owner_id=owner_id,
        is_public=is_public,
    )
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


async def async_create_test_repo(
    db: AsyncSession,
    name: str = "async-test-repo",
    owner_id: Optional[uuid.UUID] = None,
    path: Optional[str] = None,
    is_public: bool = True,
) -> "Repository":
    from app.models.repository import Repository

    if owner_id is None:
        user = await _async_get_or_create_user(db)
        owner_id = user.id

    if path is None:
        path = name

    repo = Repository(
        name=name,
        path=path,
        owner_id=owner_id,
        is_public=is_public,
    )
    db.add(repo)
    await db.commit()
    await db.refresh(repo)
    return repo


def create_test_issue(
    db: Session,
    repo_id: uuid.UUID,
    issue_number: int,
    title: str,
    status: str = "open",
    priority: str = "medium",
    author_id: Optional[uuid.UUID] = None,
    assignee_id: Optional[uuid.UUID] = None,
    labels: Optional[list] = None,
) -> "Issue":
    from app.models.issue import Issue

    if author_id is None:
        author_id = _get_or_create_user(db).id

    issue = Issue(
        repository_id=repo_id,
        issue_number=issue_number,
        title=title,
        status=status,
        priority=priority,
        author_id=author_id,
        assignee_id=assignee_id,
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)

    if labels:
        from app.models.issue import issue_label_association
        for label in labels:
            db.execute(
                issue_label_association.insert().values(
                    issue_id=issue.id, label_id=label.id
                )
            )
        db.commit()

    return issue


async def async_create_test_issue(
    db: AsyncSession,
    repo_id: uuid.UUID,
    issue_number: int,
    title: str,
    status: str = "open",
    priority: str = "medium",
    author_id: Optional[uuid.UUID] = None,
    assignee_id: Optional[uuid.UUID] = None,
    labels: Optional[list] = None,
) -> "Issue":
    from app.models.issue import Issue, issue_label_association

    if author_id is None:
        user = await _async_get_or_create_user(db)
        author_id = user.id

    issue = Issue(
        repository_id=repo_id,
        issue_number=issue_number,
        title=title,
        status=status,
        priority=priority,
        author_id=author_id,
        assignee_id=assignee_id,
    )
    db.add(issue)
    await db.commit()
    await db.refresh(issue)

    if labels:
        for label in labels:
            await db.execute(
                issue_label_association.insert().values(
                    issue_id=issue.id, label_id=label.id
                )
            )
        await db.commit()

    return issue


def create_test_pr(
    db: Session,
    repo_id: uuid.UUID,
    pr_number: int,
    title: str,
    status: str = "open",
    author_id: Optional[uuid.UUID] = None,
    description: Optional[str] = None,
) -> "PullRequest":
    from app.models.pull_request import PullRequest

    if author_id is None:
        author_id = _get_or_create_user(db).id

    pr = PullRequest(
        repository_id=repo_id,
        pr_number=pr_number,
        title=title,
        description=description,
        source_branch="feature/test",
        target_branch="main",
        status=status,
        author_id=author_id,
    )
    db.add(pr)
    db.commit()
    db.refresh(pr)
    return pr


async def async_create_test_pr(
    db: AsyncSession,
    repo_id: uuid.UUID,
    pr_number: int,
    title: str,
    status: str = "open",
    author_id: Optional[uuid.UUID] = None,
    description: Optional[str] = None,
) -> "PullRequest":
    from app.models.pull_request import PullRequest

    if author_id is None:
        user = await _async_get_or_create_user(db)
        author_id = user.id

    pr = PullRequest(
        repository_id=repo_id,
        pr_number=pr_number,
        title=title,
        description=description,
        source_branch="feature/test",
        target_branch="main",
        status=status,
        author_id=author_id,
    )
    db.add(pr)
    await db.commit()
    await db.refresh(pr)
    return pr


def create_test_label(
    db: Session,
    repo_id: uuid.UUID,
    name: str,
    color: str = "#ff0000",
) -> "Label":
    from app.models.issue import Label

    label = Label(
        repository_id=repo_id,
        name=name,
        color=color,
    )
    db.add(label)
    db.commit()
    db.refresh(label)
    return label


async def async_create_test_label(
    db: AsyncSession,
    repo_id: uuid.UUID,
    name: str,
    color: str = "#ff0000",
) -> "Label":
    from app.models.issue import Label

    label = Label(
        repository_id=repo_id,
        name=name,
        color=color,
    )
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return label


# ---------------------------------------------------------------------------
# LFS：batch → transfer token 辅助
# ---------------------------------------------------------------------------

def lfs_batch(client, repo_id, operation, objects, auth_headers=None):
    """
    调用 LFS batch 并抽取签发出的短时效 transfer token。

    batch 是**唯一**接受用户凭证（Bearer / Basic）的入口；传输端点
    （upload/download/verify/delete）只认它返回的 token。

    Returns:
        (data, transfer_headers)：transfer_headers 为传输端点需携带的头；
        若本批所有对象都没有下发动作（对象已存在 / 不存在），则为 None。
    """
    response = client.post(
        f"/api/v1/repositories/{repo_id}/lfs/objects/batch",
        json={"operation": operation, "objects": objects},
        headers=auth_headers or {},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    for obj in data.get("objects", []):
        for action in (obj.get("actions") or {}).values():
            if isinstance(action, dict) and action.get("header"):
                return data, dict(action["header"])
    return data, None
