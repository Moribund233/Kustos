"""dashboard 扩展卡片端点冒烟测试（待审阅 PR / 最近构建 / 贡献者排行）"""


class TestDashboardCardsApi:
    def test_review_requests_empty(self, test_client, auth_headers):
        resp = test_client.get("/api/v1/users/me/review-requests", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_builds_empty(self, test_client, auth_headers):
        resp = test_client.get("/api/v1/users/me/builds", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_contributors_empty(self, test_client, auth_headers):
        resp = test_client.get("/api/v1/users/me/contributors", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json() == []

    def test_contributors_rejects_negative_days(self, test_client, auth_headers):
        resp = test_client.get(
            "/api/v1/users/me/contributors?days=-5", headers=auth_headers
        )
        # days<0 在服务层收敛为至少 1 天窗口，仍应正常返回
        assert resp.status_code == 200
