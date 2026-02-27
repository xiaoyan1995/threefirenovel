"""LangGraph Agent Router - 多Agent编排入口"""
import logging
import threading
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from agents.workflow import build_workflow, NovelState
from agents.llm import LLMClient
from db import get_db_path, get_db_with_path
from memory.chunk_manager import ChunkManager
from memory.epa_analyzer import EPAAnalyzer
from memory.meta_thinking import MetaThinking

agent_router = APIRouter()
logger = logging.getLogger(__name__)

# 延迟初始化的全局实例
_workflow = None
_llm = None
_chunk_manager = None
_epa = None
_meta_thinking = None
_services_lock = threading.RLock()


def _get_db_path():
    return get_db_path()


def _reload_llm_services():
    """重建 LLM 及其依赖服务，使 API 配置变更可即时生效。"""
    global _llm, _epa, _meta_thinking
    with _services_lock:
        db_path = _get_db_path()
        _llm = LLMClient(db_path)
        _epa = EPAAnalyzer(_llm)
        _meta_thinking = MetaThinking(_llm)


def _init_services():
    global _workflow, _llm, _chunk_manager, _epa, _meta_thinking
    with _services_lock:
        if _workflow is None:
            db_path = _get_db_path()
            _reload_llm_services()
            try:
                import os
                chroma_path = os.path.join(os.path.dirname(db_path), "chromadb")
                _chunk_manager = ChunkManager(db_path, chroma_path)
            except Exception:
                logger.warning("Failed to initialize ChunkManager, continue without memory retrieval", exc_info=True)
                _chunk_manager = None
            _workflow = build_workflow()
        elif _llm is None or _epa is None or _meta_thinking is None:
            _reload_llm_services()


class AgentRequest(BaseModel):
    project_id: str
    agent_type: str
    message: str
    chapter_id: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None


class AgentResponse(BaseModel):
    content: str
    agent_type: str
    review: Optional[str] = None
    metadata: dict = {}
    resolved_model: str = ""


class TestKeyRequest(BaseModel):
    provider: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None  # 自定义中转站指定测试模型
    relay_id: Optional[str] = None


def _load_project_runtime(project_id: str) -> tuple[str, float]:
    default_model = "claude-sonnet-4"
    default_temp = 0.7
    db_path = _get_db_path()
    if not db_path:
        return default_model, default_temp
    try:
        with get_db_with_path(db_path) as db:
            row = db.execute(
                "SELECT model_main, temperature FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
        if not row:
            return default_model, default_temp
        model = str((row["model_main"] or "")).strip() or default_model
        temp_raw = row["temperature"]
        temp = float(temp_raw) if temp_raw is not None else default_temp
        return model, temp
    except Exception:
        logger.warning("Failed to load project runtime config: project_id=%s", project_id, exc_info=True)
        return default_model, default_temp


@agent_router.post("/invoke", response_model=AgentResponse)
async def invoke_agent(req: AgentRequest):
    """调用指定Agent处理任务"""
    _init_services()

    # 检查Agent是否被禁用
    db_path = _get_db_path()
    try:
        with get_db_with_path(db_path) as db:
            row = db.execute(
                "SELECT enabled FROM agent_configs WHERE project_id = ? AND agent_type = ?",
                (req.project_id, req.agent_type),
            ).fetchone()
        if row and row[0] == 0:
            return AgentResponse(
                content="", agent_type=req.agent_type,
                metadata={"error": "agent_disabled", "message": f"{req.agent_type} 已被禁用"},
            )
    except Exception:
        logger.warning(
            "Failed to check agent enabled state: project_id=%s agent_type=%s",
            req.project_id,
            req.agent_type,
            exc_info=True,
        )

    project_model, project_temp = _load_project_runtime(req.project_id)
    request_model = str(req.model or "").strip()
    request_temp = req.temperature

    logger.info(
        "[AgentInvoke] agent=%s request_model=%r project_model=%r → %r",
        req.agent_type, request_model, project_model,
        request_model or project_model,
    )

    resolved_model = request_model or project_model

    initial_state: NovelState = {
        "project_id": req.project_id,
        "agent_type": req.agent_type,
        "model": resolved_model,
        "temperature": float(request_temp if request_temp is not None else project_temp),
        "user_message": req.message,
        "chapter_id": req.chapter_id,
        "context_chunks": [],
        "draft": "",
        "review_result": {},
        "final_output": "",
        "metadata": {
            "_llm": _llm,
            "_chunk_manager": _chunk_manager,
            "_epa": _epa,
            "_meta_thinking": _meta_thinking,
            "_db_path": _get_db_path(),
        },
    }

    result = await _workflow.ainvoke(initial_state)

    return AgentResponse(
        content=result.get("final_output") or result.get("draft", ""),
        agent_type=req.agent_type,
        review=result.get("review_result", {}).get("review"),
        metadata={"project_id": req.project_id},
        resolved_model=resolved_model,
    )


def close_services():
    """释放服务资源。"""
    global _chunk_manager
    with _services_lock:
        if _chunk_manager is not None:
            try:
                _chunk_manager.close()
            except Exception:
                logger.debug("Failed to close chunk manager", exc_info=True)
            _chunk_manager = None


def _load_saved_provider_auth(provider: str) -> tuple[str, str]:
    db_path = _get_db_path()
    if not db_path:
        return "", ""
    try:
        with get_db_with_path(db_path) as db:
            row = db.execute(
                "SELECT api_key, base_url FROM api_keys WHERE provider = ?",
                (provider,),
            ).fetchone()
        if not row:
            return "", ""
        return str(row["api_key"] or "").strip(), str(row["base_url"] or "").strip()
    except Exception:
        logger.warning("Failed to load saved provider key: provider=%s", provider, exc_info=True)
        return "", ""


def _load_saved_relay_auth(relay_id: str) -> tuple[str, str]:
    db_path = _get_db_path()
    if not db_path:
        return "", ""
    try:
        with get_db_with_path(db_path) as db:
            row = db.execute(
                "SELECT api_key, base_url FROM custom_relays WHERE id = ?",
                (relay_id,),
            ).fetchone()
        if not row:
            return "", ""
        return str(row["api_key"] or "").strip(), str(row["base_url"] or "").strip()
    except Exception:
        logger.warning("Failed to load saved relay key: relay_id=%s", relay_id, exc_info=True)
        return "", ""


def _to_openai_compatible_model(model: str) -> str:
    model_name = str(model or "").strip()
    if not model_name:
        return "openai/gpt-4o-mini"
    if model_name.lower().startswith("openai/"):
        return model_name
    return f"openai/{model_name}"


@agent_router.post("/test-key")
async def test_api_key(req: TestKeyRequest):
    """测试API密钥是否有效"""
    import litellm

    model_map = {
        "openai": "gpt-4o-mini",
        "anthropic": "claude-haiku-3",
        "google": "gemini/gemini-2.0-flash",
        "deepseek": "openai/deepseek-chat",
        "qwen": "openai/qwen-turbo",
        "zhipu": "openai/glm-4-flash",
        "moonshot": "openai/moonshot-v1-8k",
    }

    input_api_key = str(req.api_key or "").strip()
    input_base_url = str(req.base_url or "").strip()
    api_base: Optional[str] = input_base_url or None
    api_key = input_api_key

    input_model = str(req.model or "").strip()

    # 自定义中转站：默认按 OpenAI 兼容接口测试
    if req.provider == "custom":
        test_model = _to_openai_compatible_model(input_model or "gpt-4o-mini")
        if not api_key:
            relay_id = str(req.relay_id or "").strip()
            if relay_id:
                saved_key, saved_base = _load_saved_relay_auth(relay_id)
                api_key = saved_key
                if not api_base:
                    api_base = saved_base or None
    else:
        if input_model:
            # 未知服务商默认按 OpenAI 兼容协议（如 NVIDIA/OpenRouter 等）
            if req.provider in {"deepseek", "qwen", "zhipu", "moonshot"}:
                test_model = _to_openai_compatible_model(input_model)
            elif req.provider == "google":
                test_model = input_model if input_model.startswith("gemini/") else f"gemini/{input_model}"
            elif req.provider == "openai":
                test_model = input_model
            elif req.provider == "anthropic":
                test_model = input_model
            else:
                test_model = _to_openai_compatible_model(input_model)
        else:
            test_model = model_map.get(req.provider, "gpt-4o-mini")
        # 国产模型需要 api_base
        base_url_map = {
            "deepseek": "https://api.deepseek.com",
            "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "zhipu": "https://open.bigmodel.cn/api/paas/v4",
            "moonshot": "https://api.moonshot.cn/v1",
        }
        if not api_base:
            api_base = base_url_map.get(req.provider)
        if not api_key:
            saved_key, saved_base = _load_saved_provider_auth(req.provider)
            api_key = saved_key
            if not input_base_url and saved_base:
                api_base = saved_base

    if not api_key:
        return {"ok": False, "message": "未提供 API Key。请先输入，或先保存密钥后再测试。"}

    try:
        resp = await litellm.acompletion(
            model=test_model,
            messages=[{"role": "user", "content": "Hi"}],
            max_tokens=5,
            api_key=api_key,
            api_base=api_base,
        )
        return {"ok": True, "message": "连接成功"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
