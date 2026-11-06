"""客户端兼容性端点测试

桌面端需要判断"我这个客户端能不能跟这个实例正常协作"，而服务端版本与 API
契约是两件事：实例可能升到 0.2，但 API 仍然是 v1；也可能反过来打了补丁却没
改 API。所以端点要声明 **API 契约版本** 与 **最低兼容版本**，客户端自己比对。

落地位置说明：设计文档原本把它写成 ``/api/app/client-compat``，但同一份文档
的 bridge 白名单又显式拒绝 ``/api/app/``（那是只能在受信网络里用的管理面）。
放在那儿等于桌面端永远访问不到。因此改为 ``/api/v1/client-compat`` 的公开面。

声明式而非判定式：客户端各自知道自己的版本，服务端只需要如实公布契约版本与
特性开关，不需要替客户端假设"你是哪个版本"。
"""

import pytest


class TestClientCompat:
    def _get(self, client):
        return client.get("/api/v1/client-compat")

    def test_publicly_accessible_without_auth(self, test_client):
        """桌面端启动时还没登录就要能判断兼容性，因此必须免鉴权"""
        resp = self._get(test_client)
        assert resp.status_code == 200

    def test_declares_api_version_and_minimum(self, test_client):
        body = self._get(test_client).json()
        assert body["api_version"].startswith("v")
        # 客户端版本低于此值即应阻断，而不是"尽量兼容"
        assert body["api_min"]
        # 服务端版本与 API 契约版本是两件事，都要给出
        assert body["server_version"]

    def test_lists_feature_flags(self, test_client):
        """特性开关让客户端按能力降级，而不是按版本号猜"""
        body = self._get(test_client).json()
        assert isinstance(body["features"], dict)
        # 本轮新增的协作感知即典型例子：老实例没有它，客户端不该显示 live 圆点
        assert "collab_active" in body["features"]

    def test_collab_active_reflects_configuration(self, test_client, monkeypatch):
        """特性开关必须反映真实配置，不能说一套做一套"""
        monkeypatch.setenv("KUSTOS_COLLAB_ACTIVE_ENDPOINTS", "http://collab:4446")
        monkeypatch.setenv("KUSTOS_COLLAB_INTERNAL_SECRET", "s")
        body = self._get(test_client).json()
        assert body["features"]["collab_active"] is True

    def test_collab_active_false_when_unconfigured(self, test_client, monkeypatch):
        monkeypatch.delenv("KUSTOS_COLLAB_ACTIVE_ENDPOINTS", raising=False)
        body = self._get(test_client).json()
        assert body["features"]["collab_active"] is False

    def test_includes_idempotency_and_pkce_capabilities(self, test_client):
        """桌面端依赖的两项后端能力应如实公布"""
        features = self._get(test_client).json()["features"]
        assert features["idempotency_key"] is True
        assert features["pkce_login"] is True
