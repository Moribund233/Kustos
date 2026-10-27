"""运行时降级登记

背景：Redis 缺失时三处子系统**静默**回退，把「错数据」当正常数据返回——

- ``middleware/request_stats``：Admin QPS/时序只剩**单 worker** 视图；
- ``utils/realtime_bus``：跨 worker 的 WS 消息**丢失**（只剩轮询）；
- ``services/realtime/presence_service``：在线状态只看得到本 worker（Redis 全无时为空）。

静默的代价是运维无法区分「指标就是低」与「指标缺了一半」。本模块提供**唯一
登记点**：子系统退化/恢复时登记，Admin 面板（``GET /api/redis/status`` 的
``degradation`` 段）与运行日志据此显示显式 degraded。

取舍：
    - ✅ **显式 degraded 指标/横幅**：不打断业务，开发与单 worker 场景本就可降级；
    - ❌ 生产 fail-fast：Redis 若在运行期（而非启动时）宕掉，fail-fast 无能为力，
      反而会把可降级的只读功能一起打死；且 wiki 对「可选/必需」本就口径不一
      （已统一为「生产必需、开发/单 worker 可选」）。
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DegradedComponent:
    """单个子系统的降级快照"""

    component: str
    #: 退化到的形态：``memory``（进程内计数）/ ``in-process``（进程内广播或 presence）
    mode: str
    #: 对运维的影响说明（面板直接展示）
    detail: str
    #: 进入降级的时间（ISO8601 UTC）
    since: str


class DegradedRegistry:
    """子系统降级登记表（进程内单例；幂等、只在**状态变化**时打日志）"""

    def __init__(self) -> None:
        self._states: Dict[str, DegradedComponent] = {}

    def set(self, component: str, mode: str, detail: str) -> None:
        """登记降级。重复登记同一状态不打日志（避免每请求刷屏）。"""
        current = self._states.get(component)
        if current is not None and current.mode == mode and current.detail == detail:
            return
        self._states[component] = DegradedComponent(
            component=component,
            mode=mode,
            detail=detail,
            since=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        logger.warning("运行时降级: %s → %s（%s）", component, mode, detail)

    def clear(self, component: str) -> None:
        """恢复：从登记表移除（仅当原本存在时打日志）。"""
        if self._states.pop(component, None) is not None:
            logger.info("运行时恢复: %s 已回到共享后端", component)

    @property
    def degraded(self) -> bool:
        return bool(self._states)

    def snapshot(self) -> List[Dict[str, Optional[str]]]:
        """按组件名排序的快照（供 Admin 面板）"""
        return [
            {
                "component": item.component,
                "mode": item.mode,
                "detail": item.detail,
                "since": item.since,
            }
            for item in sorted(self._states.values(), key=lambda x: x.component)
        ]

    def reset(self) -> None:
        """清空（测试隔离用）"""
        self._states.clear()


#: 进程级单例
registry = DegradedRegistry()
