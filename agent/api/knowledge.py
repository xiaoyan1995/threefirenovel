"""知识库导入与规则包（Skill Profile）接口

设计约定：
- 文件夹（collection）= 资料集，可用于提炼规则包
- 单文件（source）= 参考卡，可标注参考类型（角色/情节/场景/世界观/道具/钩子/通用）
"""
from __future__ import annotations

import io
import json
import os
import re
import zipfile
from xml.etree import ElementTree as ET
from typing import Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from db import get_db
from agents import router as agent_router
from agents.default_prompts import KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT

router = APIRouter()

ProfileMode = Literal["rules_only", "rules_plus_examples"]
ReferenceType = Literal["general", "character", "plot", "scene", "world", "item", "hook"]
PROFILE_AGENT_TYPE = "knowledge_profile_builder"
PROFILE_DEFAULT_MODEL = "claude-sonnet-4"
PROFILE_DEFAULT_TEMPERATURE = 0.35
PROFILE_DEFAULT_SYSTEM_PROMPT = KNOWLEDGE_PROFILE_BUILDER_SYSTEM_PROMPT


class CollectionCreateRequest(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=80)
    description: str = ""


class CollectionUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    description: Optional[str] = None


class KnowledgeImportRequest(BaseModel):
    project_id: str
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1)
    source_type: str = "text"
    collection_id: Optional[str] = None
    reference_type: ReferenceType = "general"
    metadata: dict = {}


class KnowledgeImportResponse(BaseModel):
    source_id: str
    chunks_indexed: int
    message: str


class ProfileExtractRequest(BaseModel):
    project_id: str
    name: str = Field(default="通用规则包", min_length=1, max_length=80)
    genre: str = Field(default="", max_length=40)
    collection_id: Optional[str] = None
    source_ids: list[str] = []
    reference_types: list[ReferenceType] = []
    mode: ProfileMode = "rules_only"


class ProfileBindRequest(BaseModel):
    project_id: str
    profile_id: Optional[str] = None
    enabled: bool = True


class SourceUpdateRequest(BaseModel):
    project_id: str
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    collection_id: Optional[str] = None
    reference_type: Optional[ReferenceType] = None
    enabled: Optional[bool] = None


class TemplateCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    category: str = Field(default="", max_length=40)


class TemplateUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    description: Optional[str] = Field(default=None, max_length=500)
    category: Optional[str] = Field(default=None, max_length=40)


class TemplateItemCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1)
    reference_type: ReferenceType = "general"
    metadata: dict = {}


class TemplateItemUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    content: Optional[str] = None
    reference_type: Optional[ReferenceType] = None
    metadata: Optional[dict] = None


class TemplateImportRequest(BaseModel):
    project_id: str
    template_id: str
    collection_name: str = ""


class TemplateFromCollectionRequest(BaseModel):
    project_id: str
    collection_id: str
    name: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=500)
    category: str = Field(default="", max_length=40)


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _safe_reference_type(v: str) -> str:
    vv = (v or "").strip().lower()
    if vv in {"general", "character", "plot", "scene", "world", "item", "hook"}:
        return vv
    return "general"


def _split_text(content: str, chunk_size: int = 700) -> list[str]:
    text = (content or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paras:
        if len(buf) + len(para) + 2 <= chunk_size:
            buf = f"{buf}\n\n{para}".strip()
        else:
            if buf:
                chunks.append(buf)
            if len(para) <= chunk_size:
                buf = para
            else:
                for i in range(0, len(para), chunk_size):
                    chunks.append(para[i:i + chunk_size].strip())
                buf = ""
    if buf:
        chunks.append(buf)
    return [c for c in chunks if c]


def _decode_text_bytes(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "big5"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("latin-1", errors="ignore")


def _extract_docx_text(raw: bytes) -> str:
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraph_tags = {f"{ns}p"}
    text_tags = {f"{ns}t"}
    break_tags = {f"{ns}br", f"{ns}cr"}
    tab_tags = {f"{ns}tab"}
    out: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        for p in root.iter():
            if p.tag not in paragraph_tags:
                continue
            seg: list[str] = []
            for n in p.iter():
                if n.tag in text_tags and n.text:
                    seg.append(n.text)
                elif n.tag in break_tags:
                    seg.append("\n")
                elif n.tag in tab_tags:
                    seg.append("\t")
            line = "".join(seg).strip()
            if line:
                out.append(line)
    except Exception as e:
        raise HTTPException(400, f"DOCX 解析失败: {e}")
    return "\n".join(out).strip()


def _extract_pdf_text(raw: bytes) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        raise HTTPException(400, "当前环境缺少 PDF 解析组件，请安装 pypdf 后重试。")

    try:
        reader = PdfReader(io.BytesIO(raw))
        pages: list[str] = []
        for page in reader.pages:
            txt = (page.extract_text() or "").strip()
            if txt:
                pages.append(txt)
        return "\n\n".join(pages).strip()
    except Exception as e:
        raise HTTPException(400, f"PDF 解析失败: {e}")


def _extract_uploaded_text(filename: str, raw: bytes) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in {".txt", ".md", ".markdown", ".json", ".csv"}:
        return _decode_text_bytes(raw).strip()
    if ext == ".docx":
        return _extract_docx_text(raw)
    if ext == ".pdf":
        return _extract_pdf_text(raw)
    if ext == ".doc":
        raise HTTPException(400, "暂不支持 .doc，请先另存为 .docx 后再导入。")
    raise HTTPException(400, "暂不支持该文件类型，请上传 txt/md/json/csv/docx/pdf。")


def _strip_fence(raw: str) -> str:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_profile(raw: str, name: str, genre: str) -> dict:
    default = {
        "name": name,
        "genre": genre,
        "writing_principles": [],
        "plot_rules": [],
        "character_rules": [],
        "scene_rules": [],
        "world_rules": [],
        "prop_rules": [],
        "hook_rules": [],
        "pacing_rules": [],
        "taboos": [],
        "quality_checklist": [],
        "examples": [],
    }
    text = _strip_fence(raw)
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            merged = {**default, **obj}
            # 兼容历史/第三方命名：item_rules/props_rules -> prop_rules
            if not merged.get("prop_rules"):
                alias = (
                    merged.get("item_rules")
                    or merged.get("props_rules")
                    or merged.get("artifact_rules")
                )
                if isinstance(alias, list):
                    merged["prop_rules"] = alias
            for key in (
                "writing_principles",
                "plot_rules",
                "character_rules",
                "scene_rules",
                "world_rules",
                "prop_rules",
                "hook_rules",
                "pacing_rules",
                "taboos",
                "quality_checklist",
                "examples",
            ):
                value = merged.get(key)
                if isinstance(value, list):
                    merged[key] = [_clip(str(x), 240) for x in value if str(x).strip()]
                elif value is None:
                    merged[key] = []
                else:
                    merged[key] = [_clip(str(value), 240)] if str(value).strip() else []
            return merged
    except Exception:
        pass
    return default


def _get_llm_or_raise():
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(500, "模型服务未初始化")
    return llm


def _load_project(project_id: str):
    with get_db() as db:
        return db.execute(
            "SELECT id, name, genre, model_main FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()


def _load_project_context_for_profile(project_id: str) -> tuple[str, list[str]]:
    """当知识库为空时，回退到项目内部资料作为提炼语料。"""
    with get_db() as db:
        bible = db.execute(
            "SELECT version, content FROM story_bibles "
            "WHERE project_id = ? ORDER BY version DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        outlines = db.execute(
            "SELECT phase, title, content FROM outlines "
            "WHERE project_id = ? ORDER BY phase_order ASC, created_at ASC LIMIT 12",
            (project_id,),
        ).fetchall()
        characters = db.execute(
            "SELECT name, category, gender, age, identity, personality, motivation "
            "FROM characters WHERE project_id = ? "
            "ORDER BY sort_order ASC, created_at ASC LIMIT 16",
            (project_id,),
        ).fetchall()
        worldbuilding = db.execute(
            "SELECT category, title, content FROM worldbuilding "
            "WHERE project_id = ? ORDER BY category ASC, sort_order ASC, created_at ASC LIMIT 16",
            (project_id,),
        ).fetchall()
        chapters = db.execute(
            "SELECT chapter_num, title, synopsis FROM chapters "
            "WHERE project_id = ? AND COALESCE(synopsis, '') != '' "
            "ORDER BY chapter_num ASC LIMIT 24",
            (project_id,),
        ).fetchall()

    blocks: list[str] = []
    pseudo_ids: list[str] = []
    if bible and str(bible["content"] or "").strip():
        blocks.append(f"【小说圣经 v{int(bible['version'] or 1)}】\n{_clip(str(bible['content']), 5200)}")
        pseudo_ids.append("project:bible")
    if outlines:
        lines = ["【现有大纲】"]
        for o in outlines:
            phase = _clip(str(o["phase"] or "").strip(), 4)
            title = _clip(str(o["title"] or "").strip() or "未命名大纲", 40)
            content = _clip(str(o["content"] or "").strip(), 200)
            phase_tag = f"[{phase}] " if phase else ""
            lines.append(f"- {phase_tag}{title}：{content}")
        blocks.append("\n".join(lines))
        pseudo_ids.append("project:outlines")
    if characters:
        lines = ["【现有角色】"]
        for c in characters:
            name = _clip(str(c["name"] or "").strip() or "未命名角色", 24)
            category = _clip(str(c["category"] or "").strip(), 8)
            gender = _clip(str(c["gender"] or "").strip(), 8)
            age = _clip(str(c["age"] or "").strip(), 10)
            identity = _clip(str(c["identity"] or "").strip(), 80)
            personality = _clip(str(c["personality"] or "").strip(), 80)
            motivation = _clip(str(c["motivation"] or "").strip(), 80)
            detail = identity or personality or motivation
            tags = [x for x in (category, gender, age) if x]
            tag = f"（{'/'.join(tags)}）" if tags else ""
            lines.append(f"- {name}{tag}: {detail}")
        blocks.append("\n".join(lines))
        pseudo_ids.append("project:characters")
    if worldbuilding:
        lines = ["【现有世界观】"]
        for w in worldbuilding:
            category = _clip(str(w["category"] or "").strip(), 20)
            title = _clip(str(w["title"] or "").strip() or "未命名设定", 40)
            content = _clip(str(w["content"] or "").strip(), 220)
            cat_tag = f"({category})" if category else ""
            lines.append(f"- {title}{cat_tag}: {content}")
        blocks.append("\n".join(lines))
        pseudo_ids.append("project:worldbuilding")
    if chapters:
        lines = ["【现有章节摘要】"]
        for ch in chapters:
            try:
                num = int(ch["chapter_num"] or 0)
            except Exception:
                num = 0
            title = _clip(str(ch["title"] or f"第{num}章").strip(), 40)
            synopsis = _clip(str(ch["synopsis"] or "").strip(), 180)
            if num > 0:
                lines.append(f"- 第{num}章《{title}》：{synopsis}")
            elif synopsis:
                lines.append(f"- 《{title}》：{synopsis}")
        if len(lines) > 1:
            blocks.append("\n".join(lines))
            pseudo_ids.append("project:chapters")

    return _clip("\n\n".join(blocks), 15000), pseudo_ids


def _normalize_max_tokens(value, default_value: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = int(default_value)
    if parsed <= 0:
        parsed = int(default_value)
    return max(256, min(12000, parsed))


def _load_profile_runtime_config(project_id: str) -> tuple[str, float, str, bool, int]:
    with get_db() as db:
        row = db.execute(
            "SELECT p.model_main, ac.model AS cfg_model, ac.temperature AS cfg_temp, "
            "ac.system_prompt AS cfg_prompt, ac.enabled AS cfg_enabled, ac.max_tokens AS cfg_max_tokens "
            "FROM projects p "
            "LEFT JOIN agent_configs ac "
            "ON ac.project_id = p.id AND ac.agent_type = ? "
            "WHERE p.id = ?",
            (PROFILE_AGENT_TYPE, project_id),
        ).fetchone()
        if not row:
            return PROFILE_DEFAULT_MODEL, PROFILE_DEFAULT_TEMPERATURE, "", True, 2200

        model_name = str((row["cfg_model"] or "").strip() or (row["model_main"] or PROFILE_DEFAULT_MODEL))
        cfg_temp = row["cfg_temp"]
        temperature = float(cfg_temp) if cfg_temp is not None and float(cfg_temp) >= 0 else PROFILE_DEFAULT_TEMPERATURE
        prompt_override = str((row["cfg_prompt"] or "")).strip()
        enabled_raw = row["cfg_enabled"]
        enabled = bool(enabled_raw) if enabled_raw is not None else True
        max_tokens = _normalize_max_tokens(row["cfg_max_tokens"], 2200)
        return model_name, temperature, prompt_override, enabled, max_tokens


def _check_collection_owner(project_id: str, collection_id: str) -> bool:
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM knowledge_collections WHERE id = ? AND project_id = ?",
            (collection_id, project_id),
        ).fetchone()
        return bool(row)


def _safe_json_obj(text: Optional[str]) -> dict:
    try:
        obj = json.loads(text or "{}")
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _pick_import_collection_name(project_id: str, preferred_name: str) -> str:
    base = _clip((preferred_name or "导入资料集").strip() or "导入资料集", 80)
    with get_db() as db:
        rows = db.execute(
            "SELECT name FROM knowledge_collections WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    existing = {str(r["name"]) for r in rows}
    if base not in existing:
        return base
    i = 2
    while True:
        candidate = _clip(f"{base}（导入{i}）", 80)
        if candidate not in existing:
            return candidate
        i += 1


def _save_source_and_index(
    *,
    project_id: str,
    title: str,
    source_type: str,
    collection_id: Optional[str],
    reference_type: str,
    content: str,
    metadata: Optional[dict] = None,
) -> KnowledgeImportResponse:
    ref_type = _safe_reference_type(reference_type)
    clipped_title = _clip(title, 120)
    with get_db() as db:
        row = db.execute(
            "INSERT INTO knowledge_sources "
            "(project_id, title, source_type, collection_id, reference_type, content, metadata, enabled) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 1) "
            "RETURNING id",
            (
                project_id,
                clipped_title,
                _clip(source_type or "text", 30),
                collection_id,
                ref_type,
                content,
                json.dumps(metadata or {}, ensure_ascii=False),
            ),
        ).fetchone()
        source_id = row["id"]

    chunks = _split_text(content)
    indexed = 0
    chunk_manager = agent_router._chunk_manager
    if chunk_manager is not None:
        for chunk in chunks:
            try:
                chunk_manager.add_chunk(
                    project_id=project_id,
                    source_type="knowledge",
                    source_id=source_id,
                    content=chunk,
                    summary=_clip(chunk, 160),
                    importance=0.6,
                    metadata={
                        "source_type": "knowledge",
                        "knowledge_source_id": source_id,
                        "knowledge_title": clipped_title,
                        "collection_id": collection_id or "",
                        "reference_type": ref_type,
                    },
                )
                indexed += 1
            except Exception:
                continue

    return KnowledgeImportResponse(
        source_id=source_id,
        chunks_indexed=indexed,
        message=f"知识文件已导入（类型: {ref_type}），已索引 {indexed} 个片段。",
    )


@router.get("/collections")
def list_collections(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, project_id, name, description, created_at, updated_at "
            "FROM knowledge_collections WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/collections")
def create_collection(req: CollectionCreateRequest):
    agent_router._init_services()
    if not _load_project(req.project_id):
        raise HTTPException(404, "项目不存在")
    with get_db() as db:
        row = db.execute(
            "INSERT INTO knowledge_collections (project_id, name, description) "
            "VALUES (?, ?, ?) "
            "RETURNING id, project_id, name, description, created_at, updated_at",
            (req.project_id, _clip(req.name, 80), _clip(req.description, 500)),
        ).fetchone()
        return dict(row)


@router.put("/collections/{collection_id}")
def update_collection(collection_id: str, req: CollectionUpdateRequest):
    with get_db() as db:
        row = db.execute(
            "SELECT id, project_id, name, description FROM knowledge_collections WHERE id = ?",
            (collection_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "资料集不存在")
        name = _clip(req.name if req.name is not None else row["name"], 80)
        desc = _clip(req.description if req.description is not None else (row["description"] or ""), 500)
        db.execute(
            "UPDATE knowledge_collections SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?",
            (name, desc, collection_id),
        )
        updated = db.execute(
            "SELECT id, project_id, name, description, created_at, updated_at "
            "FROM knowledge_collections WHERE id = ?",
            (collection_id,),
        ).fetchone()
        return dict(updated)


@router.delete("/collections/{collection_id}")
def delete_collection(collection_id: str):
    with get_db() as db:
        row = db.execute("SELECT id FROM knowledge_collections WHERE id = ?", (collection_id,)).fetchone()
        if not row:
            return {"deleted": False}
        db.execute(
            "UPDATE knowledge_sources SET collection_id = NULL WHERE collection_id = ?",
            (collection_id,),
        )
        db.execute("DELETE FROM knowledge_collections WHERE id = ?", (collection_id,))
    return {"deleted": True}


@router.get("/template-library/templates")
def list_global_templates():
    with get_db() as db:
        rows = db.execute(
            "SELECT t.id, t.name, t.description, t.category, t.created_at, t.updated_at, "
            "COALESCE(COUNT(i.id), 0) AS item_count "
            "FROM global_knowledge_templates t "
            "LEFT JOIN global_knowledge_template_items i ON i.template_id = t.id "
            "GROUP BY t.id "
            "ORDER BY t.updated_at DESC, t.created_at DESC",
        ).fetchall()
        return [dict(r) for r in rows]


@router.get("/template-library/templates/{template_id}")
def get_global_template(template_id: str):
    with get_db() as db:
        tpl = db.execute(
            "SELECT t.id, t.name, t.description, t.category, t.created_at, t.updated_at, "
            "COALESCE(COUNT(i.id), 0) AS item_count "
            "FROM global_knowledge_templates t "
            "LEFT JOIN global_knowledge_template_items i ON i.template_id = t.id "
            "WHERE t.id = ? GROUP BY t.id",
            (template_id,),
        ).fetchone()
        if not tpl:
            raise HTTPException(404, "模板不存在")

        items = db.execute(
            "SELECT id, template_id, title, reference_type, content, metadata, created_at, updated_at "
            "FROM global_knowledge_template_items WHERE template_id = ? "
            "ORDER BY created_at DESC",
            (template_id,),
        ).fetchall()
        result = dict(tpl)
        result["items"] = [dict(r) for r in items]
        return result


@router.post("/template-library/templates")
def create_global_template(req: TemplateCreateRequest):
    with get_db() as db:
        row = db.execute(
            "INSERT INTO global_knowledge_templates (name, description, category) "
            "VALUES (?, ?, ?) "
            "RETURNING id, name, description, category, created_at, updated_at",
            (
                _clip(req.name, 80),
                _clip(req.description, 500),
                _clip(req.category, 40),
            ),
        ).fetchone()
        result = dict(row)
        result["item_count"] = 0
        result["items"] = []
        return result


@router.put("/template-library/templates/{template_id}")
def update_global_template(template_id: str, req: TemplateUpdateRequest):
    payload = req.model_dump(exclude_unset=True)
    if not payload:
        raise HTTPException(400, "无更新字段")

    with get_db() as db:
        row = db.execute(
            "SELECT id, name, description, category FROM global_knowledge_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "模板不存在")

        name = _clip(req.name if req.name is not None else row["name"], 80)
        description = _clip(req.description if req.description is not None else (row["description"] or ""), 500)
        category = _clip(req.category if req.category is not None else (row["category"] or ""), 40)
        db.execute(
            "UPDATE global_knowledge_templates "
            "SET name = ?, description = ?, category = ?, updated_at = datetime('now') "
            "WHERE id = ?",
            (name, description, category, template_id),
        )

        updated = db.execute(
            "SELECT t.id, t.name, t.description, t.category, t.created_at, t.updated_at, "
            "COALESCE(COUNT(i.id), 0) AS item_count "
            "FROM global_knowledge_templates t "
            "LEFT JOIN global_knowledge_template_items i ON i.template_id = t.id "
            "WHERE t.id = ? GROUP BY t.id",
            (template_id,),
        ).fetchone()
        return dict(updated)


@router.delete("/template-library/templates/{template_id}")
def delete_global_template(template_id: str):
    with get_db() as db:
        row = db.execute("SELECT id FROM global_knowledge_templates WHERE id = ?", (template_id,)).fetchone()
        if not row:
            return {"deleted": False}
        db.execute("DELETE FROM global_knowledge_templates WHERE id = ?", (template_id,))
    return {"deleted": True}


@router.post("/template-library/templates/{template_id}/items")
def create_global_template_item(template_id: str, req: TemplateItemCreateRequest):
    ref_type = _safe_reference_type(req.reference_type)
    with get_db() as db:
        tpl = db.execute("SELECT id FROM global_knowledge_templates WHERE id = ?", (template_id,)).fetchone()
        if not tpl:
            raise HTTPException(404, "模板不存在")

        row = db.execute(
            "INSERT INTO global_knowledge_template_items "
            "(template_id, title, reference_type, content, metadata) "
            "VALUES (?, ?, ?, ?, ?) "
            "RETURNING id, template_id, title, reference_type, content, metadata, created_at, updated_at",
            (
                template_id,
                _clip(req.title, 120),
                ref_type,
                req.content,
                json.dumps(req.metadata or {}, ensure_ascii=False),
            ),
        ).fetchone()
        db.execute(
            "UPDATE global_knowledge_templates SET updated_at = datetime('now') WHERE id = ?",
            (template_id,),
        )
        return dict(row)


@router.put("/template-library/items/{item_id}")
def update_global_template_item(item_id: str, req: TemplateItemUpdateRequest):
    payload = req.model_dump(exclude_unset=True)
    if not payload:
        raise HTTPException(400, "无更新字段")

    with get_db() as db:
        row = db.execute(
            "SELECT id, template_id, title, reference_type, content, metadata "
            "FROM global_knowledge_template_items WHERE id = ?",
            (item_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "模板条目不存在")

        next_title = _clip(req.title if req.title is not None else row["title"], 120)
        next_content = req.content if req.content is not None else row["content"]
        next_ref_type = _safe_reference_type(req.reference_type) if req.reference_type is not None else _safe_reference_type(row["reference_type"])
        next_metadata = req.metadata if req.metadata is not None else _safe_json_obj(row["metadata"])

        db.execute(
            "UPDATE global_knowledge_template_items "
            "SET title = ?, reference_type = ?, content = ?, metadata = ?, updated_at = datetime('now') "
            "WHERE id = ?",
            (
                next_title,
                next_ref_type,
                next_content,
                json.dumps(next_metadata, ensure_ascii=False),
                item_id,
            ),
        )
        db.execute(
            "UPDATE global_knowledge_templates SET updated_at = datetime('now') WHERE id = ?",
            (row["template_id"],),
        )
        updated = db.execute(
            "SELECT id, template_id, title, reference_type, content, metadata, created_at, updated_at "
            "FROM global_knowledge_template_items WHERE id = ?",
            (item_id,),
        ).fetchone()
        return dict(updated)


@router.delete("/template-library/items/{item_id}")
def delete_global_template_item(item_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT id, template_id FROM global_knowledge_template_items WHERE id = ?",
            (item_id,),
        ).fetchone()
        if not row:
            return {"deleted": False}
        db.execute("DELETE FROM global_knowledge_template_items WHERE id = ?", (item_id,))
        db.execute(
            "UPDATE global_knowledge_templates SET updated_at = datetime('now') WHERE id = ?",
            (row["template_id"],),
        )
    return {"deleted": True}


@router.post("/template-library/import")
def import_global_template(req: TemplateImportRequest):
    agent_router._init_services()
    if not _load_project(req.project_id):
        raise HTTPException(404, "项目不存在")

    with get_db() as db:
        tpl = db.execute(
            "SELECT id, name, description, category FROM global_knowledge_templates WHERE id = ?",
            (req.template_id,),
        ).fetchone()
        if not tpl:
            raise HTTPException(404, "模板不存在")

        items = db.execute(
            "SELECT id, title, reference_type, content, metadata "
            "FROM global_knowledge_template_items WHERE template_id = ? "
            "ORDER BY created_at ASC",
            (req.template_id,),
        ).fetchall()
        if not items:
            raise HTTPException(400, "模板为空，请先添加条目")

        picked_name = _pick_import_collection_name(
            req.project_id,
            req.collection_name.strip() or str(tpl["name"]),
        )
        coll = db.execute(
            "INSERT INTO knowledge_collections (project_id, name, description) "
            "VALUES (?, ?, ?) "
            "RETURNING id, name",
            (
                req.project_id,
                picked_name,
                _clip(f"导入自全局模板：{tpl['name']}", 500),
            ),
        ).fetchone()
        collection_id = coll["id"]
        collection_name = coll["name"]

    imported = 0
    for it in items:
        item_meta = _safe_json_obj(it["metadata"])
        item_meta.update(
            {
                "from_global_template_id": req.template_id,
                "from_global_template_name": tpl["name"],
                "from_global_template_item_id": it["id"],
            }
        )
        _save_source_and_index(
            project_id=req.project_id,
            title=str(it["title"]),
            source_type="template",
            collection_id=collection_id,
            reference_type=str(it["reference_type"] or "general"),
            content=str(it["content"] or ""),
            metadata=item_meta,
        )
        imported += 1

    return {
        "collection_id": collection_id,
        "collection_name": collection_name,
        "template_id": req.template_id,
        "template_name": tpl["name"],
        "imported": imported,
    }


@router.post("/template-library/create-from-collection")
def create_global_template_from_collection(req: TemplateFromCollectionRequest):
    if not _load_project(req.project_id):
        raise HTTPException(404, "项目不存在")
    if not _check_collection_owner(req.project_id, req.collection_id):
        raise HTTPException(400, "collection_id 不属于当前项目")

    with get_db() as db:
        coll = db.execute(
            "SELECT id, name, description FROM knowledge_collections "
            "WHERE id = ? AND project_id = ?",
            (req.collection_id, req.project_id),
        ).fetchone()
        if not coll:
            raise HTTPException(404, "资料集不存在")

        rows = db.execute(
            "SELECT title, reference_type, content, metadata "
            "FROM knowledge_sources WHERE project_id = ? AND collection_id = ? AND enabled = 1 "
            "ORDER BY created_at ASC",
            (req.project_id, req.collection_id),
        ).fetchall()
        if not rows:
            raise HTTPException(400, "该资料集暂无可导出的已启用文件")

        template_name = _clip((req.name or "").strip() or f"{coll['name']}模板", 80)
        template_desc = _clip((req.description or "").strip() or f"来自项目资料集：{coll['name']}", 500)
        template_category = _clip((req.category or "").strip(), 40)
        tpl = db.execute(
            "INSERT INTO global_knowledge_templates (name, description, category) "
            "VALUES (?, ?, ?) "
            "RETURNING id, name, description, category, created_at, updated_at",
            (template_name, template_desc, template_category),
        ).fetchone()
        template_id = tpl["id"]

        for r in rows:
            src_meta = _safe_json_obj(r["metadata"])
            src_meta.update(
                {
                    "from_project_id": req.project_id,
                    "from_collection_id": req.collection_id,
                    "from_collection_name": coll["name"],
                }
            )
            db.execute(
                "INSERT INTO global_knowledge_template_items "
                "(template_id, title, reference_type, content, metadata) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    template_id,
                    _clip(str(r["title"] or "未命名"), 120),
                    _safe_reference_type(str(r["reference_type"] or "general")),
                    str(r["content"] or ""),
                    json.dumps(src_meta, ensure_ascii=False),
                ),
            )

        count = db.execute(
            "SELECT COUNT(*) AS c FROM global_knowledge_template_items WHERE template_id = ?",
            (template_id,),
        ).fetchone()["c"]
        result = dict(tpl)
        result["item_count"] = int(count or 0)
        return result


@router.post("/import", response_model=KnowledgeImportResponse)
async def import_knowledge(req: KnowledgeImportRequest):
    agent_router._init_services()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    if req.collection_id and (not _check_collection_owner(req.project_id, req.collection_id)):
        raise HTTPException(400, "collection_id 不属于当前项目")

    return _save_source_and_index(
        project_id=req.project_id,
        title=req.title,
        source_type=req.source_type or "text",
        collection_id=req.collection_id,
        reference_type=req.reference_type,
        content=req.content,
        metadata=req.metadata or {},
    )


@router.post("/import-file", response_model=KnowledgeImportResponse)
async def import_knowledge_file(
    project_id: str = Form(...),
    title: str = Form(default=""),
    collection_id: Optional[str] = Form(default=None),
    reference_type: str = Form(default="general"),
    file: UploadFile = File(...),
):
    agent_router._init_services()
    if not _load_project(project_id):
        raise HTTPException(404, "项目不存在")

    if collection_id == "":
        collection_id = None

    if collection_id and (not _check_collection_owner(project_id, collection_id)):
        raise HTTPException(400, "collection_id 不属于当前项目")

    filename = file.filename or "未命名文件"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "上传文件为空")

    parsed_text = _extract_uploaded_text(filename, raw)
    if not parsed_text.strip():
        raise HTTPException(400, "未从文件中解析出可用文本")

    inferred_title = os.path.splitext(filename)[0] or "未命名文件"
    source_title = _clip((title or "").strip() or inferred_title, 120)
    source_type = (os.path.splitext(filename)[1].lower().lstrip(".") or "file")[:30]

    return _save_source_and_index(
        project_id=project_id,
        title=source_title,
        source_type=source_type,
        collection_id=collection_id,
        reference_type=reference_type,
        content=parsed_text,
        metadata={
            "upload_name": filename,
            "upload_ext": os.path.splitext(filename)[1].lower(),
            "import_mode": "file",
        },
    )


@router.get("/sources")
def list_sources(project_id: str, collection_id: Optional[str] = None):
    with get_db() as db:
        if collection_id:
            rows = db.execute(
                "SELECT id, title, source_type, collection_id, reference_type, enabled, created_at, "
                "substr(content, 1, 260) AS preview_text "
                "FROM knowledge_sources "
                "WHERE project_id = ? AND collection_id = ? "
                "ORDER BY created_at DESC",
                (project_id, collection_id),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id, title, source_type, collection_id, reference_type, enabled, created_at, "
                "substr(content, 1, 260) AS preview_text "
                "FROM knowledge_sources "
                "WHERE project_id = ? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows]


@router.put("/sources/{source_id}/reference-type")
def update_source_reference_type(source_id: str, project_id: str, reference_type: ReferenceType):
    ref_type = _safe_reference_type(reference_type)
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM knowledge_sources WHERE id = ? AND project_id = ?",
            (source_id, project_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "知识文件不存在")
        db.execute(
            "UPDATE knowledge_sources SET reference_type = ? WHERE id = ?",
            (ref_type, source_id),
        )
    return {"source_id": source_id, "reference_type": ref_type}


@router.put("/sources/{source_id}")
def update_source(source_id: str, req: SourceUpdateRequest):
    payload = req.model_dump(exclude_unset=True)
    fields = [k for k in payload.keys() if k != "project_id"]
    if not fields:
        raise HTTPException(400, "无更新字段")

    with get_db() as db:
        row = db.execute(
            "SELECT id, project_id, title, collection_id, reference_type, enabled "
            "FROM knowledge_sources WHERE id = ? AND project_id = ?",
            (source_id, req.project_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "知识文件不存在")

        next_title = _clip(req.title if req.title is not None else row["title"], 120)

        if "collection_id" in payload:
            next_collection = req.collection_id
            if next_collection and (not _check_collection_owner(req.project_id, next_collection)):
                raise HTTPException(400, "collection_id 不属于当前项目")
        else:
            next_collection = row["collection_id"]

        next_ref_type = (
            _safe_reference_type(req.reference_type)
            if req.reference_type is not None
            else _safe_reference_type(row["reference_type"])
        )
        next_enabled = (1 if req.enabled else 0) if req.enabled is not None else int(row["enabled"] or 0)

        db.execute(
            "UPDATE knowledge_sources SET title = ?, collection_id = ?, reference_type = ?, enabled = ? WHERE id = ?",
            (next_title, next_collection, next_ref_type, next_enabled, source_id),
        )
        updated = db.execute(
            "SELECT id, title, source_type, collection_id, reference_type, enabled, created_at "
            "FROM knowledge_sources WHERE id = ?",
            (source_id,),
        ).fetchone()
        return dict(updated)


@router.delete("/sources/{source_id}")
def delete_source(source_id: str, project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM knowledge_sources WHERE id = ? AND project_id = ?",
            (source_id, project_id),
        ).fetchone()
        if not row:
            return {"deleted": False}

        db.execute("DELETE FROM knowledge_sources WHERE id = ?", (source_id,))
        # 清理该知识源关联的 chunk（如果存在）
        try:
            db.execute(
                "DELETE FROM memory_chunks WHERE source_type = 'knowledge' AND source_id = ?",
                (source_id,),
            )
        except Exception:
            pass
    return {"deleted": True}


@router.post("/profile/extract")
async def extract_profile(req: ProfileExtractRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    model_name, temperature, prompt_override, enabled, max_tokens = _load_profile_runtime_config(req.project_id)
    if not enabled:
        raise HTTPException(403, "规则包提炼已在项目设置中禁用")

    if req.collection_id and (not _check_collection_owner(req.project_id, req.collection_id)):
        raise HTTPException(400, "collection_id 不属于当前项目")

    with get_db() as db:
        rows = []
        if req.source_ids:
            placeholders = ",".join(["?"] * len(req.source_ids))
            params = [req.project_id, *req.source_ids]
            rows = db.execute(
                f"SELECT id, title, reference_type, content FROM knowledge_sources "
                f"WHERE project_id = ? AND id IN ({placeholders}) AND enabled = 1 "
                f"ORDER BY created_at DESC",
                params,
            ).fetchall()
        elif req.collection_id:
            rows = db.execute(
                "SELECT id, title, reference_type, content FROM knowledge_sources "
                "WHERE project_id = ? AND collection_id = ? AND enabled = 1 "
                "ORDER BY created_at DESC",
                (req.project_id, req.collection_id),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id, title, reference_type, content FROM knowledge_sources "
                "WHERE project_id = ? AND enabled = 1 ORDER BY created_at DESC LIMIT 12",
                (req.project_id,),
            ).fetchall()

    if req.reference_types:
        type_set = set(req.reference_types)
        rows = [r for r in rows if r["reference_type"] in type_set]

    source_ids: list[str] = []
    corpus = ""
    source_origin = ""
    if rows:
        source_ids = [r["id"] for r in rows]
        corpus_blocks = []
        for r in rows:
            corpus_blocks.append(
                f"【{r['title']}｜类型:{r['reference_type']}】\n{_clip(str(r['content']), 2200)}"
            )
        corpus = _clip("\n\n".join(corpus_blocks), 15000)
        source_origin = f"知识库资料（{len(rows)}份）"
    else:
        fallback_corpus, fallback_ids = _load_project_context_for_profile(req.project_id)
        source_ids = fallback_ids or ["project:meta"]
        source_origin = "项目内资料回退（圣经/角色/世界观/大纲/章节摘要）"
        corpus = _clip(fallback_corpus, 15000)
        if not corpus.strip():
            corpus = _clip(
                f"【项目题材】{project['genre'] or '未指定'}\n"
                f"【项目名称】{project['name'] or '未命名项目'}\n"
                "【项目上下文】当前未找到可引用的已生成内容，请按题材与项目信息生成规则包。",
                15000,
            )
            source_origin = "项目元信息回退"

    prompt = f"""
请从以下小说资料中提炼可执行“写作规则包”，输出严格 JSON。

规则包名称：{req.name}
题材：{req.genre or project['genre'] or '未指定'}
模式：{req.mode}
资料来源：{source_origin}

资料：
{corpus}

JSON 字段要求：
{{
  "name": "规则包名称",
  "genre": "题材",
  "writing_principles": ["写作原则1", "..."],
  "plot_rules": ["情节规则1", "..."],
  "character_rules": ["角色塑造规则1", "..."],
  "scene_rules": ["场景描写规则1", "..."],
  "world_rules": ["世界观规则1", "..."],
  "prop_rules": ["道具/物品规则1", "..."],
  "hook_rules": ["开篇/章节钩子规则1", "..."],
  "pacing_rules": ["节奏规则1", "..."],
  "taboos": ["禁忌1", "..."],
  "quality_checklist": ["质检项1", "..."],
  "examples": ["可选简短例子，最多3条，每条<120字"]
}}

要求：
1) 只抽象规律，不复刻原文情节。
2) 规则要覆盖不同参考类型，不局限某单一类型。
3) prop_rules（道具法则）必须给出 3-8 条，且可检查可执行；至少覆盖：来源与获取门槛、持有与使用限制、代价/冷却/损耗、丢失或损毁后的影响、回收闭环。
4) 若资料中道具信息较少，也要输出“通用但可执行”的道具治理法则，不得留空。
5) 仅输出 JSON，不要解释。
""".strip()

    system_prompt = prompt_override or PROFILE_DEFAULT_SYSTEM_PROMPT

    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.0), 1.0),
            max_tokens=max_tokens,
        )
    except Exception as e:
        raise HTTPException(500, f"规则提炼失败: {e}")

    profile = _parse_profile(raw, req.name, req.genre or project["genre"] or "")
    if not isinstance(profile.get("prop_rules"), list) or not profile.get("prop_rules"):
        # 二次补全：确保道具法则由 AI 生成，不依赖手工填写
        prop_prompt = f"""
请仅补全“道具法则”，输出严格 JSON：
{{
  "prop_rules": ["规则1", "..."]
}}

项目题材：{req.genre or project['genre'] or '未指定'}
规则包名称：{req.name}
资料：
{corpus}

要求：
1) 返回 3-8 条可执行规则；
2) 每条规则必须可判定（必须/禁止/触发条件/阈值）；
3) 覆盖：来源、归属、能力边界、代价或冷却、损耗、升级、丢失/被夺、回收；
4) 只输出 JSON，不要解释。
""".strip()
        try:
            prop_raw = await llm.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prop_prompt},
                ],
                temperature=min(max(temperature, 0.0), 0.8),
                max_tokens=max(512, min(max_tokens, 1800)),
            )
            prop_profile = _parse_profile(prop_raw, req.name, req.genre or project["genre"] or "")
            prop_rules = prop_profile.get("prop_rules")
            if isinstance(prop_rules, list) and prop_rules:
                profile["prop_rules"] = [_clip(str(x), 240) for x in prop_rules if str(x).strip()][:8]
        except Exception:
            pass
    summary = "；".join([str(x) for x in profile.get("writing_principles", [])[:3]])

    with get_db() as db:
        v = db.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM knowledge_profiles "
            "WHERE project_id = ? AND name = ?",
            (req.project_id, req.name),
        ).fetchone()["v"]
        next_version = int(v) + 1
        saved = db.execute(
            "INSERT INTO knowledge_profiles "
            "(project_id, name, genre, version, collection_id, profile_json, text_summary, source_ids) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "RETURNING id, project_id, name, genre, version, collection_id, profile_json, text_summary, source_ids, created_at, updated_at",
            (
                req.project_id,
                req.name,
                req.genre or (project["genre"] or ""),
                next_version,
                req.collection_id,
                json.dumps(profile, ensure_ascii=False),
                _clip(summary, 500),
                json.dumps(source_ids, ensure_ascii=False),
            ),
        ).fetchone()
        return dict(saved)


@router.get("/profiles")
def list_profiles(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, genre, version, collection_id, text_summary, source_ids, created_at, updated_at "
            "FROM knowledge_profiles WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: str, project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT id FROM knowledge_profiles WHERE id = ? AND project_id = ?",
            (profile_id, project_id),
        ).fetchone()
        if not row:
            return {"deleted": False}

        # 若该规则包正在绑定，先断开绑定
        db.execute(
            "UPDATE project_profile_binding SET profile_id = NULL, enabled = 0, updated_at = datetime('now') "
            "WHERE project_id = ? AND profile_id = ?",
            (project_id, profile_id),
        )
        db.execute("DELETE FROM knowledge_profiles WHERE id = ?", (profile_id,))
    return {"deleted": True}


@router.post("/profile/bind")
def bind_profile(req: ProfileBindRequest):
    with get_db() as db:
        if req.profile_id:
            p = db.execute(
                "SELECT id FROM knowledge_profiles WHERE id = ? AND project_id = ?",
                (req.profile_id, req.project_id),
            ).fetchone()
            if not p:
                raise HTTPException(404, "规则包不存在")

        db.execute(
            "INSERT INTO project_profile_binding (project_id, profile_id, enabled, updated_at) "
            "VALUES (?, ?, ?, datetime('now')) "
            "ON CONFLICT(project_id) DO UPDATE SET "
            "profile_id = excluded.profile_id, "
            "enabled = excluded.enabled, "
            "updated_at = datetime('now')",
            (req.project_id, req.profile_id, 1 if req.enabled else 0),
        )

        row = db.execute(
            "SELECT project_id, profile_id, enabled, updated_at "
            "FROM project_profile_binding WHERE project_id = ?",
            (req.project_id,),
        ).fetchone()
        return dict(row)


@router.get("/profile/active")
def get_active_profile(project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT b.project_id, b.profile_id, b.enabled, b.updated_at, "
            "p.name, p.genre, p.version, p.collection_id, p.profile_json, p.text_summary "
            "FROM project_profile_binding b "
            "LEFT JOIN knowledge_profiles p ON p.id = b.profile_id "
            "WHERE b.project_id = ?",
            (project_id,),
        ).fetchone()
        if not row:
            return None
        result = dict(row)
        try:
            result["profile_json"] = json.loads(result.get("profile_json") or "{}")
        except Exception:
            result["profile_json"] = {}
        return result
