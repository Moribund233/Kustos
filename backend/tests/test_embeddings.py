"""embedding 适配器测试"""
import httpx
import pytest
import respx

from app.services.indexing import embeddings
from app.services.indexing.embeddings import (
    NotConfiguredEmbeddingProvider,
    OpenAICompatEmbeddingProvider,
)


class TestOpenAICompatEmbedding:
    @pytest.mark.asyncio
    async def test_parses_embeddings(self):
        with respx.mock() as mock:
            route = mock.post("https://api.test/v1/embeddings").mock(
                return_value=httpx.Response(200, json={
                    "data": [
                        {"index": 1, "embedding": [0.0, 1.0]},
                        {"index": 0, "embedding": [1.0, 0.0]},
                    ]
                })
            )
            provider = OpenAICompatEmbeddingProvider(
                api_key="sk-secret", base_url="https://api.test/v1", model="m", dim=2
            )
            out = await provider.embed(["a", "b"])
            assert out == [[1.0, 0.0], [0.0, 1.0]]  # 按 index 排序
            assert route.calls[0].request.headers["authorization"] == "Bearer sk-secret"
            assert "sk-secret" not in repr(provider)

    @pytest.mark.asyncio
    async def test_empty_input(self):
        provider = OpenAICompatEmbeddingProvider(api_key="k", base_url="x", model="m", dim=2)
        assert await provider.embed([]) == []


class TestEmbeddingFactory:
    def test_no_key_returns_not_configured(self, monkeypatch):
        embeddings.reset_embedding_provider()
        monkeypatch.delenv("KUSTOS_AGENT_API_KEY", raising=False)
        assert isinstance(embeddings.get_embedding_provider(), NotConfiguredEmbeddingProvider)
        assert embeddings.is_configured(embeddings.get_embedding_provider()) is False

    def test_override(self):
        embeddings.reset_embedding_provider()
        marker = object()
        embeddings.set_embedding_provider(marker)
        try:
            assert embeddings.get_embedding_provider(api_key="x") is marker
            assert embeddings.is_configured(marker) is True
        finally:
            embeddings.reset_embedding_provider()
