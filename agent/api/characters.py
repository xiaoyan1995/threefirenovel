"""角色 CRUD API"""
import json
import logging
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Optional
from agents import router as agent_router
from db import get_db

router = APIRouter()
logger = logging.getLogger(__name__)


def _clip(text: str, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[:limit]


def _normalize_gender_value(raw: str) -> str:
    v = str(raw or "").strip()
    if not v:
        return "男"
    lowered = v.lower()
    if any(k in v for k in ("非二元", "双性", "中性", "无性")) or any(
        k in lowered for k in ("non-binary", "nonbinary", "nb")
    ):
        return "非二元"
    if "女" in v or any(k in lowered for k in ("female", "woman", "girl")):
        return "女"
    if "男" in v or any(k in lowered for k in ("male", "man", "boy")):
        return "男"
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(
        k in lowered for k in ("unknown", "unspecified", "not specified")
    ):
        return "男"
    return _clip(v, 12) or "男"


def _normalize_category_value(raw: str) -> str:
    v = str(raw or "").strip()
    if v in {"主角", "反派", "配角", "其他"}:
        return v
    if "主" in v:
        return "主角"
    if "反" in v:
        return "反派"
    if "配" in v:
        return "配角"
    return "其他"


def _normalize_age_value(raw: str) -> str:
    v = re.sub(r"\s+", "", str(raw or "").strip())
    if not v:
        return "18"
    lowered = v.lower()
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(
        k in lowered for k in ("unknown", "unspecified", "notspecified", "n/a", "na")
    ):
        return "18"
    if re.fullmatch(r"\d{1,3}", v):
        try:
            parsed = int(v)
            if 0 < parsed < 160:
                return str(parsed)
        except Exception:
            pass
    range_match = re.fullmatch(r"(\d{1,3})[~\-～到](\d{1,3})(?:岁)?", v)
    if range_match:
        try:
            left = int(range_match.group(1))
            right = int(range_match.group(2))
            if 0 < left < 160 and 0 < right < 160:
                return str(int(round((left + right) / 2)))
        except Exception:
            pass
    m = re.search(r"(\d{1,3})", v)
    if m:
        try:
            parsed = int(m.group(1))
            if 0 < parsed < 160:
                return str(parsed)
        except Exception:
            pass
    return "18"


def _normalize_character_row(row: dict) -> dict:
    data = dict(row)
    data["category"] = _normalize_category_value(str(data.get("category") or ""))
    data["gender"] = _normalize_gender_value(str(data.get("gender") or ""))
    data["age"] = _normalize_age_value(str(data.get("age") or ""))
    return data


def _normalize_name_key(name: str) -> str:
    return re.sub(r"\s+", "", str(name or "").strip()).lower()


def _ensure_unique_character_name(raw_name: str, existing_names: set[str]) -> str:
    base = _clip(str(raw_name or "").strip(), 30) or "新角色"
    if _normalize_name_key(base) not in existing_names:
        return base
    for idx in range(2, 200):
        candidate = _clip(f"{base}{idx}", 30)
        if _normalize_name_key(candidate) not in existing_names:
            return candidate
    return _clip(f"{base}{len(existing_names) + 1}", 30)


def _strip_fence(raw: str) -> str:
    text = str(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _extract_json_object(raw: str) -> str:
    text = _strip_fence(raw)
    if not text:
        return ""
    if text.startswith("{") and text.endswith("}"):
        return text
    start = text.find("{")
    if start < 0:
        return ""
    depth = 0
    for idx in range(start, len(text)):
        ch = text[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return ""


def _pick_str_alias(data: dict[str, Any], keys: tuple[str, ...], default: str = "") -> str:
    for key in keys:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return default


def _parse_ai_character_payload(raw: str) -> dict[str, str]:
    json_text = _extract_json_object(raw)
    if not json_text:
        return {}
    try:
        payload = json.loads(json_text)
    except Exception:
        return {}
    if not isinstance(payload, dict):
        return {}
    merged: dict[str, Any] = {}
    for key in ("character", "profile", "角色", "角色档案", "人物", "data"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            merged.update(nested)
    merged.update(payload)
    return {
        "name": _clip(_pick_str_alias(merged, ("name", "character_name", "姓名", "角色名"), ""), 30),
        "category": _normalize_category_value(_pick_str_alias(merged, ("category", "role", "角色定位", "角色类型"), "配角")),
        "gender": _normalize_gender_value(_pick_str_alias(merged, ("gender", "sex", "性别"), "男")),
        "age": _normalize_age_value(_pick_str_alias(merged, ("age", "年龄"), "18")),
        "identity": _clip(_pick_str_alias(merged, ("identity", "身份", "职业"), ""), 120),
        "appearance": _clip(_pick_str_alias(merged, ("appearance", "外貌", "外形"), ""), 600),
        "personality": _clip(_pick_str_alias(merged, ("personality", "性格"), ""), 600),
        "motivation": _clip(_pick_str_alias(merged, ("motivation", "动机", "目标"), ""), 300),
        "backstory": _clip(_pick_str_alias(merged, ("backstory", "背景", "经历"), ""), 600),
        "arc": _clip(_pick_str_alias(merged, ("arc", "弧线", "成长弧线"), ""), 300),
        "usage_notes": _clip(_pick_str_alias(merged, ("usage_notes", "usage_advice", "使用建议"), ""), 600),
    }


class CharacterCreate(BaseModel):
    project_id: str
    name: str
    category: str = "配角"
    gender: str = ""
    age: str = ""
    identity: str = ""
    appearance: str = ""
    personality: str = ""
    motivation: str = ""
    backstory: str = ""
    arc: str = ""
    usage_notes: str = ""


class CharacterAIGenerateRequest(BaseModel):
    project_id: str
    brief: str = ""
    category_hint: str = ""


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    gender: Optional[str] = None
    age: Optional[str] = None
    identity: Optional[str] = None
    appearance: Optional[str] = None
    personality: Optional[str] = None
    motivation: Optional[str] = None
    backstory: Optional[str] = None
    arc: Optional[str] = None
    usage_notes: Optional[str] = None
    status: Optional[str] = None


class CharacterRelationInput(BaseModel):
    target_id: str
    relation_type: str = ""
    description: str = ""


class CharacterRelationsUpdate(BaseModel):
    relations: list[CharacterRelationInput] = Field(default_factory=list)


@router.get("/")
def list_characters(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM characters WHERE project_id = ? ORDER BY sort_order, created_at",
            (project_id,),
        ).fetchall()
        return [_normalize_character_row(dict(r)) for r in rows]


@router.post("/")
def create_character(req: CharacterCreate):
    gender = _normalize_gender_value(req.gender)
    age = _normalize_age_value(req.age)
    category = _normalize_category_value(req.category)
    with get_db() as db:
        db.execute(
            "INSERT INTO characters (project_id, name, category, gender, age, identity, "
            "appearance, personality, motivation, backstory, arc, usage_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (req.project_id, req.name, category, gender, age, req.identity,
             req.appearance, req.personality, req.motivation, req.backstory, req.arc, req.usage_notes),
        )
        row = db.execute("SELECT * FROM characters WHERE rowid = last_insert_rowid()").fetchone()
        return _normalize_character_row(dict(row))


@router.post("/ai-generate")
async def generate_single_character(req: CharacterAIGenerateRequest):
    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(500, "模型服务未初始化")

    with get_db() as db:
        project = db.execute(
            "SELECT id, name, genre, description, structure, custom_structure, word_target, model_main, temperature "
            "FROM projects WHERE id = ?",
            (req.project_id,),
        ).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")

        existing_rows = db.execute(
            "SELECT name, category, gender, age, identity, personality, motivation "
            "FROM characters WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 24",
            (req.project_id,),
        ).fetchall()
        outline_rows = db.execute(
            "SELECT phase, title, content FROM outlines WHERE project_id = ? ORDER BY phase_order ASC, created_at ASC LIMIT 8",
            (req.project_id,),
        ).fetchall()
        world_rows = db.execute(
            "SELECT category, title, content FROM worldbuilding WHERE project_id = ? "
            "ORDER BY category ASC, sort_order ASC, created_at ASC LIMIT 8",
            (req.project_id,),
        ).fetchall()
        latest_bible = None
        try:
            latest_bible = db.execute(
                "SELECT version, content FROM story_bibles WHERE project_id = ? ORDER BY version DESC LIMIT 1",
                (req.project_id,),
            ).fetchone()
        except Exception:
            latest_bible = None

    existing_names = [str(r["name"] or "").strip() for r in existing_rows if str(r["name"] or "").strip()]
    existing_name_keys = {_normalize_name_key(name) for name in existing_names}
    existing_name_hint = "、".join(existing_names[:20]) if existing_names else "无"

    character_context_lines: list[str] = []
    for row in existing_rows[:10]:
        name = _clip(str(row["name"] or "").strip(), 20)
        if not name:
            continue
        category = _normalize_category_value(str(row["category"] or ""))
        gender = _normalize_gender_value(str(row["gender"] or ""))
        age = _normalize_age_value(str(row["age"] or ""))
        identity = _clip(str(row["identity"] or "").strip(), 60)
        personality = _clip(str(row["personality"] or "").strip(), 60)
        motivation = _clip(str(row["motivation"] or "").strip(), 60)
        detail = identity or personality or motivation
        character_context_lines.append(f"- {name}({category}/{gender}/{age})：{detail}")
    characters_block = "\n".join(character_context_lines) if character_context_lines else "- 暂无已有角色"

    outline_context_lines: list[str] = []
    for row in outline_rows[:6]:
        phase = _clip(str(row["phase"] or "").strip(), 8)
        title = _clip(str(row["title"] or "").strip(), 32)
        content = _clip(str(row["content"] or "").strip(), 90)
        phase_tag = f"[{phase}] " if phase else ""
        outline_context_lines.append(f"- {phase_tag}{title}：{content}")
    outlines_block = "\n".join(outline_context_lines) if outline_context_lines else "- 暂无大纲"

    world_context_lines: list[str] = []
    for row in world_rows[:6]:
        category = _clip(str(row["category"] or "").strip(), 16)
        title = _clip(str(row["title"] or "").strip(), 32)
        content = _clip(str(row["content"] or "").strip(), 90)
        world_context_lines.append(f"- {title}({category})：{content}")
    world_block = "\n".join(world_context_lines) if world_context_lines else "- 暂无世界观"

    bible_text = ""
    if latest_bible and str(latest_bible["content"] or "").strip():
        bible_text = _clip(str(latest_bible["content"]), 2200)
    bible_block = f"\n\n【小说圣经摘要】\n{bible_text}" if bible_text else ""

    category_hint = _normalize_category_value(req.category_hint)
    model_name = str(project["model_main"] or "").strip() or "claude-sonnet-4"
    temperature = float(project["temperature"]) if project["temperature"] is not None else 0.55
    system_prompt = (
        "你是小说角色设计助手。"
        "只输出一个严格 JSON 对象，不要 Markdown，不要解释。"
        "JSON 字段必须包含：name,category,gender,age,identity,appearance,personality,motivation,backstory,arc,usage_notes。"
    )
    user_prompt = f"""
请基于以下项目上下文，新增 1 个可入库角色（不是重写全部角色）。

【项目】
- 名称：{project["name"]}
- 题材：{project["genre"] or "未指定"}
- 简介：{project["description"] or "无"}
- 结构：{project["structure"] or "起承转合"}{f"（{project['custom_structure']}）" if str(project["custom_structure"] or "").strip() else ""}
- 目标字数：{project["word_target"] or 100000}
- 用户补充：{_clip(req.brief, 300) or "无"}
- 新角色类型倾向：{category_hint}

【已有角色（避免重名/重复功能）】
{characters_block}

【已有世界观】
{world_block}

【已有大纲】
{outlines_block}
{bible_block}

硬约束：
1) 只输出一个 JSON 对象；
2) name 必须是新的具名角色，不能与已有角色重名：{existing_name_hint}；
3) category 只能是：主角/反派/配角/其他；
4) gender 不能为空，默认男；
5) age 必须是纯数字字符串（不带“岁”），未知默认 18；
6) identity/personality/motivation/backstory/arc/usage_notes 要可执行、避免空洞。
""".strip()

    raw = ""
    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=min(max(temperature, 0.35), 0.75),
            max_tokens=1800,
        )
    except Exception as e:
        fallback_model = "claude-sonnet-4"
        if model_name != fallback_model:
            try:
                raw = await llm.chat(
                    model=fallback_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=0.5,
                    max_tokens=1800,
                )
            except Exception as fallback_err:
                raise HTTPException(500, f"AI 角色生成失败（model={model_name}/{fallback_model}）: {fallback_err}")
        else:
            raise HTTPException(500, f"AI 角色生成失败（model={model_name}）: {e}")

    payload = _parse_ai_character_payload(raw)
    if not payload:
        logger.warning("AI single-character payload parse failed: project_id=%s raw=%s", req.project_id, _clip(raw, 600))
        raise HTTPException(500, "AI 角色输出解析失败，请重试一次")

    name = _ensure_unique_character_name(payload.get("name", ""), existing_name_keys)
    category = _normalize_category_value(payload.get("category", category_hint))
    if category not in {"主角", "反派", "配角", "其他"}:
        category = category_hint if category_hint in {"主角", "反派", "配角", "其他"} else "配角"
    gender = _normalize_gender_value(payload.get("gender", ""))
    age = _normalize_age_value(payload.get("age", ""))

    with get_db() as db:
        db.execute(
            "INSERT INTO characters (project_id, name, category, gender, age, identity, appearance, personality, motivation, backstory, arc, usage_notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                req.project_id,
                name,
                category,
                gender,
                age,
                payload.get("identity", ""),
                payload.get("appearance", ""),
                payload.get("personality", ""),
                payload.get("motivation", ""),
                payload.get("backstory", ""),
                payload.get("arc", ""),
                payload.get("usage_notes", ""),
            ),
        )
        row = db.execute("SELECT * FROM characters WHERE rowid = last_insert_rowid()").fetchone()
    if not row:
        raise HTTPException(500, "AI 角色生成后写库失败")
    return _normalize_character_row(dict(row))


@router.get("/{char_id}")
def get_character(char_id: str):
    with get_db() as db:
        row = db.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone()
        if not row:
            raise HTTPException(404, "角色不存在")
        # 附带关系
        rels = db.execute(
            "SELECT cr.*, c1.name as name_a, c2.name as name_b "
            "FROM character_relations cr "
            "JOIN characters c1 ON cr.character_a_id = c1.id "
            "JOIN characters c2 ON cr.character_b_id = c2.id "
            "WHERE cr.character_a_id = ? OR cr.character_b_id = ?",
            (char_id, char_id),
        ).fetchall()
        outgoing = db.execute(
            "SELECT cr.id, cr.character_a_id, cr.character_b_id, cr.relation_type, cr.description, "
            "c2.name as target_name "
            "FROM character_relations cr "
            "JOIN characters c2 ON cr.character_b_id = c2.id "
            "WHERE cr.character_a_id = ? "
            "ORDER BY cr.created_at",
            (char_id,),
        ).fetchall()
        result = dict(row)
        result = _normalize_character_row(result)
        result["relations"] = [dict(r) for r in rels]
        result["outgoing_relations"] = [dict(r) for r in outgoing]
        return result


@router.put("/{char_id}")
def update_character(char_id: str, req: CharacterUpdate):
    updates, values = [], []
    payload = req.model_dump(exclude_none=True)
    if "category" in payload:
        payload["category"] = _normalize_category_value(str(payload.get("category") or ""))
    if "gender" in payload:
        payload["gender"] = _normalize_gender_value(str(payload.get("gender") or ""))
    if "age" in payload:
        payload["age"] = _normalize_age_value(str(payload.get("age") or ""))
    for field, val in payload.items():
        updates.append(f"{field} = ?")
        values.append(val)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(char_id)
    with get_db() as db:
        db.execute(f"UPDATE characters SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone()
        if not row:
            raise HTTPException(404, "角色不存在")
        return _normalize_character_row(dict(row))


@router.put("/{char_id}/relations")
def replace_character_relations(char_id: str, req: CharacterRelationsUpdate):
    with get_db() as db:
        owner = db.execute(
            "SELECT id, project_id FROM characters WHERE id = ?",
            (char_id,),
        ).fetchone()
        if not owner:
            raise HTTPException(404, "角色不存在")
        project_id = str(owner["project_id"])

        db.execute("DELETE FROM character_relations WHERE character_a_id = ?", (char_id,))

        seen_target_ids = set()
        for rel in req.relations:
            target_id = str(rel.target_id or "").strip()
            if not target_id or target_id == char_id or target_id in seen_target_ids:
                continue
            target = db.execute(
                "SELECT id FROM characters WHERE id = ? AND project_id = ?",
                (target_id, project_id),
            ).fetchone()
            if not target:
                continue
            seen_target_ids.add(target_id)
            db.execute(
                "INSERT INTO character_relations (character_a_id, character_b_id, relation_type, description) "
                "VALUES (?,?,?,?)",
                (
                    char_id,
                    target_id,
                    str(rel.relation_type or "").strip()[:60],
                    str(rel.description or "").strip()[:260],
                ),
            )

        rows = db.execute(
            "SELECT cr.id, cr.character_a_id, cr.character_b_id, cr.relation_type, cr.description, "
            "c2.name as target_name "
            "FROM character_relations cr "
            "JOIN characters c2 ON cr.character_b_id = c2.id "
            "WHERE cr.character_a_id = ? "
            "ORDER BY cr.created_at",
            (char_id,),
        ).fetchall()
        return {"relations": [dict(r) for r in rows]}


@router.delete("/{char_id}")
def delete_character(char_id: str):
    with get_db() as db:
        db.execute("DELETE FROM characters WHERE id = ?", (char_id,))
        return {"ok": True}
