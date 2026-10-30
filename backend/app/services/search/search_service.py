"""搜索域 · 门面

原先 1608 行的搜索实现已按职责拆成五个模块：

| 模块 | 职责 |
| --- | --- |
| ``config.py`` | 配置与限流（结果条数上限、文件/字节护栏、批量大小、锁 TTL） |
| ``dto.py`` | 返回结构（命中结果、符号查找） |
| ``git_scan.py`` | Git 对象遍历、RRF 融合、按 ref 现场扫描符号/引用 |
| ``locks.py`` | per-repo 重建锁（Redis SET NX + 进程内兜底） |
| ``service.py`` | 搜索服务主体（索引构建、增量更新、语义检索、自愈） |

本模块只做**再导出**：调用方继续 ``from app.services.search.search_service
import SearchService`` 即可，导入路径不变；新代码直接引用职责明确的模块。
"""
from app.services.search.config import (
    INDEX_GENERATION,
    _clamp_results,
    _index_file_batch,
    _index_limits,
    _index_row_batch,
    _max_file_bytes,
    _rebuild_lock_ttl,
    search_results_cap,
)
from app.services.search.dto import (
    ChunkRef,
    SearchResponse,
    SearchResult,
    SymbolHit,
    SymbolLookup,
    UsageHit,
)
from app.services.search.git_scan import (
    _batched,
    _default_branch,
    _extract_all_snapshot,
    _head_commit,
    _is_text_path,
    _iter_text_blobs,
    _iter_text_paths,
    _list_text_paths,
    _needs_ref_scan,
    _path_prefix,
    _read_text_blobs,
    _rrf_fuse,
    _scan_definitions_at_ref,
    _scan_usages_at_ref,
    _test_path_clauses,
    head_commit,
)
from app.services.search.locks import (
    _acquire_rebuild_lock,
    _local_rebuild_lock,
    _release_rebuild_lock,
)
from app.services.search.service import SearchService

__all__ = [
    "SearchService",
    "search_results_cap",
    "INDEX_GENERATION",
    "head_commit",
    "ChunkRef",
    "SearchResponse",
    "SearchResult",
    "SymbolHit",
    "SymbolLookup",
    "UsageHit",
]
