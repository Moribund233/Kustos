"""搜索域 · 数据传输对象

命中结果、符号查找等对外返回结构的定义。放在独立模块，让「契约」与
「实现」分离——改检索算法不会波及返回结构。
"""
from dataclasses import dataclass, field
from typing import Generic, List, Optional, TypeVar


@dataclass
class ChunkRef:
    """命中结果所属代码块引用（file:start-end 区间，供 Agent 按块取内容）"""
    chunk_index: int
    symbol: Optional[str]
    kind: Optional[str]
    start_line: int
    end_line: int


@dataclass
class SearchResult:
    """搜索结果"""
    file: str
    line: int
    content: str
    chunk: Optional[ChunkRef] = None


@dataclass
class SearchResponse:
    """搜索响应

    ``source``：本轮命中的**来源**，让调用方（尤其 Agent）能察觉召回质量，
    而不是把兜底全扫当索引命中：
    - ``index``    主库块级索引（含懒构建/增量后的关键词 + 语义融合）
    - ``git_tree`` 现场 Git tree 全扫兜底（索引缺失/超限/ref 非默认分支/索引查询失败）
    - ``none``     空查询，未执行检索

    ``semantic_used``：语义检索是否**实际参与**本轮排序（provider 未配置、
    未开启或查询向量生成失败时为 False——即降级为纯关键词）。
    """
    query: str
    results: list[SearchResult] = field(default_factory=list)
    total_count: int = 0
    truncated: bool = False
    source: str = "none"
    semantic_used: bool = False


@dataclass
class SymbolHit:
    """符号定义命中（find-definition）"""
    file: str
    symbol: str
    kind: Optional[str]
    start_line: int
    end_line: int


@dataclass
class UsageHit:
    """标识符引用命中（find-usages）；附带引用点所在的符号块区间，供一次跳转拿上下文"""
    file: str
    line: int
    symbol: Optional[str] = None
    kind: Optional[str] = None
    start_line: Optional[int] = None
    end_line: Optional[int] = None


T = TypeVar("T")


@dataclass
class SymbolLookup(Generic[T]):
    """符号查找结果：命中列表 + 来源 + 完整性标记。

    ``source="index"`` 表示走默认分支的块级索引；``source="ref_scan"`` 表示该 ref
    未被索引、按 ref 现场扫描 Git tree。修复后调用方据此判断答案是否可信——
    ``partial=True`` 说明扫描被护栏截断，结果**可能不完整**。
    """
    hits: List[T] = field(default_factory=list)
    source: str = "index"
    partial: bool = False

