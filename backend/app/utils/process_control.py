"""进程管理器信号

背景：`POST /api/app/restart` 原实现是「手工拉新进程 +
SIGTERM 自己」，三处都错——

1. ``_spawn_restart`` 起的是**第二个**服务进程，与原进程争端口；
   在多 worker 部署下还可能出现双 master；
2. ``os.kill(getpid(), SIGTERM)`` 只终止**收到请求的那个 worker**，
   4 worker 部署下「重启应用」实际只重启 1/4；
3. ``trigger_graceful_shutdown`` 在独立 ``asyncio.new_event_loop()`` 里跑
   ``manager.shutdown()``——manager 的 ``asyncio.Lock``/WebSocket 绑定主
   loop，跨 loop 使用为未定义行为。

改为把重启/关闭交给**进程管理器**（本模块负责找到它并发信号）：

===========  信号   ==========================  效果（多 worker） ===========
``SIGHUP``   uvicorn ``MultiProcess.restart_all()``：**新 worker 就绪后才退役
             旧 worker**（真·滚动）；gunicorn：重载配置 + 优雅回收旧 worker
``SIGTERM``  管理器优雅退出全部 worker；容器场景由编排层（compose restart
             策略）重新拉起
===========  ============================================================

**检测方式**：父进程 cmdline 含 ``uvicorn`` / ``gunicorn`` 才认定为管理器。
这一条约束很关键——否则会把信号发给 shell / python 解释器 / 测试运行器等
普通父进程（例如 dev 下 ``python app.py`` 即 uvicorn 单进程运行，其父进程
是 shell，不该碰）。单进程场景 ``find_supervisor_pid()`` 返回 None，调用方
退回「拉起新进程 + 退出自身」的老路径。
"""
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 「本进程是否在提供服务」标记
# ---------------------------------------------------------------------------

_serving = False


def mark_serving() -> None:
    """由 lifespan startup 置位：本进程确实在提供服务。

    **刻意用模块级变量而非环境变量**——子进程重新 import 时该标记为 False，
    因此误入「单进程重启」分支的派生进程不会再次派生（防递归拉起）。
    """
    global _serving
    _serving = True


def is_serving() -> bool:
    """本进程是否为正在提供服务的服务器进程"""
    return _serving


def reset_serving() -> None:
    """测试隔离用"""
    global _serving
    _serving = False


#: 可认定为「进程管理器」的 cmdline 标记（大小写不敏感）
SUPERVISOR_MARKERS = ("uvicorn", "gunicorn")

#: 首段为这些可执行文件时（shell / 解释器 / 包装器），命令行里「出现
#: uvicorn/gunicorn」还不够——必须真的把它当参数执行（见
#: ``_looks_like_supervisor_argv``），否则 ``bash -lc "uvicorn app.main:app"``
#: 这类脚本壳会被误判成管理器，信号就发错了进程。
_WRAPPED_HEADS = frozenset({
    "sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe",
    "powershell", "powershell.exe", "pwsh", "python", "python3",
    "python.exe", "su", "sudo",
})


def matches_supervisor(ppid: int, cmdline: str) -> bool:
    """纯函数：父进程 cmdline 是否表明它是 uvicorn/gunicorn 管理器。

    Args:
        ppid: 父进程 pid（0 或等于自身一律否定）
        cmdline: 父进程命令行（小写拼接；获取失败传空串）

    Returns:
        bool: 是否可安全向该父进程发信号
    """
    if not ppid or ppid == os.getpid():
        return False
    if not cmdline:
        return False
    lowered = cmdline.lower()
    if not any(marker in lowered for marker in SUPERVISOR_MARKERS):
        return False
    first = lowered.split(None, 1)[0]
    if os.path.basename(first) in _WRAPPED_HEADS and not _runs_supervisor_argv(lowered):
        return False
    return True


def _runs_supervisor_argv(lowered: str) -> bool:
    """``python /path/uvicorn ...`` 或 ``python -m uvicorn``（管理器真由解释器拉起）；"""
    parts = lowered.split()
    if not parts:
        return False
    if os.path.basename(parts[0]) not in {"python", "python3", "python.exe"}:
        return False  # 首段即 uvicorn/gunicorn 本体（shebang 直接执行）
    args = parts[1:]
    if "-m" in args:
        idx = args.index("-m")
        return idx + 1 < len(args) and args[idx + 1] in SUPERVISOR_MARKERS
    return any(os.path.basename(a) in SUPERVISOR_MARKERS for a in args)


def _cmdline_of(pid: int) -> str:
    """读取进程命令行（失败返回空串 → 判定为非管理器）"""
    try:
        import psutil

        return " ".join(psutil.Process(pid).cmdline()).lower()
    except Exception:  # noqa: BLE001 — 进程可能已退出/无权限
        return ""


def find_supervisor_pid() -> Optional[int]:
    """找到当前进程的管理器 pid；非多 worker 场景返回 None"""
    ppid = os.getppid()
    if matches_supervisor(ppid, _cmdline_of(ppid)):
        return ppid
    return None


def signal_supervisor(sig: int) -> Optional[int]:
    """向管理器发信号；不是管理器模式或发送失败时返回 None（调用方回退自身路径）"""
    pid = find_supervisor_pid()
    if pid is None:
        return None
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError, OSError) as exc:
        logger.warning("向进程管理器 pid=%s 发送信号失败: %s", pid, exc)
        return None
    logger.info("已向进程管理器 pid=%s 发送信号 %s", pid, sig)
    return pid