"""内置 Agent 的 provider 声明式目录。

目录只是 **UI 与审计元数据**，不是协议分支：运行时统一走 OpenAI 兼容实现
（``services/agent/providers.py`` 的 ``OpenAICompatProvider``）。未来接入
非 OpenAI 协议时通过 ``api_mode`` 扩展位声明（当前仅 ``chat_completions``），
不在调用点散落 if/else。

安全红线：目录只记录**环境变量名**（``key_env`` / ``key_envs``），
任何环节不出现 key 值；``key_envs`` 为有序候选，首个非空者生效，
末位统一回落到 ``agent.api_key_env``（既有部署只注入 ``KUSTOS_AGENT_API_KEY`` 也能用）。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

#: 当前唯一支持的协议形状；接入非 OpenAI 协议时在此扩展（如 anthropic_messages）
API_MODE_CHAT_COMPLETIONS = "chat_completions"


@dataclass(frozen=True)
class ProviderCatalogEntry:
    """单个供应商的目录条目（常量，无 I/O）"""

    id: str
    label: str
    base_url: str
    #: 有序候选环境变量名（首个非空生效）
    key_envs: Tuple[str, ...] = ()
    #: False = 本地/无鉴权端点（Ollama/vLLM），未注入 key 也允许探测
    requires_key: bool = True
    api_mode: str = API_MODE_CHAT_COMPLETIONS
    #: 静态兜底模型目录（上游 /models 不可用时回退，仅 UI 下拉用）
    models: Tuple[str, ...] = ()
    #: 自托管/自定义端点：前端允许改写 base_url
    custom: bool = False

    @property
    def key_env(self) -> str:
        """契约字段 ``key_env``（主环境变量名；无鉴权端点可为空串）"""
        return self.key_envs[0] if self.key_envs else ""


PROVIDERS: Tuple[ProviderCatalogEntry, ...] = (
    ProviderCatalogEntry(
        id="openai",
        label="OpenAI",
        base_url="https://api.openai.com/v1",
        key_envs=("KUSTOS_OPENAI_API_KEY",),
        models=("gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"),
    ),
    ProviderCatalogEntry(
        id="deepseek",
        label="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        key_envs=("KUSTOS_DEEPSEEK_API_KEY",),
        models=("deepseek-chat", "deepseek-reasoner"),
    ),
    ProviderCatalogEntry(
        id="moonshot",
        label="Moonshot (Kimi)",
        base_url="https://api.moonshot.ai/v1",
        key_envs=("KUSTOS_MOONSHOT_API_KEY", "KUSTOS_KIMI_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="zai",
        label="智谱 GLM (Z.ai)",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        key_envs=("KUSTOS_ZAI_API_KEY", "KUSTOS_GLM_API_KEY"),
    ),
    # ---- 国内供应商（均为 OpenAI 兼容端点，官方文档核实）----
    ProviderCatalogEntry(
        id="alibaba",
        label="阿里百炼 (通义千问)",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        key_envs=("KUSTOS_DASHSCOPE_API_KEY", "KUSTOS_QWEN_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="volcengine",
        label="火山方舟 (豆包)",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        key_envs=("KUSTOS_ARK_API_KEY", "KUSTOS_DOUBAO_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="siliconflow",
        label="硅基流动 SiliconFlow",
        base_url="https://api.siliconflow.cn/v1",
        key_envs=("KUSTOS_SILICONFLOW_API_KEY",),
    ),
    ProviderCatalogEntry(
        id="minimax",
        label="MiniMax",
        base_url="https://api.minimax.cn/v1",
        key_envs=("KUSTOS_MINIMAX_API_KEY",),
    ),
    ProviderCatalogEntry(
        id="qianfan",
        label="百度千帆",
        base_url="https://qianfan.baidubce.com/v2",
        key_envs=("KUSTOS_QIANFAN_API_KEY", "KUSTOS_BAIDU_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="spark",
        label="讯飞星火",
        base_url="https://spark-api-open.xf-yun.com/v1",
        key_envs=("KUSTOS_SPARK_API_KEY", "KUSTOS_XFYUN_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="xiaomi",
        label="小米 MiMo",
        base_url="https://api.xiaomimimo.com/v1",
        key_envs=("KUSTOS_XIAOMI_API_KEY", "KUSTOS_MIMO_API_KEY"),
    ),
    ProviderCatalogEntry(
        id="stepfun",
        label="阶跃星辰 StepFun",
        base_url="https://api.stepfun.com/v1",
        key_envs=("KUSTOS_STEPFUN_API_KEY",),
    ),
    ProviderCatalogEntry(
        id="ollama",
        label="Ollama（自托管）",
        base_url="http://127.0.0.1:11434/v1",
        key_envs=("KUSTOS_OLLAMA_API_KEY",),
        requires_key=False,
        custom=True,
    ),
    ProviderCatalogEntry(
        id="vllm",
        label="vLLM（自托管）",
        base_url="http://127.0.0.1:8000/v1",
        key_envs=(),
        requires_key=False,
        custom=True,
    ),
)

_BY_ID: Dict[str, ProviderCatalogEntry] = {e.id: e for e in PROVIDERS}


def get_entry(provider_id: Optional[str]) -> Optional[ProviderCatalogEntry]:
    """按 id 取目录条目（忽略大小写与首尾空白）；未知/空 → ``None``"""
    if not provider_id:
        return None
    return _BY_ID.get(str(provider_id).strip().lower())


def catalog_list() -> List[Dict[str, object]]:
    """契约字段 ``providers``（id/label/base_url/models/key_env/custom，
    附加 requires_key/api_mode/key_envs 供前端判断；不含任何 key 值）"""
    return [
        {
            "id": e.id,
            "label": e.label,
            "base_url": e.base_url,
            "models": list(e.models),
            "key_env": e.key_env,
            "key_envs": list(e.key_envs),
            "requires_key": e.requires_key,
            "api_mode": e.api_mode,
            "custom": e.custom,
        }
        for e in PROVIDERS
    ]
