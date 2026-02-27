"""设置 API — API密钥 / 全局配置 / Agent配置 / 自定义中转站"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from db import get_db
from agents import router as agent_router
from agents import prompts
from agents.default_prompts import (
    WRITER_ASSISTANT_CHAT_SYSTEM_PROMPT,
    CONFLICT_REVIEW_SYSTEM_PROMPT,
    NER_EXTRACTOR_SYSTEM_PROMPT,
    BUTTERFLY_SIMULATOR_SYSTEM_PROMPT,
    DEBATE_ROOM_SYSTEM_PROMPT,
    KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT,
    PIPELINE_BRAINSTORM_SYSTEM_PROMPT,
    PIPELINE_AUTOFILL_SYSTEM_PROMPT,
    PIPELINE_BIBLE_GENERATE_SYSTEM_PROMPT,
    PIPELINE_BOOTSTRAP_SYSTEM_PROMPT,
)

router = APIRouter()

DEFAULT_PROVIDER_CONFIGS = [
    {
        "provider": "openai",
        "label": "OpenAI",
        "color": "#10A37F",
        "base_url": "https://api.openai.com/v1",
        "sort_order": 1,
    },
    {
        "provider": "anthropic",
        "label": "Anthropic",
        "color": "#D4A574",
        "base_url": "https://api.anthropic.com",
        "sort_order": 2,
    },
    {
        "provider": "google",
        "label": "Google Gemini",
        "color": "#4285F4",
        "base_url": "",
        "sort_order": 3,
    },
    {
        "provider": "deepseek",
        "label": "DeepSeek",
        "color": "#5B6EF5",
        "base_url": "https://api.deepseek.com",
        "sort_order": 4,
    },
    {
        "provider": "qwen",
        "label": "通义千问",
        "color": "#6236FF",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "sort_order": 5,
    },
    {
        "provider": "zhipu",
        "label": "智谱 GLM",
        "color": "#3366FF",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "sort_order": 6,
    },
    {
        "provider": "moonshot",
        "label": "月之暗面",
        "color": "#000000",
        "base_url": "https://api.moonshot.cn/v1",
        "sort_order": 7,
    },
    {
        "provider": "custom",
        "label": "自定义中转",
        "color": "#FF6B35",
        "base_url": "",
        "sort_order": 90,
    },
]

DEFAULT_MODEL_CONFIGS = [
    {"provider": "openai", "model_id": "gpt-4o", "model_label": "GPT-4o", "sort_order": 1},
    {"provider": "openai", "model_id": "gpt-4o-mini", "model_label": "GPT-4o Mini", "sort_order": 2},
    {"provider": "openai", "model_id": "gpt-4-turbo", "model_label": "GPT-4 Turbo", "sort_order": 3},
    {"provider": "openai", "model_id": "o1", "model_label": "o1", "sort_order": 4},
    {"provider": "openai", "model_id": "o1-mini", "model_label": "o1-mini", "sort_order": 5},
    {"provider": "anthropic", "model_id": "claude-opus-4", "model_label": "Claude Opus 4", "sort_order": 1},
    {"provider": "anthropic", "model_id": "claude-sonnet-4", "model_label": "Claude Sonnet 4", "sort_order": 2},
    {"provider": "anthropic", "model_id": "claude-haiku-3", "model_label": "Claude Haiku 3", "sort_order": 3},
    {"provider": "google", "model_id": "gemini-2.5-pro", "model_label": "Gemini 2.5 Pro", "sort_order": 1},
    {"provider": "google", "model_id": "gemini-2.0-flash", "model_label": "Gemini 2.0 Flash", "sort_order": 2},
    {"provider": "google", "model_id": "gemini-2.0-flash-lite", "model_label": "Gemini 2.0 Flash Lite", "sort_order": 3},
    {"provider": "deepseek", "model_id": "deepseek-chat", "model_label": "DeepSeek Chat", "sort_order": 1},
    {"provider": "deepseek", "model_id": "deepseek-reasoner", "model_label": "DeepSeek Reasoner", "sort_order": 2},
    {"provider": "qwen", "model_id": "qwen-max", "model_label": "Qwen Max", "sort_order": 1},
    {"provider": "qwen", "model_id": "qwen-plus", "model_label": "Qwen Plus", "sort_order": 2},
    {"provider": "qwen", "model_id": "qwen-turbo", "model_label": "Qwen Turbo", "sort_order": 3},
    {"provider": "qwen", "model_id": "qwen-long", "model_label": "Qwen Long", "sort_order": 4},
    {"provider": "zhipu", "model_id": "glm-4-plus", "model_label": "GLM-4-Plus", "sort_order": 1},
    {"provider": "zhipu", "model_id": "glm-4-flash", "model_label": "GLM-4-Flash", "sort_order": 2},
    {"provider": "zhipu", "model_id": "glm-4-long", "model_label": "GLM-4-Long", "sort_order": 3},
    {"provider": "moonshot", "model_id": "moonshot-v1-128k", "model_label": "Moonshot v1 128k", "sort_order": 1},
    {"provider": "moonshot", "model_id": "moonshot-v1-32k", "model_label": "Moonshot v1 32k", "sort_order": 2},
    {"provider": "moonshot", "model_id": "moonshot-v1-8k", "model_label": "Moonshot v1 8k", "sort_order": 3},
]

DEFAULT_NER_SYSTEM_PROMPT = NER_EXTRACTOR_SYSTEM_PROMPT
DEFAULT_CONFLICT_REVIEW_PROMPT = CONFLICT_REVIEW_SYSTEM_PROMPT
DEFAULT_BUTTERFLY_SYSTEM_PROMPT = BUTTERFLY_SIMULATOR_SYSTEM_PROMPT
DEFAULT_DEBATE_ROOM_PROMPT = DEBATE_ROOM_SYSTEM_PROMPT
DEFAULT_KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT = KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT
DEFAULT_PIPELINE_BRAINSTORM_PROMPT = PIPELINE_BRAINSTORM_SYSTEM_PROMPT
DEFAULT_PIPELINE_AUTOFILL_PROMPT = PIPELINE_AUTOFILL_SYSTEM_PROMPT
DEFAULT_PIPELINE_BIBLE_PROMPT = PIPELINE_BIBLE_GENERATE_SYSTEM_PROMPT
DEFAULT_PIPELINE_BOOTSTRAP_PROMPT = PIPELINE_BOOTSTRAP_SYSTEM_PROMPT


def _ensure_default_provider_configs(db):
    existing = {
        row["provider"]
        for row in db.execute("SELECT provider FROM provider_configs").fetchall()
    }
    for item in DEFAULT_PROVIDER_CONFIGS:
        if item["provider"] in existing:
            continue
        db.execute(
            "INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order) "
            "VALUES (?,?,?,?,1,0,?)",
            (
                item["provider"],
                item["label"],
                item["color"],
                item["base_url"],
                item["sort_order"],
            ),
        )


def _ensure_default_model_configs(db):
    existing = {
        (row["provider"], row["model_id"])
        for row in db.execute("SELECT provider, model_id FROM model_configs").fetchall()
    }
    for item in DEFAULT_MODEL_CONFIGS:
        key = (item["provider"], item["model_id"])
        if key in existing:
            continue
        db.execute(
            "INSERT INTO model_configs (provider, model_id, model_label, visible, is_custom, sort_order) "
            "VALUES (?,?,?,1,0,?)",
            (
                item["provider"],
                item["model_id"],
                item["model_label"],
                item["sort_order"],
            ),
        )


def _normalize_model_id(value: str | None, default: str = "gpt-4o-mini") -> str:
    model_id = str(value or "").strip()
    return model_id or default


def _ensure_custom_provider_and_model(db, model_id: str):
    model = _normalize_model_id(model_id)
    provider_row = db.execute(
        "SELECT id FROM provider_configs WHERE provider = 'custom' LIMIT 1"
    ).fetchone()
    if not provider_row:
        db.execute(
            "INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order) "
            "VALUES ('custom', '自定义中转', '#FF6B35', '', 1, 0, 90)"
        )

    model_row = db.execute(
        "SELECT id FROM model_configs WHERE provider = 'custom' AND model_id = ? LIMIT 1",
        (model,),
    ).fetchone()
    if model_row:
        db.execute(
            "UPDATE model_configs SET model_label = ?, visible = 1, updated_at = datetime('now') WHERE id = ?",
            (model, model_row["id"]),
        )
    else:
        db.execute(
            "INSERT INTO model_configs (provider, model_id, model_label, visible, is_custom, sort_order) "
            "VALUES ('custom', ?, ?, 1, 1, 0)",
            (model, model),
        )


def _sync_custom_models_from_relays(db):
    """让 custom 模型列表与当前中转站 test_model 一致，避免出现历史残留模型。"""
    relay_rows = db.execute(
        "SELECT test_model FROM custom_relays WHERE enabled = 1"
    ).fetchall()
    relay_models = sorted(
        {
            _normalize_model_id(str(row["test_model"] or ""))
            for row in relay_rows
            if _normalize_model_id(str(row["test_model"] or ""))
        }
    )

    if relay_models:
        provider_row = db.execute(
            "SELECT id FROM provider_configs WHERE provider = 'custom' LIMIT 1"
        ).fetchone()
        if not provider_row:
            db.execute(
                "INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order) "
                "VALUES ('custom', '自定义中转', '#FF6B35', '', 1, 0, 90)"
            )

        for model in relay_models:
            row = db.execute(
                "SELECT id FROM model_configs WHERE provider = 'custom' AND model_id = ? LIMIT 1",
                (model,),
            ).fetchone()
            if row:
                db.execute(
                    "UPDATE model_configs SET model_label = ?, visible = 1, updated_at = datetime('now') WHERE id = ?",
                    (model, row["id"]),
                )
            else:
                db.execute(
                    "INSERT INTO model_configs (provider, model_id, model_label, visible, is_custom, sort_order) "
                    "VALUES ('custom', ?, ?, 1, 1, 0)",
                    (model, model),
                )

        placeholders = ",".join(["?"] * len(relay_models))
        db.execute(
            f"DELETE FROM model_configs WHERE provider = 'custom' AND is_custom = 1 AND model_id NOT IN ({placeholders})",
            relay_models,
        )
    else:
        db.execute(
            "DELETE FROM model_configs WHERE provider = 'custom' AND is_custom = 1"
        )


# ========== API 密钥 ==========

class ApiKeyUpsert(BaseModel):
    provider: str
    api_key: Optional[str] = None
    base_url: str = ""


def _mask_api_key_row(row):
    data = dict(row)
    data["has_key"] = bool(str(data.get("api_key") or "").strip())
    data.pop("api_key", None)
    return data


@router.get("/api-keys")
def list_api_keys():
    with get_db() as db:
        rows = db.execute("SELECT provider, api_key, base_url, status, last_tested FROM api_keys").fetchall()
        return [_mask_api_key_row(r) for r in rows]


@router.post("/api-keys")
def upsert_api_key(req: ApiKeyUpsert):
    incoming_key = str(req.api_key or "").strip()
    with get_db() as db:
        existing = db.execute(
            "SELECT provider FROM api_keys WHERE provider = ?",
            (req.provider,),
        ).fetchone()
        if not incoming_key and not existing:
            raise HTTPException(400, "api_key 不能为空")
        db.execute(
            "INSERT INTO api_keys (provider, api_key, base_url) VALUES (?,?,?) "
            "ON CONFLICT(provider) DO UPDATE SET "
            "api_key=CASE WHEN excluded.api_key = '' THEN api_keys.api_key ELSE excluded.api_key END, "
            "base_url=excluded.base_url",
            (req.provider, incoming_key, req.base_url),
        )
    agent_router._reload_llm_services()
    return {"ok": True}


@router.delete("/api-keys/{provider}")
def delete_api_key(provider: str):
    with get_db() as db:
        db.execute("DELETE FROM api_keys WHERE provider = ?", (provider,))
    agent_router._reload_llm_services()
    return {"ok": True}


# ========== 全局设置 ==========

@router.get("/global")
def get_global_settings():
    with get_db() as db:
        rows = db.execute("SELECT key, value FROM global_settings").fetchall()
        return {r["key"]: r["value"] for r in rows}


@router.post("/global")
def save_global_settings(data: dict):
    with get_db() as db:
        for k, v in data.items():
            db.execute(
                "INSERT INTO global_settings (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, str(v)),
            )
    agent_router._reload_llm_services()
    return {"ok": True}


# ========== Agent 独立配置 ==========

class AgentConfigUpsert(BaseModel):
    project_id: str
    agent_type: str
    model: str = ""
    temperature: Optional[float] = None
    system_prompt: str = ""
    max_tokens: int = 4096
    enabled: bool = True


@router.get("/agent-configs")
def list_agent_configs(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM agent_configs WHERE project_id = ?", (project_id,)
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/agent-configs")
def upsert_agent_config(req: AgentConfigUpsert):
    with get_db() as db:
        db.execute(
            "INSERT INTO agent_configs (project_id, agent_type, model, temperature, system_prompt, max_tokens, enabled) "
            "VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT(project_id, agent_type) DO UPDATE SET "
            "model=excluded.model, temperature=excluded.temperature, system_prompt=excluded.system_prompt, "
            "max_tokens=excluded.max_tokens, enabled=excluded.enabled",
            (req.project_id, req.agent_type, req.model, req.temperature,
             req.system_prompt, req.max_tokens, 1 if req.enabled else 0),
        )
        return {"ok": True}


# ========== 自定义中转站 ==========

class RelayCreate(BaseModel):
    name: str
    base_url: str
    api_key: str
    test_model: str = "gpt-4o-mini"


class RelayUpdate(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    test_model: Optional[str] = None
    enabled: Optional[bool] = None
    priority: Optional[int] = None


@router.get("/relays")
def list_relays():
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, base_url, api_key, test_model, enabled, priority, created_at FROM custom_relays ORDER BY priority DESC"
        ).fetchall()
        return [_mask_api_key_row(r) for r in rows]


@router.post("/relays")
def create_relay(req: RelayCreate):
    relay_model = _normalize_model_id(req.test_model)
    with get_db() as db:
        db.execute(
            "INSERT INTO custom_relays (name, base_url, api_key, test_model) VALUES (?,?,?,?)",
            (req.name, req.base_url, req.api_key, relay_model),
        )
        _sync_custom_models_from_relays(db)
        row = db.execute("SELECT * FROM custom_relays ORDER BY created_at DESC LIMIT 1").fetchone()
    agent_router._reload_llm_services()
    return _mask_api_key_row(row)


@router.put("/relays/{relay_id}")
def update_relay(relay_id: str, req: RelayUpdate):
    updates, values = [], []
    for field, val in req.model_dump(exclude_none=True).items():
        if field == "enabled":
            val = 1 if val else 0
        if field == "test_model":
            val = _normalize_model_id(str(val or ""))
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        return {"ok": True}
    values.append(relay_id)
    with get_db() as db:
        db.execute(f"UPDATE custom_relays SET {', '.join(updates)} WHERE id = ?", values)
        _sync_custom_models_from_relays(db)
    agent_router._reload_llm_services()
    return {"ok": True}


@router.delete("/relays/{relay_id}")
def delete_relay(relay_id: str):
    with get_db() as db:
        db.execute("DELETE FROM custom_relays WHERE id = ?", (relay_id,))
        _sync_custom_models_from_relays(db)
    agent_router._reload_llm_services()
    return {"ok": True}


@router.get("/agent-default-prompts")
def list_agent_default_prompts():
    return {
        "writer_assistant": WRITER_ASSISTANT_CHAT_SYSTEM_PROMPT,
        "conflict_reviewer": DEFAULT_CONFLICT_REVIEW_PROMPT,
        "outline_writer": prompts.OUTLINE_WRITER,
        "character_designer": prompts.CHARACTER_DESIGNER,
        "chapter_writer": prompts.CHAPTER_WRITER,
        "reviewer": prompts.REVIEWER,
        "editor": prompts.EDITOR,
        "ner_extractor": DEFAULT_NER_SYSTEM_PROMPT,
        "debate_room": DEFAULT_DEBATE_ROOM_PROMPT,
        "butterfly_simulator": DEFAULT_BUTTERFLY_SYSTEM_PROMPT,
        "knowledge_profile_builder": DEFAULT_KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT,
        "pipeline_brainstorm": DEFAULT_PIPELINE_BRAINSTORM_PROMPT,
        "pipeline_autofill": DEFAULT_PIPELINE_AUTOFILL_PROMPT,
        "pipeline_bible_generate": DEFAULT_PIPELINE_BIBLE_PROMPT,
        "pipeline_bootstrap": DEFAULT_PIPELINE_BOOTSTRAP_PROMPT,
    }


# ========== 模型配置 ==========

class ModelConfigCreate(BaseModel):
    provider: str
    model_id: str
    model_label: str
    visible: bool = True
    sort_order: int = 0


class ModelConfigUpdate(BaseModel):
    model_label: Optional[str] = None
    visible: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get("/model-configs")
def list_model_configs():
    """获取所有模型配置"""
    with get_db() as db:
        _ensure_default_provider_configs(db)
        _ensure_default_model_configs(db)
        _sync_custom_models_from_relays(db)
        rows = db.execute(
            "SELECT * FROM model_configs ORDER BY provider, sort_order"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/model-configs")
def create_model_config(req: ModelConfigCreate):
    """添加新模型"""
    with get_db() as db:
        db.execute(
            "INSERT INTO model_configs (provider, model_id, model_label, visible, is_custom, sort_order) "
            "VALUES (?,?,?,?,1,?)",
            (req.provider, req.model_id, req.model_label, 1 if req.visible else 0, req.sort_order),
        )
        row = db.execute("SELECT * FROM model_configs ORDER BY created_at DESC LIMIT 1").fetchone()
        return dict(row)


@router.put("/model-configs/{config_id}")
def update_model_config(config_id: str, req: ModelConfigUpdate):
    """更新模型配置（包括可见性）"""
    updates, values = [], []
    for field, val in req.model_dump(exclude_none=True).items():
        if field == "visible":
            val = 1 if val else 0
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        return {"ok": True}

    updates.append("updated_at = datetime('now')")
    values.append(config_id)

    with get_db() as db:
        db.execute(f"UPDATE model_configs SET {', '.join(updates)} WHERE id = ?", values)
        return {"ok": True}


@router.delete("/model-configs/{config_id}")
def delete_model_config(config_id: str):
    """删除模型配置（仅限用户自定义模型）"""
    with get_db() as db:
        # 只允许删除用户自定义的模型
        db.execute("DELETE FROM model_configs WHERE id = ? AND is_custom = 1", (config_id,))
        return {"ok": True}


# ========== 服务商配置 ==========

class ProviderConfigCreate(BaseModel):
    provider: str
    label: str
    color: str = "#666666"
    base_url: str = ""
    visible: bool = True
    sort_order: int = 0


class ProviderConfigUpdate(BaseModel):
    label: Optional[str] = None
    color: Optional[str] = None
    base_url: Optional[str] = None
    visible: Optional[bool] = None
    sort_order: Optional[int] = None


@router.get("/provider-configs")
def list_provider_configs():
    """获取所有服务商配置"""
    with get_db() as db:
        _ensure_default_provider_configs(db)
        rows = db.execute(
            "SELECT * FROM provider_configs ORDER BY sort_order"
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/provider-configs")
def create_provider_config(req: ProviderConfigCreate):
    """添加新服务商"""
    with get_db() as db:
        db.execute(
            "INSERT INTO provider_configs (provider, label, color, base_url, visible, is_custom, sort_order) "
            "VALUES (?,?,?,?,?,1,?)",
            (req.provider, req.label, req.color, req.base_url, 1 if req.visible else 0, req.sort_order),
        )
        row = db.execute("SELECT * FROM provider_configs ORDER BY created_at DESC LIMIT 1").fetchone()
        return dict(row)


@router.put("/provider-configs/{config_id}")
def update_provider_config(config_id: str, req: ProviderConfigUpdate):
    """更新服务商配置（包括可见性）"""
    updates, values = [], []
    for field, val in req.model_dump(exclude_none=True).items():
        if field == "visible":
            val = 1 if val else 0
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        return {"ok": True}

    updates.append("updated_at = datetime('now')")
    values.append(config_id)

    with get_db() as db:
        db.execute(f"UPDATE provider_configs SET {', '.join(updates)} WHERE id = ?", values)
        return {"ok": True}


@router.delete("/provider-configs/{config_id}")
def delete_provider_config(config_id: str):
    """删除服务商配置（仅限用户自定义服务商）"""
    with get_db() as db:
        # 只允许删除用户自定义的服务商
        db.execute("DELETE FROM provider_configs WHERE id = ? AND is_custom = 1", (config_id,))
        return {"ok": True}
