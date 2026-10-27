"""进程管理器信号（滚动重启）与危险操作权限

回归目标：
- 重启不再手工拉起第二个服务进程（端口竞争 / 双 master）；
- 关闭不再自建 ``asyncio.new_event_loop`` 跑 ``manager.shutdown()``（跨 loop
  未定义行为），也不再只终止收到请求的那个 worker；
- 单进程场景仍走「拉起新进程 + 退出自身」的旧路径。

回归目标：``KUSTOS_APP_DEBUG=true`` 不得对**远程**已登录用户放宽危险操作
（重启/关闭/配置写回/日志清理）——仅管理员或**本机来源**可通过。
"""
import signal as signal_mod
from types import SimpleNamespace

import pytest

import app.api.v1.app_controller as app_ctl
import app.services.app_service as app_svc
from app.utils import process_control


@pytest.fixture(autouse=True)
def _serving_flag():
    """隔离「本进程是否在提供服务」标记（lifespan startup 置位）"""
    process_control.reset_serving()
    yield
    process_control.reset_serving()


def _debug_on(monkeypatch):
    """让 app_controller 的权限判定看到 debug=true"""
    monkeypatch.setattr(
        app_ctl,
        "get_config",
        lambda: SimpleNamespace(app=SimpleNamespace(debug=True)),
    )


def _debug_off(monkeypatch):
    monkeypatch.setattr(
        app_ctl,
        "get_config",
        lambda: SimpleNamespace(app=SimpleNamespace(debug=False)),
    )


def _trust_proxy(monkeypatch):
    """把 TestClient 直连 peer（固定 "testclient"，非可信来源）视为可信代理。

    仅用于隔离「X-Real-IP 回环放行」分支的判断；可信来源裁决本身由
    `test_untrusted_peer_x_real_ip_ignored` 等反向/单元用例覆盖。
    """
    monkeypatch.setattr(app_ctl, "_is_trusted_proxy", lambda peer: True)


class _FakeManager:
    def __init__(self, shutting_down: bool = False):
        self._shutting_down = shutting_down

    def is_shutting_down(self) -> bool:
        return self._shutting_down

    async def shutdown(self) -> None:
        raise AssertionError(
            "trigger_graceful_shutdown 不应手动执行 manager.shutdown()——"
            "应由 lifespan 在主事件循环里执行"
        )


class TestSupervisorDetection:
    def test_uvicorn_supervisor(self):
        assert process_control.matches_supervisor(
            1234, "/usr/local/bin/uvicorn app.main:app --host 0.0.0.0 --workers 4"
        )

    def test_gunicorn_master(self):
        assert process_control.matches_supervisor(
            1234, "/usr/local/bin/python /usr/local/bin/gunicorn -c gunicorn.conf.py app.main:app"
        )

    @pytest.mark.parametrize(
        "cmdline",
        [
            "/bin/bash",
            "/usr/bin/python app.py",
            "python -m pytest tests/",
            "bash -lc uvicorn app.main:app --workers 4",
            "sh -c gunicorn app.main:app",
            "",
        ],
    )
    def test_rejects_non_supervisor_parent(self, cmdline):
        """父进程是 shell / 解释器 / 测试运行器时不得发信号（否则会杀错进程）"""
        assert process_control.matches_supervisor(1234, cmdline) is False

    @pytest.mark.parametrize(
        "cmdline",
        [
            "/usr/local/bin/python /usr/local/bin/uvicorn app.main:app --workers 4",
            "python -m uvicorn app.main:app --workers 4",
            "/usr/local/bin/uvicorn app.main:app",
            "/usr/local/bin/python /usr/local/bin/gunicorn -c g.conf app.main:app",
        ],
    )
    def test_accepts_real_supervisor_forms(self, cmdline):
        """解释器拉起 uvicorn/gunicorn、或直接执行其可执行文件 → 是管理器"""
        assert process_control.matches_supervisor(1234, cmdline) is True

    def test_rejects_self_or_zero_pid(self):
        assert process_control.matches_supervisor(0, "uvicorn app.main:app") is False
        assert process_control.matches_supervisor(
            __import__("os").getpid(), "uvicorn app.main:app"
        ) is False


class TestSupervisorSignal:
    def test_find_supervisor_pid_positive(self, monkeypatch):
        monkeypatch.setattr(process_control, "_cmdline_of", lambda pid: "uvicorn app.main:app")
        monkeypatch.setattr(process_control.os, "getppid", lambda: 4242)
        assert process_control.find_supervisor_pid() == 4242

    def test_find_supervisor_pid_none_for_shell_parent(self, monkeypatch):
        monkeypatch.setattr(process_control, "_cmdline_of", lambda pid: "/bin/bash -lc dev")
        monkeypatch.setattr(process_control.os, "getppid", lambda: 4242)
        assert process_control.find_supervisor_pid() is None

    def test_signal_supervisor_sends_requested_signal(self, monkeypatch):
        killed = []
        monkeypatch.setattr(process_control, "_cmdline_of", lambda pid: "uvicorn app.main:app")
        monkeypatch.setattr(process_control.os, "getppid", lambda: 4242)
        monkeypatch.setattr(
            process_control.os, "kill", lambda pid, sig: killed.append((pid, sig))
        )

        assert process_control.signal_supervisor(signal_mod.SIGHUP) == 4242
        assert killed == [(4242, signal_mod.SIGHUP)]

    def test_signal_supervisor_none_without_supervisor(self, monkeypatch):
        monkeypatch.setattr(process_control, "_cmdline_of", lambda pid: "/bin/bash")
        monkeypatch.setattr(process_control.os, "getppid", lambda: 4242)
        assert process_control.signal_supervisor(signal_mod.SIGHUP) is None

    def test_signal_supervisor_swallows_kill_error(self, monkeypatch):
        monkeypatch.setattr(process_control, "_cmdline_of", lambda pid: "uvicorn app.main:app")
        monkeypatch.setattr(process_control.os, "getppid", lambda: 4242)

        def _boom(pid, sig):
            raise ProcessLookupError("gone")

        monkeypatch.setattr(process_control.os, "kill", _boom)
        assert process_control.signal_supervisor(signal_mod.SIGHUP) is None


class TestGracefulShutdown:
    def test_signals_supervisor_not_new_loop(self, monkeypatch):
        import app.core.lifespan as lifespan

        signals = []
        monkeypatch.setattr(lifespan, "get_lifecycle_manager", lambda: _FakeManager())
        monkeypatch.setattr(
            process_control,
            "signal_supervisor",
            lambda sig: signals.append(sig) or 4242,
        )

        assert lifespan.trigger_graceful_shutdown(reason="test") is True
        assert signals == [signal_mod.SIGTERM]

    def test_falls_back_to_self_signal(self, monkeypatch):
        import app.core.lifespan as lifespan

        process_control.mark_serving()
        killed = []
        monkeypatch.setattr(lifespan, "get_lifecycle_manager", lambda: _FakeManager())
        monkeypatch.setattr(process_control, "signal_supervisor", lambda sig: None)
        monkeypatch.setattr(
            lifespan.os, "kill", lambda pid, sig: killed.append((pid, sig))
        )

        assert lifespan.trigger_graceful_shutdown(reason="test") is True
        assert killed == [(__import__("os").getpid(), signal_mod.SIGTERM)]

    def test_refuses_self_signal_when_not_serving(self, monkeypatch):
        """非服务进程（docker exec / 脚本）误调 → 不得 SIGTERM 调用者"""
        import app.core.lifespan as lifespan

        killed = []
        monkeypatch.setattr(lifespan, "get_lifecycle_manager", lambda: _FakeManager())
        monkeypatch.setattr(process_control, "signal_supervisor", lambda sig: None)
        monkeypatch.setattr(
            lifespan.os, "kill", lambda pid, sig: killed.append((pid, sig))
        )

        assert lifespan.trigger_graceful_shutdown(reason="test") is False
        assert killed == []

    def test_skips_when_already_shutting_down(self, monkeypatch):
        import app.core.lifespan as lifespan

        monkeypatch.setattr(
            lifespan, "get_lifecycle_manager", lambda: _FakeManager(shutting_down=True)
        )
        monkeypatch.setattr(
            process_control,
            "signal_supervisor",
            lambda sig: pytest.fail("已在关闭中，不应重复发信号"),
        )

        assert lifespan.trigger_graceful_shutdown(reason="again") is True

    def test_source_has_no_new_event_loop(self):
        """静态防线：的病灶是自建事件循环跑 shutdown（按调用 AST 判定，
        不看文本——docstring 里正引用该病灶做说明）"""
        import ast
        import inspect
        import textwrap

        import app.core.lifespan as lifespan

        source = textwrap.dedent(inspect.getsource(lifespan.trigger_graceful_shutdown))
        called = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Call) and isinstance(node.func, (ast.Attribute, ast.Name)):
                called.add(
                    node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
                )
        assert "new_event_loop" not in called
        assert "run_until_complete" not in called
        assert "set_event_loop" not in called


class TestDoRestart:
    def test_multi_worker_uses_supervisor_sighup(self, monkeypatch):
        """有管理器 → 只发 SIGHUP（滚动重启），绝不手工拉第二个进程"""
        signals = []
        spawned = []
        terminated = []

        monkeypatch.setattr(
            process_control, "signal_supervisor", lambda sig: signals.append(sig) or 4242
        )
        monkeypatch.setattr(app_svc, "_spawn_restart", lambda cmd: spawned.append(cmd))
        monkeypatch.setattr(app_svc, "_terminate_process", lambda: terminated.append(True))

        app_svc._do_restart(delay=0, settle=0)

        assert signals == [signal_mod.SIGHUP]
        assert spawned == []
        assert terminated == []

    def test_single_process_falls_back_to_spawn(self, monkeypatch):
        """无管理器（dev 单进程，且确在提供服务）→ 拉起新进程 + 退出自身"""
        process_control.mark_serving()
        signals = []
        spawned = []
        terminated = []

        monkeypatch.setattr(
            process_control, "signal_supervisor", lambda sig: signals.append(sig)
        )
        monkeypatch.setattr(app_svc, "_spawn_restart", lambda cmd: spawned.append(cmd))
        monkeypatch.setattr(app_svc, "_terminate_process", lambda: terminated.append(True))

        app_svc._do_restart(delay=0, settle=0)

        assert signals == [signal_mod.SIGHUP]  # 尝试过，但没有管理器可发
        assert len(spawned) == 1
        assert terminated == [True]

    def test_refuses_single_process_path_when_not_serving(self, monkeypatch):
        """非服务进程（docker exec / 脚本 / 派生进程）→ 不得拉起新进程

        实测场景：``docker exec`` 的 ppid=0 → 无管理器 → 若不加闸就会
        ``_spawn_restart`` 出一个多余的服务进程。
        """
        signals = []
        spawned = []
        terminated = []

        monkeypatch.setattr(
            process_control, "signal_supervisor", lambda sig: signals.append(sig)
        )
        monkeypatch.setattr(app_svc, "_spawn_restart", lambda cmd: spawned.append(cmd))
        monkeypatch.setattr(app_svc, "_terminate_process", lambda: terminated.append(True))

        app_svc._do_restart(delay=0, settle=0)

        assert signals == [signal_mod.SIGHUP]
        assert spawned == [], "未提供服务的进程不应拉起新服务进程"
        assert terminated == [], "未提供服务的进程不应自我终止"

    def test_service_restart_spawns_thread_not_loop(self, monkeypatch):
        """restart() 只负责校验权限并异步触发执行体（循环里不得 new_event_loop）"""
        calls = []
        monkeypatch.setattr(app_svc, "_do_restart", lambda: calls.append(True))

        service = app_svc.AppService()
        assert service.restart(is_admin=True) is True

        import threading

        for _ in range(50):
            if calls:
                break
            threading.Event().wait(0.02)
        assert calls == [True]


class TestDangerPermission:
    """危险操作（重启/关闭/配置写回/日志清理）的门控"""

    @staticmethod
    def _stub_restart(monkeypatch):
        calls = []

        class FakeAppService:
            def restart(self, is_debug=False, is_admin=False):
                calls.append((is_debug, is_admin))
                return True

            def shutdown(self, is_debug=False, is_admin=False, force=False):
                calls.append((is_debug, is_admin))
                return True

        monkeypatch.setattr(app_ctl, "get_app_service", lambda: FakeAppService())
        return calls

    def test_debug_does_not_open_remote_access(self, test_client, auth_headers, monkeypatch):
        """debug=true + 远程来源 → 403（原「debug 或 admin」的病灶）"""
        _debug_on(monkeypatch)
        self._stub_restart(monkeypatch)

        r = test_client.post("/api/app/restart", headers=auth_headers)
        assert r.status_code == 403

    def test_debug_allows_loopback(self, test_client, auth_headers, monkeypatch):
        """debug=true + 本机来源（X-Real-IP=127.0.0.1）→ 放行"""
        _debug_on(monkeypatch)
        _trust_proxy(monkeypatch)
        calls = self._stub_restart(monkeypatch)

        r = test_client.post(
            "/api/app/restart",
            headers={**auth_headers, "X-Real-IP": "127.0.0.1"},
        )
        assert r.status_code == 200
        assert calls, "应触发服务层 restart"

    @pytest.mark.parametrize("ip", ["10.1.2.3", "172.18.0.7", "192.168.1.9"])
    def test_non_loopback_denied_even_in_debug(self, test_client, auth_headers,
                                               monkeypatch, ip):
        _debug_on(monkeypatch)
        _trust_proxy(monkeypatch)
        self._stub_restart(monkeypatch)

        r = test_client.post(
            "/api/app/restart", headers={**auth_headers, "X-Real-IP": ip}
        )
        assert r.status_code == 403

    def test_forwarded_for_is_not_trusted(self, test_client, auth_headers, monkeypatch):
        """X-Forwarded-For 首段可被客户端伪造，不得用作 loopback 判定"""
        _debug_on(monkeypatch)
        _trust_proxy(monkeypatch)
        self._stub_restart(monkeypatch)

        r = test_client.post(
            "/api/app/restart",
            headers={**auth_headers, "X-Forwarded-For": "127.0.0.1"},
        )
        assert r.status_code == 403

    def test_debug_off_remote_denied(self, test_client, auth_headers, monkeypatch):
        _debug_off(monkeypatch)
        _trust_proxy(monkeypatch)
        self._stub_restart(monkeypatch)

        r = test_client.post(
            "/api/app/restart",
            headers={**auth_headers, "X-Real-IP": "127.0.0.1"},
        )
        assert r.status_code == 403

    def test_admin_allowed_remotely_without_debug(self, test_client, admin_headers,
                                                  monkeypatch):
        _debug_off(monkeypatch)
        calls = self._stub_restart(monkeypatch)

        r = test_client.post("/api/app/restart", headers=admin_headers)
        assert r.status_code == 200
        assert calls

    def test_untrusted_peer_x_real_ip_ignored(self, test_client, auth_headers,
                                              monkeypatch):
        """不可信 peer（同 docker 网络内其它容器直连）伪造 X-Real-IP=127.0.0.1
        → 按真实直连 peer 判定，不得冒充本机来源"""
        _debug_on(monkeypatch)
        self._stub_restart(monkeypatch)

        r = test_client.post(
            "/api/app/restart",
            headers={**auth_headers, "X-Real-IP": "127.0.0.1"},
        )
        assert r.status_code == 403

    def test_trusted_proxy_gateway_resolution(self, monkeypatch):
        """仅回环与网关容器（compose 服务名 DNS 解析）是可信来源"""
        fake_gateway = "172.18.0.2"

        def _resolve(name):
            return fake_gateway if name == "gateway" else "0.0.0.0"

        monkeypatch.setattr(app_ctl.socket, "gethostbyname", _resolve)
        assert app_ctl._is_trusted_proxy(fake_gateway) is True   # 网关容器
        assert app_ctl._is_trusted_proxy("172.18.0.7") is False  # 同网络其它容器
        assert app_ctl._is_trusted_proxy("127.0.0.1") is True    # 回环恒可信
        assert app_ctl._is_trusted_proxy("testclient") is False  # TestClient 直连 peer

    def test_gateway_unresolvable_only_loopback_trusted(self, monkeypatch):
        """网关不可解析（单容器部署/无 gateway 服务）→ 仅回环可信"""

        def _no_resolve(name):
            raise OSError("no gateway on network")

        monkeypatch.setattr(app_ctl.socket, "gethostbyname", _no_resolve)
        assert app_ctl._is_trusted_proxy("172.18.0.2") is False
        assert app_ctl._is_trusted_proxy("127.0.0.1") is True
        assert app_ctl._is_trusted_proxy("::1") is True
