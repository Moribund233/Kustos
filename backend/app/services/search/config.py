"""搜索域 · 配置与限流

搜索相关的**运行期可调**参数（结果条数上限、文件/字节护栏、批量大小、
重建锁 TTL）在这里统一读取，调用方不再各自散落 get_config_value。
默认值 = 模块常量；配置未就绪时回落到常量。
"""
from typing import Optional, Tuple

from app.core.config import get_config_value


MAX_FILE_BYTES = 2 * 1024 * 1024


SCAN_FILE_LIMIT = 200


def _max_file_bytes() -> int:
    """单文件大小上限：读 ``search.max_file_size``，helper 热生效、
    降级为模块常量（默认 = 模块常量）。服务内所有按块/按文件扫描
    （索引、Git tree 兜底、ref 现场扫描、增量更新）共用同一上限语义。
    """
    return int(get_config_value("search", "max_file_size", MAX_FILE_BYTES))


def search_results_cap() -> int:
    """搜索结果硬上限：``search.max_results`` = service 默认兼
    硬上限，controller ``Query`` 上限与 agent 工具 cap 均由此派生；service 侧
    夹取是最终裁决方。
    """
    return int(get_config_value("search", "max_results", 100) or 100)


def _clamp_results(max_results: Optional[int], default: int) -> int:
    """把结果数夹取到 ``search.max_results`` 上限内。

    Args:
        max_results: 显式传参；None 表示未指定
        default: 未指定时的该方法缺省值（仍受上限约束）
    """
    cap = search_results_cap()
    if max_results is None:
        return min(default, cap)
    return max(1, min(int(max_results), cap))


SYMBOL_SCAN_MAX_FILES = 2000


SYMBOL_SCAN_MAX_BYTES = 16 * 1024 * 1024


INDEX_MAX_FILES = 5000            # 超过则不建索引，搜索退回 Git tree 全扫


INDEX_MAX_BYTES = 32 * 1024 * 1024  # 源文本字节上限（与 INDEX_MAX_FILES 任一超限即跳过）


INDEX_FILE_BATCH = 200           # 每批读取/切分的文件数


INDEX_ROW_BATCH = 2000           # 每批 INSERT 的 chunk 行数


REBUILD_LOCK_TTL = 180           # 跨 worker 重建锁 TTL（秒）


def scan_file_limit() -> int:
    """Git tree 兜底扫描的文件数上限（``search.scan_file_limit``）"""
    return int(get_config_value("search", "scan_file_limit", SCAN_FILE_LIMIT))


def symbol_scan_limits() -> Tuple[int, int]:
    """按 ref 现场扫描符号/引用的护栏：``(文件数上限, 字节上限)``"""
    return (
        int(get_config_value("search", "symbol_scan_max_files", SYMBOL_SCAN_MAX_FILES)),
        int(get_config_value("search", "symbol_scan_max_bytes", SYMBOL_SCAN_MAX_BYTES)),
    )


def _index_limits() -> Tuple[int, int]:
    """索引构建护栏 (文件数, 字节)——读 ``search.index_max_files`` / ``index_max_bytes``"""
    return (
        int(get_config_value("search", "index_max_files", INDEX_MAX_FILES)),
        int(get_config_value("search", "index_max_bytes", INDEX_MAX_BYTES)),
    )


def _index_file_batch() -> int:
    """每批读取/切分的文件数——读 ``search.index_file_batch``"""
    return int(get_config_value("search", "index_file_batch", INDEX_FILE_BATCH))


def _index_row_batch() -> int:
    """每批 INSERT 的 chunk 行数——读 ``search.index_row_batch``"""
    return int(get_config_value("search", "index_row_batch", INDEX_ROW_BATCH))


def _rebuild_lock_ttl() -> int:
    """跨 worker 重建锁 TTL（秒）——读 ``search.rebuild_lock_ttl``"""
    return int(get_config_value("search", "rebuild_lock_ttl", REBUILD_LOCK_TTL))


INDEX_GENERATION = 1

