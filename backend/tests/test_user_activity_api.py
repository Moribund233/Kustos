"""
跨仓库动态流

覆盖 ``GET /users/me/activity``：只返回当前用户可访问仓库的活动，
私仓活动不外泄，并支持实体类型过滤与分页。
"""
import pytest
import uuid

from app.models.activity import Activity
from app.models.repository import Repository
from app.models.user import User
from app.utils.password_utils import get_password_hash


@pytest.fixture
def activity_user(db):
    user = User(
        username="activityuser",
        email="activity@example.com",
        password=get_password_hash("password123"),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _repo(db, owner: User, name: str, is_public: bool) -> Repository:
    repo = Repository(owner_id=owner.id, name=name, path=f"{owner.username}/{name}",
                      is_public=is_public)
    db.add(repo)
    db.commit()
    db.refresh(repo)
    return repo


def _activity(db, repo: Repository, actor: User, entity_type: str = "pull_request") -> Activity:
    item = Activity(
        repository_id=repo.id,
        actor_id=actor.id,
        entity_type=entity_type,
        entity_id=uuid.uuid4(),
        action="opened",
    )
    db.add(item)
    db.commit()
    return item


def _headers(user: User) -> dict:
    from app.services.auth.token_service import create_access_token

    token = create_access_token(
        {"sub": str(user.id), "username": user.username, "is_admin": user.is_admin}
    )
    return {"Authorization": f"Bearer {token}"}


def test_activity_includes_own_and_excludes_private(test_client, db, activity_user):
    other = User(username="otheruser", email="other@example.com",
                 password=get_password_hash("x"), is_active=True)
    db.add(other)
    db.commit()
    db.refresh(other)

    mine = _repo(db, activity_user, "mine", is_public=False)
    public = _repo(db, other, "public", is_public=True)
    foreign = _repo(db, other, "secret", is_public=False)

    _activity(db, mine, activity_user)
    _activity(db, public, other)
    _activity(db, foreign, other)

    response = test_client.get("/api/v1/users/me/activity", headers=_headers(activity_user))
    assert response.status_code == 200
    body = response.json()
    repo_ids = {item["repository_id"] for item in body["items"]}
    assert str(mine.id) in repo_ids
    assert str(public.id) in repo_ids
    assert str(foreign.id) not in repo_ids
    assert body["total"] == 2


def test_activity_filters_by_entity_type(test_client, db, activity_user):
    repo = _repo(db, activity_user, "filters", is_public=False)
    _activity(db, repo, activity_user, "pull_request")
    _activity(db, repo, activity_user, "issue")

    response = test_client.get(
        "/api/v1/users/me/activity?entity_type=issue", headers=_headers(activity_user)
    )
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["entity_type"] == "issue"


def test_activity_requires_auth(test_client):
    assert test_client.get("/api/v1/users/me/activity").status_code in (401, 403)
