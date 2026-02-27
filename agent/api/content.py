"""大纲 + 伏笔 + 世界观 CRUD API"""
import json
import re
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Optional, Literal
from db import get_db
from agents import router as agent_router
from agents.default_prompts import REVIEWER_SYSTEM_PROMPT

router = APIRouter()
logger = logging.getLogger(__name__)


# ========== 大纲 ==========

class OutlineCreate(BaseModel):
    project_id: str
    structure: str = "起承转合"
    phase: str
    phase_order: int
    title: str
    content: str
    word_range: str = ""


@router.get("/outlines")
def list_outlines(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM outlines WHERE project_id = ? ORDER BY phase_order",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/outlines")
def create_outline(req: OutlineCreate):
    with get_db() as db:
        db.execute(
            "INSERT INTO outlines (project_id, structure, phase, phase_order, title, content, word_range) "
            "VALUES (?,?,?,?,?,?,?)",
            (req.project_id, req.structure, req.phase, req.phase_order,
             req.title, req.content, req.word_range),
        )
        row = db.execute(
            "SELECT * FROM outlines WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (req.project_id,),
        ).fetchone()
        return dict(row)


@router.put("/outlines/{outline_id}")
def update_outline(outline_id: str, data: dict):
    allowed = {"phase", "phase_order", "title", "content", "word_range", "structure"}
    updates, values = [], []
    for k, v in data.items():
        if k in allowed:
            updates.append(f"{k} = ?")
            values.append(v)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(outline_id)
    with get_db() as db:
        db.execute(f"UPDATE outlines SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM outlines WHERE id = ?", (outline_id,)).fetchone()
        if not row:
            raise HTTPException(404, "大纲不存在")
        return dict(row)


@router.delete("/outlines/{outline_id}")
def delete_outline(outline_id: str):
    with get_db() as db:
        db.execute("DELETE FROM outlines WHERE id = ?", (outline_id,))
        return {"ok": True}


# ========== 伏笔 ==========

class ForeshadowingCreate(BaseModel):
    project_id: str
    name: str
    description: str
    category: str = "剧情"
    importance: str = "中"
    plant_chapter_id: Optional[str] = None
    plant_text: str = ""


class ForeshadowExtractPreviewRequest(BaseModel):
    project_id: str
    chapter_id: Optional[str] = None
    text: str = ""
    limit: int = 8


class ForeshadowExtractItem(BaseModel):
    name: str
    description: str
    category: str = "剧情"
    importance: str = "中"
    status: str = "hinted"
    plant_text: str = ""
    resolve_text: str = ""
    confidence: float = 0.0


class ForeshadowExtractPreviewResponse(BaseModel):
    chapter_id: Optional[str] = None
    chapter_title: str = ""
    items: list[ForeshadowExtractItem] = []
    note: str = ""


class ForeshadowExtractCommitRequest(BaseModel):
    project_id: str
    chapter_id: Optional[str] = None
    items: list[ForeshadowExtractItem] = []


class AITracePreviewRequest(BaseModel):
    project_id: str
    chapter_id: Optional[str] = None
    text: str = ""
    strictness: Literal["low", "medium", "high"] = "medium"
    max_hits: int = 24


class AITraceHit(BaseModel):
    pattern_id: str
    pattern_name: str
    evidence: str
    confidence: float
    advice: str
    start: Optional[int] = None
    end: Optional[int] = None


class AITracePreviewResponse(BaseModel):
    chapter_id: Optional[str] = None
    chapter_title: str = ""
    risk_score: int = 0
    risk_level: Literal["low", "medium", "high"] = "low"
    total_hits: int = 0
    summary: str = ""
    hits: list[AITraceHit] = []


def _clip(text: str, limit: int) -> str:
    s = str(text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


# 小说模式 V1：只保留高相关规则，低相关规则降权；补充少量高精度“聊天残留”规则。
AI_TRACE_PATTERNS: list[dict[str, Any]] = [
    {
        "id": "grand_narrative",
        "name": "宏大意义宣告",
        "weight": 6.6,
        "advice": "删掉“历史意义/时代转折”类宣告，改成具体动作与后果。",
        "regexes": [
            r"(标志着|见证了|作为).{0,14}(关键|里程碑|转折|时代)",
            r"(不仅|不只是).{0,20}(而是|更是)",
            r"(命运的齿轮|时代的洪流|历史的车轮)",
        ],
    },
    {
        "id": "vague_attribution",
        "name": "模糊归因",
        "weight": 6.2,
        "advice": "把“有人认为/专家指出”改成明确人物、组织或证据。",
        "regexes": [
            r"(专家认为|有观点认为|观察者指出|业内人士表示|据悉|有声音指出|普遍认为)",
        ],
    },
    {
        "id": "ai_vocab_cluster",
        "name": "高频AI词簇",
        "weight": 5.8,
        "advice": "把抽象套话替换成场景细节、行为细节与具体对象。",
        "regexes": [
            r"(格局|生态|赋能|闭环|多维|协同|沉浸式|持续进化|系统性|全方位)",
            r"(深度探讨|凸显|彰显|赋予|至关重要|关键性的|持久的)",
        ],
    },
    {
        "id": "safe_generic_end",
        "name": "空泛正向结尾",
        "weight": 5.4,
        "advice": "结尾落到可感知结果或新冲突，不要用空泛鸡汤收束。",
        "regexes": [
            r"(未来可期|意义深远|值得期待|具有重要意义|一切才刚刚开始|翻开了新的篇章)",
        ],
    },
    {
        "id": "question_style_meta",
        "name": "讲解腔/元叙事",
        "weight": 5.1,
        "advice": "删除“本章将/接下来我们将”等讲解句，直接写人物行动与反应。",
        "regexes": [
            r"(接下来我们将|本文将|本章将|下面将|让我们来看看|我们可以看到)",
        ],
    },
    {
        "id": "formula_transition",
        "name": "模板化转折",
        "weight": 4.6,
        "advice": "减少“尽管/虽然…但是…”套模板，直接给因果冲突链。",
        "regexes": [
            r"尽管.{0,24}(但|但是|然而)",
            r"虽然.{0,24}(但|但是)",
        ],
    },
    {
        "id": "over_hedging",
        "name": "过度限定",
        "weight": 4.6,
        "advice": "减少“可能/或许/似乎”连用，把判断改成更明确的描述。",
        "regexes": [
            r"(可能|或许|似乎|某种程度上|在一定程度上).{0,16}(可能|或许|似乎|某种程度上|在一定程度上)",
            r"(可以)?\s*(潜在地)?\s*可能",
        ],
    },
    {
        "id": "filler_connectors",
        "name": "填充连接词",
        "weight": 4.2,
        "advice": "删掉“值得一提的是/不可否认”等填充短语，直接进入事件。",
        "regexes": [
            r"(值得一提的是|不可否认的是|毋庸置疑|总的来说|归根结底|换句话说)",
            r"(此外|与此同时|然而|因此).{0,12}(此外|与此同时|然而|因此)",
        ],
    },
    {
        "id": "list_of_three",
        "name": "三段式机械列举",
        "weight": 3.2,
        "advice": "避免过多公式化“三连”，保留最关键信息即可。",
        "regexes": [
            r"[^，。；\n]{2,18}、[^，。；\n]{2,18}、[^，。；\n]{2,18}",
        ],
    },
    {
        "id": "promo_tone",
        "name": "宣传式描写",
        "weight": 2.8,
        "advice": "若非角色主观视角，尽量减少“震撼/宏大/必看”类宣发措辞。",
        "regexes": [
            r"(令人叹为观止|必游之地|震撼人心|史诗级|宏大叙事|丰富的文化底蕴)",
            r"(坐落在|位于).{0,20}(中心|核心)",
        ],
    },
    {
        "id": "chatbot_collab_residue",
        "name": "对话助手残留",
        "weight": 7.4,
        "advice": "删除“希望这对你有帮助/请告诉我”等助手对话语句。",
        "regexes": [
            r"(希望这对你有帮助|如果你希望我|请告诉我|当然[！!]|您说得完全正确)",
        ],
    },
    {
        "id": "knowledge_cutoff_disclaimer",
        "name": "知识截止免责声明",
        "weight": 7.0,
        "advice": "删除“截至训练数据/根据我最后的训练”等模型免责声明。",
        "regexes": [
            r"(根据我最后的训练|截至.{0,20}(训练|知识|更新)|基于可用信息|具体细节(?:有限|稀缺))",
        ],
    },
]


def _build_evidence_snippet(text: str, start: int, end: int, window: int = 24) -> str:
    source = str(text or "")
    left = max(0, start - window)
    right = min(len(source), end + window)
    snippet = source[left:right].replace("\n", " ").strip()
    if left > 0:
        snippet = "..." + snippet
    if right < len(source):
        snippet = snippet + "..."
    return _clip(snippet, 180)


def _calc_ai_trace_score(hits: list[dict[str, Any]], text_len: int, strictness: str) -> tuple[int, str]:
    if not hits:
        return 8, "low"
    unique_patterns = len({str(h.get("pattern_id") or "") for h in hits if str(h.get("pattern_id") or "")})
    total_weight = sum(float(h.get("weight", 0.0) or 0.0) for h in hits)
    hit_count = len(hits)
    length_base = max(1, int(text_len / 400))
    density = min(15.0, (hit_count / length_base) * 2.2)
    raw = unique_patterns * 6.5 + hit_count * 2.8 + total_weight * 0.9 + density
    factor = 1.0
    if strictness == "low":
        factor = 0.88
    elif strictness == "high":
        factor = 1.14
    score = max(0, min(100, int(round(raw * factor))))
    if score >= 68:
        level = "high"
    elif score >= 34:
        level = "medium"
    else:
        level = "low"
    return score, level


def _summarize_ai_trace(hits: list[dict[str, Any]], score: int, level: str) -> str:
    if not hits:
        return "未识别到明显 AI 文风痕迹，可继续保持当前表达。"
    top_names: list[str] = []
    seen: set[str] = set()
    for hit in hits:
        n = str(hit.get("pattern_name") or "").strip()
        if not n or n in seen:
            continue
        seen.add(n)
        top_names.append(n)
        if len(top_names) >= 3:
            break
    labels = {"low": "低", "medium": "中", "high": "高"}
    return f"检测到 {len(hits)} 处疑似 AI 文风痕迹，风险{labels.get(level, '中')}（{score}/100），主要集中在：{'、'.join(top_names) or '表达模板化'}。"


def _detect_ai_trace_hits(text: str, strictness: str, max_hits: int) -> list[dict[str, Any]]:
    source = str(text or "")
    if not source.strip():
        return []
    safe_limit = max(1, min(80, int(max_hits or 24)))
    min_conf = 0.26
    if strictness == "low":
        min_conf = 0.34
    elif strictness == "high":
        min_conf = 0.18

    hits: list[dict[str, Any]] = []
    seen_signatures: set[str] = set()
    for pattern in AI_TRACE_PATTERNS:
        pattern_hits = 0
        for regex in pattern["regexes"]:
            try:
                iterator = re.finditer(regex, source, re.IGNORECASE)
            except re.error:
                continue
            for matched in iterator:
                evidence = _build_evidence_snippet(source, matched.start(), matched.end())
                signature = f"{pattern['id']}::{evidence}"
                if signature in seen_signatures:
                    continue
                seen_signatures.add(signature)
                matched_text = str(matched.group(0) or "").strip()
                confidence = 0.32 + min(0.35, len(matched_text) / 90) + min(0.2, pattern_hits * 0.08)
                confidence = max(0.0, min(0.99, confidence))
                if confidence < min_conf:
                    continue
                hits.append(
                    {
                        "pattern_id": pattern["id"],
                        "pattern_name": pattern["name"],
                        "evidence": evidence,
                        "confidence": confidence,
                        "advice": pattern["advice"],
                        "weight": float(pattern["weight"]),
                        "start": int(matched.start()),
                        "end": int(matched.end()),
                    }
                )
                pattern_hits += 1
                if pattern_hits >= 2 or len(hits) >= safe_limit:
                    break
            if pattern_hits >= 2 or len(hits) >= safe_limit:
                break
        if len(hits) >= safe_limit:
            break
    hits.sort(key=lambda item: (float(item.get("weight", 0.0)), float(item.get("confidence", 0.0))), reverse=True)
    return hits[:safe_limit]


def _extract_first_json_object(text: str) -> str:
    if not text:
        return ""
    start: Optional[int] = None
    depth = 0
    in_string = False
    escape = False
    for idx, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
            continue
        if ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                return text[start: idx + 1]
    return ""


def _parse_json_payload(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    candidates = [text]
    extracted = _extract_first_json_object(text)
    if extracted and extracted != text:
        candidates.append(extracted)
    for c in candidates:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _normalize_foreshadow_item(raw: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    name = _clip(raw.get("name", ""), 40)
    desc = _clip(raw.get("description", ""), 260)
    if len(name) < 2 or len(desc) < 6:
        return None
    category = _clip(raw.get("category", "剧情") or "剧情", 20)
    importance = str(raw.get("importance", "中") or "中").strip()
    if importance not in {"高", "中", "低"}:
        importance = "中"
    status = str(raw.get("status", "hinted") or "hinted").strip().lower()
    if status not in {"planted", "hinted", "resolved"}:
        status = "hinted"
    try:
        confidence = float(raw.get("confidence", 0.0) or 0.0)
    except Exception:
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    plant_text = _clip(raw.get("plant_text", ""), 260)
    resolve_text = _clip(raw.get("resolve_text", ""), 260)
    if status == "resolved" and not resolve_text:
        resolve_text = desc
    if status in {"planted", "hinted"} and not plant_text:
        plant_text = desc
    return {
        "name": name,
        "description": desc,
        "category": category,
        "importance": importance,
        "status": status,
        "plant_text": plant_text,
        "resolve_text": resolve_text,
        "confidence": confidence,
    }


def _load_extract_runtime(project_id: str) -> tuple[str, float, int]:
    default_model = "claude-sonnet-4"
    default_temp = 0.2
    default_max_tokens = 2200
    with get_db() as db:
        row = db.execute(
            "SELECT model_main FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "项目不存在")
    model = str((row["model_main"] or "")).strip() or default_model
    return model, default_temp, default_max_tokens


def _load_chapter_extract_text(project_id: str, chapter_id: str) -> tuple[str, str]:
    with get_db() as db:
        chapter = db.execute(
            "SELECT id, chapter_num, title, synopsis FROM chapters WHERE id = ? AND project_id = ?",
            (chapter_id, project_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(404, "章节不存在")
        paras = db.execute(
            "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? ORDER BY para_index ASC LIMIT 120",
            (chapter_id,),
        ).fetchall()
    title = f"第{chapter['chapter_num']}章《{chapter['title'] or '未命名'}》"
    synopsis = str(chapter["synopsis"] or "").strip()
    para_text = "\n".join([str(p["content"] or "") for p in paras if str(p["content"] or "").strip()])
    source_text = para_text if para_text else synopsis
    if not source_text:
        raise HTTPException(400, "当前章节暂无正文与梗概，无法提取伏笔")
    return title, source_text


@router.get("/foreshadowing")
def list_foreshadowing(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT f.*, c1.title as plant_chapter, c2.title as resolve_chapter "
            "FROM foreshadowing f "
            "LEFT JOIN chapters c1 ON f.plant_chapter_id = c1.id "
            "LEFT JOIN chapters c2 ON f.resolve_chapter_id = c2.id "
            "WHERE f.project_id = ? ORDER BY f.created_at",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/foreshadowing")
def create_foreshadowing(req: ForeshadowingCreate):
    with get_db() as db:
        db.execute(
            "INSERT INTO foreshadowing (project_id, name, description, category, importance, "
            "plant_chapter_id, plant_text) VALUES (?,?,?,?,?,?,?)",
            (req.project_id, req.name, req.description, req.category,
             req.importance, req.plant_chapter_id, req.plant_text),
        )
        row = db.execute(
            "SELECT * FROM foreshadowing WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (req.project_id,),
        ).fetchone()
        return dict(row)


@router.put("/foreshadowing/{fs_id}")
def update_foreshadowing(fs_id: str, data: dict):
    allowed = {"name", "description", "category", "importance", "status",
               "plant_chapter_id", "resolve_chapter_id", "plant_text", "resolve_text"}
    updates, values = [], []
    for k, v in data.items():
        if k in allowed:
            updates.append(f"{k} = ?")
            values.append(v)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(fs_id)
    with get_db() as db:
        db.execute(f"UPDATE foreshadowing SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM foreshadowing WHERE id = ?", (fs_id,)).fetchone()
        if not row:
            raise HTTPException(404, "伏笔不存在")
        return dict(row)


@router.post("/foreshadowing/extract-preview", response_model=ForeshadowExtractPreviewResponse)
async def extract_foreshadow_preview(req: ForeshadowExtractPreviewRequest):
    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(500, "模型服务未初始化")

    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    source_text = str(req.text or "").strip()
    chapter_title = ""
    chapter_id = str(req.chapter_id or "").strip() or None
    if chapter_id:
        chapter_title, chapter_source_text = _load_chapter_extract_text(project_id, chapter_id)
        if not source_text:
            source_text = chapter_source_text
    if not source_text:
        raise HTTPException(400, "请提供章节ID或正文文本")

    limit = max(1, min(20, int(req.limit or 8)))

    with get_db() as db:
        existing_rows = db.execute(
            "SELECT name, description FROM foreshadowing WHERE project_id = ? ORDER BY created_at DESC LIMIT 80",
            (project_id,),
        ).fetchall()
    existing_text = "\n".join([f"- {r['name']}：{_clip(r['description'] or '', 80)}" for r in existing_rows[:30]])
    existing_block = f"\n\n【已有伏笔（避免重复）】\n{existing_text}" if existing_text else ""

    model, temperature, max_tokens = _load_extract_runtime(project_id)

    prompt = f"""
你是小说伏笔提取器。请从文本中识别“值得入库追踪”的伏笔候选。

提取原则：
1) 本章可以没有伏笔；若没有，请返回空数组；
2) 仅提取“后续可回收”的线索（隐藏信息、未解释异常、明确承诺、未兑现冲突）；
3) 避免把普通叙事句当伏笔，避免重复已有伏笔；
4) 每条描述要具体，不要空话。

输出 JSON 对象（不要解释）：
{{
  "items": [
    {{
      "name": "伏笔短名",
      "description": "该伏笔要点（20~120字）",
      "category": "剧情",
      "importance": "高|中|低",
      "status": "planted|hinted|resolved",
      "plant_text": "埋设文本（可空）",
      "resolve_text": "回收文本（可空）",
      "confidence": 0.0
    }}
  ]
}}

约束：
- 最多返回 {limit} 条；
- status=resolved 仅在文本里明确“已经兑现/揭晓/回收”时使用；
- confidence 取 0~1；
- 若无合格候选，items 返回 []。

【章节】
{chapter_title or "未指定"}
{existing_block}

【待分析文本】
{_clip(source_text, 14000)}
""".strip()

    raw = await llm.chat(
        model=model,
        messages=[
            {"role": "system", "content": "你是严格JSON抽取器，只输出合法JSON对象。"},
            {"role": "user", "content": prompt},
        ],
        temperature=min(max(temperature, 0.0), 0.4),
        max_tokens=max_tokens,
    )

    payload = _parse_json_payload(raw)
    raw_items = payload.get("items", []) if isinstance(payload.get("items"), list) else []
    deduped: list[ForeshadowExtractItem] = []
    seen: set[str] = set()
    for raw_item in raw_items:
        item = _normalize_foreshadow_item(raw_item)
        if not item:
            continue
        key = f"{item['name']}::{item['description']}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ForeshadowExtractItem(**item))
        if len(deduped) >= limit:
            break

    return ForeshadowExtractPreviewResponse(
        chapter_id=chapter_id,
        chapter_title=chapter_title,
        items=deduped,
        note="说明：本章可能没有伏笔，返回空列表是正常结果。",
    )


@router.post("/foreshadowing/extract-commit")
def commit_foreshadow_extract(req: ForeshadowExtractCommitRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    chapter_id = str(req.chapter_id or "").strip() or None
    incoming_items = req.items or []
    if not incoming_items:
        return {"inserted": 0, "skipped": 0, "items": []}

    normalized_items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in incoming_items:
        item = _normalize_foreshadow_item(raw.model_dump() if isinstance(raw, BaseModel) else raw)
        if not item:
            continue
        key = f"{item['name']}::{item['description']}"
        if key in seen:
            continue
        seen.add(key)
        normalized_items.append(item)

    inserted = 0
    skipped = 0
    created: list[dict[str, Any]] = []
    with get_db() as db:
        proj = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "项目不存在")

        for item in normalized_items:
            status = item["status"]
            plant_chapter_id = chapter_id if status in {"planted", "hinted"} else None
            resolve_chapter_id = chapter_id if status == "resolved" else None
            plant_text = item["plant_text"] if status in {"planted", "hinted"} else ""
            resolve_text = item["resolve_text"] if status == "resolved" else ""

            existed = db.execute(
                "SELECT id FROM foreshadowing WHERE project_id = ? AND name = ? AND description = ? "
                "AND COALESCE(plant_chapter_id, '') = COALESCE(?, '') "
                "AND COALESCE(resolve_chapter_id, '') = COALESCE(?, '') LIMIT 1",
                (project_id, item["name"], item["description"], plant_chapter_id, resolve_chapter_id),
            ).fetchone()
            if existed:
                skipped += 1
                continue

            db.execute(
                "INSERT INTO foreshadowing (project_id, name, description, category, importance, status, "
                "plant_chapter_id, resolve_chapter_id, plant_text, resolve_text) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    project_id,
                    item["name"],
                    item["description"],
                    item["category"],
                    item["importance"],
                    status,
                    plant_chapter_id,
                    resolve_chapter_id,
                    plant_text,
                    resolve_text,
                ),
            )
            row = db.execute(
                "SELECT * FROM foreshadowing WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
            if row:
                created.append(dict(row))
            inserted += 1

    return {"inserted": inserted, "skipped": skipped, "items": created}


# ========== 世界观 ==========

class WorldbuildingCreate(BaseModel):
    project_id: str
    category: str
    title: str
    content: str
    parent_id: Optional[str] = None


@router.get("/worldbuilding")
def list_worldbuilding(project_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM worldbuilding WHERE project_id = ? ORDER BY category, sort_order",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


@router.post("/worldbuilding")
def create_worldbuilding(req: WorldbuildingCreate):
    with get_db() as db:
        db.execute(
            "INSERT INTO worldbuilding (project_id, category, title, content, parent_id) VALUES (?,?,?,?,?)",
            (req.project_id, req.category, req.title, req.content, req.parent_id),
        )
        row = db.execute(
            "SELECT * FROM worldbuilding WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (req.project_id,),
        ).fetchone()
        return dict(row)


@router.put("/worldbuilding/{wb_id}")
def update_worldbuilding(wb_id: str, data: dict):
    allowed = {"category", "title", "content", "parent_id", "sort_order"}
    updates, values = [], []
    for k, v in data.items():
        if k in allowed:
            updates.append(f"{k} = ?")
            values.append(v)
    if not updates:
        raise HTTPException(400, "无更新字段")
    values.append(wb_id)
    with get_db() as db:
        db.execute(f"UPDATE worldbuilding SET {', '.join(updates)} WHERE id = ?", values)
        row = db.execute("SELECT * FROM worldbuilding WHERE id = ?", (wb_id,)).fetchone()
        if not row:
            raise HTTPException(404, "世界观条目不存在")
        return dict(row)


@router.delete("/worldbuilding/{wb_id}")
def delete_worldbuilding(wb_id: str):
    with get_db() as db:
        db.execute("DELETE FROM worldbuilding WHERE id = ?", (wb_id,))
        return {"ok": True}


# ========== 角色/世界观候选池 ==========

EntityType = Literal["character", "worldbuilding"]
EntityCandidateAction = Literal["create", "merge", "ignore"]


class EntityCandidateExtractRequest(BaseModel):
    project_id: str
    chapter_id: Optional[str] = None
    text: str = ""
    limit: int = 10


class EntityCandidateItem(BaseModel):
    entity_type: EntityType
    name: str
    category: str = ""
    description: str = ""
    gender: str = ""
    age: str = ""
    source_excerpt: str = ""
    confidence: float = 0.0


class EntityCandidateExtractResponse(BaseModel):
    chapter_id: Optional[str] = None
    chapter_title: str = ""
    items: list[EntityCandidateItem] = []
    note: str = ""


class EntityCandidateCommitOperation(BaseModel):
    candidate_id: str
    action: EntityCandidateAction = "create"
    target_id: Optional[str] = None
    name: str = ""
    category: str = ""
    description: str = ""
    gender: str = ""
    age: str = ""


class EntityCandidateCommitRequest(BaseModel):
    project_id: str
    operations: list[EntityCandidateCommitOperation] = []


def _normalize_entity_type(raw: Any) -> str:
    v = str(raw or "").strip().lower()
    if not v:
        return ""
    if any(k in v for k in ("character", "角色", "人物", "人名", "person")):
        return "character"
    if any(k in v for k in ("world", "setting", "worldbuilding", "世界", "设定", "地点", "势力", "规则", "组织", "道具", "历史")):
        return "worldbuilding"
    return ""


def _normalize_char_category(raw: Any) -> str:
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


def _normalize_world_category(raw: Any) -> str:
    v = str(raw or "").strip()
    if not v:
        return "其他"
    mapping = (
        ("势力", "势力"),
        ("组织", "组织"),
        ("地点", "地点"),
        ("地理", "地点"),
        ("规则", "规则"),
        ("制度", "规则"),
        ("设定", "规则"),
        ("物品", "物品"),
        ("道具", "物品"),
        ("历史", "历史"),
        ("文化", "文化"),
    )
    for key, target in mapping:
        if key in v:
            return target
    return _clip(v, 20) or "其他"


def _normalize_gender(raw: Any) -> str:
    v = str(raw or "").strip()
    if not v:
        return ""
    lower = v.lower()
    if any(k in v for k in ("非二元", "双性", "中性", "无性")) or any(k in lower for k in ("non-binary", "nonbinary", "nb")):
        return "非二元"
    if "女" in v or any(k in lower for k in ("female", "woman", "girl")):
        return "女"
    if "男" in v or any(k in lower for k in ("male", "man", "boy")):
        return "男"
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(k in lower for k in ("unknown", "unspecified")):
        return "未知"
    return _clip(v, 12)


def _normalize_age(raw: Any) -> str:
    v = re.sub(r"\s+", "", str(raw or "").strip())
    if not v:
        return ""
    lower = v.lower()
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(k in lower for k in ("unknown", "unspecified", "n/a", "na")):
        return "未知"
    if re.fullmatch(r"\d{1,3}", v):
        try:
            n = int(v)
        except Exception:
            n = 0
        if 0 < n < 160:
            return f"{n}岁"
    if re.fullmatch(r"\d{1,3}[~\-～到]\d{1,3}(?:岁)?", v):
        return _clip(v if v.endswith("岁") else f"{v}岁", 20)
    return _clip(v, 20)


def _normalize_confidence(raw: Any) -> float:
    try:
        v = float(raw or 0.0)
    except Exception:
        v = 0.0
    return max(0.0, min(1.0, v))


def _merge_text(base: str, addition: str, limit: int) -> str:
    b = str(base or "").strip()
    a = str(addition or "").strip()
    if not a:
        return _clip(b, limit)
    if not b:
        return _clip(a, limit)
    if a in b:
        return _clip(b, limit)
    return _clip(f"{b}；{a}", limit)


def _normalize_entity_candidate_item(raw: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    entity_type = _normalize_entity_type(raw.get("entity_type") or raw.get("type") or raw.get("kind"))
    if not entity_type:
        return None
    name = _clip(raw.get("name", ""), 40)
    if len(name) < 2:
        return None
    description = _clip(raw.get("description") or raw.get("content") or raw.get("summary") or "", 320)
    if len(description) < 6:
        return None
    source_excerpt = _clip(raw.get("source_excerpt") or raw.get("evidence") or raw.get("quote") or "", 220)
    confidence = _normalize_confidence(raw.get("confidence"))

    if entity_type == "character":
        category = _normalize_char_category(raw.get("category") or "配角")
        gender = _normalize_gender(raw.get("gender"))
        age = _normalize_age(raw.get("age"))
    else:
        category = _normalize_world_category(raw.get("category") or "其他")
        gender = ""
        age = ""

    return {
        "entity_type": entity_type,
        "name": name,
        "category": category,
        "description": description,
        "gender": gender,
        "age": age,
        "source_excerpt": source_excerpt or _clip(description, 180),
        "confidence": confidence,
    }


def _load_existing_entity_reference(project_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    with get_db() as db:
        chars = db.execute(
            "SELECT name, category, gender, age, identity FROM characters "
            "WHERE project_id = ? ORDER BY created_at ASC LIMIT 60",
            (project_id,),
        ).fetchall()
        world = db.execute(
            "SELECT title, category, content FROM worldbuilding "
            "WHERE project_id = ? ORDER BY created_at ASC LIMIT 60",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in chars], [dict(r) for r in world]


async def _extract_entity_candidates_items(
    *,
    project_id: str,
    chapter_id: Optional[str],
    text: str,
    limit: int,
    strict: bool,
) -> tuple[str, list[dict[str, Any]]]:
    project_id = str(project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    source_text = str(text or "").strip()
    chapter_title = ""
    cleaned_chapter_id = str(chapter_id or "").strip() or None
    if cleaned_chapter_id:
        chapter_title, chapter_source_text = _load_chapter_extract_text(project_id, cleaned_chapter_id)
        if not source_text:
            source_text = chapter_source_text
    if not source_text:
        if strict:
            raise HTTPException(400, "请提供章节ID或正文文本")
        return chapter_title, []

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        if strict:
            raise HTTPException(500, "模型服务未初始化")
        return chapter_title, []

    model, temperature, max_tokens = _load_extract_runtime(project_id)
    chars, world = _load_existing_entity_reference(project_id)
    chars_block = (
        "\n".join(
            f"- {c.get('name', '')}（{c.get('category', '')}/{c.get('gender', '')}/{c.get('age', '')}）：{_clip(c.get('identity', '') or '', 60)}"
            for c in chars[:24]
        ) if chars else "无"
    )
    world_block = (
        "\n".join(
            f"- {w.get('title', '')}（{w.get('category', '')}）：{_clip(w.get('content', '') or '', 70)}"
            for w in world[:24]
        ) if world else "无"
    )
    safe_limit = max(1, min(20, int(limit or 10)))

    prompt = f"""
你是小说设定抽取器。请从章节文本中提取“适合加入设定库”的候选，仅输出 JSON。

目标：
1) 角色候选：新增人物，或现有人物的重要新增设定（身份/动机/年龄线索）。
2) 世界观候选：新增规则、势力、地点、道具、历史背景等可复用设定。
3) 文本可以没有候选；没有就返回空数组。

输出 JSON 对象（不要解释）：
{{
  "items": [
    {{
      "entity_type": "character|worldbuilding",
      "name": "候选名",
      "category": "角色:主角/反派/配角/其他；世界观:地点/势力/规则/物品/历史/文化/其他",
      "description": "20~120字，具体可执行",
      "gender": "仅角色可填：男/女/非二元/未知，可空",
      "age": "仅角色可填：例如24岁/30岁左右/未知，可空",
      "source_excerpt": "原文证据片段，可空",
      "confidence": 0.0
    }}
  ]
}}

约束：
- 最多返回 {safe_limit} 条；
- 禁止输出与已有设定完全重复的条目；
- 若只是普通叙事句，不要提取；
- confidence 在 0~1 范围内。

【已有角色（避免重复）】
{chars_block}

【已有世界观（避免重复）】
{world_block}

【章节】
{chapter_title or "未指定"}

【待分析文本】
{_clip(source_text, 14000)}
""".strip()

    raw = await llm.chat(
        model=model,
        messages=[
            {"role": "system", "content": "你是严格JSON抽取器，只输出合法JSON对象。"},
            {"role": "user", "content": prompt},
        ],
        temperature=min(max(temperature, 0.0), 0.4),
        max_tokens=max_tokens,
    )

    payload = _parse_json_payload(raw)
    raw_items = payload.get("items", []) if isinstance(payload.get("items"), list) else []
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_item in raw_items:
        item = _normalize_entity_candidate_item(raw_item)
        if not item:
            continue
        dedup_key = f"{item['entity_type']}::{str(item['name']).lower()}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        deduped.append(item)
        if len(deduped) >= safe_limit:
            break
    return chapter_title, deduped


def _persist_entity_candidates(
    *,
    project_id: str,
    chapter_id: Optional[str],
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    if not items:
        return {"inserted": 0, "skipped": 0, "items": []}

    inserted = 0
    skipped = 0
    saved: list[dict[str, Any]] = []
    with get_db() as db:
        existing_char_names = {
            str(r["name"] or "").strip().lower()
            for r in db.execute(
                "SELECT name FROM characters WHERE project_id = ?",
                (project_id,),
            ).fetchall()
            if str(r["name"] or "").strip()
        }
        existing_world_titles = {
            str(r["title"] or "").strip().lower()
            for r in db.execute(
                "SELECT title FROM worldbuilding WHERE project_id = ?",
                (project_id,),
            ).fetchall()
            if str(r["title"] or "").strip()
        }

        for item in items:
            entity_type = str(item.get("entity_type") or "").strip()
            name = _clip(item.get("name", ""), 40)
            if not entity_type or not name:
                skipped += 1
                continue
            lowered_name = name.lower()
            if entity_type == "character" and lowered_name in existing_char_names:
                skipped += 1
                continue
            if entity_type == "worldbuilding" and lowered_name in existing_world_titles:
                skipped += 1
                continue

            existed_pending = db.execute(
                "SELECT id FROM entity_candidates "
                "WHERE project_id = ? AND entity_type = ? AND lower(name) = lower(?) AND status = 'pending' "
                "LIMIT 1",
                (project_id, entity_type, name),
            ).fetchone()
            if existed_pending:
                skipped += 1
                continue

            db.execute(
                "INSERT INTO entity_candidates "
                "(project_id, chapter_id, entity_type, name, category, description, gender, age, source_excerpt, confidence, status, target_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    project_id,
                    chapter_id,
                    entity_type,
                    name,
                    _clip(item.get("category", ""), 20),
                    _clip(item.get("description", ""), 320),
                    _clip(item.get("gender", ""), 12),
                    _clip(item.get("age", ""), 20),
                    _clip(item.get("source_excerpt", ""), 220),
                    _normalize_confidence(item.get("confidence", 0.0)),
                    "pending",
                    "",
                ),
            )
            row = db.execute(
                "SELECT ec.*, c.chapter_num, c.title AS chapter_title "
                "FROM entity_candidates ec "
                "LEFT JOIN chapters c ON c.id = ec.chapter_id "
                "WHERE ec.rowid = last_insert_rowid()",
            ).fetchone()
            if row:
                saved.append(dict(row))
            inserted += 1
    return {"inserted": inserted, "skipped": skipped, "items": saved}


def _archive_previous_chapter_pending_candidates(
    *,
    project_id: str,
    chapter_id: Optional[str],
) -> int:
    clean_project_id = str(project_id or "").strip()
    clean_chapter_id = str(chapter_id or "").strip()
    if not clean_project_id or not clean_chapter_id:
        return 0
    with get_db() as db:
        row = db.execute(
            "SELECT COUNT(*) AS c FROM entity_candidates "
            "WHERE project_id = ? AND chapter_id = ? AND status = 'pending'",
            (clean_project_id, clean_chapter_id),
        ).fetchone()
        pending_count = int((row["c"] if row else 0) or 0)
        if pending_count <= 0:
            return 0
        db.execute(
            "UPDATE entity_candidates "
            "SET status = 'ignored', updated_at = datetime('now') "
            "WHERE project_id = ? AND chapter_id = ? AND status = 'pending'",
            (clean_project_id, clean_chapter_id),
        )
    return pending_count


async def _extract_and_store_entity_candidates(
    *,
    project_id: str,
    chapter_id: Optional[str],
    text: str,
    limit: int,
    strict: bool,
) -> dict[str, Any]:
    chapter_title, items = await _extract_entity_candidates_items(
        project_id=project_id,
        chapter_id=chapter_id,
        text=text,
        limit=limit,
        strict=strict,
    )
    archived = _archive_previous_chapter_pending_candidates(
        project_id=project_id,
        chapter_id=chapter_id,
    )
    result = _persist_entity_candidates(
        project_id=project_id,
        chapter_id=chapter_id,
        items=items,
    )
    result["chapter_title"] = chapter_title
    result["archived"] = archived
    return result


async def auto_extract_entity_candidates_background(
    project_id: str,
    chapter_id: Optional[str],
    text: str = "",
    limit: int = 8,
):
    try:
        await _extract_and_store_entity_candidates(
            project_id=project_id,
            chapter_id=chapter_id,
            text=text,
            limit=limit,
            strict=False,
        )
    except Exception:
        logger.warning(
            "Auto extract entity candidates failed: project_id=%s chapter_id=%s",
            project_id,
            chapter_id,
            exc_info=True,
        )


@router.get("/entity-candidates")
def list_entity_candidates(
    project_id: str,
    entity_type: str = "",
    status: str = "pending",
    limit: int = 120,
):
    project_id = str(project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")
    safe_limit = max(1, min(500, int(limit or 120)))
    clean_entity_type = str(entity_type or "").strip().lower()
    clean_status = str(status or "pending").strip().lower()
    if clean_entity_type and clean_entity_type not in {"character", "worldbuilding"}:
        raise HTTPException(400, "entity_type 仅支持 character/worldbuilding")
    if clean_status and clean_status not in {"pending", "approved", "merged", "ignored"}:
        raise HTTPException(400, "status 仅支持 pending/approved/merged/ignored")

    clauses = ["ec.project_id = ?"]
    params: list[Any] = [project_id]
    if clean_entity_type:
        clauses.append("ec.entity_type = ?")
        params.append(clean_entity_type)
    if clean_status:
        clauses.append("ec.status = ?")
        params.append(clean_status)
    params.append(safe_limit)
    where_sql = " AND ".join(clauses)
    with get_db() as db:
        rows = db.execute(
            f"SELECT ec.*, c.chapter_num, c.title AS chapter_title "
            f"FROM entity_candidates ec "
            f"LEFT JOIN chapters c ON c.id = ec.chapter_id "
            f"WHERE {where_sql} "
            f"ORDER BY ec.created_at DESC LIMIT ?",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/entity-candidates/extract-preview", response_model=EntityCandidateExtractResponse)
async def extract_entity_candidates_preview(req: EntityCandidateExtractRequest):
    chapter_title, items = await _extract_entity_candidates_items(
        project_id=req.project_id,
        chapter_id=req.chapter_id,
        text=req.text,
        limit=req.limit,
        strict=True,
    )
    return EntityCandidateExtractResponse(
        chapter_id=str(req.chapter_id or "").strip() or None,
        chapter_title=chapter_title,
        items=[EntityCandidateItem(**item) for item in items],
        note="仅预览，不会入库。可调用 extract-auto 或 commit 执行入库。",
    )


@router.post("/entity-candidates/extract-auto")
async def extract_entity_candidates_auto(req: EntityCandidateExtractRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")
    chapter_id = str(req.chapter_id or "").strip() or None
    result = await _extract_and_store_entity_candidates(
        project_id=project_id,
        chapter_id=chapter_id,
        text=req.text,
        limit=req.limit,
        strict=True,
    )
    return {
        "inserted": result.get("inserted", 0),
        "skipped": result.get("skipped", 0),
        "chapter_title": result.get("chapter_title", ""),
        "items": result.get("items", []),
    }


@router.post("/entity-candidates/commit")
def commit_entity_candidates(req: EntityCandidateCommitRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")
    operations = req.operations or []
    if not operations:
        return {"created": 0, "merged": 0, "ignored": 0, "skipped": 0}

    created = 0
    merged = 0
    ignored = 0
    skipped = 0
    with get_db() as db:
        proj = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "项目不存在")

        for op in operations:
            candidate_id = str(op.candidate_id or "").strip()
            if not candidate_id:
                skipped += 1
                continue
            row = db.execute(
                "SELECT * FROM entity_candidates WHERE id = ? AND project_id = ? LIMIT 1",
                (candidate_id, project_id),
            ).fetchone()
            if not row:
                skipped += 1
                continue

            candidate = dict(row)
            action = str(op.action or "create").strip().lower()
            if action not in {"create", "merge", "ignore"}:
                skipped += 1
                continue
            if candidate.get("status") != "pending" and action in {"create", "merge", "ignore"}:
                skipped += 1
                continue

            entity_type = str(candidate.get("entity_type") or "").strip()
            name = _clip(op.name or candidate.get("name", ""), 40)
            category = _clip(op.category or candidate.get("category", ""), 20)
            description = _clip(op.description or candidate.get("description", ""), 320)
            gender = _normalize_gender(op.gender or candidate.get("gender", ""))
            age = _normalize_age(op.age or candidate.get("age", ""))

            if action == "ignore":
                db.execute(
                    "UPDATE entity_candidates SET status = 'ignored', updated_at = datetime('now') WHERE id = ?",
                    (candidate_id,),
                )
                ignored += 1
                continue

            if action == "create":
                if entity_type == "character":
                    existed = db.execute(
                        "SELECT id FROM characters WHERE project_id = ? AND lower(name) = lower(?) LIMIT 1",
                        (project_id, name),
                    ).fetchone()
                    if existed:
                        db.execute(
                            "UPDATE entity_candidates SET status = 'merged', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                            (existed["id"], candidate_id),
                        )
                        merged += 1
                        continue
                    db.execute(
                        "INSERT INTO characters (project_id, name, category, gender, age, identity, personality, motivation, arc) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            project_id,
                            name,
                            _normalize_char_category(category),
                            gender,
                            age if age else "未知",
                            description,
                            "",
                            "",
                            "",
                        ),
                    )
                    target = db.execute("SELECT id FROM characters WHERE rowid = last_insert_rowid()").fetchone()
                    target_id = str(target["id"]) if target else ""
                    db.execute(
                        "UPDATE entity_candidates SET status = 'approved', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                        (target_id, candidate_id),
                    )
                    created += 1
                elif entity_type == "worldbuilding":
                    existed = db.execute(
                        "SELECT id FROM worldbuilding WHERE project_id = ? AND lower(title) = lower(?) LIMIT 1",
                        (project_id, name),
                    ).fetchone()
                    if existed:
                        db.execute(
                            "UPDATE entity_candidates SET status = 'merged', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                            (existed["id"], candidate_id),
                        )
                        merged += 1
                        continue
                    db.execute(
                        "INSERT INTO worldbuilding (project_id, category, title, content) VALUES (?,?,?,?)",
                        (
                            project_id,
                            _normalize_world_category(category),
                            name,
                            description,
                        ),
                    )
                    target = db.execute("SELECT id FROM worldbuilding WHERE rowid = last_insert_rowid()").fetchone()
                    target_id = str(target["id"]) if target else ""
                    db.execute(
                        "UPDATE entity_candidates SET status = 'approved', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                        (target_id, candidate_id),
                    )
                    created += 1
                else:
                    skipped += 1
                continue

            if action == "merge":
                target_id = str(op.target_id or "").strip()
                if not target_id:
                    skipped += 1
                    continue

                if entity_type == "character":
                    target = db.execute(
                        "SELECT id, category, gender, age, identity FROM characters "
                        "WHERE id = ? AND project_id = ? LIMIT 1",
                        (target_id, project_id),
                    ).fetchone()
                    if not target:
                        skipped += 1
                        continue
                    merged_identity = _merge_text(target["identity"] or "", description, 240)
                    merged_category = target["category"] or _normalize_char_category(category)
                    merged_gender = target["gender"] or gender
                    merged_age = target["age"] or (age if age else "未知")
                    db.execute(
                        "UPDATE characters SET category = ?, gender = ?, age = ?, identity = ? WHERE id = ?",
                        (merged_category, merged_gender, merged_age, merged_identity, target_id),
                    )
                    db.execute(
                        "UPDATE entity_candidates SET status = 'merged', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                        (target_id, candidate_id),
                    )
                    merged += 1
                elif entity_type == "worldbuilding":
                    target = db.execute(
                        "SELECT id, category, content FROM worldbuilding "
                        "WHERE id = ? AND project_id = ? LIMIT 1",
                        (target_id, project_id),
                    ).fetchone()
                    if not target:
                        skipped += 1
                        continue
                    merged_content = _merge_text(target["content"] or "", description, 1800)
                    merged_category = target["category"] or _normalize_world_category(category)
                    db.execute(
                        "UPDATE worldbuilding SET category = ?, content = ? WHERE id = ?",
                        (merged_category, merged_content, target_id),
                    )
                    db.execute(
                        "UPDATE entity_candidates SET status = 'merged', target_id = ?, updated_at = datetime('now') WHERE id = ?",
                        (target_id, candidate_id),
                    )
                    merged += 1
                else:
                    skipped += 1

    return {"created": created, "merged": merged, "ignored": ignored, "skipped": skipped}


# ========== AI 痕迹体检 ==========

@router.post("/ai-trace/preview", response_model=AITracePreviewResponse)
async def ai_trace_preview(req: AITracePreviewRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    strictness = str(req.strictness or "medium").strip().lower()
    if strictness not in {"low", "medium", "high"}:
        strictness = "medium"

    chapter_id = str(req.chapter_id or "").strip() or None
    chapter_title = ""
    source_text = str(req.text or "")

    if chapter_id:
        try:
            chapter_title, chapter_source_text = _load_chapter_extract_text(project_id, chapter_id)
            if not str(source_text).strip():
                source_text = chapter_source_text
        except HTTPException:
            if not str(source_text).strip():
                raise

    if not str(source_text).strip():
        raise HTTPException(400, "请提供章节ID或文本内容")

    # 保持原始字符偏移，避免 _clip 的 strip/省略号改变命中索引。
    text_for_check = str(source_text)[:24000]
    detected_hits = _detect_ai_trace_hits(text_for_check, strictness, req.max_hits)
    score, level = _calc_ai_trace_score(detected_hits, len(text_for_check), strictness)
    summary = _summarize_ai_trace(detected_hits, score, level)

    return AITracePreviewResponse(
        chapter_id=chapter_id,
        chapter_title=chapter_title,
        risk_score=score,
        risk_level=level,  # type: ignore[arg-type]
        total_hits=len(detected_hits),
        summary=summary,
        hits=[
            AITraceHit(
                pattern_id=str(item.get("pattern_id") or ""),
                pattern_name=str(item.get("pattern_name") or ""),
                evidence=str(item.get("evidence") or ""),
                confidence=max(0.0, min(1.0, float(item.get("confidence", 0.0) or 0.0))),
                advice=str(item.get("advice") or ""),
                start=(int(item.get("start")) if isinstance(item.get("start"), (int, float)) else None),
                end=(int(item.get("end")) if isinstance(item.get("end"), (int, float)) else None),
            )
            for item in detected_hits
        ],
    )


# ========== 审阅记录 ==========

ReviewScope = Literal["project", "chapter"]


class ReviewRunRequest(BaseModel):
    project_id: str
    scope: ReviewScope = "project"
    chapter_id: Optional[str] = None


def _normalize_token_limit(value: Any, default_value: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = int(default_value)
    if parsed <= 0:
        parsed = int(default_value)
    return max(256, min(12000, parsed))


def _load_reviewer_runtime(project_id: str) -> tuple[str, float, int, str, bool]:
    default_model = "claude-sonnet-4"
    default_temp = 0.3
    default_max_tokens = 2200
    with get_db() as db:
        row = db.execute(
            "SELECT p.model_main, ac.model AS cfg_model, ac.temperature AS cfg_temp, "
            "ac.max_tokens AS cfg_max_tokens, ac.system_prompt AS cfg_prompt, ac.enabled AS cfg_enabled "
            "FROM projects p "
            "LEFT JOIN agent_configs ac ON ac.project_id = p.id AND ac.agent_type = 'reviewer' "
            "WHERE p.id = ?",
            (project_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "项目不存在")

    model = str((row["cfg_model"] or "").strip() or (row["model_main"] or default_model))
    cfg_temp = row["cfg_temp"]
    temperature = default_temp
    if cfg_temp is not None:
        try:
            parsed_temp = float(cfg_temp)
            if parsed_temp >= 0:
                temperature = parsed_temp
        except Exception:
            temperature = default_temp

    max_tokens = _normalize_token_limit(row["cfg_max_tokens"], default_max_tokens)
    prompt_override = str((row["cfg_prompt"] or "")).strip()
    enabled_raw = row["cfg_enabled"]
    enabled = bool(enabled_raw) if enabled_raw is not None else True
    system_prompt = prompt_override or REVIEWER_SYSTEM_PROMPT
    return model, temperature, max_tokens, system_prompt, enabled


def _load_single_chapter_review_material(project_id: str, chapter_id: str) -> tuple[str, str, str]:
    with get_db() as db:
        chapter = db.execute(
            "SELECT id, chapter_num, title, synopsis, phase FROM chapters WHERE id = ? AND project_id = ?",
            (chapter_id, project_id),
        ).fetchone()
        if not chapter:
            raise HTTPException(404, "章节不存在")
        paras = db.execute(
            "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? ORDER BY para_index ASC LIMIT 500",
            (chapter_id,),
        ).fetchall()

    chapter_title = f"第{chapter['chapter_num']}章《{chapter['title'] or '未命名'}》"
    chapter_text = "\n\n".join(
        [str(p["content"] or "").strip() for p in paras if str(p["content"] or "").strip()]
    ).strip()
    if not chapter_text:
        chapter_text = str(chapter["synopsis"] or "").strip()
    if not chapter_text:
        raise HTTPException(400, "该章节暂无正文与梗概，无法审阅")

    material = [
        f"【章节】{chapter_title}",
        f"【阶段】{str(chapter['phase'] or '').strip() or '未标注'}",
        f"【章节梗概】{_clip(str(chapter['synopsis'] or '').strip(), 700) or '无'}",
        "",
        "【章节正文】",
        _clip(chapter_text, 18000),
    ]
    return chapter_id, chapter_title, "\n".join(material).strip()


def _load_project_review_material(project_id: str) -> tuple[None, str, str]:
    with get_db() as db:
        project = db.execute(
            "SELECT name, genre, description FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")

        outlines = db.execute(
            "SELECT phase, title, content FROM outlines WHERE project_id = ? ORDER BY phase_order ASC, created_at ASC LIMIT 16",
            (project_id,),
        ).fetchall()
        characters = db.execute(
            "SELECT name, category, identity, personality FROM characters WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 24",
            (project_id,),
        ).fetchall()
        world_items = db.execute(
            "SELECT title, category, content FROM worldbuilding WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 24",
            (project_id,),
        ).fetchall()
        chapters = db.execute(
            "SELECT id, chapter_num, title, synopsis FROM chapters WHERE project_id = ? ORDER BY chapter_num ASC, sort_order ASC LIMIT 120",
            (project_id,),
        ).fetchall()

        chapter_blocks: list[str] = []
        for ch in chapters:
            snippets = db.execute(
                "SELECT content FROM chapter_paragraphs WHERE chapter_id = ? ORDER BY para_index ASC LIMIT 3",
                (str(ch["id"]),),
            ).fetchall()
            snippet_text = " ".join(
                [str(p["content"] or "").strip() for p in snippets if str(p["content"] or "").strip()]
            ).strip()
            synopsis = str(ch["synopsis"] or "").strip()
            block = (
                f"- 第{ch['chapter_num']}章《{ch['title'] or '未命名'}》"
                f" | 梗概:{_clip(synopsis, 120) or '无'}"
                f" | 正文片段:{_clip(snippet_text, 180) or '无'}"
            )
            chapter_blocks.append(block)

    material_parts: list[str] = [
        f"【项目】{project['name']}（题材：{str(project['genre'] or '').strip() or '未标注'}）",
        f"【项目简介】{_clip(str(project['description'] or '').strip(), 420) or '无'}",
    ]

    if characters:
        char_lines = [
            f"- {c['name']}（{str(c['category'] or '').strip() or '未分类'}）"
            f" | 身份:{_clip(str(c['identity'] or '').strip(), 80) or '无'}"
            f" | 性格:{_clip(str(c['personality'] or '').strip(), 60) or '无'}"
            for c in characters
        ]
        material_parts.extend(["", "【角色摘要】", "\n".join(char_lines)])

    if world_items:
        world_lines = [
            f"- {w['title']}（{str(w['category'] or '').strip() or '其他'}）：{_clip(str(w['content'] or '').strip(), 100) or '无'}"
            for w in world_items
        ]
        material_parts.extend(["", "【世界观摘要】", "\n".join(world_lines)])

    if outlines:
        outline_lines = [
            f"- [{str(o['phase'] or '').strip() or '未标注'}] {str(o['title'] or '').strip() or '未命名'}：{_clip(str(o['content'] or '').strip(), 120) or '无'}"
            for o in outlines
        ]
        material_parts.extend(["", "【大纲摘要】", "\n".join(outline_lines)])

    if chapter_blocks:
        material_parts.extend(["", "【章节序列摘要】", "\n".join(chapter_blocks)])
    else:
        material_parts.extend(["", "【章节序列摘要】", "- 暂无章节内容"])

    project_title = f"{project['name']}（全书）"
    return None, project_title, _clip("\n".join(material_parts).strip(), 22000)


def _normalize_review_dimension(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if any(k in text for k in ("consistency", "一致", "连贯", "主线")):
        return "consistency"
    if any(k in text for k in ("character", "人物", "角色")):
        return "character"
    if any(k in text for k in ("pacing", "节奏", "推进")):
        return "pacing"
    if any(k in text for k in ("logic", "逻辑", "因果")):
        return "logic"
    return "logic"


def _normalize_review_severity(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if any(k in text for k in ("高", "high", "严重", "fatal")):
        return "高"
    if any(k in text for k in ("低", "low", "轻微")):
        return "低"
    return "中"


def _normalize_issue_text(raw: Any) -> str:
    text = str(raw or "").strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[\-\*\d\.\)\(、\s]+", "", text)
    return _clip(text, 260)


def _normalize_review_issues(raw_issues: Any, raw_review: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()

    if isinstance(raw_issues, list):
        for item in raw_issues:
            if isinstance(item, dict):
                text = _normalize_issue_text(
                    item.get("text")
                    or item.get("detail")
                    or item.get("description")
                    or item.get("issue")
                    or item.get("problem")
                )
                if not text:
                    continue
                severity = _normalize_review_severity(item.get("severity") or item.get("level") or item.get("priority"))
                dimension = _normalize_review_dimension(item.get("dimension") or item.get("type"))
            else:
                text = _normalize_issue_text(item)
                if not text:
                    continue
                severity = _normalize_review_severity(text)
                dimension = _normalize_review_dimension(text)

            key = f"{dimension}:{severity}:{text}"
            if key in seen:
                continue
            seen.add(key)
            normalized.append({"text": text, "severity": severity, "dimension": dimension})
            if len(normalized) >= 16:
                break

    if normalized:
        return normalized

    lines = [
        _normalize_issue_text(line)
        for line in str(raw_review or "").replace("\r\n", "\n").split("\n")
        if _normalize_issue_text(line)
    ]
    for line in lines:
        if len(line) < 10:
            continue
        if re.search(r"(总评|评分|结论|总结|建议结构|输出要求)", line):
            continue
        if not re.search(r"(问题|冲突|不一致|矛盾|薄弱|突兀|跳跃|混乱|缺失|建议|需要|不足)", line):
            continue
        severity = _normalize_review_severity(line)
        dimension = _normalize_review_dimension(line)
        key = f"{dimension}:{severity}:{line}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"text": line, "severity": severity, "dimension": dimension})
        if len(normalized) >= 10:
            break
    return normalized


def _extract_score_from_text(raw_review: str, aliases: list[str]) -> Optional[int]:
    for alias in aliases:
        pattern = rf"{re.escape(alias)}\s*[：:]\s*(\d{{1,3}})"
        match = re.search(pattern, raw_review, re.IGNORECASE)
        if match:
            try:
                return int(match.group(1))
            except Exception:
                continue
    return None


def _clamp_score(value: Any) -> int:
    try:
        score = int(round(float(value)))
    except Exception:
        score = 0
    return max(0, min(100, score))


def _build_score_fallback(issues: list[dict[str, Any]]) -> dict[str, int]:
    high = sum(1 for item in issues if str(item.get("severity")) == "高")
    medium = sum(1 for item in issues if str(item.get("severity")) == "中")
    low = sum(1 for item in issues if str(item.get("severity")) == "低")
    base = 84 - high * 16 - medium * 8 - low * 4
    base = max(22, min(94, base))
    return {
        "consistency": base,
        "character": max(20, min(96, base - (high * 2))),
        "pacing": max(20, min(96, base - (medium * 2))),
        "logic": max(18, min(95, base - (high * 3))),
    }


def _normalize_review_scores(raw_scores: Any, issues: list[dict[str, Any]], raw_review: str) -> dict[str, int]:
    normalized: dict[str, int] = {}
    if isinstance(raw_scores, dict):
        for key, value in raw_scores.items():
            dim = _normalize_review_dimension(key)
            normalized[dim] = _clamp_score(value)

    aliases = {
        "consistency": ["内容一致性", "一致性", "主线一致性", "consistency"],
        "character": ["人物塑造", "角色塑造", "角色一致性", "character"],
        "pacing": ["叙事节奏", "节奏", "推进节奏", "pacing"],
        "logic": ["角色逻辑", "逻辑", "因果逻辑", "logic"],
    }
    for dim, words in aliases.items():
        if dim in normalized and normalized[dim] > 0:
            continue
        parsed = _extract_score_from_text(raw_review, words)
        if parsed is not None:
            normalized[dim] = _clamp_score(parsed)

    fallback = _build_score_fallback(issues)
    for dim in ("consistency", "character", "pacing", "logic"):
        if dim not in normalized or normalized[dim] <= 0:
            normalized[dim] = fallback[dim]

    if all(v == 0 for v in normalized.values()):
        normalized = fallback
    return normalized


def _normalize_review_summary(raw_summary: Any, raw_review: str) -> str:
    summary = str(raw_summary or "").strip()
    if summary.startswith("```"):
        summary = re.sub(r"^```(?:json)?\s*", "", summary)
        summary = re.sub(r"\s*```$", "", summary)
        summary = summary.strip()

    if not summary:
        summary = str(raw_review or "").strip()
    summary = re.sub(r"\r\n", "\n", summary)
    summary = re.sub(r"\n{3,}", "\n\n", summary)

    if summary and "\n" not in summary and len(summary) > 220:
        summary = re.sub(r"([。！？；;])", r"\1\n", summary)
        summary = re.sub(r"\n{3,}", "\n\n", summary)
    return _clip(summary.strip(), 1800)


def _build_review_filters(
    project_id: str,
    scope: str = "",
    chapter_id: str = "",
) -> tuple[str, list[Any]]:
    clauses = ["project_id = ?"]
    params: list[Any] = [project_id]
    scope_clean = str(scope or "").strip().lower()
    chapter_clean = str(chapter_id or "").strip()
    if scope_clean == "project":
        clauses.append("chapter_id IS NULL")
    elif scope_clean == "chapter":
        if chapter_clean:
            clauses.append("chapter_id = ?")
            params.append(chapter_clean)
        else:
            clauses.append("chapter_id IS NOT NULL")
    elif chapter_clean:
        clauses.append("chapter_id = ?")
        params.append(chapter_clean)
    return " AND ".join(clauses), params


@router.post("/reviews/run")
async def run_review(req: ReviewRunRequest):
    project_id = str(req.project_id or "").strip()
    if not project_id:
        raise HTTPException(400, "project_id 不能为空")

    scope = str(req.scope or "project").strip().lower()
    if scope not in {"project", "chapter"}:
        raise HTTPException(400, "scope 仅支持 project/chapter")
    chapter_id = str(req.chapter_id or "").strip() or None
    if scope == "chapter" and not chapter_id:
        raise HTTPException(400, "chapter 范围必须提供 chapter_id")

    model, temperature, max_tokens, system_prompt, enabled = _load_reviewer_runtime(project_id)
    if not enabled:
        raise HTTPException(400, "审核编辑已在项目设置中禁用")

    if scope == "chapter":
        resolved_chapter_id, scope_title, material_text = _load_single_chapter_review_material(project_id, chapter_id or "")
    else:
        resolved_chapter_id, scope_title, material_text = _load_project_review_material(project_id)

    prompt = f"""
你是连载小说审校主编。请根据给定材料进行审阅，返回严格 JSON。

目标范围：{scope_title}
审阅维度：内容一致性、人物塑造、叙事节奏、角色逻辑。

输出格式（必须严格遵守）：
{{
  "scores": {{
    "consistency": 0-100,
    "character": 0-100,
    "pacing": 0-100,
    "logic": 0-100
  }},
  "issues": [
    {{
      "text": "问题描述（可执行）",
      "severity": "高|中|低",
      "dimension": "consistency|character|pacing|logic"
    }}
  ],
  "summary": "分段总结，包含总体判断与改稿优先级。"
}}

要求：
1) 若无明显问题，issues 可为空数组；
2) 分数必须是数字，且 0-100；
3) 仅输出 JSON，不要 Markdown，不要额外解释。

【审阅材料】
{material_text}
""".strip()

    agent_router._init_services()
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(500, "模型服务未初始化")

    raw_review = await llm.chat(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        temperature=min(max(temperature, 0.0), 1.0),
        max_tokens=max_tokens,
    )

    payload = _parse_json_payload(raw_review)
    issues = _normalize_review_issues(payload.get("issues"), raw_review)
    scores = _normalize_review_scores(payload.get("scores"), issues, raw_review)
    summary = _normalize_review_summary(payload.get("summary"), raw_review)

    with get_db() as db:
        db.execute(
            "INSERT INTO reviews (project_id, chapter_id, scores, issues, summary) VALUES (?,?,?,?,?)",
            (
                project_id,
                resolved_chapter_id if scope == "chapter" else None,
                json.dumps(scores, ensure_ascii=False),
                json.dumps(issues, ensure_ascii=False),
                summary,
            ),
        )
        row = db.execute(
            "SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (project_id,),
        ).fetchone()

    result = dict(row) if row else {}
    return {
        "id": result.get("id"),
        "project_id": project_id,
        "scope": scope,
        "chapter_id": resolved_chapter_id if scope == "chapter" else None,
        "scope_title": scope_title,
        "scores": scores,
        "issues": issues,
        "summary": summary,
        "created_at": result.get("created_at"),
    }


@router.get("/reviews")
def list_reviews(project_id: str, scope: str = "", chapter_id: str = ""):
    where_sql, params = _build_review_filters(project_id, scope, chapter_id)
    with get_db() as db:
        rows = db.execute(
            f"SELECT * FROM reviews WHERE {where_sql} ORDER BY created_at DESC",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


@router.get("/reviews/latest")
def get_latest_review(project_id: str, scope: str = "", chapter_id: str = ""):
    where_sql, params = _build_review_filters(project_id, scope, chapter_id)
    with get_db() as db:
        row = db.execute(
            f"SELECT * FROM reviews WHERE {where_sql} ORDER BY created_at DESC LIMIT 1",
            params,
        ).fetchone()
        if not row:
            return None
        return dict(row)


@router.post("/reviews")
def create_review(data: dict):
    with get_db() as db:
        db.execute(
            "INSERT INTO reviews (project_id, chapter_id, scores, issues, summary) VALUES (?,?,?,?,?)",
            (
                data["project_id"],
                data.get("chapter_id"),
                json.dumps(data.get("scores", {}), ensure_ascii=False),
                json.dumps(data.get("issues", []), ensure_ascii=False),
                data.get("summary", ""),
            ),
        )
        row = db.execute(
            "SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
            (data["project_id"],),
        ).fetchone()
        return dict(row)
