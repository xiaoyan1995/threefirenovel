"""LiteLLM统一接口 - 支持OpenAI/Anthropic/Google/DeepSeek/Qwen/Zhipu/Moonshot"""
import logging
import os
import threading
import litellm
from typing import Any, AsyncIterator, Optional
from db import get_db_with_path

# 国产模型 provider → LiteLLM model prefix 映射
# DeepSeek/Qwen/Zhipu/Moonshot 均兼容 OpenAI 接口，通过 openai/ prefix + api_base 调用
PROVIDER_ENV_MAP = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "qwen": "QWEN_API_KEY",
    "zhipu": "ZHIPU_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
}

logger = logging.getLogger(__name__)


def _supports_optional_kwargs_retry(exc: Exception) -> bool:
    text = str(exc or "").lower()
    if not text:
        return False
    # 常见“参数不支持/未知字段”错误信号。
    return (
        "response_format" in text
        or "unknown parameter" in text
        or "unexpected keyword" in text
        or "not supported" in text
        or "unsupported" in text
        or "invalid request" in text
    )


def _extract_message_content(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
                continue
            if isinstance(part, dict):
                txt = part.get("text")
                if not isinstance(txt, str) or not txt:
                    txt = part.get("content")
                if isinstance(txt, str) and txt:
                    parts.append(txt)
        return "".join(parts)
    return str(content or "")


class LLMClient:
    """统一LLM调用客户端，从数据库读取API配置"""
    _reload_lock = threading.Lock()

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._provider_keys: dict[str, dict] = {}
        self._global_config: dict = {}
        self._load_keys()
        self._load_global_config()

    def _load_keys(self):
        """从api_keys表加载所有密钥"""
        with self._reload_lock:
            for env_key in PROVIDER_ENV_MAP.values():
                os.environ.pop(env_key, None)
            try:
                litellm.api_key = None
                litellm.api_base = None
            except Exception:
                logger.debug("Failed to reset LiteLLM global API state", exc_info=True)

            self._provider_keys = {}
            try:
                with get_db_with_path(self.db_path) as db:
                    rows = db.execute("SELECT provider, api_key, base_url FROM api_keys").fetchall()
                for row in rows:
                    p = row["provider"]
                    self._provider_keys[p] = {"api_key": row["api_key"], "base_url": row["base_url"]}
                    # 设置环境变量供 LiteLLM 使用
                    env_key = PROVIDER_ENV_MAP.get(p)
                    if env_key:
                        os.environ[env_key] = row["api_key"]
                    # OpenAI 特殊处理
                    if p == "openai":
                        litellm.api_key = row["api_key"]
                        if row["base_url"]:
                            litellm.api_base = row["base_url"]
            except Exception:
                logger.warning("Failed to load API keys from database", exc_info=True)

            # 加载自定义中转站
            self._custom_relays: list[dict] = []
            try:
                with get_db_with_path(self.db_path) as db:
                    rows = db.execute(
                        "SELECT name, api_key, base_url FROM custom_relays WHERE enabled = 1"
                    ).fetchall()
                self._custom_relays = [dict(r) for r in rows]
            except Exception:
                logger.warning("Failed to load custom relays from database", exc_info=True)

    def _load_global_config(self):
        """从global_settings表加载通用配置"""
        with self._reload_lock:
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                os.environ.pop(key, None)
            try:
                with get_db_with_path(self.db_path) as db:
                    rows = db.execute("SELECT key, value FROM global_settings").fetchall()
                self._global_config = {row["key"]: row["value"] for row in rows}
                # 设置HTTP代理
                proxy = self._global_config.get("http_proxy", "")
                if proxy:
                    os.environ["HTTP_PROXY"] = proxy
                    os.environ["HTTPS_PROXY"] = proxy
            except Exception:
                logger.warning("Failed to load global settings from database", exc_info=True)

    def _has_direct_key(self, provider: str) -> bool:
        """检查是否有某个 provider 的直连 API key"""
        cfg = self._provider_keys.get(provider, {})
        return bool(str((cfg or {}).get("api_key", "")).strip())

    def _relay_fallback(self, model: str, kwargs: dict) -> tuple[str, dict] | None:
        """若有可用的自定义中转站，返回中转路由；否则返回 None"""
        if self._custom_relays:
            relay = self._custom_relays[0]
            return f"openai/{model}", {**kwargs, "api_key": relay["api_key"], "api_base": relay["base_url"]}
        return None

    def _resolve_model(self, model: str) -> tuple[str, dict]:
        """解析模型名 → (litellm_model, extra_kwargs)
        国产模型通过 openai/ prefix + api_base 路由到对应服务商。
        若直连 key 缺失但有自定义中转站，自动走中转。
        """
        kwargs: dict = {}
        timeout = int(self._global_config.get("timeout", 60))
        kwargs["timeout"] = timeout

        # DeepSeek 模型
        if model.startswith("deepseek-"):
            cfg = self._provider_keys.get("deepseek", {})
            if str((cfg or {}).get("api_key", "")).strip():
                return f"openai/{model}", {**kwargs, "api_key": cfg["api_key"], "api_base": cfg.get("base_url", "https://api.deepseek.com")}
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # 通义千问
        if model.startswith("qwen-"):
            cfg = self._provider_keys.get("qwen", {})
            if str((cfg or {}).get("api_key", "")).strip():
                return f"openai/{model}", {**kwargs, "api_key": cfg["api_key"], "api_base": cfg.get("base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1")}
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # 智谱GLM
        if model.startswith("glm-"):
            cfg = self._provider_keys.get("zhipu", {})
            if str((cfg or {}).get("api_key", "")).strip():
                return f"openai/{model}", {**kwargs, "api_key": cfg["api_key"], "api_base": cfg.get("base_url", "https://open.bigmodel.cn/api/paas/v4")}
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # 月之暗面
        if model.startswith("moonshot-"):
            cfg = self._provider_keys.get("moonshot", {})
            if str((cfg or {}).get("api_key", "")).strip():
                return f"openai/{model}", {**kwargs, "api_key": cfg["api_key"], "api_base": cfg.get("base_url", "https://api.moonshot.cn/v1")}
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # Gemini 需要 gemini/ prefix
        if model.startswith("gemini-"):
            if self._has_direct_key("google"):
                return f"gemini/{model}", kwargs
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # OpenAI / Anthropic 原生模型 — 有直连 key 时直传，否则走中转
        if model.startswith(("gpt-", "o1")):
            if self._has_direct_key("openai"):
                return model, kwargs
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        if model.startswith("claude-"):
            if self._has_direct_key("anthropic"):
                return model, kwargs
            fb = self._relay_fallback(model, kwargs)
            if fb:
                return fb

        # 未匹配到已知 provider → 尝试通过第一个可用的自定义中转站路由
        if self._custom_relays:
            relay = self._custom_relays[0]
            return f"openai/{model}", {**kwargs, "api_key": relay["api_key"], "api_base": relay["base_url"]}

        # 兜底：直接传给 LiteLLM 尝试
        return model, kwargs

    async def chat(
        self,
        model: str,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        **completion_kwargs,
    ) -> str:
        """调用LLM并返回文本"""
        resolved_model, extra = self._resolve_model(model)
        request_extra = {**extra, **completion_kwargs}
        logger.info(
            "[LLM.chat] input_model=%r → resolved=%r api_base=%s has_api_key=%s extra_keys=%s",
            model, resolved_model,
            extra.get("api_base", "(default)"),
            bool(extra.get("api_key")),
            ",".join(sorted(completion_kwargs.keys())) if completion_kwargs else "-",
        )
        try:
            resp = await litellm.acompletion(
                model=resolved_model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                **request_extra,
            )
        except Exception as exc:
            if completion_kwargs and _supports_optional_kwargs_retry(exc):
                logger.warning(
                    "[LLM.chat] optional completion kwargs unsupported; retrying without extras: model=%r keys=%s err=%s",
                    resolved_model,
                    ",".join(sorted(completion_kwargs.keys())),
                    exc,
                )
                resp = await litellm.acompletion(
                    model=resolved_model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    **extra,
                )
            else:
                raise
        return _extract_message_content(resp.choices[0].message)

    async def chat_stream(
        self,
        model: str,
        messages: list[dict],
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        """流式调用LLM并返回token增量
        注意：当前调用方使用 `async for x in await chat_stream(...)`，
        所以这里返回一个异步迭代器对象。
        """
        resolved_model, extra = self._resolve_model(model)
        stream = await litellm.acompletion(
            model=resolved_model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
            **extra,
        )

        async def _gen():
            async for chunk in stream:
                text = ""
                try:
                    delta = chunk.choices[0].delta
                    # 兼容 dict/object 两种 delta 形态
                    if isinstance(delta, dict):
                        text = delta.get("content") or ""
                    else:
                        text = getattr(delta, "content", "") or ""
                except Exception:
                    text = ""
                if text:
                    yield text

        return _gen()

    async def embed(self, texts: list[str], model: str = "text-embedding-3-small") -> list[list[float]]:
        """生成embedding向量"""
        resp = await litellm.aembedding(model=model, input=texts)
        return [item["embedding"] for item in resp.data]
