"""LLM provider 适配器测试（OpenAI 兼容 + 密钥脱敏）"""
import httpx
import pytest
import respx

from app.services.agent import providers
from app.services.agent.providers import (
    ModelReply,
    NotConfiguredProvider,
    OpenAICompatProvider,
    ProviderNotConfigured,
)


class TestOpenAICompatProvider:
    @pytest.mark.asyncio
    async def test_parses_tool_calls(self):
        with respx.mock() as mock:
            route = mock.post("https://api.test/v1/chat/completions").mock(
                return_value=httpx.Response(200, json={
                    "choices": [{
                        "message": {
                            "content": None,
                            "tool_calls": [{
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "search_code", "arguments": '{"query": "foo"}'},
                            }],
                        }
                    }],
                    "usage": {"total_tokens": 10},
                })
            )
            provider = OpenAICompatProvider(
                api_key="sk-secret", base_url="https://api.test/v1", model="m"
            )
            reply = await provider.complete(
                [{"role": "user", "content": "hi"}],
                [{"type": "function", "function": {"name": "search_code", "parameters": {}}}],
            )
            assert isinstance(reply, ModelReply)
            assert reply.tool_calls[0].name == "search_code"
            assert reply.tool_calls[0].arguments == {"query": "foo"}
            assert route.calls[0].request.headers["authorization"] == "Bearer sk-secret"
            assert "sk-secret" not in repr(provider)

    @pytest.mark.asyncio
    async def test_parses_plain_answer(self):
        with respx.mock() as mock:
            mock.post("https://api.test/v1/chat/completions").mock(
                return_value=httpx.Response(200, json={
                    "choices": [{"message": {"content": "答案"}}]
                })
            )
            provider = OpenAICompatProvider(api_key="k", base_url="https://api.test/v1", model="m")
            reply = await provider.complete([{"role": "user", "content": "q"}], [])
            assert reply.content == "答案"
            assert reply.tool_calls == []


class TestProviderFactory:
    def test_no_key_returns_not_configured(self, monkeypatch):
        providers.reset_provider()
        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        assert isinstance(providers.get_provider(), NotConfiguredProvider)

    @pytest.mark.asyncio
    async def test_not_configured_raises(self):
        with pytest.raises(ProviderNotConfigured):
            await NotConfiguredProvider().complete([], [])

    def test_injected_provider_takes_precedence(self, monkeypatch):
        providers.reset_provider()
        fake = object()
        providers.set_provider(fake)
        try:
            assert providers.get_provider(api_key="ignored") is fake
        finally:
            providers.reset_provider()
