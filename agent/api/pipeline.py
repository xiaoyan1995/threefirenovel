"""参考项目风格的创作流水线接口

包含三类能力：
1) 立项对话（brainstorm）
2) 小说圣经（story bible）生成与查询
3) 基于圣经/项目信息的一键结构化初始化（角色/世界观/大纲/章节）

注意：不改动现有记忆系统实现，仅新增项目层编排能力。
"""
from __future__ import annotations

import ast
import json
import logging
import random
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db
from agents import router as agent_router
from agents import prompts as agent_prompts
from agents.default_prompts import PIPELINE_DEFAULT_SYSTEM_PROMPTS

router = APIRouter()
logger = logging.getLogger(__name__)

ScopeType = Literal["all", "planning", "outline", "characters", "worldbuilding", "chapters"]
BrainstormMode = Literal["fast", "standard", "deep"]
DEFAULT_MODEL = "claude-sonnet-4"
JSON_OBJECT_RESPONSE_FORMAT = {"type": "json_object"}
BRAINSTORM_MAX_TOKENS = 8000
BRAINSTORM_MAX_QUESTIONS = 3
BRAINSTORM_CORE_SLOT_LABELS = {
    "genre": "题材",
    "protagonist": "主角定位",
    "goal": "主角目标",
    "conflict": "主冲突",
    "length": "篇幅",
    "structure": "小说结构",
    "chapter_count": "预估章节数",
    "chapter_words": "每章字数",
    "ending": "结局倾向",
}
BRAINSTORM_CORE_SLOT_ORDER = [
    "genre",
    "protagonist",
    "goal",
    "conflict",
    "length",
    "structure",
    "chapter_count",
    "chapter_words",
    "ending",
]
BRAINSTORM_GENRE_HINT_KEYWORDS = (
    "悬疑",
    "推理",
    "言情",
    "爱情",
    "恋爱",
    "都市",
    "玄幻",
    "修真",
    "仙侠",
    "奇幻",
    "科幻",
    "赛博",
    "历史",
    "权谋",
    "宫斗",
    "校园",
    "现实",
    "军事",
    "战争",
    "惊悚",
    "恐怖",
    "灵异",
    "轻喜",
    "喜剧",
    "搞笑",
    "武侠",
    "古言",
    "现言",
)
BRAINSTORM_UNKNOWN_MARKERS = (
    "不确定",
    "暂不",
    "不知道",
    "待定",
    "没想好",
    "未想好",
    "先不",
    "暂无",
    "以后再说",
)
OTHER_OPTION_VALUE = "__other__"
OTHER_OPTION_LABEL = "其他（手动填写）"
AI_DECIDE_OPTION_VALUE = "__ai_decide__"
AI_DECIDE_OPTION_LABEL = "交给AI决定"
PIPELINE_AGENT_TYPES = {
    "brainstorm": "pipeline_brainstorm",
    "autofill": "pipeline_autofill",
    "bible_generate": "pipeline_bible_generate",
    "bootstrap": "pipeline_bootstrap",
}


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class BrainstormRequest(BaseModel):
    project_id: str
    message: str
    history: list[ChatMessage] = []
    mode: BrainstormMode = "fast"
    selected_source_ids: list[str] = []


class BrainstormQuestionOption(BaseModel):
    label: str
    value: str


class BrainstormQuestion(BaseModel):
    id: str
    title: str
    qtype: Literal["single", "multi", "text", "number"] = "text"
    options: list[BrainstormQuestionOption] = []
    required: bool = True
    max_select: Optional[int] = None
    placeholder: str = ""


class BrainstormOptionRefreshRequest(BaseModel):
    project_id: str
    title: str
    qtype: Literal["single", "multi"] = "single"
    options: list[BrainstormQuestionOption] = []
    history: list[ChatMessage] = []
    mode: BrainstormMode = "fast"


class BrainstormResponse(BaseModel):
    reply: str
    questions: list[BrainstormQuestion] = []
    ready_for_bible: bool = False
    resolved_model: str = ""


class BrainstormOptionRefreshResponse(BaseModel):
    options: list[BrainstormQuestionOption] = []


class GenerateBibleRequest(BaseModel):
    project_id: str
    brief: str = ""
    history: list[ChatMessage] = []
    selected_source_ids: list[str] = []
    option_history: list[dict[str, Any]] = []


class SaveBibleRequest(BaseModel):
    project_id: str
    content: str
    brief: str = ""


class StoryBibleResponse(BaseModel):
    version: int
    content: str
    created_at: str


class ReviseBibleRequest(BaseModel):
    project_id: str
    instruction: str
    base_version: Optional[int] = None
    locked_sections: list[str] = []


class ReviseBibleResponse(BaseModel):
    base_version: int
    revised_content: str
    changed_sections: list[str] = []
    change_summary: str = ""


class PlanningStudioStateUpsertRequest(BaseModel):
    project_id: str
    state: dict[str, Any] = {}


class PlanningStudioStateResponse(BaseModel):
    project_id: str
    state: dict[str, Any] = {}
    updated_at: str


class ProjectAutofillRequest(BaseModel):
    project_id: str
    history: list[ChatMessage] = []
    bible: str = ""


class ProjectAutofillResponse(BaseModel):
    name: str
    name_candidates: list[str] = []
    genre: str
    description: str
    word_target: int
    structure: str
    custom_structure: str = ""
    chapter_words: int
    priority: str
    reason: str = ""


class BootstrapRequest(BaseModel):
    project_id: str
    scope: ScopeType = "all"
    chapter_count: Optional[int] = None
    start_chapter: Optional[int] = None
    end_chapter: Optional[int] = None
    batch_size: Optional[int] = None
    volume_index: Optional[int] = None
    volume_title: str = ""
    volume_start_chapter: Optional[int] = None
    volume_end_chapter: Optional[int] = None
    force: bool = False
    use_bible: bool = True
    use_profile: bool = True


class BootstrapResponse(BaseModel):
    inserted: dict
    skipped: dict
    message: str
    effective_range: Optional[dict] = None
    batch_stats: Optional[dict] = None
    failed_range: Optional[dict] = None
    retry_count: int = 0
    format_degraded: bool = False


class VolumePlanGenerateRequest(BaseModel):
    project_id: str
    target_word_count: Optional[int] = None
    target_volume_count: int = 8
    chapter_count: Optional[int] = None
    force: bool = False
    use_bible: bool = True
    use_profile: bool = True


class VolumePlanResponse(BaseModel):
    items: list[dict]
    message: str


class VolumePlanCheckResponse(BaseModel):
    ok: bool
    issues: list[str] = []
    total_chapter_count: int = 0


class WorldModelCheckRequest(BaseModel):
    project_id: str
    text: str
    chapter_num: Optional[int] = None
    chapter_title: str = ""
    use_bible: bool = True
    use_profile: bool = True
    use_planning_material: bool = True
    use_recent_chapters: bool = True
    recent_limit: int = 12


class WorldModelCheckIssue(BaseModel):
    type: Literal["world", "prop", "character", "timeline", "plot", "other"] = "other"
    severity: Literal["high", "medium", "low"] = "medium"
    quote: str = ""
    description: str
    suggestion: str = ""


class WorldModelCheckResponse(BaseModel):
    ok: bool
    summary: str = ""
    issues: list[WorldModelCheckIssue] = []
    context_flags: dict[str, bool] = {}
    resolved_model: str = ""


CORE_SLOT_OPTION_TEMPLATES: dict[str, list[tuple[str, str]]] = {
    "genre": [
        ("都市悬疑", "都市悬疑"),
        ("都市言情", "都市言情"),
        ("古代权谋", "古代权谋"),
        ("古风言情", "古风言情"),
        ("玄幻修真", "玄幻修真"),
        ("科幻/赛博", "科幻/赛博"),
        ("现实主义", "现实主义"),
    ],
    "protagonist": [
        ("单女主", "单女主"),
        ("单男主", "单男主"),
        ("双主角", "双主角"),
        ("群像主角团", "群像主角团"),
        ("反英雄主角", "反英雄主角"),
    ],
    "goal": [
        ("查清关键谜案并公开真相", "查清关键谜案并公开真相"),
        ("保护重要之人并阻止悲剧重演", "保护重要之人并阻止悲剧重演"),
        ("摆脱被操控处境并夺回主动权", "摆脱被操控处境并夺回主动权"),
        ("为冤案翻案并让幕后者付代价", "为冤案翻案并让幕后者付代价"),
        ("在权力斗争中夺回主导地位", "在权力斗争中夺回主导地位"),
    ],
    "conflict": [
        ("强敌持续压制且证据链被封锁", "强敌持续压制且证据链被封锁"),
        ("制度规则卡死主角行动空间", "制度规则卡死主角行动空间"),
        ("身份秘密随时暴露并反噬主线", "身份秘密随时暴露并反噬主线"),
        ("情感关系与阵营立场正面对撞", "情感关系与阵营立场正面对撞"),
        ("资源稀缺叠加时限危机同步升级", "资源稀缺叠加时限危机同步升级"),
    ],
    "length": [
        ("短篇（3-5万字）", "短篇（3-5万字）"),
        ("中篇（8-12万字）", "中篇（8-12万字）"),
        ("长篇（15-20万字）", "长篇（15-20万字）"),
        ("超长篇（25万字以上）", "超长篇（25万字以上）"),
    ],
    "structure": [
        ("单元案件式（单元事件串联）", "单元案件式（单元事件串联）"),
        ("强主线式（一条主线持续推进）", "强主线式（一条主线持续推进）"),
        ("主线+支线并行", "主线+支线并行"),
        ("群像网状推进", "群像网状推进"),
    ],
    "chapter_count": [
        ("约12章", "约12章"),
        ("约20章", "约20章"),
        ("约30章", "约30章"),
        ("约40章", "约40章"),
        ("约60章", "约60章"),
    ],
    "chapter_words": [
        ("每章约2000字", "每章约2000字"),
        ("每章约3000字", "每章约3000字"),
        ("每章约4500字", "每章约4500字"),
        ("每章约6000字", "每章约6000字"),
        ("每章约8000字", "每章约8000字"),
    ],
    "ending": [
        ("HE（圆满）", "HE（圆满）"),
        ("BE（悲剧）", "BE（悲剧）"),
        ("开放式", "开放式"),
        ("悲喜混合", "悲喜混合"),
    ],
}

GOAL_SLOT_OPTION_VARIANTS: dict[str, list[str]] = {
    "suspense": [
        "锁定首个真凶线索并做证据闭环",
        "揭开关键失踪案背后操盘者",
        "在时限内还原案发当晚链条",
        "找到被篡改证据并公开校验",
        "逼出幕后同盟并拿到公示证据",
        "保住调查资格同时推进真相曝光",
        "保护关键证人并完成指认",
        "拆穿伪证叙事重建事实顺序",
    ],
    "romance": [
        "确认彼此底线并建立信任契约",
        "在家族阻力下守住关系选择权",
        "解开误会并完成一次坦白对话",
        "兼顾事业与感情避免关系失衡",
        "让对方看见真实自我并被接纳",
        "终止消耗关系并重建边界",
        "挽回破裂联盟并给出承诺代价",
        "在关键抉择中选择共同未来",
    ],
    "fantasy": [
        "突破当前境界并补齐能力短板",
        "夺回核心资源点稳住宗门局势",
        "找到传承真相并修复力量反噬",
        "集齐关键线索解锁上古封印",
        "在大战前完成队伍重组磨合",
        "守住城池并阻断敌方补给线",
        "赢下试炼取得进入禁地资格",
        "斩断心魔束缚恢复战力峰值",
    ],
    "history_power": [
        "夺回朝局话语权并稳住盟友",
        "查清旧案为家族翻案复位",
        "拆解政敌布局并反制舆论",
        "在权力博弈中保住继承顺位",
        "以最小代价完成派系整合",
        "先稳边局再推进内政清洗",
        "揭露通敌证据迫使对手退场",
        "在皇权压力下守住底线原则",
    ],
    "sci_fi": [
        "破解核心协议阻止系统失控",
        "夺回关键节点避免城市瘫痪",
        "找出内鬼并封堵数据泄露链",
        "修复主控偏差并重建规则",
        "在倒计时前完成舰队撤离",
        "追踪异常信号定位母体来源",
        "关闭危险实验并保全证据",
        "打通跨域协作完成危机止损",
    ],
    "urban_reality": [
        "保住岗位同时查清项目黑箱",
        "在舆论压力下守住职业底线",
        "拿下关键合同逆转团队处境",
        "弥补决策失误并重建团队信任",
        "用有限资源完成阶段性翻盘",
        "解决债务危机争取喘息窗口",
        "揪出背锅链条恢复个人名誉",
        "兼顾家庭责任与事业推进",
    ],
    "military": [
        "拿下战略高地打通补给通道",
        "识破诱敌计划避免主力折损",
        "限时突围并完成平民撤离",
        "修复指挥链断点重建节奏",
        "夺回制空权压制敌方火力",
        "保护核心情报安全送达前线",
        "稳住士气并完成反攻部署",
        "以最小伤亡达成战役目标",
    ],
    "horror": [
        "查明诡异源头并设法封锁",
        "保护同伴存活并找到撤离路径",
        "识别规则陷阱避免二次触发",
        "在天亮前完成仪式逆转",
        "找到失联者并确认生死真相",
        "破坏诅咒媒介阻断污染扩散",
        "用有限线索拼出真相拼图",
        "在恐惧失控前稳住团队秩序",
    ],
    "generic": [
        "查清关键真相并形成证据闭环",
        "保护核心关系并阻止局势失控",
        "夺回主动权并打破被动局面",
        "为旧案翻案并追究幕后责任",
        "在高压对抗中守住底线成果",
        "完成阶段目标并埋下后续反转",
        "解决眼前危机并为终局铺路",
        "在代价可控下实现核心诉求",
    ],
}

GOAL_THEME_KEYWORDS: dict[str, tuple[str, ...]] = {
    "suspense": ("悬疑", "推理", "刑侦", "侦探", "谜案", "破案", "调查", "谍战", "校园悬疑"),
    "romance": ("言情", "恋爱", "爱情", "婚恋", "古言", "甜宠", "虐恋", "情感"),
    "fantasy": ("玄幻", "奇幻", "修真", "仙侠", "宗门", "异能", "魔法", "秘境"),
    "history_power": ("历史", "权谋", "宫斗", "朝堂", "王朝", "夺嫡", "侯门", "庙堂"),
    "sci_fi": ("科幻", "赛博", "未来", "机甲", "星际", "ai", "人工智能", "系统"),
    "urban_reality": ("都市", "现实", "职场", "商战", "家庭", "创业", "世情", "校园"),
    "military": ("军事", "战争", "战役", "前线", "军旅", "突围", "阵地"),
    "horror": ("惊悚", "恐怖", "灵异", "诡异", "诅咒", "怪谈", "凶宅"),
}

LOW_QUALITY_OPTION_EXACT = {
    "保持当前方向",
    "尝试反转设定",
    "提高冲突强度",
    "看情况",
    "都可以",
    "随机",
    "待定",
    "不确定",
    "按常规",
}
LOW_QUALITY_SLOT_PHRASES: dict[str, set[str]] = {
    "goal": {
        "查明真相",
        "守护重要之人",
        "自救与成长",
        "复仇或翻案",
        "逆袭上位",
        "自我成长",
    },
    "conflict": {
        "强敌持续压制",
        "规则制度封锁",
        "身份秘密暴露风险",
        "情感与立场对立",
        "资源稀缺时限危机",
    },
}
SPLIT_REQUIRED_CORE_SLOTS = {
    "protagonist",
    "goal",
    "length",
    "structure",
}


def _clip(text: str, limit: int) -> str:
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit] + "..."


def _strip_fence(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json|markdown)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _try_json_dict(text: str) -> Optional[dict]:
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _try_python_dict(text: str) -> Optional[dict]:
    """兼容模型偶发返回 Python 字典风格（单引号/True/None）。"""
    try:
        parsed = ast.literal_eval(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _try_json_list(text: str) -> Optional[list]:
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, list) else None


def _try_python_list(text: str) -> Optional[list]:
    try:
        parsed = ast.literal_eval(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, list) else None


def _extract_first_json_object(text: str) -> str:
    start: Optional[int] = None
    depth = 0
    in_string = False
    quote_char = ""
    escaped = False
    for idx, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == quote_char:
                in_string = False
            continue

        if ch in {'"', "'"}:
            in_string = True
            quote_char = ch
            continue
        if ch == "{":
            if depth == 0:
                start = idx
            depth += 1
            continue
        if ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                return text[start : idx + 1]
    return ""


def _extract_first_json_array(text: str) -> str:
    start: Optional[int] = None
    depth = 0
    in_string = False
    quote_char = ""
    escaped = False
    for idx, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == quote_char:
                in_string = False
            continue

        if ch in {'"', "'"}:
            in_string = True
            quote_char = ch
            continue
        if ch == "[":
            if depth == 0:
                start = idx
            depth += 1
            continue
        if ch == "]" and depth > 0:
            depth -= 1
            if depth == 0 and start is not None:
                return text[start : idx + 1]
    return ""


def _extract_first_json_object_brace_only(text: str) -> str:
    """忽略字符串状态，仅按大括号配对提取首个对象，容错处理坏引号。"""
    start = text.find("{")
    if start < 0:
        return ""
    depth = 0
    for idx in range(start, len(text)):
        ch = text[idx]
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return text[start:]


def _extract_first_json_array_bracket_only(text: str) -> str:
    """忽略字符串状态，仅按中括号配对提取首个数组，容错处理坏引号。"""
    start = text.find("[")
    if start < 0:
        return ""
    depth = 0
    for idx in range(start, len(text)):
        ch = text[idx]
        if ch == "[":
            depth += 1
            continue
        if ch == "]":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return text[start:]


def _normalize_json_candidate(text: str) -> str:
    t = (text or "").strip().lstrip("\ufeff")
    if not t:
        return ""
    # 常见引号异常与尾逗号，尽量做最小修复。
    t = (
        t.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
    )
    prev = None
    while prev != t:
        prev = t
        t = re.sub(r",\s*([}\]])", r"\1", t)
    return t.strip()


def _repair_json_candidate_for_parse(text: str, *, root_kind: Literal["dict", "list"]) -> str:
    """面向解析阶段的兜底修复：修坏引号、全角分隔符与配对括号。"""
    source = _normalize_json_candidate(text)
    if not source:
        return ""

    out: list[str] = []
    stack: list[str] = []
    in_string = False
    escaped = False
    n = len(source)

    def _next_non_ws_char(pos: int) -> str:
        j = pos
        while j < n and source[j].isspace():
            j += 1
        return source[j] if j < n else ""

    for idx, ch in enumerate(source):
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
                continue
            if ch == "\\":
                out.append(ch)
                escaped = True
                continue
            if ch in {"\r", "\n"}:
                out.append("\\n")
                continue
            if ch == '"':
                nxt = _next_non_ws_char(idx + 1)
                if nxt in {",", "}", "]", ":", ""}:
                    out.append(ch)
                    in_string = False
                else:
                    out.append('\\"')
                continue
            out.append(ch)
            continue

        if ch in {'"', "'"}:
            out.append('"')
            in_string = True
            escaped = False
            continue
        if ch == "，":
            out.append(",")
            continue
        if ch == "：":
            out.append(":")
            continue
        if ch == "{":
            stack.append("{")
            out.append(ch)
            continue
        if ch == "[":
            stack.append("[")
            out.append(ch)
            continue
        if ch == "}":
            if stack and stack[-1] == "{":
                stack.pop()
                out.append(ch)
            continue
        if ch == "]":
            if stack and stack[-1] == "[":
                stack.pop()
                out.append(ch)
            continue
        out.append(ch)

    if in_string:
        out.append('"')
    for token in reversed(stack):
        out.append("}" if token == "{" else "]")

    repaired = "".join(out).strip()
    if not repaired:
        return ""

    prev = None
    while prev != repaired:
        prev = repaired
        repaired = re.sub(r",\s*([}\]])", r"\1", repaired)

    if root_kind == "dict":
        extracted = _extract_first_json_object(repaired) or _extract_first_json_object_brace_only(repaired)
    else:
        extracted = _extract_first_json_array(repaired) or _extract_first_json_array_bracket_only(repaired)
    return (extracted or repaired).strip()


def _parse_payload(raw: str) -> dict:
    text = _strip_fence(raw)
    if not text:
        return {}

    extracted = _extract_first_json_object(text)
    extracted_brace_only = _extract_first_json_object_brace_only(text)
    candidates: list[str] = [text]
    if extracted and extracted != text:
        candidates.append(extracted)
    if extracted_brace_only and extracted_brace_only not in candidates:
        candidates.append(extracted_brace_only)

    for c in candidates:
        for parser in (_try_json_dict, _try_python_dict):
            parsed = parser(c)
            if parsed is not None:
                return parsed

        fixed = _normalize_json_candidate(c)
        if fixed and fixed != c:
            for parser in (_try_json_dict, _try_python_dict):
                parsed = parser(fixed)
                if parsed is not None:
                    return parsed

        repaired = _repair_json_candidate_for_parse(c, root_kind="dict")
        if repaired and repaired not in {c, fixed}:
            for parser in (_try_json_dict, _try_python_dict):
                parsed = parser(repaired)
                if parsed is not None:
                    return parsed

    return {}


def _parse_payload_list(raw: str) -> list:
    text = _strip_fence(raw)
    if not text:
        return []

    extracted = _extract_first_json_array(text)
    extracted_bracket_only = _extract_first_json_array_bracket_only(text)
    candidates: list[str] = [text]
    if extracted and extracted != text:
        candidates.append(extracted)
    if extracted_bracket_only and extracted_bracket_only not in candidates:
        candidates.append(extracted_bracket_only)

    for c in candidates:
        for parser in (_try_json_list, _try_python_list):
            parsed = parser(c)
            if parsed is not None:
                return parsed

        fixed = _normalize_json_candidate(c)
        if fixed and fixed != c:
            for parser in (_try_json_list, _try_python_list):
                parsed = parser(fixed)
                if parsed is not None:
                    return parsed

        repaired = _repair_json_candidate_for_parse(c, root_kind="list")
        if repaired and repaired not in {c, fixed}:
            for parser in (_try_json_list, _try_python_list):
                parsed = parser(repaired)
                if parsed is not None:
                    return parsed
    return []


def _payload_parse_diagnostics(raw: str) -> str:
    text = _strip_fence(raw)
    if not text:
        return "empty"
    extracted = _extract_first_json_object(text)
    candidate = extracted or text
    normalized = _normalize_json_candidate(candidate)
    target = normalized or candidate
    json_status = "json_ok"
    python_status = "py_ok"
    try:
        parsed = json.loads(target)
        if not isinstance(parsed, dict):
            json_status = f"json_not_dict={type(parsed).__name__}"
    except Exception as exc:
        json_status = f"json_err={type(exc).__name__}:{_clip(str(exc), 160)}"
    try:
        parsed_py = ast.literal_eval(target)
        if not isinstance(parsed_py, dict):
            python_status = f"py_not_dict={type(parsed_py).__name__}"
    except Exception as exc:
        python_status = f"py_err={type(exc).__name__}:{_clip(str(exc), 160)}"
    obj_open = target.count("{")
    obj_close = target.count("}")
    arr_open = target.count("[")
    arr_close = target.count("]")
    tail = _clip(repr(target[-220:]), 260)
    return (
        f"{json_status}; {python_status}; "
        f"len={len(target)}; braces={obj_open}/{obj_close}; brackets={arr_open}/{arr_close}; "
        f"tail={tail}"
    )


def _extract_brainstorm_reply_from_jsonish(raw: str) -> str:
    text = _strip_fence(raw)
    if not text:
        return ""
    candidates = [text]
    extracted = _extract_first_json_object(text)
    if extracted and extracted != text:
        candidates.append(extracted)
    for candidate in candidates:
        if not candidate:
            continue
        m = re.search(r'"reply"\s*:\s*"((?:\\.|[^"\\])*)"', candidate, re.S)
        if not m:
            continue
        encoded = f"\"{m.group(1)}\""
        try:
            decoded = json.loads(encoded)
            if isinstance(decoded, str) and decoded.strip():
                return decoded.strip()
        except Exception:
            pass
        rough = m.group(1)
        rough = rough.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"').replace("\\\\", "\\")
        if rough.strip():
            return rough.strip()
    return ""


BOOTSTRAP_KEYS = ("outlines", "characters", "worldbuilding", "chapters")
MAX_BOOTSTRAP_CHAPTER_COUNT = 300
BOOTSTRAP_AUTO_SPLIT_CHAPTER_THRESHOLD = 80
DEFAULT_CHAPTER_RANGE_BATCH_SIZE = 40
MIN_CHAPTER_RANGE_BATCH_SIZE = 10
MAX_CHAPTER_RANGE_BATCH_SIZE = 40
MAX_CHAPTER_INDEX_HARD_LIMIT = 5000
_BOOTSTRAP_SCOPE_TO_KEY = {
    "outline": "outlines",
    "characters": "characters",
    "worldbuilding": "worldbuilding",
    "chapters": "chapters",
}
_BOOTSTRAP_SCOPE_LABELS = {
    "outline": "大纲",
    "characters": "角色",
    "worldbuilding": "世界观",
    "chapters": "章节",
}


def _target_character_count_range(chapter_count: int) -> tuple[int, int]:
    safe = max(1, int(chapter_count or 1))
    if safe <= 12:
        return 6, 10
    if safe <= 24:
        return 8, 14
    if safe <= 60:
        return 10, 18
    if safe <= 120:
        return 12, 22
    return 14, 24


def _target_character_role_mix(chapter_count: int) -> dict[str, tuple[int, int]]:
    safe = max(1, int(chapter_count or 1))
    if safe <= 12:
        return {"主角": (1, 2), "反派": (1, 2), "配角": (3, 6), "其他": (1, 2)}
    if safe <= 24:
        return {"主角": (1, 2), "反派": (1, 2), "配角": (5, 8), "其他": (1, 3)}
    if safe <= 60:
        return {"主角": (1, 3), "反派": (2, 3), "配角": (6, 10), "其他": (1, 4)}
    if safe <= 120:
        return {"主角": (1, 3), "反派": (2, 4), "配角": (7, 12), "其他": (2, 5)}
    return {"主角": (1, 4), "反派": (3, 5), "配角": (8, 14), "其他": (2, 6)}


def _character_category_label(category: str) -> str:
    cat = str(category or "").strip()
    if cat == "其他":
        return "其他(功能/路人)"
    return cat or "其他(功能/路人)"


def _format_character_role_mix_targets(chapter_count: int) -> str:
    targets = _target_character_role_mix(chapter_count)
    ordered = ("主角", "反派", "配角", "其他")
    parts: list[str] = []
    for category in ordered:
        minimum, maximum = targets.get(category, (0, 0))
        parts.append(f"{_character_category_label(category)} {minimum}-{maximum} 个")
    return "；".join(parts)


def _character_category_counts(items: list[dict]) -> dict[str, int]:
    counts = {"主角": 0, "反派": 0, "配角": 0, "其他": 0}
    for item in items or []:
        if not isinstance(item, dict):
            continue
        category = _safe_category(str(item.get("category", "配角")))
        counts[category] = counts.get(category, 0) + 1
    return counts


def _character_mix_shortfalls(items: list[dict], chapter_count: int) -> dict[str, int]:
    targets = _target_character_role_mix(chapter_count)
    counts = _character_category_counts(items)
    shortfalls: dict[str, int] = {}
    for category, (minimum, _maximum) in targets.items():
        deficit = max(0, int(minimum) - int(counts.get(category, 0)))
        if deficit > 0:
            shortfalls[category] = deficit
    return shortfalls


def _format_character_mix_shortfalls(shortfalls: dict[str, int]) -> str:
    if not shortfalls:
        return ""
    ordered = ("主角", "反派", "配角", "其他")
    parts: list[str] = []
    for category in ordered:
        deficit = int(shortfalls.get(category, 0))
        if deficit <= 0:
            continue
        parts.append(f"{_character_category_label(category)}缺 {deficit}")
    return "；".join(parts)


def _bootstrap_required_keys_for_scopes(scopes: set[str]) -> list[str]:
    ordered: list[str] = []
    for scope in ("outline", "characters", "worldbuilding", "chapters"):
        if scope not in scopes:
            continue
        key = _BOOTSTRAP_SCOPE_TO_KEY.get(scope)
        if key and key not in ordered:
            ordered.append(key)
    if not ordered:
        return list(BOOTSTRAP_KEYS)
    return ordered


def _bootstrap_scope_label(scopes: set[str]) -> str:
    labels = [
        _BOOTSTRAP_SCOPE_LABELS[s]
        for s in ("outline", "characters", "worldbuilding", "chapters")
        if s in scopes
    ]
    if not labels:
        return "全量"
    return " + ".join(labels)


def _bootstrap_output_field_specs(
    scopes: set[str],
    *,
    project_structure: str = "起承转合",
    custom_structure: str = "",
) -> list[str]:
    required_keys = set(_bootstrap_required_keys_for_scopes(scopes))
    phase_labels = _resolve_outline_phase_labels(project_structure, custom_structure, max_count=12)
    phase_hint = " / ".join(phase_labels[:8]) if phase_labels else "项目结构阶段标签"
    specs: list[str] = []
    if "outlines" in required_keys:
        specs.append(
            "- outlines: 数组。元素 {phase, title, content, word_range}，"
            f"phase 应匹配当前项目结构（建议使用：{phase_hint}）"
        )
    if "characters" in required_keys:
        specs.append(
            "- characters: 数组。元素 {name, category, gender, age, identity, appearance, personality, motivation, backstory, arc, usage_notes, relations}；"
            "relations 为可选数组，元素 {target, relation_type, description}；"
            "建议输出不少于 6 个具名角色（长篇按章节规模增加）"
        )
    if "worldbuilding" in required_keys:
        specs.append("- worldbuilding: 数组。元素 {category, title, content}")
    if "chapters" in required_keys:
        specs.append("- chapters: 数组。元素 {chapter_num, title, phase, synopsis}")
    return specs


def _bootstrap_schema_constraint_lines(
    scopes: set[str],
    chapter_count: int,
    *,
    project_structure: str = "起承转合",
    custom_structure: str = "",
    include_top_level: bool = True,
) -> list[str]:
    required_keys = _bootstrap_required_keys_for_scopes(scopes)
    required_set = set(required_keys)
    phase_labels = _resolve_outline_phase_labels(project_structure, custom_structure, max_count=12)
    phase_hint = " / ".join(phase_labels[:8]) if phase_labels else "项目结构阶段标签"
    lines: list[str] = []
    if include_top_level:
        lines.append(f"顶层必须包含 {' / '.join(required_keys)} 字段，且都为数组")
    if "outlines" in required_set:
        lines.append(
            "outlines 元素字段：phase,title,content,word_range；"
            f"phase 必须匹配当前项目结构（建议使用：{phase_hint}）"
        )
        lines.append(
            "若上下文已给出角色设定，outlines.content 需优先使用具体角色姓名，不要只写“主角/反派/某人”等泛称"
        )
    if "characters" in required_set:
        char_min, char_max = _target_character_count_range(chapter_count)
        mix_target_text = _format_character_role_mix_targets(chapter_count)
        lines.append(
            "characters 元素字段：name,category,gender,age,identity,appearance,personality,motivation,backstory,arc,usage_notes,relations"
            "（name 不得为空、不得重复，且不能使用“角色A/角色1/某人”等占位名；"
            "gender 不得为空（若不确定默认写“男”）；"
            "age 必须为数字字符串（仅数字，不含“岁”；若不确定默认写 18）；"
            "relations 可选数组，元素为 target,relation_type,description）"
        )
        lines.append(
            f"characters 数量建议 {char_min}-{char_max}，且不少于 {char_min} 个具名角色（除非用户明确要求更少）"
        )
        lines.append(f"characters.category 配比建议：{mix_target_text}。反派不可缺失，其他(功能/路人)不可全部省略")
    if "worldbuilding" in required_set:
        lines.append("worldbuilding 元素字段：category,title,content")
    if "chapters" in required_set:
        lines.append(
            "chapters 元素字段：chapter_num,title,phase,synopsis；"
            f"chapter_num 从 1 开始连续，目标到 {chapter_count}"
        )
    return lines


def _bootstrap_writing_requirements(
    scopes: set[str],
    chapter_count: int,
    *,
    project_structure: str = "起承转合",
    custom_structure: str = "",
) -> list[str]:
    phase_labels = _resolve_outline_phase_labels(project_structure, custom_structure, max_count=12)
    phase_hint = " / ".join(phase_labels[:8]) if phase_labels else "项目结构阶段标签"
    requirements = [
        "结果要中文，风格匹配题材",
        "不要空值，字段尽量完整",
        "若存在“小说圣经”，必须严格遵循硬约束",
        "若存在“知识规则包”，必须优先满足其写作规则与禁忌约束",
    ]
    if "outline" in scopes:
        requirements.insert(1, f"outlines.phase 分布要合理，并遵循当前项目结构（建议使用：{phase_hint}）")
        requirements.insert(2, "若上下文已有角色设定，阶段内容需出现具体角色姓名（避免仅写“主角/反派”）")
    elif "chapters" in scopes:
        requirements.insert(1, "章节 phase 分布要合理（起/承/转/合）")
    if "chapters" in scopes:
        requirements.insert(2, f"章节从 1 连续到 {chapter_count}")
        requirements.insert(3, "synopsis 每条控制在 40-120 字")
    if "characters" in scopes:
        char_min, char_max = _target_character_count_range(chapter_count)
        mix_target_text = _format_character_role_mix_targets(chapter_count)
        requirements.append(
            "角色字段必须完整：name/category/gender/age/identity/appearance/personality/motivation/backstory/arc/usage_notes；"
            "gender 不得留空（默认男）；age 必须为数字（未知也写默认值 18）。"
        )
        requirements.append(f"角色数量建议 {char_min}-{char_max}，避免只给 2-3 个模板角色。")
        requirements.append(f"角色结构建议：{mix_target_text}。至少包含主角、反派、配角与功能/路人角色。")
    return requirements


def _is_bootstrap_payload(payload: dict, *, scopes: Optional[set[str]] = None) -> bool:
    if not isinstance(payload, dict):
        return False
    required_keys = _bootstrap_required_keys_for_scopes(scopes or set())
    for key in required_keys:
        _, found = _extract_bootstrap_scope_list(payload, key)
        if not found:
            return False
    return True


def _has_list_like_field(raw: Any, *, nested_keys: tuple[str, ...]) -> bool:
    if isinstance(raw, list):
        return True
    if not isinstance(raw, dict):
        return False
    for key in nested_keys:
        if isinstance(raw.get(key), list):
            return True
    return any(isinstance(candidate, list) for candidate in raw.values())


def _coerce_payload_list(raw: Any, *, nested_keys: tuple[str, ...]) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        return []
    for key in nested_keys:
        candidate = raw.get(key)
        if isinstance(candidate, list):
            return candidate
    for candidate in raw.values():
        if isinstance(candidate, list):
            return candidate
    return []


_BOOTSTRAP_LIST_NESTED_KEYS: dict[str, tuple[str, ...]] = {
    "outlines": ("items", "list", "data", "outline_items", "phases", "stages", "大纲", "阶段"),
    "characters": ("items", "list", "data", "profiles", "roles", "人物", "角色", "角色档案"),
    "worldbuilding": ("items", "list", "data", "settings", "rules", "世界观", "设定"),
    "chapters": ("items", "list", "data", "chapter_list", "章节", "章纲"),
}


_BOOTSTRAP_TOP_LEVEL_ALIASES: dict[str, tuple[str, ...]] = {
    "outlines": (
        "outline",
        "outline_items",
        "phases",
        "stages",
        "大纲",
        "提纲",
        "剧情大纲",
        "阶段",
    ),
    "characters": (
        "character",
        "profiles",
        "roles",
        "人物",
        "角色",
        "角色档案",
        "人设",
    ),
    "worldbuilding": (
        "worldbuilding_items",
        "world",
        "settings",
        "世界观",
        "设定",
        "世界设定",
    ),
    "chapters": (
        "chapter",
        "chapter_list",
        "chapter_plan",
        "章节",
        "章纲",
        "分章",
    ),
}

_BOOTSTRAP_WRAPPER_KEYS: tuple[str, ...] = (
    "data",
    "result",
    "payload",
    "output",
    "response",
    "json",
    "content",
    "规划",
    "结果",
)


def _bootstrap_aliases_for_key(key: str) -> tuple[str, ...]:
    aliases: list[str] = [key]
    for alias in _BOOTSTRAP_TOP_LEVEL_ALIASES.get(key, ()):
        if alias not in aliases:
            aliases.append(alias)
    for alias in _BOOTSTRAP_LIST_NESTED_KEYS.get(key, ()):
        if alias not in aliases:
            aliases.append(alias)
    return tuple(aliases)


def _extract_bootstrap_scope_list(payload: Any, key: str, *, depth: int = 0) -> tuple[list[Any], bool]:
    if depth > 4 or not isinstance(payload, dict):
        return [], False

    nested_keys = _BOOTSTRAP_LIST_NESTED_KEYS.get(key, ())
    for alias in _bootstrap_aliases_for_key(key):
        if alias not in payload:
            continue
        candidate = payload.get(alias)
        if isinstance(candidate, list):
            return candidate, True
        if isinstance(candidate, dict):
            list_candidate = _coerce_payload_list(candidate, nested_keys=nested_keys)
            if any(isinstance(candidate.get(nk), list) for nk in nested_keys):
                return list_candidate, True
            nested_list, nested_found = _extract_bootstrap_scope_list(candidate, key, depth=depth + 1)
            if nested_found:
                return nested_list, True

    for wrapper_key in _BOOTSTRAP_WRAPPER_KEYS:
        if wrapper_key not in payload:
            continue
        nested_list, nested_found = _extract_bootstrap_scope_list(
            payload.get(wrapper_key),
            key,
            depth=depth + 1,
        )
        if nested_found:
            return nested_list, True

    for value in payload.values():
        if not isinstance(value, dict):
            continue
        nested_list, nested_found = _extract_bootstrap_scope_list(value, key, depth=depth + 1)
        if nested_found:
            return nested_list, True

    return [], False


def _normalize_bootstrap_payload(payload: dict) -> dict:
    outlines, _ = _extract_bootstrap_scope_list(payload, "outlines")
    characters, _ = _extract_bootstrap_scope_list(payload, "characters")
    worldbuilding, _ = _extract_bootstrap_scope_list(payload, "worldbuilding")
    chapters, _ = _extract_bootstrap_scope_list(payload, "chapters")
    return {
        "outlines": outlines,
        "characters": characters,
        "worldbuilding": worldbuilding,
        "chapters": chapters,
    }


async def _repair_bootstrap_payload_with_llm(
    llm,
    model: str,
    raw: str,
    chapter_count: int,
    scopes: set[str],
) -> dict:
    constraints = _bootstrap_schema_constraint_lines(scopes, chapter_count, include_top_level=True)
    constraints.append("若原始输出缺少必需字段，补空数组；禁止输出额外说明文本")
    constraint_block = "\n".join(
        f"{idx}) {line}" for idx, line in enumerate(constraints, start=1)
    )
    repair_system = (
        "你是 JSON 修复器。只做格式修复，不改写设定意图。"
        "只输出一个严格 JSON 对象，不要 Markdown，不要解释。"
    )
    repair_user = f"""
把下面“原始输出”修复为可被 JSON.parse 直接解析的 JSON 对象。

硬约束：
{constraint_block}

原始输出如下（可能混有代码块标记/注释/尾逗号等格式错误）：
{raw}
""".strip()
    try:
        fixed_raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": repair_system},
                {"role": "user", "content": repair_user},
            ],
            temperature=0.0,
            max_tokens=4200,
            response_format=JSON_OBJECT_RESPONSE_FORMAT,
        )
    except Exception:
        return {}

    parsed = _parse_payload(fixed_raw)
    if not _is_bootstrap_payload(parsed, scopes=scopes):
        logger.warning(
            "Bootstrap repair output invalid: model=%s scopes=%s parse_diag=%s raw=%s",
            model,
            ",".join(sorted(scopes)),
            _payload_parse_diagnostics(fixed_raw),
            _clip(_strip_fence(fixed_raw), 1200),
        )
        return {}
    return _normalize_bootstrap_payload(parsed)


async def _regenerate_bootstrap_minimal_payload_with_llm(
    *,
    llm,
    model: str,
    temperature: float,
    project: dict,
    chapter_count: int,
    bible_text: str,
    scopes: set[str],
    active_profile: Optional[dict],
    planning_material_block: str = "",
    agent_guidance_block: str = "",
) -> dict:
    structure_name, structure_custom = _normalize_story_structure(
        project.get("structure"),
        project.get("custom_structure"),
    )
    structure_desc = (
        f"{structure_name}（{structure_custom}）"
        if structure_name == "自定义" and structure_custom
        else structure_name
    )
    bible_context = _build_bootstrap_bible_context(bible_text, scopes=scopes, limit=12000)
    bible_block = f"\n\n【必须遵守的小说圣经（含执行指令）】\n{bible_context}" if bible_context else ""
    profile_block = _build_profile_block(active_profile, json_limit=2200, summary_limit=220)
    planning_block = (
        f"\n\n【已生成/已有设定（角色/大纲/章节生成必须参考）】\n{planning_material_block}"
        if (("chapters" in scopes or "outline" in scopes or "characters" in scopes) and planning_material_block.strip())
        else ""
    )
    agent_guidance = (
        f"\n\n【按项目Agent提示词执行（优先级低于用户硬约束与圣经）】\n{agent_guidance_block}"
        if agent_guidance_block.strip()
        else ""
    )
    scope_label = _bootstrap_scope_label(scopes)
    field_specs = _bootstrap_output_field_specs(
        scopes,
        project_structure=str(project.get("structure") or "起承转合"),
        custom_structure=str(project.get("custom_structure") or ""),
    )
    field_spec_block = "\n".join(field_specs) if field_specs else "- outlines: 数组"
    constraints = _bootstrap_schema_constraint_lines(
        scopes,
        chapter_count,
        project_structure=str(project.get("structure") or "起承转合"),
        custom_structure=str(project.get("custom_structure") or ""),
        include_top_level=False,
    )
    constraints.append("若不确定可返回空数组，但必需字段必须齐全")
    constraint_block = "\n".join(
        f"{idx}) {line}" for idx, line in enumerate(constraints, start=2)
    )
    prompt = f"""
你现在只输出“可稳定解析”的结构化 JSON，对象必须包含：
{field_spec_block}

本次生成范围：{scope_label}

项目名：{project['name']}
题材：{project['genre'] or '未指定'}
简介：{project['description'] or '未填写'}
叙事结构：{structure_desc}
目标章节数：{chapter_count}
目标总字数：{project['word_target'] or 100000}
{bible_block}
{profile_block}
{planning_block}
{agent_guidance}

硬约束：
1) 只输出一个 JSON 对象，不要 Markdown、不要解释；
{constraint_block}
""".strip()
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": "你是 JSON 生成器，只输出合法 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.15), 0.45),
            max_tokens=3200,
            response_format=JSON_OBJECT_RESPONSE_FORMAT,
        )
    except Exception:
        return {}

    parsed = _parse_payload(raw)
    if not _is_bootstrap_payload(parsed, scopes=scopes):
        logger.warning(
            "Bootstrap minimal-regenerate output invalid: model=%s scopes=%s parse_diag=%s raw=%s",
            model,
            ",".join(sorted(scopes)),
            _payload_parse_diagnostics(raw),
            _clip(_strip_fence(raw), 1200),
        )
        return {}
    return _normalize_bootstrap_payload(parsed)


def _empty_bootstrap_payload() -> dict:
    return {
        "outlines": [],
        "characters": [],
        "worldbuilding": [],
        "chapters": [],
    }


def _bootstrap_generation_max_tokens(base_max_tokens: int, chapter_count: int, scopes: set[str]) -> int:
    base = max(512, min(12000, int(base_max_tokens or 4096)))
    if "chapters" in scopes:
        stage_limit = min(12000, max(4200, 1200 + chapter_count * 110))
    else:
        stage_limit = min(5200, max(2200, 1500 + len(scopes) * 900))
    return max(512, min(base, stage_limit))


def _build_scope_bootstrap_system_prompt(system_prompt: str, scopes: set[str]) -> str:
    text = str(system_prompt or "").strip()
    required_keys = _bootstrap_required_keys_for_scopes(scopes)
    if not required_keys:
        return text

    scope_only_clause = f"顶层仅需包含 {' / '.join(required_keys)} 字段，且都为数组"
    text = re.sub(
        r"顶层必须包含\s*outlines\s*/\s*characters\s*/\s*worldbuilding\s*/\s*chapters\s*四个数组",
        scope_only_clause,
        text,
        flags=re.I,
    )
    text = re.sub(
        r"顶层必须包含\s*outlines\s*/\s*characters\s*/\s*worldbuilding\s*/\s*chapters\s*四个数组；?",
        scope_only_clause + "；",
        text,
        flags=re.I,
    )
    if set(required_keys) != set(BOOTSTRAP_KEYS):
        scope_label = _bootstrap_scope_label(scopes)
        text = (
            f"{text}\n"
            f"当前任务范围仅为：{scope_label}。"
            f"禁止输出未请求的顶层字段，只输出 {' / '.join(required_keys)}。"
        ).strip()
    return text


def _build_bootstrap_generation_prompt(
    *,
    project: dict,
    chapter_count: int,
    bible_text: str,
    scopes: set[str],
    active_profile: Optional[dict],
    planning_material_block: str = "",
    agent_guidance_block: str = "",
) -> str:
    structure_name, structure_custom = _normalize_story_structure(
        project.get("structure"),
        project.get("custom_structure"),
    )
    structure_desc = (
        f"{structure_name}（{structure_custom}）"
        if structure_name == "自定义" and structure_custom
        else structure_name
    )
    bible_context = _build_bootstrap_bible_context(bible_text, scopes=scopes, limit=12000)
    bible_block = f"\n\n【必须遵守的小说圣经（含执行指令）】\n{bible_context}" if bible_context else ""
    profile_block = _build_profile_block(active_profile, json_limit=3200, summary_limit=300)
    planning_block = (
        f"\n\n【已生成/已有设定（角色/大纲/章节生成必须参考）】\n{planning_material_block}"
        if (("chapters" in scopes or "outline" in scopes or "characters" in scopes) and planning_material_block.strip())
        else ""
    )
    agent_guidance = (
        f"\n\n【按项目Agent提示词执行（优先级低于用户硬约束与圣经）】\n{agent_guidance_block}"
        if agent_guidance_block.strip()
        else ""
    )
    scope_label = _bootstrap_scope_label(scopes)
    field_specs = _bootstrap_output_field_specs(
        scopes,
        project_structure=str(project.get("structure") or "起承转合"),
        custom_structure=str(project.get("custom_structure") or ""),
    )
    field_spec_block = "\n".join(field_specs) if field_specs else "- outlines: 数组"
    writing_requirements = _bootstrap_writing_requirements(
        scopes,
        chapter_count,
        project_structure=str(project.get("structure") or "起承转合"),
        custom_structure=str(project.get("custom_structure") or ""),
    )
    requirement_block = "\n".join(
        f"{idx}) {line}" for idx, line in enumerate(writing_requirements, start=1)
    )
    schema_constraints = _bootstrap_schema_constraint_lines(
        scopes,
        chapter_count,
        project_structure=str(project.get("structure") or "起承转合"),
        custom_structure=str(project.get("custom_structure") or ""),
        include_top_level=True,
    )
    schema_block = "\n".join(
        f"{idx}) {line}" for idx, line in enumerate(schema_constraints, start=1)
    )
    schema_header = f"\n字段硬约束：\n{schema_block}\n" if schema_block else ""
    return f"""
请为小说项目生成结构化规划数据。

本次生成范围：{scope_label}
项目名：{project['name']}
题材：{project['genre'] or '未指定'}
简介：{project['description'] or '未填写'}
叙事结构：{structure_desc}
目标章节数：{chapter_count}
目标总字数：{project['word_target'] or 100000}
{bible_block}
{profile_block}
{planning_block}
{agent_guidance}

输出 JSON 对象，包含字段：
{field_spec_block}
{schema_header}
写作要求：
{requirement_block}
""".strip()


async def _generate_bootstrap_payload_for_scopes(
    *,
    llm,
    model: str,
    system_prompt: str,
    temperature: float,
    max_tokens: int,
    project_id: str,
    project: dict,
    chapter_count: int,
    bible_text: str,
    scopes: set[str],
    active_profile: Optional[dict],
    planning_material_block: str = "",
    agent_guidance_block: str = "",
) -> tuple[dict, bool]:
    user_prompt = _build_bootstrap_generation_prompt(
        project=project,
        chapter_count=chapter_count,
        bible_text=bible_text,
        scopes=scopes,
        active_profile=active_profile,
        planning_material_block=planning_material_block,
        agent_guidance_block=agent_guidance_block,
    )
    scoped_system_prompt = _build_scope_bootstrap_system_prompt(system_prompt, scopes)
    scope_label = _bootstrap_scope_label(scopes)
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": scoped_system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=min(max(temperature, 0.3), 0.8),
            max_tokens=max(512, int(max_tokens or 4096)),
            response_format=JSON_OBJECT_RESPONSE_FORMAT,
        )
    except Exception as e:
        raise HTTPException(500, f"AI 生成失败（model={model}, scope={scope_label}）: {e}")

    degraded_bootstrap = False
    payload = _parse_payload(raw)
    if not payload and len(scopes) == 1:
        only_key = _bootstrap_required_keys_for_scopes(scopes)[0]
        list_payload = _parse_payload_list(raw)
        if list_payload:
            payload = {only_key: list_payload}
    if not _is_bootstrap_payload(payload, scopes=scopes):
        logger.warning(
            "Bootstrap raw output invalid before repair: project_id=%s model=%s scopes=%s parse_diag=%s raw=%s",
            project_id,
            model,
            ",".join(sorted(scopes)),
            _payload_parse_diagnostics(raw),
            _clip(_strip_fence(raw), 1200),
        )
        payload = await _repair_bootstrap_payload_with_llm(
            llm=llm,
            model=model,
            raw=raw,
            chapter_count=chapter_count,
            scopes=scopes,
        )
    if not _is_bootstrap_payload(payload, scopes=scopes):
        payload = await _regenerate_bootstrap_minimal_payload_with_llm(
            llm=llm,
            model=model,
            temperature=temperature,
            project=project,
            chapter_count=chapter_count,
            bible_text=bible_text,
            scopes=scopes,
            active_profile=active_profile,
            planning_material_block=planning_material_block,
            agent_guidance_block=agent_guidance_block,
        )
        degraded_bootstrap = True
    if not _is_bootstrap_payload(payload, scopes=scopes):
        logger.warning(
            "Bootstrap payload parse failed after repair+regenerate: project_id=%s model=%s scopes=%s",
            project_id,
            model,
            ",".join(sorted(scopes)),
        )
        degraded_bootstrap = True
        payload = _empty_bootstrap_payload()

    normalized_payload = _normalize_bootstrap_payload(payload)
    if scopes == {"characters"} and not normalized_payload.get("characters"):
        raw_characters, raw_characters_found = _extract_bootstrap_scope_list(payload, "characters")
        try:
            raw_characters_preview = json.dumps(raw_characters[:6], ensure_ascii=False)
        except Exception:
            raw_characters_preview = str(raw_characters)
        logger.warning(
            "Bootstrap characters normalized empty: project_id=%s model=%s scopes=%s raw_characters_found=%s "
            "raw_characters_preview=%s raw=%s",
            project_id,
            model,
            ",".join(sorted(scopes)),
            raw_characters_found,
            _clip(raw_characters_preview, 1200),
            _clip(_strip_fence(raw), 1200),
        )
    return normalized_payload, degraded_bootstrap


def _get_llm_or_raise():
    llm = agent_router._llm
    if llm is None:
        raise HTTPException(500, "模型服务未初始化")
    return llm


@router.get("/debug-model/{project_id}")
def debug_model_resolution(project_id: str):
    """诊断接口：查看项目的模型解析状态"""
    agent_router._init_services()
    llm = agent_router._llm
    project = _load_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    project_model_main = project["model_main"]

    # 读取所有 agent_configs
    with get_db() as db:
        rows = db.execute(
            "SELECT agent_type, model, temperature FROM agent_configs WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    agent_configs = {r["agent_type"]: {"model": r["model"], "temperature": r["temperature"]} for r in rows}

    # 各 pipeline 阶段的解析结果
    stages = {}
    for stage, agent_type in PIPELINE_AGENT_TYPES.items():
        cfg_model = agent_configs.get(agent_type, {}).get("model", "")
        resolved = cfg_model or project_model_main or DEFAULT_MODEL
        stages[stage] = {
            "agent_type": agent_type,
            "cfg_model": cfg_model,
            "resolved": resolved,
        }

    provider_keys = {}
    relay_count = 0
    if llm:
        pk = getattr(llm, "_provider_keys", {}) or {}
        provider_keys = {k: bool(str((v or {}).get("api_key", "")).strip()) for k, v in pk.items()}
        relay_count = len(getattr(llm, "_custom_relays", []) or [])

    return {
        "project_model_main": project_model_main,
        "default_model": DEFAULT_MODEL,
        "agent_configs": agent_configs,
        "pipeline_stages": stages,
        "provider_keys_available": provider_keys,
        "custom_relay_count": relay_count,
    }


def _normalized_scope(scope: ScopeType) -> set[str]:
    if scope == "all":
        return {"outline", "characters", "worldbuilding", "chapters"}
    if scope == "planning":
        return {"outline", "chapters"}
    return {scope}


def _has_chapter_range_params(req: BootstrapRequest) -> bool:
    return any(
        value is not None
        for value in (
            req.start_chapter,
            req.end_chapter,
            req.batch_size,
            req.volume_index,
            req.volume_start_chapter,
            req.volume_end_chapter,
        )
    ) or bool(str(req.volume_title or "").strip())


def _normalize_batch_size(value: Optional[int]) -> int:
    try:
        parsed = int(value) if value is not None else DEFAULT_CHAPTER_RANGE_BATCH_SIZE
    except Exception:
        parsed = DEFAULT_CHAPTER_RANGE_BATCH_SIZE
    return max(MIN_CHAPTER_RANGE_BATCH_SIZE, min(MAX_CHAPTER_RANGE_BATCH_SIZE, parsed))


def _resolve_requested_chapter_range(
    req: BootstrapRequest,
    *,
    default_chapter_count: int,
    existing_chapters: int,
) -> tuple[int, int]:
    requested_start = req.start_chapter
    requested_end = req.end_chapter
    requested_count = req.chapter_count

    start = int(requested_start) if requested_start is not None else 1
    if start < 1:
        raise HTTPException(400, "start_chapter 必须大于等于 1")

    if requested_end is not None:
        end = int(requested_end)
    elif requested_count is not None and int(requested_count) > 0:
        if requested_start is not None:
            end = start + int(requested_count) - 1
        else:
            end = int(requested_count)
    else:
        end = max(start, int(existing_chapters or 0), int(default_chapter_count or 0))

    if end < start:
        raise HTTPException(400, "end_chapter 必须大于等于 start_chapter")
    if end > MAX_CHAPTER_INDEX_HARD_LIMIT:
        raise HTTPException(400, f"end_chapter 超出上限（{MAX_CHAPTER_INDEX_HARD_LIMIT}）")

    return start, end


def _is_timeout_like_error(err: Exception) -> bool:
    detail = ""
    if isinstance(err, HTTPException):
        detail = str(err.detail or "")
    elif hasattr(err, "detail"):
        detail = str(getattr(err, "detail"))
    else:
        detail = str(err or "")
    lowered = detail.lower()
    timeout_tokens = (
        "timeout",
        "timed out",
        "apitimeouterror",
        "read timeout",
        "deadline exceeded",
    )
    return any(token in lowered for token in timeout_tokens)


def _safe_category(c: str) -> str:
    v = (c or "").strip()
    if v in {"主角", "反派", "配角", "其他"}:
        return v
    if "主" in v:
        return "主角"
    if "反" in v:
        return "反派"
    if "配" in v:
        return "配角"
    return "其他"


def _safe_gender(g: str) -> str:
    v = (g or "").strip()
    if not v:
        return "男"
    lowered = v.lower()
    if any(k in v for k in ("非二元", "双性", "中性", "无性")) or any(k in lowered for k in ("non-binary", "nonbinary", "nb")):
        return "非二元"
    if "女" in v or any(k in lowered for k in ("female", "woman", "girl")):
        return "女"
    if "男" in v or any(k in lowered for k in ("male", "man", "boy")):
        return "男"
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(k in lowered for k in ("unknown", "unspecified", "not specified")):
        return "男"
    return _clip(v, 12)


def _safe_age(age: str) -> str:
    v = re.sub(r"\s+", "", str(age or "").strip())
    if not v:
        return "18"
    lowered = v.lower()
    if any(k in v for k in ("未知", "不明", "未说明", "未设定", "未确定")) or any(
        k in lowered for k in ("unknown", "unspecified", "notspecified", "n/a", "na")
    ):
        return "18"

    # 纯数字年龄直接保留数字
    if re.fullmatch(r"\d{1,3}", v):
        try:
            parsed = int(v)
        except Exception:
            parsed = 0
        if 0 < parsed < 160:
            return str(parsed)

    # 常见年龄区间写法，返回区间中位整数
    range_match = re.fullmatch(r"(\d{1,3})[~\-～到](\d{1,3})(?:岁)?", v)
    if range_match:
        try:
            left = int(range_match.group(1))
            right = int(range_match.group(2))
            if 0 < left < 160 and 0 < right < 160:
                return str(int(round((left + right) / 2)))
        except Exception:
            pass

    # 文本中提取首个数字作为年龄
    m = re.search(r"(\d{1,3})", v)
    if m:
        try:
            parsed = int(m.group(1))
            if 0 < parsed < 160:
                return str(parsed)
        except Exception:
            pass

    return "18"


def _estimate_chapter_count(word_target: int, existing: int, requested: Optional[int]) -> int:
    if requested and requested > 0:
        return max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, requested))
    if existing > 0:
        return max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, existing))
    est = int(round(max(12000, word_target) / 4500))
    return max(6, min(40, est))


def _extract_chapter_count_from_text(text: str) -> Optional[int]:
    raw = str(text or "").strip()
    if not raw:
        return None

    def _clamp(n: int) -> int:
        return max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, int(n)))

    explicit_hits: list[int] = []
    explicit_patterns = [
        r"(?:目标章节数|章节总数|总章节数|章节数量|章数)\s*[:：]?\s*(\d{1,4})\s*章",
        r"(?:全书|规划|预计|约|大约|共计|总计)\s*(\d{1,4})\s*章",
        r"(?:章节规划|章节规模)[^\n]{0,20}?(\d{1,4})\s*章",
    ]
    for pattern in explicit_patterns:
        for m in re.findall(pattern, raw, re.I):
            try:
                explicit_hits.append(int(m))
            except Exception:
                continue
    explicit_hits = [n for n in explicit_hits if 1 <= n <= MAX_BOOTSTRAP_CHAPTER_COUNT]
    if explicit_hits:
        return _clamp(explicit_hits[-1])

    chapter_heading_hits: list[int] = []
    for m in re.findall(r"第\s*(\d{1,4})\s*章", raw):
        try:
            chapter_heading_hits.append(int(m))
        except Exception:
            continue
    chapter_heading_hits = [n for n in chapter_heading_hits if 1 <= n <= MAX_BOOTSTRAP_CHAPTER_COUNT]
    if chapter_heading_hits:
        max_heading = max(chapter_heading_hits)
        if max_heading >= 6:
            return _clamp(max_heading)

    return None


def _resolve_bootstrap_chapter_count(
    *,
    word_target: int,
    existing: int,
    requested: Optional[int],
    bible_text: str,
) -> int:
    if requested and requested > 0:
        return max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, int(requested)))

    bible_count = _extract_chapter_count_from_text(bible_text)
    if bible_count:
        return max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, int(bible_count)))

    return _estimate_chapter_count(word_target=word_target, existing=existing, requested=None)


def _estimate_chapter_words(word_target: int, chapter_count: int) -> int:
    count = max(1, int(chapter_count or 1))
    est = int(round(max(12000, int(word_target or 0)) / count))
    return max(1500, min(12000, est))


def _estimate_chapter_scale_baseline(word_target: int) -> tuple[int, int]:
    target = max(10000, int(word_target or 100000))
    chapter_count = max(1, int(round(target / 3600.0)))
    chapter_words = int(round(target / chapter_count / 100.0) * 100)
    chapter_words = max(1500, chapter_words)
    return chapter_count, chapter_words


def _extract_word_target_from_text(text: str) -> Optional[int]:
    raw = str(text or "").strip()
    if not raw:
        return None

    def _clamp(n: int) -> int:
        return max(10000, min(500000, int(n)))

    range_wan = re.findall(r"(\d{1,3}(?:\.\d+)?)\s*[-~～到至]\s*(\d{1,3}(?:\.\d+)?)\s*万字", raw, re.I)
    if range_wan:
        a = float(range_wan[-1][0])
        b = float(range_wan[-1][1])
        midpoint = int(round(((a + b) / 2.0) * 10000))
        return _clamp(midpoint)

    single_wan = re.findall(r"(\d{1,3}(?:\.\d+)?)\s*万字", raw, re.I)
    if single_wan:
        return _clamp(int(round(float(single_wan[-1]) * 10000)))

    range_word = re.findall(r"(\d{4,6})\s*[-~～到至]\s*(\d{4,6})\s*字", raw, re.I)
    if range_word:
        a = int(range_word[-1][0])
        b = int(range_word[-1][1])
        midpoint = int(round((a + b) / 2.0))
        return _clamp(midpoint)

    single_word = re.findall(r"(\d{4,6})\s*字", raw, re.I)
    if single_word:
        return _clamp(int(single_word[-1]))

    return None


def _resolve_effective_word_target(history: list[ChatMessage], current_message: str, fallback: int) -> int:
    candidate = max(10000, min(500000, int(fallback or 100000)))
    texts = [h.content for h in history if h.role == "user" and (h.content or "").strip()]
    if (current_message or "").strip():
        texts.append(current_message)
    for text in texts:
        parsed = _extract_word_target_from_text(text)
        if parsed:
            candidate = parsed
    return candidate


def _phase_for_chapter(num: int, total: int) -> str:
    if total <= 1:
        return "起"
    ratio = num / total
    if ratio <= 0.25:
        return "起"
    if ratio <= 0.60:
        return "承"
    if ratio <= 0.85:
        return "转"
    return "合"


def _phase_for_outline(index: int, total: int) -> str:
    if total <= 1:
        return "起"
    ratio = index / total
    if ratio <= 0.25:
        return "起"
    if ratio <= 0.60:
        return "承"
    if ratio <= 0.85:
        return "转"
    return "合"


def _normalize_story_structure(structure: Any, custom_structure: Any = "") -> tuple[str, str]:
    raw = str(structure or "").strip()
    custom = str(custom_structure or "").strip()
    if raw in {"起承转合", "三幕式", "英雄之旅", "自定义"}:
        return raw, custom
    lowered = raw.lower()
    if "三幕" in raw:
        return "三幕式", custom
    if "英雄之旅" in raw or "hero" in lowered:
        return "英雄之旅", custom
    if "起承转合" in raw:
        return "起承转合", custom
    if raw:
        return "自定义", raw
    return "起承转合", custom


def _extract_custom_structure_phases(custom_structure: str, limit: int = 10) -> list[str]:
    text = str(custom_structure or "").strip()
    if not text:
        return []
    tokens = [
        t.strip()
        for t in re.split(r"[,\n，；;。|/→\-]+", text)
        if t and t.strip()
    ]
    deduped: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        norm = token.lower()
        if norm in seen:
            continue
        seen.add(norm)
        deduped.append(_clip(token, 20))
        if len(deduped) >= limit:
            break
    return deduped


def _resolve_outline_phase_labels(structure: Any, custom_structure: Any = "", *, max_count: int = 10) -> list[str]:
    normalized, custom = _normalize_story_structure(structure, custom_structure)
    if normalized == "起承转合":
        return ["起", "承", "转", "合"]
    if normalized == "三幕式":
        return ["第一幕", "第二幕", "第三幕"]
    if normalized == "英雄之旅":
        labels = [
            "平凡世界",
            "冒险召唤",
            "拒绝召唤",
            "遇见导师",
            "跨越门槛",
            "试炼与盟友",
            "逼近洞穴",
            "重大考验",
            "获得奖励",
            "归途",
            "重生",
            "带药回归",
        ]
        return labels[:max_count]
    custom_labels = _extract_custom_structure_phases(custom, limit=max_count)
    if custom_labels:
        return custom_labels
    return []


def _phase_for_outline_by_structure(
    index: int,
    total: int,
    *,
    structure: Any,
    custom_structure: Any = "",
) -> str:
    labels = _resolve_outline_phase_labels(structure, custom_structure, max_count=max(total, 1))
    if labels:
        pos = max(1, min(index, len(labels)))
        return labels[pos - 1]
    return _phase_for_outline(index, total)


def _pick_str_alias(item: dict, keys: tuple[str, ...], default: str = "") -> str:
    for key in keys:
        if key in item:
            value = item.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
    return default


def _normalize_outline_phase_label(raw_phase: str, labels: list[str]) -> str:
    phase = _clip(str(raw_phase or "").strip(), 20)
    if not labels:
        return phase
    if phase in set(labels):
        return phase
    for label in labels:
        if label and label in phase:
            return label
    return ""


def _normalize_outline_items(
    raw_items: Any,
    *,
    structure: Any = "起承转合",
    custom_structure: Any = "",
) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    labels = _resolve_outline_phase_labels(structure, custom_structure, max_count=24)
    use_strict_labels = bool(labels)
    items: list[dict] = []
    for item in raw_items[:24]:
        if not isinstance(item, dict):
            continue
        phase = _normalize_outline_phase_label(
            _pick_str_alias(item, ("phase", "stage", "阶段", "幕", "阶段标签"), ""),
            labels,
        )
        if use_strict_labels:
            if not phase:
                phase = ""
        elif not phase:
            phase = ""
        title = _clip(
            _pick_str_alias(item, ("title", "name", "heading", "标题", "阶段标题", "阶段名"), ""),
            80,
        )
        content = _clip(
            _pick_str_alias(item, ("content", "summary", "synopsis", "内容", "剧情", "描述", "摘要"), ""),
            1000,
        )
        word_range = _clip(
            _pick_str_alias(item, ("word_range", "wordRange", "length", "字数范围", "篇幅"), ""),
            60,
        )
        if not title and not content:
            continue
        items.append(
            {
                "phase": phase,
                "title": title or "阶段",
                "content": content,
                "word_range": word_range,
            }
        )
    if not items:
        return []

    phase_set = {str(it.get("phase") or "").strip() for it in items if str(it.get("phase") or "").strip()}
    needs_rebalance = False
    if use_strict_labels and labels:
        needs_rebalance = len(items) >= len(labels) and len(phase_set) < min(len(labels), len(items))
    elif str(structure or "").strip() == "起承转合":
        needs_rebalance = len(items) >= 4 and len(phase_set) < 4
    for idx, item in enumerate(items, start=1):
        if needs_rebalance or not str(item.get("phase") or "").strip():
            item["phase"] = _phase_for_outline_by_structure(
                idx,
                len(items),
                structure=structure,
                custom_structure=custom_structure,
            )
    return items


def _is_placeholder_character_name(name: str) -> bool:
    text = str(name or "").strip()
    if not text:
        return True
    lowered = text.lower()
    if lowered in {"tbd", "todo", "unknown", "未知", "待定", "未命名"}:
        return True
    if any(token in text for token in ("某人", "某角色", "未命名角色", "待定角色")):
        return True
    if re.fullmatch(r"(角色|人物|配角|主角|反派)[A-Za-z0-9一二三四五六七八九十甲乙丙丁]*", text):
        return True
    if re.fullmatch(r"(角色|人物)[\-_ ]?\d{1,3}", text):
        return True
    return False


def _normalize_character_relation_items(raw_relations: Any) -> list[dict]:
    if isinstance(raw_relations, dict):
        pairs: list[dict] = []
        for key, value in raw_relations.items():
            if isinstance(value, dict):
                pairs.append(
                    {
                        "target": _pick_str_alias(value, ("target", "name", "角色", "对象"), str(key or "").strip()),
                        "relation_type": _pick_str_alias(value, ("relation_type", "type", "关系"), ""),
                        "description": _pick_str_alias(value, ("description", "desc", "说明"), ""),
                    }
                )
            else:
                pairs.append(
                    {
                        "target": str(key or "").strip(),
                        "relation_type": str(value or "").strip(),
                        "description": "",
                    }
                )
        raw_relations = pairs
    elif isinstance(raw_relations, str):
        pairs = []
        for segment in re.split(r"[;\n；]+", raw_relations):
            seg = str(segment or "").strip()
            if not seg:
                continue
            parts = re.split(r"[:：\-]", seg, maxsplit=1)
            target = parts[0].strip() if parts else ""
            relation_type = parts[1].strip() if len(parts) > 1 else ""
            pairs.append({"target": target, "relation_type": relation_type, "description": ""})
        raw_relations = pairs

    if not isinstance(raw_relations, list):
        return []

    normalized: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for rel in raw_relations[:24]:
        if not isinstance(rel, dict):
            continue
        target = _clip(
            _pick_str_alias(rel, ("target", "target_name", "name", "character", "角色", "对象"), ""),
            30,
        )
        if not target or _is_placeholder_character_name(target):
            continue
        relation_type = _clip(
            _pick_str_alias(rel, ("relation_type", "type", "关系", "关系类型"), ""),
            60,
        )
        description = _clip(_pick_str_alias(rel, ("description", "desc", "说明"), ""), 260)
        dedupe = (target, relation_type, description)
        if dedupe in seen:
            continue
        seen.add(dedupe)
        normalized.append(
            {
                "target": target,
                "relation_type": relation_type,
                "description": description,
            }
        )
    return normalized


def _normalize_character_item(raw_item: Any) -> Optional[dict]:
    if not isinstance(raw_item, dict):
        return None
    merged: dict[str, Any] = {}
    for key in ("profile", "character", "角色档案", "档案", "details", "detail"):
        nested = raw_item.get(key)
        if isinstance(nested, dict):
            merged.update(nested)
    merged.update(raw_item)

    name = _clip(
        _pick_str_alias(merged, ("name", "character_name", "role_name", "姓名", "名字", "角色名"), ""),
        30,
    )
    if _is_placeholder_character_name(name):
        return None

    category = _safe_category(
        _pick_str_alias(merged, ("category", "role", "type", "角色定位", "角色类型", "定位"), "配角")
    )
    gender = _safe_gender(_pick_str_alias(merged, ("gender", "sex", "性别"), "未知"))
    age = _safe_age(_pick_str_alias(merged, ("age", "年龄"), "未知"))
    identity = _clip(
        _pick_str_alias(merged, ("identity", "职业", "身份", "position", "job"), ""),
        120,
    )
    appearance = _clip(
        _pick_str_alias(
            merged,
            ("appearance", "looks", "look", "external", "外貌", "外形", "形象"),
            "",
        ),
        600,
    )
    personality = _clip(
        _pick_str_alias(merged, ("personality", "traits", "性格", "性格特征"), ""),
        600,
    )
    motivation = _clip(
        _pick_str_alias(merged, ("motivation", "goal", "动机", "目标", "诉求"), ""),
        300,
    )
    backstory = _clip(
        _pick_str_alias(merged, ("backstory", "history", "past", "背景", "经历"), ""),
        600,
    )
    arc = _clip(_pick_str_alias(merged, ("arc", "character_arc", "弧线", "成长弧光"), ""), 300)
    usage_notes = _clip(
        _pick_str_alias(merged, ("usage_notes", "usage_advice", "usage", "使用建议", "剧情功能"), ""),
        600,
    )
    relations = _normalize_character_relation_items(
        merged.get("relations")
        if merged.get("relations") is not None
        else merged.get("relation")
        if merged.get("relation") is not None
        else merged.get("关系")
        if merged.get("关系") is not None
        else merged.get("关系网络")
    )
    return {
        "name": name,
        "category": category,
        "gender": gender,
        "age": age,
        "identity": identity,
        "appearance": appearance,
        "personality": personality,
        "motivation": motivation,
        "backstory": backstory,
        "arc": arc,
        "usage_notes": usage_notes,
        "relations": relations,
    }


def _normalize_character_items(raw_items: Any, *, limit: int = 24) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    normalized: list[dict] = []
    seen_names: set[str] = set()
    for raw_item in raw_items[:64]:
        item = _normalize_character_item(raw_item)
        if not item:
            continue
        dedupe_key = re.sub(r"\s+", "", str(item.get("name") or "").strip()).lower()
        if not dedupe_key or dedupe_key in seen_names:
            continue
        seen_names.add(dedupe_key)
        normalized.append(item)
        if len(normalized) >= limit:
            break
    return normalized


def _merge_character_items(base_items: list[dict], extra_items: list[dict], *, limit: int = 24) -> list[dict]:
    safe_limit = max(1, int(limit or 24))
    merged: list[dict] = []
    seen_names: set[str] = set()
    for source in (base_items or [], extra_items or []):
        for item in source:
            if not isinstance(item, dict):
                continue
            name_key = re.sub(r"\s+", "", str(item.get("name") or "").strip()).lower()
            if not name_key or name_key in seen_names:
                continue
            seen_names.add(name_key)
            merged.append(item)
            if len(merged) >= safe_limit:
                return merged
    return merged


def _normalize_worldbuilding_items(raw_items: Any, *, limit: int = 24) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    normalized: list[dict] = []
    seen_titles: set[str] = set()
    for raw_item in raw_items[:64]:
        if not isinstance(raw_item, dict):
            continue
        title = _clip(
            _pick_str_alias(raw_item, ("title", "name", "heading", "标题", "设定名", "条目"), ""),
            80,
        )
        content = _clip(
            _pick_str_alias(raw_item, ("content", "description", "desc", "内容", "描述", "规则"), ""),
            1200,
        )
        if not title and not content:
            continue
        if not title:
            title = "未命名设定"
        dedupe_key = re.sub(r"\s+", "", title).lower()
        if dedupe_key in seen_titles:
            continue
        seen_titles.add(dedupe_key)
        category = _clip(
            _pick_str_alias(raw_item, ("category", "type", "分类", "类别"), "其他"),
            30,
        )
        normalized.append(
            {
                "category": category or "其他",
                "title": title,
                "content": content,
            }
        )
        if len(normalized) >= limit:
            break
    return normalized


def _normalize_chapter_items(raw_items: Any, chapter_count: int) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    max_count = max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, int(chapter_count or 1)))
    by_num: dict[int, dict] = {}
    for idx, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            continue
        try:
            num = int(
                _pick_str_alias(
                    item,
                    ("chapter_num", "chapter", "num", "序号", "章节号", "章节编号"),
                    str(idx),
                )
            )
        except Exception:
            num = idx
        if num < 1:
            continue
        if num > max_count:
            num = max_count
        if num in by_num:
            continue
        phase = _pick_str_alias(item, ("phase", "stage", "阶段"), "")
        if phase not in {"起", "承", "转", "合"}:
            phase = _phase_for_chapter(num, max_count)
        by_num[num] = {
            "chapter_num": num,
            "title": _clip(
                _pick_str_alias(item, ("title", "name", "标题", "章节标题"), f"第{num}章") or f"第{num}章",
                80,
            ),
            "phase": phase,
            "synopsis": _clip(
                _pick_str_alias(item, ("synopsis", "summary", "梗概", "摘要", "内容"), ""),
                240,
            ),
        }
    return [by_num[n] for n in sorted(by_num.keys())]


def _normalize_chapter_items_for_range(
    raw_items: Any,
    *,
    start_chapter: int,
    end_chapter: int,
    total_chapter_count: int,
) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    start = max(1, int(start_chapter))
    end = max(start, int(end_chapter))
    expected_count = end - start + 1
    total = max(end, int(total_chapter_count or end))
    by_num: dict[int, dict] = {}

    numeric_hits: list[int] = []
    for idx, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            continue
        try:
            num = int(
                _pick_str_alias(
                    item,
                    ("chapter_num", "chapter", "num", "序号", "章节号", "章节编号"),
                    str(idx),
                )
            )
            numeric_hits.append(num)
        except Exception:
            continue

    relative_mode = False
    if start > 1 and numeric_hits:
        min_num = min(numeric_hits)
        max_num = max(numeric_hits)
        if 1 <= min_num and max_num <= expected_count:
            relative_mode = True

    for idx, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            continue
        try:
            num = int(
                _pick_str_alias(
                    item,
                    ("chapter_num", "chapter", "num", "序号", "章节号", "章节编号"),
                    str(idx),
                )
            )
        except Exception:
            num = idx
        if relative_mode:
            num = start + num - 1
        if num < start or num > end:
            continue
        if num in by_num:
            continue
        phase = _pick_str_alias(item, ("phase", "stage", "阶段"), "")
        if phase not in {"起", "承", "转", "合"}:
            phase = _phase_for_chapter(num, total)
        by_num[num] = {
            "chapter_num": num,
            "title": _clip(
                _pick_str_alias(item, ("title", "name", "标题", "章节标题"), f"第{num}章") or f"第{num}章",
                80,
            ),
            "phase": phase,
            "synopsis": _clip(
                _pick_str_alias(item, ("synopsis", "summary", "梗概", "摘要", "内容"), ""),
                240,
            ),
        }
    return [by_num[n] for n in sorted(by_num.keys())]


def _ensure_chapter_coverage(chapters: list[dict], chapter_count: int) -> list[dict]:
    max_count = max(1, min(MAX_BOOTSTRAP_CHAPTER_COUNT, int(chapter_count or 1)))
    by_num: dict[int, dict] = {}
    for ch in chapters:
        try:
            num = int(ch.get("chapter_num", 0))
        except Exception:
            num = 0
        if 1 <= num <= max_count and num not in by_num:
            phase = str(ch.get("phase", "")).strip()
            if phase not in {"起", "承", "转", "合"}:
                phase = _phase_for_chapter(num, max_count)
            by_num[num] = {
                "chapter_num": num,
                "title": _clip(str(ch.get("title", f"第{num}章")).strip() or f"第{num}章", 80),
                "phase": phase,
                "synopsis": _clip(str(ch.get("synopsis", "")).strip(), 240),
            }
    for num in range(1, max_count + 1):
        if num not in by_num:
            by_num[num] = {
                "chapter_num": num,
                "title": f"第{num}章",
                "phase": _phase_for_chapter(num, max_count),
                "synopsis": "",
            }
    return [by_num[n] for n in sorted(by_num.keys())]


def _ensure_chapter_coverage_for_range(
    chapters: list[dict],
    *,
    start_chapter: int,
    end_chapter: int,
    total_chapter_count: int,
) -> list[dict]:
    start = max(1, int(start_chapter))
    end = max(start, int(end_chapter))
    total = max(end, int(total_chapter_count or end))
    by_num: dict[int, dict] = {}
    for ch in chapters:
        try:
            num = int(ch.get("chapter_num", 0))
        except Exception:
            num = 0
        if num < start or num > end:
            continue
        if num in by_num:
            continue
        phase = str(ch.get("phase", "")).strip()
        if phase not in {"起", "承", "转", "合"}:
            phase = _phase_for_chapter(num, total)
        by_num[num] = {
            "chapter_num": num,
            "title": _clip(str(ch.get("title", f"第{num}章")).strip() or f"第{num}章", 80),
            "phase": phase,
            "synopsis": _clip(str(ch.get("synopsis", "")).strip(), 240),
        }
    for num in range(start, end + 1):
        if num not in by_num:
            by_num[num] = {
                "chapter_num": num,
                "title": f"第{num}章",
                "phase": _phase_for_chapter(num, total),
                "synopsis": "",
            }
    return [by_num[n] for n in sorted(by_num.keys())]


def _needs_chapter_fallback(chapters: list[dict], chapter_count: int) -> bool:
    if not chapters:
        return True
    non_empty_synopsis = sum(1 for ch in chapters if str(ch.get("synopsis", "")).strip())
    if chapter_count <= 2:
        min_synopsis = 1
        min_rows = max(1, chapter_count)
    else:
        min_synopsis = max(2, min(chapter_count, chapter_count // 3))
        min_rows = max(3, min(chapter_count, chapter_count // 2))
    return non_empty_synopsis < min_synopsis or len(chapters) < min_rows


def _build_profile_block(active_profile: Optional[dict], *, json_limit: int, summary_limit: int) -> str:
    if not active_profile:
        return ""
    profile_text = _clip(
        json.dumps(active_profile.get("profile_json_obj") or {}, ensure_ascii=False),
        json_limit,
    )
    return (
        "\n\n【必须遵守的知识规则包】\n"
        f"- 名称：{active_profile.get('name', '未命名规则包')} (v{active_profile.get('version', 1)})\n"
        f"- 题材：{active_profile.get('genre') or '未指定'}\n"
        f"- 摘要：{_clip(active_profile.get('text_summary') or '', summary_limit)}\n"
        f"- 规则JSON：{profile_text}"
    )


def _profile_rule_lines(raw: Any, *, max_items: int = 8, item_limit: int = 90) -> list[str]:
    if not isinstance(raw, list):
        return []
    lines: list[str] = []
    for item in raw:
        text = _clip(str(item or "").strip(), item_limit)
        if not text:
            continue
        lines.append(text)
        if len(lines) >= max_items:
            break
    return lines


def _build_world_model_profile_block(active_profile: Optional[dict], *, total_limit: int = 2000) -> str:
    if not active_profile:
        return ""
    profile_json = active_profile.get("profile_json_obj")
    if not isinstance(profile_json, dict):
        profile_json = {}

    world_rules = _profile_rule_lines(profile_json.get("world_rules"), max_items=10)
    prop_rules = _profile_rule_lines(
        profile_json.get("prop_rules")
        or profile_json.get("item_rules")
        or profile_json.get("props_rules"),
        max_items=10,
    )
    character_rules = _profile_rule_lines(profile_json.get("character_rules"), max_items=6)

    if not world_rules and not prop_rules and not character_rules:
        return ""

    lines = [
        "【规则包关键法则（用于一致性审查）】",
        f"- 规则包：{active_profile.get('name', '未命名规则包')} (v{active_profile.get('version', 1)})",
    ]
    if world_rules:
        lines.append("- 世界模型法则：")
        lines.extend([f"  - {x}" for x in world_rules])
    if prop_rules:
        lines.append("- 道具法则：")
        lines.extend([f"  - {x}" for x in prop_rules])
    if character_rules:
        lines.append("- 角色约束：")
        lines.extend([f"  - {x}" for x in character_rules])
    return _clip("\n".join(lines), total_limit)


def _normalize_world_model_issue(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    raw_type = str(raw.get("type") or raw.get("category") or raw.get("kind") or "other").strip().lower()
    if raw_type in {"world", "worldbuilding", "规则", "世界", "世界观"}:
        issue_type = "world"
    elif raw_type in {"prop", "item", "道具", "物品"}:
        issue_type = "prop"
    elif raw_type in {"character", "角色", "人设"}:
        issue_type = "character"
    elif raw_type in {"timeline", "chronology", "时间线"}:
        issue_type = "timeline"
    elif raw_type in {"plot", "logic", "剧情", "逻辑"}:
        issue_type = "plot"
    else:
        issue_type = "other"

    raw_severity = str(raw.get("severity") or raw.get("level") or "medium").strip().lower()
    if raw_severity in {"high", "critical", "严重", "高"}:
        severity = "high"
    elif raw_severity in {"low", "minor", "轻微", "低"}:
        severity = "low"
    else:
        severity = "medium"

    description = _clip(
        str(raw.get("description") or raw.get("reason") or raw.get("issue") or "").strip(),
        320,
    )
    if len(description) < 2:
        return None
    return {
        "type": issue_type,
        "severity": severity,
        "quote": _clip(str(raw.get("quote") or raw.get("evidence") or "").strip(), 180),
        "description": description,
        "suggestion": _clip(str(raw.get("suggestion") or raw.get("fix") or "").strip(), 320),
    }


def _parse_world_model_check_payload(raw: str) -> tuple[str, list[dict]]:
    payload = _parse_payload(raw)
    if not isinstance(payload, dict):
        return "", []
    summary = _clip(str(payload.get("summary") or payload.get("verdict") or "").strip(), 280)
    raw_items = payload.get("conflicts")
    if not isinstance(raw_items, list):
        raw_items = payload.get("issues")
    if not isinstance(raw_items, list):
        raw_items = []

    items: list[dict] = []
    for item in raw_items:
        normalized = _normalize_world_model_issue(item)
        if normalized:
            items.append(normalized)
        if len(items) >= 16:
            break
    return summary, items


def _load_existing_planning_material(project_id: str) -> tuple[list[dict], list[dict], list[dict]]:
    with get_db() as db:
        outlines = db.execute(
            "SELECT phase, title, content FROM outlines WHERE project_id = ? "
            "ORDER BY phase_order ASC, created_at ASC LIMIT 12",
            (project_id,),
        ).fetchall()
        characters = db.execute(
            "SELECT name, category, gender, age, identity, personality, motivation, usage_notes "
            "FROM characters WHERE project_id = ? "
            "ORDER BY sort_order ASC, created_at ASC LIMIT 16",
            (project_id,),
        ).fetchall()
        worldbuilding = db.execute(
            "SELECT category, title, content FROM worldbuilding WHERE project_id = ? "
            "ORDER BY category ASC, sort_order ASC, created_at ASC LIMIT 12",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in outlines], [dict(r) for r in characters], [dict(r) for r in worldbuilding]


def _build_planning_material_block(
    outlines: list[dict],
    characters: list[dict],
    worldbuilding: list[dict],
    *,
    total_limit: int = 4800,
) -> str:
    parts: list[str] = []
    if outlines:
        lines = ["【大纲锚点】"]
        for o in outlines[:10]:
            phase = _clip(_pick_str_alias(o, ("phase", "stage", "阶段"), ""), 4)
            title = _clip(
                _pick_str_alias(o, ("title", "name", "heading", "标题", "阶段标题"), "未命名大纲"),
                40,
            )
            content = _clip(
                _pick_str_alias(o, ("content", "summary", "synopsis", "内容", "剧情", "描述"), ""),
                140,
            )
            phase_tag = f"[{phase}] " if phase else ""
            lines.append(f"- {phase_tag}{title}：{content}")
        parts.append("\n".join(lines))
    if characters:
        lines = ["【角色设定】"]
        for c in characters[:12]:
            merged_char: dict[str, Any] = {}
            for key in ("profile", "character", "角色档案", "档案", "details", "detail"):
                nested = c.get(key) if isinstance(c, dict) else None
                if isinstance(nested, dict):
                    merged_char.update(nested)
            if isinstance(c, dict):
                merged_char.update(c)
            else:
                continue
            name = _clip(
                _pick_str_alias(merged_char, ("name", "character_name", "姓名", "角色名"), "未命名角色"),
                20,
            )
            category = _clip(_pick_str_alias(merged_char, ("category", "role", "角色定位", "角色类型"), ""), 8)
            gender = _clip(_pick_str_alias(merged_char, ("gender", "sex", "性别"), ""), 8)
            age = _clip(_pick_str_alias(merged_char, ("age", "年龄"), ""), 10)
            identity = _clip(_pick_str_alias(merged_char, ("identity", "身份", "职业"), ""), 60)
            personality = _clip(_pick_str_alias(merged_char, ("personality", "性格"), ""), 60)
            motivation = _clip(_pick_str_alias(merged_char, ("motivation", "动机", "目标"), ""), 60)
            usage_notes = _clip(_pick_str_alias(merged_char, ("usage_notes", "usage_advice", "使用建议"), ""), 60)
            detail = identity or personality or motivation or usage_notes
            tag_parts = [part for part in (category, gender, age) if part]
            cat_tag = f"({'/'.join(tag_parts)})" if tag_parts else ""
            lines.append(f"- {name}{cat_tag}: {detail}")
        parts.append("\n".join(lines))
    if worldbuilding:
        lines = ["【世界观设定】"]
        for w in worldbuilding[:10]:
            title = _clip(_pick_str_alias(w, ("title", "name", "标题", "设定名"), "未命名设定"), 40)
            category = _clip(_pick_str_alias(w, ("category", "type", "分类", "类别"), ""), 14)
            content = _clip(_pick_str_alias(w, ("content", "description", "内容", "描述"), ""), 140)
            cat_tag = f"({category})" if category else ""
            lines.append(f"- {title}{cat_tag}: {content}")
        parts.append("\n".join(lines))
    if not parts:
        return ""
    return _clip("\n\n".join(parts), total_limit)


def _load_recent_chapter_chain(project_id: str, *, upto_chapter: int, limit: int = 15) -> list[dict]:
    safe_limit = max(1, min(30, int(limit or 15)))
    safe_upto = max(1, int(upto_chapter or 1))
    with get_db() as db:
        rows = db.execute(
            "SELECT chapter_num, title, synopsis FROM chapters "
            "WHERE project_id = ? AND chapter_num <= ? "
            "ORDER BY chapter_num DESC LIMIT ?",
            (project_id, safe_upto, safe_limit),
        ).fetchall()
    chain = [dict(r) for r in rows]
    chain.reverse()
    return chain


def _build_recent_chapter_chain_block(recent_chapters: list[dict], *, total_limit: int = 1800) -> str:
    if not recent_chapters:
        return ""
    lines = ["【最近章节摘要链】"]
    for ch in recent_chapters:
        try:
            num = int(ch.get("chapter_num", 0))
        except Exception:
            num = 0
        if num <= 0:
            continue
        title = _clip(str(ch.get("title") or f"第{num}章").strip() or f"第{num}章", 40)
        synopsis = _clip(str(ch.get("synopsis") or "").strip(), 140)
        if synopsis:
            lines.append(f"- 第{num}章《{title}》：{synopsis}")
        else:
            lines.append(f"- 第{num}章《{title}》")
    if len(lines) <= 1:
        return ""
    return _clip("\n".join(lines), total_limit)


def _load_foreshadow_snapshot(project_id: str, *, limit: int = 20) -> list[dict]:
    safe_limit = max(1, min(40, int(limit or 20)))
    with get_db() as db:
        rows = db.execute(
            "SELECT name, description, status FROM foreshadowing "
            "WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
            (project_id, safe_limit),
        ).fetchall()
    return [dict(r) for r in rows]


def _build_foreshadow_snapshot_block(items: list[dict], *, total_limit: int = 1500) -> str:
    if not items:
        return ""
    unresolved: list[str] = []
    resolved: list[str] = []
    for item in items:
        status = str(item.get("status") or "").strip() or "planted"
        name = _clip(str(item.get("name") or "未命名伏笔").strip() or "未命名伏笔", 24)
        desc = _clip(str(item.get("description") or "").strip(), 100)
        line = f"- {name}[{status}]：{desc}" if desc else f"- {name}[{status}]"
        if status == "resolved":
            resolved.append(line)
        else:
            unresolved.append(line)
    lines = ["【伏笔状态快照】"]
    if unresolved:
        lines.append("未回收：")
        lines.extend(unresolved[:10])
    if resolved:
        lines.append("已回收：")
        lines.extend(resolved[:6])
    if len(lines) <= 1:
        return ""
    return _clip("\n".join(lines), total_limit)


def _load_volume_goal_for_range(project_id: str, *, start_chapter: int, end_chapter: int) -> Optional[dict]:
    start = max(1, int(start_chapter))
    end = max(start, int(end_chapter))
    try:
        with get_db() as db:
            row = db.execute(
                "SELECT volume_index, title, start_chapter, end_chapter, goal, key_turning_point, end_hook "
                "FROM volume_plans "
                "WHERE project_id = ? AND start_chapter <= ? AND end_chapter >= ? "
                "ORDER BY volume_index ASC LIMIT 1",
                (project_id, end, start),
            ).fetchone()
    except Exception:
        return None
    return dict(row) if row else None


def _build_volume_goal_block(volume_goal: Optional[dict], *, total_limit: int = 1200) -> str:
    if not volume_goal:
        return ""
    try:
        idx = int(volume_goal.get("volume_index", 0))
    except Exception:
        idx = 0
    title = _clip(str(volume_goal.get("title") or "").strip(), 40)
    start = volume_goal.get("start_chapter")
    end = volume_goal.get("end_chapter")
    goal = _clip(str(volume_goal.get("goal") or "").strip(), 200)
    turning = _clip(str(volume_goal.get("key_turning_point") or "").strip(), 180)
    hook = _clip(str(volume_goal.get("end_hook") or "").strip(), 180)
    vol_label = title or (f"第{idx}卷" if idx > 0 else "当前卷")
    lines = [f"【当前卷目标】{vol_label}（第{start}-{end}章）"]
    if goal:
        lines.append(f"- 本卷目标：{goal}")
    if turning:
        lines.append(f"- 关键转折：{turning}")
    if hook:
        lines.append(f"- 卷尾钩子：{hook}")
    return _clip("\n".join(lines), total_limit)


def _build_chapter_continuity_block(
    *,
    recent_chapter_block: str = "",
    foreshadow_block: str = "",
    volume_goal_block: str = "",
    total_limit: int = 3800,
) -> str:
    parts = [part.strip() for part in (recent_chapter_block, foreshadow_block, volume_goal_block) if str(part or "").strip()]
    if not parts:
        return ""
    return _clip("\n\n".join(parts), total_limit)


_CHARACTER_TIMING_STOPWORDS = {
    "主角",
    "男主",
    "女主",
    "反派",
    "配角",
    "角色",
    "人物",
    "主人公",
    "本卷",
    "该卷",
    "本章",
    "该章",
    "世界观",
    "大纲",
    "伏笔",
    "剧情",
    "案件",
    "工作室",
    "团队",
    "组织",
    "成员",
    "设定",
    "章节",
    "卷级",
    "锚点",
}


def _normalize_character_name_for_timing(raw_name: str) -> str:
    name = str(raw_name or "").strip()
    if not name:
        return ""
    name = re.sub(r"^[\[【(（「『《<\s:：,，。.!！?？]+", "", name)
    name = re.sub(r"[\]】)）」』》>\s:：,，。.!！?？]+$", "", name)
    name = re.sub(r"^(角色|人物|新角色|关键人物|配角|反派|主角)\s*", "", name)
    name = re.sub(r"^(角色设定|人物设定|设定|大纲锚点)\s*", "", name)
    name = re.sub(r"(正式|首次|初次|才|后|再|将|并)$", "", name)
    name = re.sub(r"\s+", "", name)
    if not (2 <= len(name) <= 12):
        return ""
    if name in _CHARACTER_TIMING_STOPWORDS:
        return ""
    if "章" in name or "卷" in name:
        return ""
    if re.fullmatch(r"\d+", name):
        return ""
    if not re.search(r"[A-Za-z\u4e00-\u9fff·]", name):
        return ""
    return name


def _extract_character_appearance_constraints(text: str) -> dict[str, int]:
    raw = str(text or "")
    if not raw.strip():
        return {}

    constraints: dict[str, int] = {}

    def _record(name: str, chapter: int):
        norm_name = _normalize_character_name_for_timing(name)
        if not norm_name:
            return
        try:
            ch = int(chapter)
        except Exception:
            return
        if ch <= 1:
            return
        prev = constraints.get(norm_name)
        if prev is None or ch < prev:
            constraints[norm_name] = ch

    direct_patterns = [
        re.compile(
            r"(?:^|[，,。；;:：\s（(【\[-])(?P<name>[A-Za-z\u4e00-\u9fff·]{2,12})\s*[（(]?\s*第?\s*(?P<ch>\d{1,4})\s*章\s*(?:首次|初次)?(?:登场|出场|出现|加入|入场|亮相|登台)"
        ),
        re.compile(
            r"(?:^|[，,。；;:：\s（(【\[-])(?P<name>[A-Za-z\u4e00-\u9fff·]{2,12})[^\n。:：]{0,24}?第\s*(?P<ch>\d{1,4})\s*章[^\n。]{0,12}?(?:才|方|后|再).{0,8}?(?:出现|登场|出场|加入|亮相)"
        ),
        re.compile(
            r"第\s*(?P<ch>\d{1,4})\s*章[^\n。]{0,20}?(?P<name>[A-Za-z\u4e00-\u9fff·]{2,12})(?:首次)?(?:登场|出场|出现|加入|亮相)"
        ),
        re.compile(
            r"(?P<name>[A-Za-z\u4e00-\u9fff·]{2,12})\s*[（(]\s*(?P<ch>\d{1,4})\s*章(?:登场|出场|出现|加入|亮相)?\s*[)）]"
        ),
    ]
    for pattern in direct_patterns:
        for m in pattern.finditer(raw):
            _record(m.group("name"), int(m.group("ch")))

    range_pattern = re.compile(
        r"第\s*(?P<start>\d{1,4})\s*[-~～到至]\s*(?P<end>\d{1,4})\s*章[^\n]{0,120}?(?P<name>[A-Za-z\u4e00-\u9fff·]{2,12})[^\n。]{0,10}?(?:正式|首次|初次)?(?:加入|登场|出场|出现|亮相|入局)"
    )
    for m in range_pattern.finditer(raw):
        _record(m.group("name"), int(m.group("start")))

    return constraints


def _build_character_appearance_constraints_block(
    constraints: dict[str, int],
    *,
    start_chapter: int,
    end_chapter: int,
    total_limit: int = 1200,
) -> str:
    if not constraints:
        return ""
    start = max(1, int(start_chapter))
    end = max(start, int(end_chapter))
    items = sorted(constraints.items(), key=lambda x: (int(x[1]), x[0]))
    lines: list[str] = ["【人物出场节奏硬约束】"]
    shown = 0
    for name, first_chapter in items:
        first = int(first_chapter)
        if first <= start:
            continue
        lines.append(f"- {name} 仅可在第{first}章及之后出现（第{start}-{min(end, first - 1)}章禁止出现）")
        shown += 1
        if shown >= 20:
            break
    if shown == 0:
        return ""
    lines.append("若角色未到允许出场章位，请使用“未具名人物/神秘人物”替代，不得直呼其名。")
    return _clip("\n".join(lines), total_limit)


def _text_mentions_character_name(text: str, name: str) -> bool:
    source = str(text or "")
    if not source or not name:
        return False
    if re.search(r"[A-Za-z]", name):
        return bool(re.search(rf"(?i)\b{re.escape(name)}\b", source))
    return name in source


def _detect_character_timing_conflicts(
    chapters: list[dict],
    *,
    constraints: dict[str, int],
) -> list[dict]:
    if not chapters or not constraints:
        return []
    issues: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for ch in chapters:
        try:
            num = int(ch.get("chapter_num", 0))
        except Exception:
            num = 0
        if num <= 0:
            continue
        title = str(ch.get("title") or "")
        synopsis = str(ch.get("synopsis") or "")
        for name, first_chapter in constraints.items():
            first = int(first_chapter)
            if num >= first:
                continue
            if _text_mentions_character_name(title, name) or _text_mentions_character_name(synopsis, name):
                key = (num, name)
                if key in seen:
                    continue
                seen.add(key)
                issues.append(
                    {
                        "chapter_num": num,
                        "name": name,
                        "earliest_chapter": first,
                    }
                )
    return issues


def _replace_character_name_mentions(text: str, name: str, replacement: str) -> str:
    source = str(text or "")
    if not source or not name:
        return source
    if re.search(r"[A-Za-z]", name):
        return re.sub(rf"(?i)\b{re.escape(name)}\b", replacement, source)
    return source.replace(name, replacement)


def _apply_character_timing_sanitizer(
    chapters: list[dict],
    *,
    constraints: dict[str, int],
) -> list[dict]:
    if not chapters or not constraints:
        return chapters
    aliases = ["某关键人物", "另一位关键人物", "某新角色", "另一名新角色"]
    name_alias: dict[str, str] = {}
    for idx, name in enumerate(sorted(constraints.keys())):
        name_alias[name] = aliases[idx % len(aliases)]

    sanitized: list[dict] = []
    for ch in chapters:
        item = dict(ch)
        try:
            num = int(item.get("chapter_num", 0))
        except Exception:
            num = 0
        title = str(item.get("title") or "")
        synopsis = str(item.get("synopsis") or "")
        if num > 0:
            for name, first_chapter in constraints.items():
                if num >= int(first_chapter):
                    continue
                alias = name_alias.get(name, "某关键人物")
                title = _replace_character_name_mentions(title, name, alias)
                synopsis = _replace_character_name_mentions(synopsis, name, alias)
        item["title"] = _clip(title, 80)
        item["synopsis"] = _clip(synopsis, 240)
        sanitized.append(item)
    return sanitized


async def _retry_character_timing_conflicts_with_llm(
    *,
    llm,
    model: str,
    chapters: list[dict],
    constraints: dict[str, int],
    start_chapter: int,
    end_chapter: int,
    total_chapter_count: int,
) -> list[dict]:
    if not chapters or not constraints:
        return chapters
    violations = _detect_character_timing_conflicts(chapters, constraints=constraints)
    if not violations:
        return chapters

    constraint_lines = [
        f"- {name}：仅可在第{int(first)}章及之后出现"
        for name, first in sorted(constraints.items(), key=lambda x: (int(x[1]), x[0]))[:24]
    ]
    violation_lines = [
        f"- 第{int(v['chapter_num'])}章出现了“{v['name']}”，应至少第{int(v['earliest_chapter'])}章才可出现"
        for v in violations[:30]
    ]
    payload = {"chapters": chapters}
    prompt = f"""
你是人物出场约束修复器。仅修复“角色提前出场”问题，禁止改写剧情主干。

本批次区间：第{start_chapter}-{end_chapter}章

人物出场硬约束：
{chr(10).join(constraint_lines)}

检测到的冲突：
{chr(10).join(violation_lines)}

输入 JSON：
{json.dumps(payload, ensure_ascii=False)}

修复规则：
1) 对于 chapter_num < 允许章位的章节，禁止直呼该角色姓名；
2) 若必须保留剧情功能，可替换成“未具名人物/神秘人物/某关键人物”等中性称谓；
3) chapter_num 和 phase 必须保持不变；
4) 除处理违规角色名外，标题与梗概尽量少改动；
5) 只输出严格 JSON 对象，不要 Markdown，不要解释。
""".strip()
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": "你是 JSON 修复器，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
            max_tokens=min(5200, 900 + len(chapters) * 220),
        )
    except Exception:
        return chapters

    parsed = _parse_payload(raw)
    items = parsed.get("chapters", []) if isinstance(parsed.get("chapters"), list) else []
    if not items:
        return chapters
    fixed = _normalize_chapter_items_for_range(
        items,
        start_chapter=start_chapter,
        end_chapter=end_chapter,
        total_chapter_count=total_chapter_count,
    )
    return fixed or chapters


def _load_volume_plans(project_id: str) -> list[dict]:
    try:
        with get_db() as db:
            rows = db.execute(
                "SELECT volume_index, title, start_chapter, end_chapter, goal, key_turning_point, end_hook "
                "FROM volume_plans WHERE project_id = ? ORDER BY volume_index ASC",
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _fallback_volume_plan_items(total_chapters: int, volume_count: int) -> list[dict]:
    total = max(1, int(total_chapters or 1))
    count = max(1, min(36, int(volume_count or 1)))
    base_span = max(1, total // count)
    remainder = max(0, total - base_span * count)
    items: list[dict] = []
    current = 1
    for idx in range(1, count + 1):
        span = base_span + (1 if idx <= remainder else 0)
        if idx == count:
            end = total
        else:
            end = min(total, current + span - 1)
        items.append(
            {
                "volume_index": idx,
                "title": f"第{idx}卷",
                "start_chapter": current,
                "end_chapter": end,
                "goal": "",
                "key_turning_point": "",
                "end_hook": "",
            }
        )
        current = end + 1
    return items


def _normalize_volume_plan_items(raw_items: Any, *, total_chapters: int, target_volume_count: int) -> list[dict]:
    if not isinstance(raw_items, list):
        return _fallback_volume_plan_items(total_chapters, target_volume_count)
    count_limit = max(1, min(36, int(target_volume_count or 1)))
    normalized: list[dict] = []
    for idx, item in enumerate(raw_items, start=1):
        if len(normalized) >= count_limit:
            break
        if not isinstance(item, dict):
            continue
        try:
            volume_index = int(item.get("volume_index", idx))
        except Exception:
            volume_index = idx
        try:
            start = int(item.get("start_chapter", 0))
        except Exception:
            start = 0
        try:
            end = int(item.get("end_chapter", 0))
        except Exception:
            end = 0
        normalized.append(
            {
                "volume_index": max(1, volume_index),
                "title": _clip(str(item.get("title", f"第{idx}卷")).strip() or f"第{idx}卷", 80),
                "start_chapter": start,
                "end_chapter": end,
                "goal": _clip(str(item.get("goal", "")).strip(), 300),
                "key_turning_point": _clip(str(item.get("key_turning_point", "")).strip(), 280),
                "end_hook": _clip(str(item.get("end_hook", "")).strip(), 280),
            }
        )
    if not normalized:
        return _fallback_volume_plan_items(total_chapters, target_volume_count)

    normalized.sort(key=lambda x: (int(x.get("volume_index", 9999)), int(x.get("start_chapter", 0))))
    repaired: list[dict] = []
    current_start = 1
    total = max(1, int(total_chapters or 1))
    for idx, item in enumerate(normalized[:count_limit], start=1):
        start = int(item.get("start_chapter") or 0)
        end = int(item.get("end_chapter") or 0)
        if start < current_start:
            start = current_start
        if start <= 0:
            start = current_start
        if end < start:
            end = start
        if idx == count_limit:
            end = max(end, total)
        start = min(start, total)
        end = min(max(end, start), total)
        repaired.append(
            {
                "volume_index": idx,
                "title": _clip(str(item.get("title", f"第{idx}卷")).strip() or f"第{idx}卷", 80),
                "start_chapter": start,
                "end_chapter": end,
                "goal": _clip(str(item.get("goal", "")).strip(), 300),
                "key_turning_point": _clip(str(item.get("key_turning_point", "")).strip(), 280),
                "end_hook": _clip(str(item.get("end_hook", "")).strip(), 280),
            }
        )
        current_start = end + 1
        if current_start > total:
            break

    if not repaired:
        return _fallback_volume_plan_items(total, count_limit)
    if len(repaired) != count_limit:
        return _fallback_volume_plan_items(total, count_limit)

    # 若未覆盖到总章节，追加最后一卷尾段。
    last_end = int(repaired[-1]["end_chapter"])
    if last_end < total:
        repaired[-1]["end_chapter"] = total
    return repaired


def _validate_volume_plan_consistency(items: list[dict], *, total_chapters: int) -> tuple[bool, list[str]]:
    issues: list[str] = []
    if not items:
        return False, ["卷计划为空"]
    total = max(1, int(total_chapters or 1))
    normalized = sorted(
        [dict(item) for item in items],
        key=lambda x: (int(x.get("start_chapter", 0) or 0), int(x.get("volume_index", 9999) or 9999)),
    )
    expected_start = 1
    for idx, item in enumerate(normalized, start=1):
        try:
            start = int(item.get("start_chapter", 0))
            end = int(item.get("end_chapter", 0))
        except Exception:
            issues.append(f"第{idx}卷章范围不是有效整数")
            continue
        if start < 1 or end < 1:
            issues.append(f"第{idx}卷章范围必须大于等于1")
            continue
        if end < start:
            issues.append(f"第{idx}卷结束章不能小于起始章")
            continue
        if start != expected_start:
            if start < expected_start:
                issues.append(f"第{idx}卷与上一卷存在重叠（应从第{expected_start}章开始）")
            else:
                issues.append(f"第{idx}卷前存在缺口（应从第{expected_start}章开始）")
        expected_start = end + 1
    if normalized:
        try:
            first_start = int(normalized[0].get("start_chapter", 0))
            last_end = int(normalized[-1].get("end_chapter", 0))
        except Exception:
            first_start, last_end = 0, 0
        if first_start != 1:
            issues.append("卷计划未从第1章开始")
        if last_end != total:
            issues.append(f"卷计划未覆盖到目标尾章（应到第{total}章）")
    return len(issues) == 0, issues


def _save_volume_plan_items(project_id: str, items: list[dict], *, force: bool) -> int:
    if not items:
        return 0
    with get_db() as db:
        if force:
            db.execute("DELETE FROM volume_plans WHERE project_id = ?", (project_id,))
        for item in items:
            db.execute(
                "INSERT INTO volume_plans (project_id, volume_index, title, start_chapter, end_chapter, goal, key_turning_point, end_hook, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?, datetime('now')) "
                "ON CONFLICT(project_id, volume_index) DO UPDATE SET "
                "title = excluded.title, "
                "start_chapter = excluded.start_chapter, "
                "end_chapter = excluded.end_chapter, "
                "goal = excluded.goal, "
                "key_turning_point = excluded.key_turning_point, "
                "end_hook = excluded.end_hook, "
                "updated_at = datetime('now')",
                (
                    project_id,
                    int(item.get("volume_index", 0)),
                    _clip(str(item.get("title", "")), 80),
                    int(item.get("start_chapter", 1)),
                    int(item.get("end_chapter", 1)),
                    _clip(str(item.get("goal", "")), 300),
                    _clip(str(item.get("key_turning_point", "")), 280),
                    _clip(str(item.get("end_hook", "")), 280),
                ),
            )
    return len(items)


def _normalize_selected_source_ids(source_ids: list[str], *, limit: int = 24) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in source_ids or []:
        sid = str(raw or "").strip()
        if not sid or sid in seen:
            continue
        seen.add(sid)
        normalized.append(sid)
        if len(normalized) >= limit:
            break
    return normalized


def _load_selected_knowledge_sources(project_id: str, source_ids: list[str], *, max_sources: int = 8) -> list[dict]:
    ids = _normalize_selected_source_ids(source_ids, limit=max(max_sources * 3, max_sources))
    if not ids:
        return []

    placeholders = ",".join(["?"] * len(ids))
    with get_db() as db:
        rows = db.execute(
            f"SELECT id, title, reference_type, content "
            f"FROM knowledge_sources "
            f"WHERE project_id = ? AND enabled = 1 AND id IN ({placeholders})",
            (project_id, *ids),
        ).fetchall()

    by_id = {str(r["id"]): dict(r) for r in rows}
    selected: list[dict] = []
    for sid in ids:
        row = by_id.get(sid)
        if not row:
            continue
        selected.append(row)
        if len(selected) >= max_sources:
            break
    return selected


def _build_selected_sources_block(
    selected_sources: list[dict],
    *,
    total_limit: int,
    per_source_limit: int,
) -> str:
    if not selected_sources:
        return ""

    blocks: list[str] = []
    for idx, row in enumerate(selected_sources, start=1):
        title = _clip(str(row.get("title") or "未命名资料"), 90)
        reference_type = _clip(str(row.get("reference_type") or "general"), 28)
        content = _clip(str(row.get("content") or ""), per_source_limit)
        if not content:
            continue
        blocks.append(f"{idx}. {title}（类型:{reference_type}）\n{content}")

    if not blocks:
        return ""
    return _clip(
        "\n\n【用户选中的知识引用（优先参考）】\n" + "\n\n".join(blocks),
        total_limit,
    )


def _build_option_history_block(
    option_history: list[dict[str, Any]],
    *,
    max_items: int = 16,
    total_limit: int = 3200,
) -> str:
    if not isinstance(option_history, list) or not option_history:
        return ""

    lines: list[str] = []
    for raw in option_history[-max_items:]:
        if not isinstance(raw, dict):
            continue
        title = _clip(str(raw.get("title") or "").strip(), 80)
        if not title:
            continue
        qtype = _clip(str(raw.get("qtype") or "").strip(), 12)
        opts_raw = raw.get("options")
        option_labels: list[str] = []
        seen: set[str] = set()
        if isinstance(opts_raw, list):
            for item in opts_raw[:10]:
                if isinstance(item, dict):
                    label = str(item.get("label", "")).strip()
                else:
                    label = str(item or "").strip()
                if not label:
                    continue
                key = label.lower()
                if key in seen:
                    continue
                seen.add(key)
                option_labels.append(_clip(label, 30))
        if not option_labels:
            continue
        lines.append(f"- {title}（{qtype or 'single'}）：{' / '.join(option_labels)}")

    if not lines:
        return ""
    return _clip(
        "\n\n【立项对话出现过的可选方向（增强参考，不是硬约束）】\n" + "\n".join(lines),
        total_limit,
    )


async def _generate_chapters_only_with_fallback(
    *,
    llm,
    model: str,
    temperature: float,
    project: dict,
    chapter_count: int,
    bible_text: str,
    active_profile: Optional[dict],
) -> list[dict]:
    bible_context = _build_bootstrap_bible_context(bible_text, scopes={"chapters"}, limit=12000)
    bible_block = f"\n\n【必须遵守的小说圣经（含章节执行指令）】\n{bible_context}" if bible_context else ""
    profile_block = _build_profile_block(active_profile, json_limit=2200, summary_limit=220)
    prompt = f"""
你现在只负责“章节规划”生成。

项目名：{project['name']}
题材：{project['genre'] or '未指定'}
简介：{project['description'] or '未填写'}
目标章节数：{chapter_count}
目标总字数：{project['word_target'] or 100000}
{bible_block}
{profile_block}

只输出严格 JSON 对象（不要 Markdown，不要额外说明）：
{{
  "chapters": [
    {{"chapter_num": 1, "title": "章节名", "phase": "起", "synopsis": "40-120字梗概"}}
  ]
}}

硬约束：
1) chapter_num 必须从 1 连续到 {chapter_count}；
2) phase 只能是 起/承/转/合；
3) synopsis 每条 40-120 字，不能为空；
4) 必须严格遵守小说圣经和规则包（若存在）。
""".strip()
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": "你是章节规划 JSON 生成器，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.25), 0.55),
            max_tokens=min(22000, max(2200, 1200 + chapter_count * 110)),
        )
    except Exception:
        return []
    payload = _parse_payload(raw)
    return payload.get("chapters", []) if isinstance(payload.get("chapters"), list) else []


async def _generate_chapters_in_range_with_fallback(
    *,
    llm,
    model: str,
    temperature: float,
    project: dict,
    start_chapter: int,
    end_chapter: int,
    total_chapter_count: int,
    bible_text: str,
    active_profile: Optional[dict],
    planning_material_block: str = "",
    continuity_block: str = "",
    format_anchor_block: str = "",
    character_timing_block: str = "",
) -> list[dict]:
    bible_context = _build_bootstrap_bible_context(bible_text, scopes={"chapters"}, limit=12000)
    bible_block = f"\n\n【必须遵守的小说圣经（含章节执行指令）】\n{bible_context}" if bible_context else ""
    profile_block = _build_profile_block(active_profile, json_limit=2200, summary_limit=220)
    planning_block = (
        f"\n\n【已生成/已有设定（章节生成必须参考）】\n{planning_material_block}"
        if planning_material_block.strip()
        else ""
    )
    continuity_prompt_block = (
        f"\n\n【连贯性上下文】\n{continuity_block}"
        if continuity_block.strip()
        else ""
    )
    format_block = f"\n\n【章节输出格式锚点（来自圣经4.4）】\n{format_anchor_block}" if format_anchor_block.strip() else ""
    timing_block = f"\n\n{character_timing_block}" if character_timing_block.strip() else ""
    expected_count = max(1, end_chapter - start_chapter + 1)
    prompt = f"""
你现在只负责“章节规划”生成（区间模式）。

项目名：{project['name']}
题材：{project['genre'] or '未指定'}
简介：{project['description'] or '未填写'}
全书目标章节数：{total_chapter_count}
本批次章节区间：第{start_chapter}-{end_chapter}章
目标总字数：{project['word_target'] or 100000}
{bible_block}
{profile_block}
{planning_block}
{continuity_prompt_block}
{format_block}
{timing_block}

只输出严格 JSON 对象（不要 Markdown，不要额外说明）：
{{
  "chapters": [
    {{"chapter_num": {start_chapter}, "title": "章节名", "phase": "起", "synopsis": "40-120字梗概"}}
  ]
}}

硬约束：
1) chapter_num 必须覆盖第 {start_chapter} 到第 {end_chapter} 章，连续且不重复；
2) chapter_num 必须使用绝对章号，禁止从 1 重新编号；
3) phase 只能是 起/承/转/合；
4) synopsis 每条 40-120 字，不能为空；
5) 必须严格遵守小说圣经、4.4 格式锚点与规则包（若存在）。
""".strip()
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": "你是章节规划 JSON 生成器，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.25), 0.55),
            max_tokens=min(12000, max(1800, 900 + expected_count * 120)),
        )
    except Exception:
        return []
    payload = _parse_payload(raw)
    raw_items = payload.get("chapters", []) if isinstance(payload.get("chapters"), list) else []
    chapters = _normalize_chapter_items_for_range(
        raw_items,
        start_chapter=start_chapter,
        end_chapter=end_chapter,
        total_chapter_count=total_chapter_count,
    )
    return chapters


def _is_default_chapter_title(title: Any, chapter_num: int) -> bool:
    text = str(title or "").strip()
    if not text:
        return True
    default_title = f"第{chapter_num}章"
    if text == default_title:
        return True
    normalized = re.sub(r"\s+", "", text)
    return normalized in {default_title, default_title + "·", default_title + "：", default_title + ":"}


def _canonical_chapter_row(rows: list[dict]) -> dict:
    if not rows:
        return {}

    def _score(row: dict) -> tuple[int, int, int]:
        synopsis = str(row.get("synopsis") or "").strip()
        title = str(row.get("title") or "").strip()
        try:
            num = int(row.get("chapter_num", 0))
        except Exception:
            num = 0
        non_default_title = 0 if _is_default_chapter_title(title, num) else 1
        try:
            row_id = str(row.get("id", ""))
            id_score = int(row_id[-6:], 16) if len(row_id) >= 6 else 0
        except Exception:
            id_score = 0
        return (1 if synopsis else 0, non_default_title, id_score)

    return max(rows, key=_score)


def _normalize_bootstrap_error_message(err: Exception, *, fallback: str) -> str:
    detail = ""
    if isinstance(err, HTTPException):
        detail = str(err.detail or "")
    else:
        detail = str(err or "")
    cleaned = detail.strip()
    if not cleaned:
        return fallback
    lowered = cleaned.lower()
    if any(token in lowered for token in ("timeout", "timed out", "apitimeouterror", "read timeout")):
        return "AI 章节规划超时，建议缩小区间到 10-20 章后重试。"
    if "start_chapter" in cleaned or "end_chapter" in cleaned:
        return f"区间参数错误：{cleaned}"
    if "scope" in cleaned and "chapters" in cleaned:
        return "区间生成仅支持章节范围（scope=chapters）。"
    if "超出上限" in cleaned:
        return cleaned
    return cleaned or fallback


def _insert_chapter_row_with_guard(
    db,
    *,
    project_id: str,
    chapter_num: int,
    title: str,
    phase: str,
    synopsis: str,
    sort_order: int,
) -> bool:
    """幂等插入章节：优先利用唯一约束防重，兼容未建索引的旧库。"""
    sql = (
        "INSERT INTO chapters (project_id, chapter_num, title, phase, synopsis, sort_order) "
        "VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(project_id, chapter_num) DO NOTHING"
    )
    params = (project_id, int(chapter_num), title, phase, synopsis, int(sort_order))
    try:
        before_changes = int(getattr(db, "total_changes", 0))
        db.execute(sql, params)
        after_changes = int(getattr(db, "total_changes", before_changes))
        return after_changes > before_changes
    except Exception as e:
        # 兼容尚未迁移到唯一索引的旧库：退化为普通插入。
        if "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint" in str(e):
            db.execute(
                "INSERT INTO chapters (project_id, chapter_num, title, phase, synopsis, sort_order) VALUES (?,?,?,?,?,?)",
                params,
            )
            return True
        raise


def _write_chapter_plan_rows(
    *,
    project_id: str,
    chapters: list[dict],
    force: bool,
    start_chapter: Optional[int] = None,
    end_chapter: Optional[int] = None,
) -> tuple[int, int]:
    inserted = 0
    skipped = 0
    range_start = int(start_chapter) if start_chapter is not None else None
    range_end = int(end_chapter) if end_chapter is not None else None
    with get_db() as db:
        if range_start is not None and range_end is not None:
            chapter_rows = db.execute(
                "SELECT id, chapter_num, title, synopsis FROM chapters WHERE project_id = ? AND chapter_num BETWEEN ? AND ?",
                (project_id, range_start, range_end),
            ).fetchall()
        else:
            chapter_rows = db.execute(
                "SELECT id, chapter_num, title, synopsis FROM chapters WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        rows_by_num: dict[int, list[dict]] = {}
        for row in chapter_rows:
            try:
                num = int(row["chapter_num"])
            except Exception:
                continue
            rows_by_num.setdefault(num, []).append(dict(row))
        existing_by_num = {num: _canonical_chapter_row(rows) for num, rows in rows_by_num.items() if rows}
        seen_nums: set[int] = set()
        for idx, ch in enumerate(chapters, start=1):
            try:
                num = int(ch.get("chapter_num", idx))
            except Exception:
                num = idx
            if num < 1:
                continue
            if range_start is not None and range_end is not None and not (range_start <= num <= range_end):
                continue
            if num in seen_nums:
                continue
            seen_nums.add(num)
            title = _clip(str(ch.get("title", f"第{num}章")), 80)
            synopsis = _clip(str(ch.get("synopsis", "")), 240)
            phase = str(ch.get("phase", "")).strip()
            if phase not in {"起", "承", "转", "合"}:
                phase = ""

            if num in existing_by_num:
                row = existing_by_num[num]
                existing_synopsis = str(row.get("synopsis", "") or "").strip()
                existing_title = str(row.get("title", "") or "").strip()
                can_update = force or (
                    (not existing_synopsis)
                    and _is_default_chapter_title(existing_title, num)
                )
                if can_update:
                    db.execute(
                        "UPDATE chapters SET title = ?, phase = ?, synopsis = ?, updated_at = datetime('now') WHERE id = ?",
                        (title, phase, synopsis, row["id"]),
                    )
                    inserted += 1
                else:
                    skipped += 1
            else:
                if _insert_chapter_row_with_guard(
                    db,
                    project_id=project_id,
                    chapter_num=num,
                    title=title,
                    phase=phase,
                    synopsis=synopsis,
                    sort_order=num,
                ):
                    inserted += 1
                else:
                    skipped += 1
    return inserted, skipped


async def _generate_and_persist_chapter_range_batches(
    *,
    req: BootstrapRequest,
    llm,
    model: str,
    system_prompt: str,
    temperature: float,
    project: dict,
    bible_text: str,
    active_profile: Optional[dict],
    planning_material_block: str,
    start_chapter: int,
    end_chapter: int,
    batch_size: int,
    total_chapter_count: int,
) -> tuple[int, int, dict, Optional[dict], int, bool]:
    start = max(1, int(start_chapter))
    end = max(start, int(end_chapter))
    current = start
    success_batches = 0
    retry_count = 0
    inserted_total = 0
    skipped_total = 0
    format_degraded = False
    failed_range: Optional[dict] = None
    planned_batches = ((end - start) // batch_size) + 1
    foreshadow_items = _load_foreshadow_snapshot(req.project_id, limit=20)
    foreshadow_block = _build_foreshadow_snapshot_block(foreshadow_items)
    character_timing_constraints = _extract_character_appearance_constraints(
        "\n\n".join(
            [
                str(bible_text or ""),
                str(planning_material_block or ""),
            ]
        )
    )

    while current <= end:
        target_end = min(end, current + batch_size - 1)
        attempt_sizes = [target_end - current + 1]
        for fallback_size in (20, 10):
            if fallback_size < attempt_sizes[0] and fallback_size >= MIN_CHAPTER_RANGE_BATCH_SIZE:
                attempt_sizes.append(fallback_size)

        batch_done = False
        for idx, size in enumerate(attempt_sizes):
            attempt_end = min(end, current + size - 1)
            if idx > 0:
                retry_count += 1

            recent_chain = _load_recent_chapter_chain(
                req.project_id,
                upto_chapter=max(1, current - 1),
                limit=15,
            )
            recent_block = _build_recent_chapter_chain_block(recent_chain)
            if req.volume_index is not None or str(req.volume_title or "").strip():
                volume_goal = {
                    "volume_index": req.volume_index,
                    "title": req.volume_title,
                    "start_chapter": req.volume_start_chapter or start,
                    "end_chapter": req.volume_end_chapter or end,
                    "goal": "",
                    "key_turning_point": "",
                    "end_hook": "",
                }
            else:
                volume_goal = _load_volume_goal_for_range(
                    req.project_id,
                    start_chapter=current,
                    end_chapter=attempt_end,
                )
            volume_goal_block = _build_volume_goal_block(volume_goal)
            continuity_block = _build_chapter_continuity_block(
                recent_chapter_block=recent_block,
                foreshadow_block=foreshadow_block,
                volume_goal_block=volume_goal_block,
            )
            character_timing_block = _build_character_appearance_constraints_block(
                character_timing_constraints,
                start_chapter=current,
                end_chapter=attempt_end,
            )
            format_anchor, anchor_degraded = _build_chapter_format_anchor_from_bible(
                bible_text,
                start_chapter=current,
                end_chapter=attempt_end,
                volume_index=req.volume_index,
                volume_title=req.volume_title,
                volume_start_chapter=req.volume_start_chapter,
                volume_end_chapter=req.volume_end_chapter,
            )
            format_degraded = format_degraded or anchor_degraded
            expected_volume_label, expected_range_label = _resolve_volume_label_and_range(
                start_chapter=current,
                end_chapter=attempt_end,
                volume_index=(
                    req.volume_index
                    if req.volume_index is not None
                    else int(volume_goal.get("volume_index", 0) or 0) if volume_goal else None
                ),
                volume_title=(
                    str(req.volume_title or "").strip()
                    or str(volume_goal.get("title", "") if volume_goal else "").strip()
                ),
                volume_start_chapter=(
                    req.volume_start_chapter
                    if req.volume_start_chapter is not None
                    else int(volume_goal.get("start_chapter", 0) or 0) if volume_goal else None
                ),
                volume_end_chapter=(
                    req.volume_end_chapter
                    if req.volume_end_chapter is not None
                    else int(volume_goal.get("end_chapter", 0) or 0) if volume_goal else None
                ),
            )

            prompt = f"""
请为小说项目生成结构化章节规划数据（区间模式）。

本次生成范围：章节
项目名：{project['name']}
题材：{project['genre'] or '未指定'}
简介：{project['description'] or '未填写'}
全书目标章节数：{total_chapter_count}
本批次章节区间：第{current}-{attempt_end}章
目标总字数：{project['word_target'] or 100000}
""".strip()
            timing_prompt_block = f"{character_timing_block}\n\n" if character_timing_block else ""

            chapter_payload: list[dict] = []
            try:
                raw = await llm.chat(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                        {
                            "role": "user",
                            "content": (
                                f"【必须遵守的小说圣经（含执行指令）】\n{_build_bootstrap_bible_context(bible_text, scopes={'chapters'}, limit=12000)}\n\n"
                                f"{_build_profile_block(active_profile, json_limit=2200, summary_limit=220)}\n\n"
                                f"【已生成/已有设定（章节生成必须参考）】\n{planning_material_block or '无'}\n\n"
                                f"【连贯性上下文】\n{continuity_block or '无'}\n\n"
                                f"{timing_prompt_block}"
                                f"【章节输出格式锚点（来自圣经4.4，冲突时以此为准）】\n{format_anchor}\n\n"
                                "只输出严格 JSON 对象，不要 Markdown，不要解释。\n"
                                "输出格式：{\"chapters\":[{\"chapter_num\":<绝对章号>,\"title\":\"...\",\"phase\":\"起|承|转|合\",\"synopsis\":\"40-120字\"}]}\n"
                                f"硬约束：chapter_num 必须覆盖第 {current} 到第 {attempt_end} 章，连续且不重复；禁止从 1 重新编号。"
                            ),
                        },
                    ],
                    temperature=min(max(temperature, 0.28), 0.65),
                    max_tokens=min(12000, max(1800, 900 + (attempt_end - current + 1) * 120)),
                )
                parsed = _parse_payload(raw)
                chapter_payload = parsed.get("chapters", []) if isinstance(parsed.get("chapters"), list) else []
            except Exception as e:
                if _is_timeout_like_error(e):
                    if idx < len(attempt_sizes) - 1:
                        continue
                    failed_range = {"start_chapter": current, "end_chapter": end}
                    batch_done = False
                    break
                logger.warning(
                    "Chapter range batch generation failed: project_id=%s model=%s range=%s-%s error=%s",
                    req.project_id,
                    model,
                    current,
                    attempt_end,
                    e,
                )
                failed_range = {"start_chapter": current, "end_chapter": end}
                batch_done = False
                break

            chapters = _normalize_chapter_items_for_range(
                chapter_payload,
                start_chapter=current,
                end_chapter=attempt_end,
                total_chapter_count=max(total_chapter_count, end),
            )
            expected = attempt_end - current + 1
            if _needs_chapter_fallback(chapters, expected):
                fallback_chapters = await _generate_chapters_in_range_with_fallback(
                    llm=llm,
                    model=model,
                    temperature=temperature,
                    project=project,
                    start_chapter=current,
                    end_chapter=attempt_end,
                    total_chapter_count=max(total_chapter_count, end),
                    bible_text=bible_text,
                    active_profile=active_profile,
                    planning_material_block=planning_material_block,
                    continuity_block=continuity_block,
                    format_anchor_block=format_anchor,
                    character_timing_block=character_timing_block,
                )
                normalized_fallback = _normalize_chapter_items_for_range(
                    fallback_chapters,
                    start_chapter=current,
                    end_chapter=attempt_end,
                    total_chapter_count=max(total_chapter_count, end),
                )
                if normalized_fallback:
                    chapters = normalized_fallback
            chapters = _ensure_chapter_coverage_for_range(
                chapters,
                start_chapter=current,
                end_chapter=attempt_end,
                total_chapter_count=max(total_chapter_count, end),
            )
            timing_conflicts = _detect_character_timing_conflicts(
                chapters,
                constraints=character_timing_constraints,
            )
            if timing_conflicts:
                timing_fixed = await _retry_character_timing_conflicts_with_llm(
                    llm=llm,
                    model=model,
                    chapters=chapters,
                    constraints=character_timing_constraints,
                    start_chapter=current,
                    end_chapter=attempt_end,
                    total_chapter_count=max(total_chapter_count, end),
                )
                remaining_conflicts = _detect_character_timing_conflicts(
                    timing_fixed,
                    constraints=character_timing_constraints,
                )
                if remaining_conflicts:
                    chapters = _apply_character_timing_sanitizer(
                        timing_fixed,
                        constraints=character_timing_constraints,
                    )
                else:
                    chapters = timing_fixed
                retry_count += 1
            if _detect_volume_label_mismatch(
                chapters,
                expected_volume_label=expected_volume_label,
                target_volume_index=(
                    req.volume_index
                    if req.volume_index is not None
                    else int(volume_goal.get("volume_index", 0) or 0) if volume_goal else None
                ),
            ):
                llm_fixed = await _retry_volume_label_mismatch_with_llm(
                    llm=llm,
                    model=model,
                    chapters=chapters,
                    expected_volume_label=expected_volume_label,
                    range_label=expected_range_label,
                )
                if _detect_volume_label_mismatch(
                    llm_fixed,
                    expected_volume_label=expected_volume_label,
                    target_volume_index=(
                        req.volume_index
                        if req.volume_index is not None
                        else int(volume_goal.get("volume_index", 0) or 0) if volume_goal else None
                    ),
                ):
                    chapters = _repair_volume_label_mismatch(
                        llm_fixed,
                        expected_volume_label=expected_volume_label,
                        range_label=expected_range_label,
                    )
                else:
                    chapters = llm_fixed
                retry_count += 1
            inserted_delta, skipped_delta = _write_chapter_plan_rows(
                project_id=req.project_id,
                chapters=chapters,
                force=req.force,
                start_chapter=current,
                end_chapter=attempt_end,
            )
            inserted_total += inserted_delta
            skipped_total += skipped_delta
            success_batches += 1
            current = attempt_end + 1
            batch_done = True
            break

        if not batch_done:
            break

    effective_planned = max(planned_batches, success_batches + (1 if failed_range else 0))
    batch_stats = {
        "planned_batches": effective_planned,
        "success_batches": success_batches,
    }
    return inserted_total, skipped_total, batch_stats, failed_range, retry_count, format_degraded


def _load_project(project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT id, name, genre, description, structure, custom_structure, chapter_words, priority, "
            "word_target, model_main, temperature "
            "FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
    return row


def _is_special_other_option(label: str, value: str) -> bool:
    l = (label or "").strip().lower()
    v = (value or "").strip().lower()
    return (
        v == OTHER_OPTION_VALUE
        or "其他" in label
        or "other" in l
    )


def _is_special_ai_decide_option(label: str, value: str) -> bool:
    l = (label or "").strip().lower().replace(" ", "")
    v = (value or "").strip().lower().replace(" ", "")
    return (
        v == AI_DECIDE_OPTION_VALUE
        or "交给ai决定" in l
        or "交给ai决定" in v
        or "aidecide" in l
        or "aidecide" in v
    )


def _normalize_option(label: str, value: str) -> tuple[str, str]:
    if _is_special_ai_decide_option(label, value):
        return AI_DECIDE_OPTION_LABEL, AI_DECIDE_OPTION_VALUE
    if _is_special_other_option(label, value):
        return OTHER_OPTION_LABEL, OTHER_OPTION_VALUE
    v = (value or "").strip() or (label or "").strip()
    return (label or "").strip(), v


def _title_has_protagonist(title: str) -> bool:
    t = (title or "").strip().lower()
    return any(k in t for k in ("主角", "主人公", "男主", "女主"))


def _title_has_goal(title: str) -> bool:
    t = (title or "").strip().lower()
    # 避免把“目标字数/总字数/篇幅目标”误判成“主角目标”。
    if any(k in t for k in ("目标字数", "总字数", "篇幅", "章节", "每章", "字/章")):
        return False
    return any(k in t for k in ("主角目标", "核心目标", "主角诉求", "主角想要", "主角任务", "主角追求", "目标", "诉求", "想要", "必须达成", "任务", "追求"))


def _sanitize_brainstorm_questions(raw_questions: Any) -> list[BrainstormQuestion]:
    if not isinstance(raw_questions, list):
        return []

    sanitized: list[BrainstormQuestion] = []
    used_ids: set[str] = set()
    for idx, raw in enumerate(raw_questions[:5], start=1):
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title", "")).strip()
        if not title:
            continue

        qid = str(raw.get("id", f"q{idx}")).strip() or f"q{idx}"
        if qid in used_ids:
            qid = f"{qid}_{idx}"
        used_ids.add(qid)

        qtype = str(raw.get("qtype", "text")).strip().lower()
        if qtype not in {"single", "multi", "text", "number"}:
            qtype = "text"

        raw_options = raw.get("options", [])
        options: list[BrainstormQuestionOption] = []
        used_option_values: set[str] = set()
        if isinstance(raw_options, list):
            for item in raw_options[:8]:
                if isinstance(item, dict):
                    label = str(item.get("label", "")).strip()
                    value = str(item.get("value", "")).strip() or label
                else:
                    label = str(item).strip()
                    value = label
                if not label:
                    continue
                normalized_label, normalized_value = _normalize_option(label, value)
                if not normalized_label:
                    continue
                dedupe_key = normalized_value.strip().lower()
                if dedupe_key in used_option_values:
                    continue
                used_option_values.add(dedupe_key)
                options.append(BrainstormQuestionOption(label=normalized_label, value=normalized_value))

        if qtype in {"single", "multi"} and len(options) < 2:
            qtype = "text"
            options = []

        required = bool(raw.get("required", True))
        max_select = raw.get("max_select")
        try:
            max_select_val = int(max_select) if max_select is not None else None
        except Exception:
            max_select_val = None
        if qtype != "multi":
            max_select_val = None
        elif max_select_val is not None and max_select_val < 1:
            max_select_val = None

        placeholder = str(raw.get("placeholder", "")).strip()
        sanitized.append(
            BrainstormQuestion(
                id=qid,
                title=title,
                qtype=qtype,  # type: ignore[arg-type]
                options=options,
                required=required,
                max_select=max_select_val,
                placeholder=placeholder,
            )
        )
        if len(sanitized) >= BRAINSTORM_MAX_QUESTIONS:
            break
    return sanitized


def _sanitize_question_options(raw_options: Any, max_items: int = 8) -> list[BrainstormQuestionOption]:
    if not isinstance(raw_options, list):
        return []
    sanitized: list[BrainstormQuestionOption] = []
    used_option_values: set[str] = set()
    for item in raw_options[:max_items]:
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            value = str(item.get("value", "")).strip() or label
        else:
            label = str(item).strip()
            value = label
        if not label:
            continue
        normalized_label, normalized_value = _normalize_option(label, value)
        if not normalized_label:
            continue
        # 刷新接口只返回业务选项，特殊项由前端统一追加。
        if normalized_value in {OTHER_OPTION_VALUE, AI_DECIDE_OPTION_VALUE}:
            continue
        dedupe_key = normalized_value.strip().lower()
        if dedupe_key in used_option_values:
            continue
        used_option_values.add(dedupe_key)
        sanitized.append(BrainstormQuestionOption(label=normalized_label, value=normalized_value))
    return sanitized


def _normalize_option_phrase(text: str) -> str:
    t = str(text or "").strip().lower()
    if not t:
        return ""
    # 去掉常见标点与分隔符，便于做“空泛词”匹配。
    t = re.sub(r"[\s/／,，。.!！?？·\-\+\(\)（）:：]+", "", t)
    return t


def _is_low_quality_refresh_option(label: str, *, slot: Optional[str]) -> bool:
    raw = (label or "").strip()
    if not raw:
        return True
    normalized = _normalize_option_phrase(raw)
    if not normalized:
        return True
    if raw in LOW_QUALITY_OPTION_EXACT or normalized in {_normalize_option_phrase(x) for x in LOW_QUALITY_OPTION_EXACT}:
        return True
    if len(raw) <= 2:
        return True
    if slot == "goal" and len(raw) < 6:
        return True
    if slot == "conflict" and len(raw) < 6:
        return True
    slot_phrases = LOW_QUALITY_SLOT_PHRASES.get(slot or "", set())
    if normalized in {_normalize_option_phrase(x) for x in slot_phrases}:
        return True
    return False


def _is_slot_misaligned_refresh_option(label: str, *, slot: Optional[str]) -> bool:
    if not slot:
        return False
    text = (label or "").strip().lower()
    if not text:
        return True

    has_structure = any(k in text for k in ("结构", "主线", "支线", "单元", "群像", "并行", "三幕", "英雄之旅", "起承转合"))
    has_chapter_count = bool(re.search(r"\d+\s*章", text)) or any(
        k in text for k in ("章节数", "章数", "总章", "预估章节", "预计章节", "多少章")
    )
    has_chapter_words = bool(re.search(r"(每章|单章|每章节).{0,6}\d{3,5}\s*字", text)) or ("字/章" in text)
    has_word_total = any(k in text for k in ("万字", "字数", "篇幅", "体量", "短篇", "中篇", "长篇", "超长篇", "多少字"))

    if slot == "length":
        if has_chapter_count or has_chapter_words or has_structure:
            return True
        return not has_word_total

    if slot == "chapter_count":
        if has_chapter_words or has_word_total or has_structure:
            return True
        return not (has_chapter_count or ("章" in text))

    if slot == "chapter_words":
        if has_structure:
            return True
        if "万字" in text:
            return True
        return not (has_chapter_words or ("章" in text and "字" in text))

    if slot == "chapter_scale":
        if has_structure or has_word_total:
            return True
        return not (has_chapter_count and (has_chapter_words or ("章" in text and "字" in text)))

    if slot == "structure":
        if has_chapter_words or has_chapter_count or has_word_total:
            return True
        return not has_structure

    return False


def _filter_refresh_options(
    options: list[BrainstormQuestionOption],
    *,
    slot: Optional[str],
    existing_values: set[str],
    limit: int = 8,
) -> list[BrainstormQuestionOption]:
    filtered: list[BrainstormQuestionOption] = []
    seen: set[str] = set()
    for opt in options:
        value_key = (opt.value or "").strip().lower()
        if not value_key:
            continue
        if value_key in existing_values or value_key in seen:
            continue
        if _is_low_quality_refresh_option(opt.label, slot=slot):
            continue
        if _is_slot_misaligned_refresh_option(opt.label, slot=slot):
            continue
        seen.add(value_key)
        filtered.append(opt)
        if len(filtered) >= limit:
            break
    return filtered


def _option_signature(options: list[BrainstormQuestionOption]) -> tuple[str, ...]:
    values = sorted(
        {
            (opt.value or "").strip().lower()
            for opt in (options or [])
            if (opt.value or "").strip()
        }
    )
    return tuple(values)


def _build_emergency_refresh_options(
    slot: Optional[str],
    title: str,
    *,
    genre_hint: str = "",
    description_hint: str = "",
) -> list[BrainstormQuestionOption]:
    if slot == "goal":
        dynamic_goal = _build_goal_slot_options(genre_hint, description_hint, limit=8)
        if len(dynamic_goal) >= 2:
            return dynamic_goal
    rows_map: dict[str, list[tuple[str, str]]] = {
        "conflict": [
            ("校规与职责冲突导致调查受阻", "校规与职责冲突导致调查受阻"),
            ("同伴立场分裂触发内部对抗", "同伴立场分裂触发内部对抗"),
            ("关键证据被篡改引发误判危机", "关键证据被篡改引发误判危机"),
            ("公开真相将直接伤害关键关系", "公开真相将直接伤害关键关系"),
            ("超常能力反噬带来现实代价", "超常能力反噬带来现实代价"),
        ],
        "goal": [
            ("先保住调查资格再追查真相", "先保住调查资格再追查真相"),
            ("先救关键人物再拆幕后链条", "先救关键人物再拆幕后链条"),
            ("先夺回主动权再推进主线", "先夺回主动权再推进主线"),
            ("先锁定证据闭环再公开对抗", "先锁定证据闭环再公开对抗"),
        ],
        "protagonist": [
            ("调查型主角（理性推理）", "调查型主角（理性推理）"),
            ("行动型主角（高压突破）", "行动型主角（高压突破）"),
            ("隐忍型主角（潜伏布局）", "隐忍型主角（潜伏布局）"),
            ("反差型主角（外弱内强）", "反差型主角（外弱内强）"),
        ],
        "structure": [
            ("前中期单元推进，后期主线收束", "前中期单元推进，后期主线收束"),
            ("双线并跑，定期交汇反转", "双线并跑，定期交汇反转"),
            ("群像并行，按事件节点汇流", "群像并行，按事件节点汇流"),
            ("主线慢热，后半程持续提速", "主线慢热，后半程持续提速"),
        ],
        "length": [
            ("中长篇（10-15万字）", "中长篇（10-15万字）"),
            ("长篇（15-25万字）", "长篇（15-25万字）"),
            ("超长篇（25万字以上）", "超长篇（25万字以上）"),
        ],
        "chapter_count": [
            ("约18章", "约18章"),
            ("约24章", "约24章"),
            ("约36章", "约36章"),
            ("约48章", "约48章"),
        ],
        "chapter_words": [
            ("每章约2500字", "每章约2500字"),
            ("每章约3500字", "每章约3500字"),
            ("每章约5000字", "每章约5000字"),
            ("每章约7000字", "每章约7000字"),
        ],
        "chapter_scale": [
            ("约16章（每章约3800字）", "约16章（每章约3800字）"),
            ("约20章（每章约4500字）", "约20章（每章约4500字）"),
            ("约24章（每章约5200字）", "约24章（每章约5200字）"),
            ("约30章（每章约6000字）", "约30章（每章约6000字）"),
        ],
        "ending": [
            ("阶段性HE，留续作伏笔", "阶段性HE，留续作伏笔"),
            ("苦涩HE（胜利但有代价）", "苦涩HE（胜利但有代价）"),
            ("开放偏BE（关键关系未修复）", "开放偏BE（关键关系未修复）"),
            ("主线完结+支线开放", "主线完结+支线开放"),
        ],
    }
    generic_rows = [
        ("先锁优先级最高的冲突线", "先锁优先级最高的冲突线"),
        ("先确定代价再决定推进节奏", "先确定代价再决定推进节奏"),
        ("先保人设一致再做强反转", "先保人设一致再做强反转"),
    ]
    rows = list(rows_map.get(slot or "", []))
    if not rows:
        if _slot_from_title(title) in rows_map:
            rows = list(rows_map[_slot_from_title(title) or ""])
    rows.extend(generic_rows)
    deduped: list[BrainstormQuestionOption] = []
    seen: set[str] = set()
    for label, value in rows:
        key = (value or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(BrainstormQuestionOption(label=label, value=value))
    return deduped


def _slot_refresh_guardrail(slot: Optional[str]) -> str:
    rules = {
        "length": "9) 本题只允许“总篇幅/总字数”维度，禁止出现结构词与章节数/每章字数。",
        "structure": "9) 本题只允许“叙事结构/推进方式”维度，禁止出现总字数、章节数、每章字数。",
        "chapter_count": "9) 本题只允许“总章节数”维度，禁止出现总字数、每章字数与结构词。",
        "chapter_words": "9) 本题只允许“每章字数”维度，禁止出现总字数、总章节数与结构词。",
        "chapter_scale": "9) 本题必须输出“约X章（每章约Y字）”格式，禁止输出结构词或总字数档位词。",
    }
    return rules.get(slot or "", "")


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        return v in {"1", "true", "yes", "y", "ready", "ok", "是", "可以", "可", "可生成", "可进入"}
    return False


def _reply_ready_for_bible(reply: str, questions: list[BrainstormQuestion]) -> bool:
    if questions:
        return False
    text = (reply or "").strip()
    if not text:
        return False
    patterns = [
        r"可(以)?进入.{0,10}(小说)?圣经(生成|阶段)?",
        r"可(以)?生成(小说)?圣经",
        r"下一步.{0,8}生成(小说)?圣经",
        r"建议.{0,8}生成(小说)?圣经",
    ]
    return any(re.search(p, text) for p in patterns)


def _normalize_for_contains(text: str) -> str:
    t = (text or "").strip().lower()
    if not t:
        return ""
    return re.sub(r"[\s，,。；;：:\-\(\)（）【】\[\]/／、!?！？]+", "", t)


def _looks_like_character_name(name: str) -> bool:
    n = (name or "").strip()
    if not n or len(n) < 2 or len(n) > 12:
        return False
    if re.search(r"\d", n):
        return False
    if not re.fullmatch(r"[\u4e00-\u9fa5A-Za-z·]+", n):
        return False
    stop_words = {
        "主线",
        "支线",
        "剧情",
        "案件",
        "角色",
        "人物",
        "这个角色",
        "该角色",
        "校园生活",
        "大学校园",
    }
    if n in stop_words:
        return False
    if re.search(r"(主线|支线|剧情|案件|尽量|不要|之前|以后|之后|出现|出场|登场|校园|生活|中间|穿插|大概|整个)", n):
        return False
    return True


def _extract_incremental_brainstorm_points(message: str, *, limit: int = 6) -> list[str]:
    text = (message or "").strip()
    if not text:
        return []
    points: list[str] = []
    seen: set[str] = set()

    def push(item: str):
        normalized = _normalize_for_contains(item)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        points.append(item)

    # 案件量级（如 30-40 个）
    has_case_range = False
    for m in re.finditer(r"(?:案件|单元).{0,10}?(\d{1,3})\s*[-~～到至]\s*(\d{1,3})\s*(?:个|起|章)?", text, re.I):
        a = int(m.group(1))
        b = int(m.group(2))
        if a > b:
            a, b = b, a
        push(f"案件规模：约{a}-{b}个")
        has_case_range = True
        if len(points) >= limit:
            return points
    if not has_case_range:
        for m in re.finditer(r"(?:案件|单元).{0,8}?(\d{1,3})\s*(?:个|起)", text, re.I):
            push(f"案件规模：约{int(m.group(1))}个")
            if len(points) >= limit:
                return points

    # 校园/日常线偏好
    if re.search(r"(校园生活|校园日常|大学校园|校园线|生活流|日常线)", text, re.I):
        if re.search(r"(穿插|夹杂|中间|并行|兼顾|融合)", text, re.I):
            push("叙事补充：中段穿插校园生活线")
        elif re.search(r"(为主|主打|重点|侧重)", text, re.I):
            push("叙事侧重：校园生活线为主")
        else:
            push("叙事补充：保留校园生活线")
        if len(points) >= limit:
            return points

    # 角色出场窗口（名字 + 章数）
    pattern_after_1 = r"([A-Za-z\u4e00-\u9fa5·]{2,8}?)(?:这个角色|该角色|这个人物|该人物)?\s*(?:在|于)?\s*(\d{1,3})\s*章(?:以?后|之?后|后)\s*(?:才)?(?:出现|出场|登场)"
    pattern_after_2 = r"(\d{1,3})\s*章(?:以?后|之?后|后)\s*([A-Za-z\u4e00-\u9fa5·]{2,8})(?:才)?(?:出现|出场|登场)"
    pattern_before = r"([A-Za-z\u4e00-\u9fa5·]{2,8}?)(?:这个角色|该角色|这个人物|该人物)?\s*(?:在|于)?\s*(\d{1,3})\s*章(?:前|之前)\s*(?:出现|出场|登场)"
    for m in re.finditer(pattern_after_1, text, re.I):
        name = re.sub(r"(这个角色|该角色|这个人物|该人物)$", "", m.group(1).strip())
        chapter = int(m.group(2))
        if _looks_like_character_name(name):
            push(f"角色出场约束：{name}在第{chapter}章后登场")
            if len(points) >= limit:
                return points
    for m in re.finditer(pattern_after_2, text, re.I):
        chapter = int(m.group(1))
        name = m.group(2).strip()
        if _looks_like_character_name(name):
            push(f"角色出场约束：{name}在第{chapter}章后登场")
            if len(points) >= limit:
                return points
    for m in re.finditer(pattern_before, text, re.I):
        name = re.sub(r"(这个角色|该角色|这个人物|该人物)$", "", m.group(1).strip())
        chapter = int(m.group(2))
        if _looks_like_character_name(name):
            push(f"角色出场约束：{name}在第{chapter}章前登场")
            if len(points) >= limit:
                return points

    # 主线推进窗口
    m = re.search(r"(主线|核心主线|主剧情).{0,12}?(?:不(?:要|能)|避免|尽量不).{0,8}?(\d{1,3})\s*章(?:前|之前)", text, re.I)
    if m:
        push(f"主线推进约束：第{int(m.group(2))}章前尽量不展开主线")
    else:
        m_after = re.search(r"(主线|核心主线|主剧情).{0,10}?(\d{1,3})\s*章(?:后|以后|之后).{0,8}?(?:出现|展开|推进|进入)", text, re.I)
        if m_after:
            push(f"主线推进约束：主线在第{int(m_after.group(2))}章后再集中展开")

    return points[:limit]


def _inject_points_into_reply(reply: str, points: list[str], *, max_points: int = 4) -> str:
    text = (reply or "").strip()
    if not points:
        return text

    def already_present(point: str) -> bool:
        if not text:
            return False
        if point.startswith("案件规模："):
            return bool(re.search(r"(案件|单元).{0,8}\d+\s*[-~～到至]\s*\d+", text)) or bool(
                re.search(r"(案件|单元).{0,8}\d+\s*(个|起)", text)
            )
        if point.startswith("主线推进约束："):
            return "主线" in text and bool(re.search(r"\d+\s*章", text))
        if point.startswith("叙事补充：") or point.startswith("叙事侧重："):
            return "校园" in text or "日常" in text
        if point.startswith("角色出场约束："):
            m = re.search(r"角色出场约束：(.+?)在第(\d+)章", point)
            if not m:
                return False
            name = m.group(1).strip()
            chapter = m.group(2).strip()
            return name in text and chapter in text and ("登场" in text or "出场" in text or "出现" in text)
        return False

    existing_norm = _normalize_for_contains(text)
    additions: list[str] = []
    seen: set[str] = set()
    for p in points:
        norm = _normalize_for_contains(p)
        if not norm or norm in seen:
            continue
        seen.add(norm)
        if norm in existing_norm:
            continue
        if already_present(p):
            continue
        additions.append(p)
        if len(additions) >= max_points:
            break
    if not additions:
        return text

    bullet_block = "\n".join(f"- {item}" for item in additions)
    header = "【本轮确认】"
    if header not in text:
        if text:
            return f"{text}\n{header}\n{bullet_block}"
        return f"{header}\n{bullet_block}"

    head_idx = text.find(header)
    rest = text[head_idx + len(header):]
    next_section = re.search(r"\n【[^】]+】", rest)
    if next_section:
        body = rest[: next_section.start()]
        tail = rest[next_section.start():]
    else:
        body = rest
        tail = ""

    body = body.rstrip()
    if body:
        body = f"{body}\n{bullet_block}"
    else:
        body = f"\n{bullet_block}"
    return f"{text[:head_idx]}{header}{body}{tail}".strip()


def _needs_followup_option_question(message: str) -> bool:
    text = (message or "").strip()
    if not text:
        return False
    if re.search(r"(给我|请给|帮我|列出|提供).{0,8}(选项|方案|方向|比较|推荐)", text, re.I):
        return True
    if re.search(r"(怎么选|选哪个|哪个好|哪种更好|要不要|还是)", text, re.I):
        return True
    if re.search(r"[？?]", text) and re.search(r"(主线|支线|案件|角色|出场|章|结局|冲突|节奏|方案|方向|设定)", text, re.I):
        return True
    return False


def _build_followup_option_question(message: str) -> BrainstormQuestion:
    text = (message or "").strip()
    opts: list[BrainstormQuestionOption] = []
    used: set[str] = set()

    def add(label: str, value: str):
        key = _normalize_for_contains(value)
        if not key or key in used:
            return
        used.add(key)
        opts.append(BrainstormQuestionOption(label=label, value=value))

    if re.search(r"(主线|支线|节奏|推进|40章|30章|20章|章前|章后)", text, re.I):
        add("先细化主线推进节奏", "细化主线推进节奏")
    if re.search(r"(角色|人物|登场|出场|男主|女主)", text, re.I):
        add("先锁角色登场顺序", "锁定角色登场顺序")
    if re.search(r"(校园|日常|生活线|大学)", text, re.I):
        add("先定校园/日常线占比", "确定校园日常线占比")
    if re.search(r"(案件|单元|案子)", text, re.I):
        add("先定单元案件密度", "确定单元案件密度")

    add("给我 3 套推进方案对比", "给我3套推进方案")
    add("先按你推荐方案定稿", "按AI推荐方案定稿")
    add("本轮只记录约束不展开", "本轮仅记录约束")

    return BrainstormQuestion(
        id="q_followup_focus",
        title="这轮你希望我先细化哪一项？",
        qtype="single",
        options=opts[:6],
        required=False,
        max_select=None,
        placeholder="",
    )


def _is_unknown_answer(text: str) -> bool:
    value = (text or "").strip().lower()
    if not value:
        return True
    return any(marker in value for marker in BRAINSTORM_UNKNOWN_MARKERS)


def _slot_from_title(title: str) -> Optional[str]:
    t = (title or "").strip().lower()
    if not t:
        return None
    if any(k in t for k in ("章节规模", "章节节奏", "章节配置", "章（每章", "章(每章")):
        return "chapter_scale"
    has_goal = _title_has_goal(t)
    has_conflict = any(k in t for k in ("主冲突", "核心冲突", "冲突", "矛盾", "阻碍", "对抗"))
    has_structure = any(k in t for k in ("小说结构", "叙事结构", "结构形式", "单元案件", "群像结构", "单元式"))
    if not has_structure and ("主线" in t or "支线" in t or "群像" in t or "单元" in t):
        if any(k in t for k in ("结构", "推进", "并行", "形式", "编排", "节奏")) and not has_conflict:
            has_structure = True

    if any(k in t for k in ("每章字数", "单章字数", "章节字数", "每章节字数", "字/章")):
        return "chapter_words"
    if any(k in t for k in ("章节数", "章数", "预计章节", "预估章节", "多少章", "总章")):
        return "chapter_count"
    if _title_has_protagonist(t) and not _title_has_goal(t):
        return "protagonist"
    if has_goal:
        return "goal"
    if has_conflict:
        return "conflict"
    if has_structure:
        return "structure"
    if any(k in t for k in ("篇幅", "目标字数", "总字数", "字数", "体量", "多长", "多少字", "长篇", "中篇", "短篇")):
        return "length"
    if any(k in t for k in ("结局", "结尾", "he", "be", "开放式", "悲剧", "喜剧")):
        return "ending"
    if any(k in t for k in ("题材", "类型", "风格", "赛道")):
        return "genre"
    return None


def _split_slot_mentions_from_title(title: str) -> set[str]:
    t = (title or "").strip().lower()
    if not t:
        return set()
    mentions: set[str] = set()
    if any(k in t for k in ("章节规模", "章节节奏", "章节配置", "章（每章", "章(每章")):
        mentions.add("chapter_count")
        mentions.add("chapter_words")
    if _title_has_protagonist(t):
        mentions.add("protagonist")
    if _title_has_goal(t):
        mentions.add("goal")
    if any(k in t for k in ("篇幅", "目标字数", "总字数", "字数", "体量", "多长", "多少字", "长篇", "中篇", "短篇")):
        mentions.add("length")
    if any(k in t for k in ("小说结构", "叙事结构", "结构形式", "单元案件", "单元式", "群像结构", "主线+支线", "推进方式")):
        mentions.add("structure")
    if any(k in t for k in ("章节数", "章数", "预计章节", "预估章节", "多少章", "总章")):
        mentions.add("chapter_count")
    if any(k in t for k in ("每章字数", "单章字数", "章节字数", "每章节字数", "字/章")):
        mentions.add("chapter_words")
    return mentions


def _is_merged_split_slot_question(title: str, *, missing_slots: set[str]) -> bool:
    mentions = _split_slot_mentions_from_title(title)
    if len(mentions) < 2:
        return False
    return bool(mentions & missing_slots)


def _collect_confirmed_core_slots(history: list[ChatMessage], current_message: str) -> dict[str, bool]:
    confirmed = {k: False for k in BRAINSTORM_CORE_SLOT_LABELS.keys()}
    user_texts: list[str] = []
    structured_roles: dict[str, set[str]] = {}
    for h in history:
        text = (h.content or "").strip()
        if not text:
            continue
        # 核心槽位确认只认用户输入/选择；助手复述不计入确认，避免误判。
        role_key = "user" if h.role == "user" else "assistant"
        if text not in structured_roles:
            structured_roles[text] = set()
        structured_roles[text].add(role_key)
        if h.role == "user":
            user_texts.append(text)
    if (current_message or "").strip():
        current = current_message.strip()
        user_texts.append(current)
        if current not in structured_roles:
            structured_roles[current] = set()
        structured_roles[current].add("user")

    for text, roles in structured_roles.items():
        from_user_structured = "user" in roles
        if not from_user_structured:
            continue
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        for line in lines:
            m = re.match(r"^-+\s*(.+?)\s*[:：]\s*(.+)\s*$", line)
            if not m:
                continue
            title = m.group(1).strip()
            value = m.group(2).strip()
            slot = _slot_from_title(title)
            has_count_and_words = bool(
                re.search(r"\d+\s*章", value, re.I)
                and (
                    re.search(r"(每章|单章|每章节).{0,6}\d{3,5}\s*字", value, re.I)
                    or re.search(r"\d{3,5}\s*字/章", value, re.I)
                    or re.search(r"每章约?\s*\d{3,5}\s*字", value, re.I)
                )
            )
            if (
                has_count_and_words
                and (
                    slot in {"chapter_count", "chapter_words", "chapter_scale"}
                    or any(k in title for k in ("章节规模", "章节节奏", "章节配置"))
                )
                and not _is_unknown_answer(value)
            ):
                confirmed["chapter_count"] = True
                confirmed["chapter_words"] = True
                continue
            if not slot or slot not in confirmed or _is_unknown_answer(value):
                continue
            if slot == "ending" and re.fullmatch(r"[A-Ea-e]", value):
                continue
            confirmed[slot] = True

    unique_user_texts: list[str] = []
    seen: set[str] = set()
    for text in user_texts:
        if text in seen:
            continue
        seen.add(text)
        unique_user_texts.append(text)

    # 启发式只看“用户输入”，避免助手提示语误触发。
    for text in unique_user_texts:
        t = text.lower()
        if not confirmed["genre"] and (
            (
                any(k in t for k in ("题材", "类型", "风格", "赛道"))
                or any(k in t for k in BRAINSTORM_GENRE_HINT_KEYWORDS)
            )
            and not _is_unknown_answer(text)
        ):
            confirmed["genre"] = True
        if not confirmed["protagonist"] and re.search(r"(主角|主人公|男主|女主).{0,10}(是|叫|身份|职业|设定)", text, re.I):
            confirmed["protagonist"] = True
        if not confirmed["protagonist"] and re.search(r"(单女主|单男主|双主角|群像)", text, re.I):
            confirmed["protagonist"] = True
        if not confirmed["goal"] and re.search(r"主角.{0,10}(目标|想要|必须|任务|诉求)", text, re.I):
            confirmed["goal"] = True
        if not confirmed["conflict"] and re.search(r"(主冲突|核心冲突|冲突|矛盾|阻碍|对抗)", text, re.I):
            confirmed["conflict"] = True
        if not confirmed["length"] and re.search(r"(\d+\s*(万字|字)|目标字数|总字数|篇幅|字数|体量|长篇|中篇|短篇)", text, re.I):
            confirmed["length"] = True
        if not confirmed["structure"] and re.search(r"(单元案件|单元|主线|支线|并行|群像|网状|叙事结构|小说结构)", text, re.I):
            if not _is_unknown_answer(text):
                confirmed["structure"] = True
        if not confirmed["chapter_count"] and re.search(r"((预计|预估|大约|约|总共|共)\s*\d+\s*章)|(\d+\s*章\s*(左右|以内|以上)?)", text, re.I):
            if not _is_unknown_answer(text):
                confirmed["chapter_count"] = True
        if not confirmed["chapter_words"] and re.search(r"(每章|单章|每章节).{0,6}(\d{3,5})\s*字|(\d{3,5}\s*字/章)", text, re.I):
            if not _is_unknown_answer(text):
                confirmed["chapter_words"] = True
        if not confirmed["ending"] and re.search(r"(结局|结尾).{0,12}(he|be|开放|悲|喜|圆满|双线|混合|倾向)", text, re.I):
            if not _is_unknown_answer(text):
                confirmed["ending"] = True

    return confirmed


def _missing_core_slots(confirmed: dict[str, bool]) -> list[str]:
    return [slot for slot in BRAINSTORM_CORE_SLOT_ORDER if not confirmed.get(slot, False)]


def _missing_core_slots_for_questions(confirmed: dict[str, bool]) -> list[str]:
    missing = _missing_core_slots(confirmed)
    if not confirmed.get("length", False):
        missing = [slot for slot in missing if slot not in {"chapter_count", "chapter_words"}]
    return missing


def _stable_rotate_texts(items: list[str], seed_text: str) -> list[str]:
    values = [str(x or "").strip() for x in items if str(x or "").strip()]
    if len(values) <= 1:
        return values
    seed_base = str(seed_text or "").strip()
    if not seed_base:
        return values
    seed = 0
    for idx, ch in enumerate(seed_base[:96]):
        seed += (idx + 1) * ord(ch)
    offset = seed % len(values)
    if offset <= 0:
        return values
    return values[offset:] + values[:offset]


def _pick_goal_themes(genre_hint: str, description_hint: str) -> list[str]:
    text = f"{genre_hint} {description_hint}".strip().lower()
    if not text:
        return ["generic"]
    scores: dict[str, int] = {}
    for theme, keywords in GOAL_THEME_KEYWORDS.items():
        score = 0
        for kw in keywords:
            if kw and kw.lower() in text:
                score += 1
        if score > 0:
            scores[theme] = score
    if not scores:
        return ["generic"]
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    picked = [ordered[0][0]]
    if len(ordered) > 1 and ordered[1][1] >= max(1, ordered[0][1] - 1):
        picked.append(ordered[1][0])
    if "generic" not in picked:
        picked.append("generic")
    return picked


def _build_goal_slot_options(genre_hint: str, description_hint: str, *, limit: int = 8) -> list[BrainstormQuestionOption]:
    themes = _pick_goal_themes(genre_hint, description_hint)
    base_seed = f"{genre_hint}|{description_hint}"
    rows: list[str] = []
    for theme in themes:
        source = GOAL_SLOT_OPTION_VARIANTS.get(theme, [])
        rows.extend(_stable_rotate_texts(source, f"{base_seed}:{theme}"))
    rows.extend(_stable_rotate_texts(GOAL_SLOT_OPTION_VARIANTS.get("generic", []), f"{base_seed}:generic-extra"))

    deduped: list[BrainstormQuestionOption] = []
    seen: set[str] = set()
    for row in rows:
        label = _clip(str(row or "").strip(), 24)
        if len(label) < 6:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(BrainstormQuestionOption(label=label, value=label))
        if len(deduped) >= max(2, min(12, limit)):
            break
    return deduped


def _build_slot_options(slot: str, *, genre_hint: str = "", description_hint: str = "") -> list[BrainstormQuestionOption]:
    if slot == "goal":
        goal_options = _build_goal_slot_options(genre_hint, description_hint, limit=8)
        if len(goal_options) >= 2:
            return goal_options
    rows = CORE_SLOT_OPTION_TEMPLATES.get(slot, [])
    return [BrainstormQuestionOption(label=label, value=value) for label, value in rows]


def _build_chapter_scale_options(word_target: int, *, limit: int = 5) -> list[BrainstormQuestionOption]:
    target = max(10000, int(word_target or 100000))
    # 按“总字数 + 每章字数档位”反推章节数，不对章节数设置上限。
    preferred_chapter_words = [3000, 3300, 3600, 4000, 4500]

    options: list[BrainstormQuestionOption] = []
    seen: set[tuple[int, int]] = set()
    for preferred_words in preferred_chapter_words:
        count = max(1, int(round(target / float(preferred_words))))
        chapter_words = int(round(target / count / 100.0) * 100)
        chapter_words = max(1500, chapter_words)
        dedupe_key = (count, chapter_words)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        label = f"约{count}章（每章约{chapter_words}字）"
        options.append(BrainstormQuestionOption(label=label, value=label))
        if len(options) >= limit:
            break

    # 兜底：极端情况下仍给出至少一项
    if not options:
        count, chapter_words = _estimate_chapter_scale_baseline(target)
        label = f"约{count}章（每章约{chapter_words}字）"
        options.append(BrainstormQuestionOption(label=label, value=label))

    # 尝试补齐到 limit，围绕基准每章字数展开
    if len(options) < limit:
        base_count, _base_words = _estimate_chapter_scale_baseline(target)
        candidate_counts = [max(1, base_count - 12), max(1, base_count - 6), base_count + 6, base_count + 12]
        for count in candidate_counts:
            chapter_words = int(round(target / count / 100.0) * 100)
            chapter_words = max(1500, chapter_words)
            dedupe_key = (count, chapter_words)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            label = f"约{count}章（每章约{chapter_words}字）"
            options.append(BrainstormQuestionOption(label=label, value=label))
            if len(options) >= limit:
                break

    return options[:limit]


def _build_chapter_scale_question(word_target: int) -> BrainstormQuestion:
    return BrainstormQuestion(
        id="q_chapter_scale",
        title="章节规模更接近哪种节奏？（按总字数自动换算）",
        qtype="single",
        options=_build_chapter_scale_options(word_target),
        required=True,
    )


def _prefer_select_question(
    question: BrainstormQuestion,
    *,
    genre_hint: str = "",
    description_hint: str = "",
) -> BrainstormQuestion:
    slot = _slot_from_title(question.title)
    if not slot:
        return question
    slot_options = _build_slot_options(
        slot,
        genre_hint=genre_hint,
        description_hint=description_hint,
    )
    if len(slot_options) < 2:
        return question

    if slot == "goal":
        ai_goal_options = question.options if question.qtype in {"single", "multi"} else []
        mixed_goal_options = _blend_goal_options_half_ai(ai_goal_options, slot_options, limit=8)
        if len(mixed_goal_options) >= 2:
            return BrainstormQuestion(
                id=question.id,
                title=question.title,
                qtype="single",
                options=mixed_goal_options,
                required=question.required,
                max_select=None,
                placeholder="",
            )

    if slot == "protagonist":
        base_options = question.options if len(question.options) >= 2 else slot_options
        if len(base_options) < 2:
            return question
        max_select = question.max_select if isinstance(question.max_select, int) else None
        if max_select is None or max_select < 2:
            max_select = 2
        return BrainstormQuestion(
            id=question.id,
            title=question.title,
            qtype="multi",
            options=base_options,
            required=question.required,
            max_select=max_select,
            placeholder="",
        )

    if question.qtype in {"single", "multi"} and len(question.options) >= 2:
        return question

    return BrainstormQuestion(
        id=question.id,
        title=question.title,
        qtype="single",
        options=slot_options,
        required=question.required,
        max_select=None,
        placeholder="",
    )


def _dedupe_questions(questions: list[BrainstormQuestion], max_questions: int) -> list[BrainstormQuestion]:
    deduped: list[BrainstormQuestion] = []
    seen_slots: set[str] = set()
    seen_titles: set[str] = set()
    for q in questions:
        slot = _slot_from_title(q.title)
        normalized_title = re.sub(r"\s+", "", (q.title or "").lower())
        if slot:
            if slot in seen_slots:
                continue
            seen_slots.add(slot)
        elif normalized_title:
            if normalized_title in seen_titles:
                continue
            seen_titles.add(normalized_title)
        deduped.append(q)
        if len(deduped) >= max_questions:
            break
    return deduped


def _fill_questions_with_missing_slots(
    questions: list[BrainstormQuestion],
    missing_slots: list[str],
    max_questions: int,
    *,
    word_target: int,
    genre_hint: str = "",
    description_hint: str = "",
) -> list[BrainstormQuestion]:
    filled = list(questions)
    covered_slots = {
        slot for slot in (_slot_from_title(q.title) for q in filled) if slot
    }
    chapter_scale_added = any(
        any(token in (q.title or "") for token in ("章节规模", "每章", "章（每章", "章(每章"))
        for q in filled
    )
    for slot in missing_slots:
        if len(filled) >= max_questions:
            break
        if slot in {"chapter_count", "chapter_words"}:
            if chapter_scale_added:
                covered_slots.add("chapter_count")
                covered_slots.add("chapter_words")
                continue
            if "chapter_count" in covered_slots and "chapter_words" in covered_slots:
                chapter_scale_added = True
                continue
            filled.append(_build_chapter_scale_question(word_target))
            covered_slots.add("chapter_count")
            covered_slots.add("chapter_words")
            chapter_scale_added = True
            continue
        if slot in covered_slots:
            continue
        filled.append(
            _build_fallback_question(
                slot,
                genre_hint=genre_hint,
                description_hint=description_hint,
            )
        )
        covered_slots.add(slot)
    return filled


def _enforce_missing_core_slot_questions(
    questions: list[BrainstormQuestion],
    confirmed_slots: dict[str, bool],
    *,
    max_questions: int,
    word_target: int,
    genre_hint: str = "",
    description_hint: str = "",
) -> list[BrainstormQuestion]:
    missing_slots = _missing_core_slots_for_questions(confirmed_slots)
    if not missing_slots:
        return []

    missing_set = set(missing_slots)
    needs_chapter_scale = bool(missing_set & {"chapter_count", "chapter_words"})
    normalized: list[BrainstormQuestion] = []
    for q in questions:
        slot = _slot_from_title(q.title)
        if not slot or slot not in missing_set:
            continue
        if needs_chapter_scale and slot in {"chapter_count", "chapter_words"}:
            continue
        if slot in SPLIT_REQUIRED_CORE_SLOTS and _is_merged_split_slot_question(q.title, missing_slots=missing_set):
            continue
        normalized.append(q)

    normalized = _dedupe_questions(normalized, max_questions=max_questions)
    normalized = _fill_questions_with_missing_slots(
        normalized,
        missing_slots,
        max_questions=max_questions,
        word_target=word_target,
        genre_hint=genre_hint,
        description_hint=description_hint,
    )
    return normalized


def _filter_questions_by_confirmed_slots(
    questions: list[BrainstormQuestion],
    confirmed: dict[str, bool],
    max_questions: int,
) -> list[BrainstormQuestion]:
    filtered: list[BrainstormQuestion] = []
    for q in questions:
        slot = _slot_from_title(q.title)
        if slot and confirmed.get(slot, False):
            continue
        filtered.append(q)
        if len(filtered) >= max_questions:
            break
    return filtered


def _optionalize_followup_questions(
    questions: list[BrainstormQuestion],
    *,
    max_questions: int = 2,
) -> list[BrainstormQuestion]:
    optionalized: list[BrainstormQuestion] = []
    for q in questions:
        # 核心项已齐后，follow-up 仅作为增强，不再追问核心槽位。
        if _slot_from_title(q.title):
            continue
        optionalized.append(
            BrainstormQuestion(
                id=q.id,
                title=q.title,
                qtype=q.qtype,
                options=q.options,
                required=False,
                max_select=q.max_select,
                placeholder=q.placeholder,
            )
        )
        if len(optionalized) >= max_questions:
            break
    return optionalized


def _blocking_brainstorm_questions(questions: list[BrainstormQuestion]) -> list[BrainstormQuestion]:
    return [q for q in (questions or []) if q.required is not False]


def _append_brainstorm_state_hint(reply: str, *, ready_for_bible: bool, questions: list[BrainstormQuestion]) -> str:
    text = (reply or "").strip()
    blocking = _blocking_brainstorm_questions(questions)
    if blocking:
        lines = [f"- {q.title}" for q in blocking[:3] if (q.title or "").strip()]
        if not lines:
            return text
        hint = "【系统校验】仍需确认：\n" + "\n".join(lines)
        if hint in text:
            return text
        return f"{text}\n{hint}".strip() if text else hint

    if ready_for_bible:
        hint = "【系统校验】核心项已齐，可进入圣经生成。"
        if hint in text:
            return text
        return f"{text}\n{hint}".strip() if text else hint
    return text


def _normalize_brainstorm_mode(mode: Any) -> BrainstormMode:
    value = str(mode or "").strip().lower()
    if value in {"deep", "standard", "fast"}:
        return value  # type: ignore[return-value]
    return "fast"


def _brainstorm_mode_config(mode: BrainstormMode) -> dict[str, Any]:
    if mode == "deep":
        return {
            "label": "深度",
            "max_questions": 3,
            "ask_scope": "可覆盖 P0 核心项 + P2 禁改项 + 关键写作规格；但仍禁止重复追问已确认项。",
            "extra_rule": "若用户回答“交给AI决定”，仅对非硬锁字段采用默认方案；硬锁字段仍需一次确认。",
        }
    if mode == "standard":
        return {
            "label": "标准",
            "max_questions": 3,
            "ask_scope": "优先 P0 核心项，其次少量 P2 禁改项；避免展开到过细执行层。",
            "extra_rule": "优先让用户做方向选择，不要求用户写细节段落。",
        }
    return {
        "label": "极速",
        "max_questions": 3,
        "ask_scope": "仅可追问 P0 核心项（题材/主角定位/主角目标/主冲突/篇幅/小说结构/章节规模〔预估章节数+每章字数〕/结局倾向），禁止细枝末节深挖。",
        "extra_rule": "用户可回答“交给AI决定”，视为该项已确认为 AI 默认方案。",
    }


def _build_fallback_question(
    slot: str,
    *,
    genre_hint: str = "",
    description_hint: str = "",
) -> BrainstormQuestion:
    if slot == "genre":
        return BrainstormQuestion(
            id="q_genre",
            title="先锁定题材方向（可选主副轴）",
            qtype="single",
            options=_build_slot_options(
                "genre",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    if slot == "protagonist":
        return BrainstormQuestion(
            id="q_protagonist",
            title="主角定位先选哪种？（可多选，最多2项）",
            qtype="multi",
            options=_build_slot_options(
                "protagonist",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
            max_select=2,
        )
    if slot == "goal":
        return BrainstormQuestion(
            id="q_goal",
            title="主角当前最核心目标是？",
            qtype="single",
            options=_build_slot_options(
                "goal",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    if slot == "conflict":
        return BrainstormQuestion(
            id="q_conflict",
            title="主线冲突主要来自哪一类？",
            qtype="single",
            options=_build_slot_options(
                "conflict",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    if slot == "length":
        return BrainstormQuestion(
            id="q_length",
            title="篇幅目标更接近哪档？",
            qtype="single",
            options=_build_slot_options(
                "length",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    if slot == "structure":
        return BrainstormQuestion(
            id="q_structure",
            title="小说结构更偏向哪种推进方式？",
            qtype="single",
            options=_build_slot_options(
                "structure",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    if slot in {"chapter_count", "chapter_words"}:
        return _build_chapter_scale_question(100000)
    if slot == "ending":
        return BrainstormQuestion(
            id="q_ending",
            title="结局倾向希望哪种？",
            qtype="single",
            options=_build_slot_options(
                "ending",
                genre_hint=genre_hint,
                description_hint=description_hint,
            ),
            required=True,
        )
    return BrainstormQuestion(
        id="q_generic",
        title="请补充一个你最在意的核心设定。",
        qtype="text",
        required=True,
    )


def _merge_and_dedupe_options(
    primary: list[BrainstormQuestionOption],
    secondary: list[BrainstormQuestionOption],
    limit: int = 8,
) -> list[BrainstormQuestionOption]:
    result: list[BrainstormQuestionOption] = []
    seen: set[str] = set()
    for source in (primary, secondary):
        for opt in source:
            key = (opt.value or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            result.append(opt)
            if len(result) >= limit:
                return result
    return result


def _blend_goal_options_half_ai(
    ai_options: list[BrainstormQuestionOption],
    template_options: list[BrainstormQuestionOption],
    *,
    limit: int = 8,
) -> list[BrainstormQuestionOption]:
    max_items = max(2, min(8, int(limit or 8)))
    ai_target = max(1, max_items // 2)
    template_target = max(1, max_items - ai_target)

    ai_clean = _filter_refresh_options(
        ai_options,
        slot="goal",
        existing_values=set(),
        limit=max_items * 2,
    )
    template_clean = _filter_refresh_options(
        template_options,
        slot="goal",
        existing_values=set(),
        limit=max_items * 2,
    )
    ai_clean = [
        opt for opt in ai_clean
        if not _is_special_other_option(opt.label, opt.value)
        and not _is_special_ai_decide_option(opt.label, opt.value)
    ]
    template_clean = [
        opt for opt in template_clean
        if not _is_special_other_option(opt.label, opt.value)
        and not _is_special_ai_decide_option(opt.label, opt.value)
    ]

    mixed: list[BrainstormQuestionOption] = []
    seen: set[str] = set()

    def _take(source: list[BrainstormQuestionOption], count: int):
        picked = 0
        for opt in source:
            key = (opt.value or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            mixed.append(opt)
            picked += 1
            if picked >= count or len(mixed) >= max_items:
                break

    # 先保证“AI + 模板”各占一半（能力不足时自动降级补齐）。
    _take(ai_clean, ai_target)
    _take(template_clean, template_target)
    if len(mixed) < max_items:
        _take(ai_clean, max_items)
    if len(mixed) < max_items:
        _take(template_clean, max_items)

    if len(mixed) >= 2:
        return mixed[:max_items]

    fallback = _merge_and_dedupe_options(ai_clean or ai_options, template_clean or template_options, limit=max_items)
    if len(fallback) >= 2:
        return fallback
    return _merge_and_dedupe_options(template_options, ai_options, limit=max_items)


def _shuffle_options(options: list[BrainstormQuestionOption]) -> list[BrainstormQuestionOption]:
    copied = list(options)
    random.shuffle(copied)
    return copied


def _resolve_pipeline_runtime(
    project_id: str,
    project,
    stage: str,
    default_temperature: float,
    default_system_prompt: str,
    default_max_tokens: int,
    llm=None,
) -> tuple[str, float, str, int]:
    agent_type = PIPELINE_AGENT_TYPES.get(stage, "")
    cfg_model = ""
    cfg_temp = None
    cfg_prompt = ""
    cfg_max_tokens = None
    if agent_type:
        with get_db() as db:
            row = db.execute(
                "SELECT model, temperature, system_prompt, max_tokens FROM agent_configs WHERE project_id = ? AND agent_type = ?",
                (project_id, agent_type),
            ).fetchone()
            if row:
                cfg_model = str((row["model"] or "")).strip()
                cfg_temp = row["temperature"]
                cfg_prompt = str((row["system_prompt"] or "")).strip()
                cfg_max_tokens = row["max_tokens"]

    project_model = str(project["model_main"] or DEFAULT_MODEL).strip()
    model_name = cfg_model or project_model or DEFAULT_MODEL

    logger.info(
        "[ModelResolve] stage=%s cfg_model=%r project_model=%r → model_name=%r",
        stage, cfg_model, project_model, model_name,
    )

    # 容错：若阶段模型不可用（例如未配置该provider key），自动回退到项目主模型或可用模型
    if llm is not None:
        provider_keys = getattr(llm, "_provider_keys", {}) or {}
        custom_relays = getattr(llm, "_custom_relays", []) or []

        def _has_provider(provider: str) -> bool:
            cfg = provider_keys.get(provider, {}) if isinstance(provider_keys, dict) else {}
            return bool(str((cfg or {}).get("api_key", "")).strip())

        def _model_provider(m: str) -> str:
            mm = (m or "").strip()
            if mm.startswith("deepseek-"):
                return "deepseek"
            if mm.startswith("qwen-"):
                return "qwen"
            if mm.startswith("glm-"):
                return "zhipu"
            if mm.startswith("moonshot-"):
                return "moonshot"
            if mm.startswith("gemini-"):
                return "google"
            if mm.startswith("claude-"):
                return "anthropic"
            if mm.startswith("gpt-") or mm.startswith("o1"):
                return "openai"
            return ""

        def _is_model_available(m: str) -> bool:
            provider = _model_provider(m)
            if provider:
                return _has_provider(provider) or bool(custom_relays)
            return bool(custom_relays)

        def _pick_first_available_model() -> str:
            # 优先国产模型，再回退到通用模型
            candidates = [
                ("deepseek", "deepseek-chat"),
                ("qwen", "qwen-plus"),
                ("zhipu", "glm-4-flash"),
                ("moonshot", "moonshot-v1-8k"),
                ("openai", "gpt-4o-mini"),
                ("anthropic", "claude-haiku-3"),
                ("google", "gemini-2.0-flash"),
            ]
            for provider, candidate in candidates:
                if _has_provider(provider):
                    return candidate
            if custom_relays:
                return "gpt-4o-mini"
            return DEFAULT_MODEL

        if not _is_model_available(model_name):
            original = model_name
            if project_model and _is_model_available(project_model):
                model_name = project_model
            else:
                model_name = _pick_first_available_model()
            logger.warning(
                "[ModelResolve] stage=%s model %r unavailable, fallback → %r "
                "(providers=%s, relays=%d)",
                stage, original, model_name,
                list(provider_keys.keys()), len(custom_relays),
            )
    temperature = float(default_temperature)
    if cfg_temp is not None:
        try:
            parsed = float(cfg_temp)
            if parsed >= 0:
                temperature = parsed
        except Exception:
            pass
    max_tokens = int(default_max_tokens) if int(default_max_tokens) > 0 else 4096
    if cfg_max_tokens is not None:
        try:
            parsed_tokens = int(float(cfg_max_tokens))
            if parsed_tokens > 0:
                max_tokens = parsed_tokens
        except Exception:
            pass
    # 统一做安全裁剪，避免异常值导致请求失败或成本失控。
    max_tokens = max(256, min(12000, max_tokens))
    system_prompt = cfg_prompt or default_system_prompt
    return model_name, temperature, system_prompt, max_tokens


def _load_latest_bible(project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT version, content, created_at FROM story_bibles "
            "WHERE project_id = ? ORDER BY version DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        return dict(row) if row else None


def _save_story_bible(project_id: str, content: str, source_brief: str = "") -> dict:
    with get_db() as db:
        v = db.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM story_bibles WHERE project_id = ?",
            (project_id,),
        ).fetchone()["v"]
        next_version = int(v) + 1
        db.execute(
            "INSERT INTO story_bibles (project_id, version, content, source_brief) VALUES (?, ?, ?, ?)",
            (project_id, next_version, content, _clip(source_brief, 3000)),
        )
        row = db.execute(
            "SELECT version, content, created_at FROM story_bibles "
            "WHERE project_id = ? AND version = ?",
            (project_id, next_version),
        ).fetchone()
        return dict(row)


def _load_bible_by_version(project_id: str, version: int):
    with get_db() as db:
        row = db.execute(
            "SELECT version, content, created_at FROM story_bibles "
            "WHERE project_id = ? AND version = ? LIMIT 1",
            (project_id, int(version)),
        ).fetchone()
    return dict(row) if row else None


_BIBLE_SECTION_HEADING_RE = re.compile(
    r"(?m)^\s*(?:#{1,6}\s*)?(\d+(?:\.\d+)*)(?:[\.、])?\s*([^\n]*)$"
)


def _section_sort_key(section_id: str) -> tuple[int, ...]:
    parts = []
    for raw in str(section_id or "").split("."):
        try:
            parts.append(int(raw))
        except Exception:
            parts.append(10_000)
    return tuple(parts) if parts else (10_000,)


def _normalize_section_ids(raw: Any) -> list[str]:
    tokens: list[str] = []
    if isinstance(raw, str):
        tokens.extend(re.split(r"[,\n;，；\s]+", raw))
    elif isinstance(raw, list):
        for item in raw:
            tokens.extend(re.split(r"[,\n;，；\s]+", str(item or "")))

    normalized: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        value = str(token or "").strip().strip(".")
        if not value:
            continue
        if not re.fullmatch(r"\d+(?:\.\d+)*", value):
            continue
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return sorted(normalized, key=_section_sort_key)


def _split_numbered_sections(content: str) -> tuple[str, list[tuple[str, str]]]:
    text = str(content or "").replace("\r\n", "\n")
    matches = list(_BIBLE_SECTION_HEADING_RE.finditer(text))
    if not matches:
        return text.strip(), []

    valid_matches: list[tuple[str, int]] = []
    seen: set[str] = set()
    for match in matches:
        section_id = str(match.group(1) or "").strip()
        title = str(match.group(2) or "").strip()
        raw_line = str(match.group(0) or "").lstrip()
        has_hash_heading = raw_line.startswith("#")
        if not section_id or section_id in seen:
            continue
        # 避免把正文中的“1. xxx / 2. xxx”列表项误识别为章节标题
        if not has_hash_heading:
            if title.startswith(("**", "*", "-", "+", "`", ">")):
                continue
            if len(title) > 60:
                continue
            if any(ch in title for ch in ("：", ":", "。", "；", ";")):
                continue
        seen.add(section_id)
        valid_matches.append((section_id, match.start()))

    if not valid_matches:
        return text.strip(), []

    prefix = text[: valid_matches[0][1]].strip()
    sections: list[tuple[str, str]] = []
    for idx, (section_id, start) in enumerate(valid_matches):
        end = valid_matches[idx + 1][1] if idx + 1 < len(valid_matches) else len(text)
        block = text[start:end].strip()
        if not block:
            continue
        sections.append((section_id, block))
    return prefix, sections


def _compose_numbered_sections(prefix: str, blocks: list[str]) -> str:
    parts: list[str] = []
    p = str(prefix or "").strip()
    if p:
        parts.append(p)
    for block in blocks:
        b = str(block or "").strip()
        if b:
            parts.append(b)
    return "\n\n".join(parts).strip()


_BOOTSTRAP_BIBLE_CORE_SECTION_IDS = (
    "1",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "2",
    "2.1",
    "2.2",
    "2.3",
    "2.4",
    "3",
    "3.1",
    "3.2",
)
_BOOTSTRAP_EXEC_SECTION_BY_SCOPE: dict[str, tuple[str, ...]] = {
    "characters": ("4.1",),
    "worldbuilding": ("4.2",),
    "outline": ("4.3",),
    "chapters": ("4.4",),
}


def _build_bootstrap_bible_context(content: str, *, scopes: set[str], limit: int = 12000) -> str:
    text = str(content or "").strip()
    if not text:
        return ""

    prefix, sections = _split_numbered_sections(text)
    if not sections:
        return _clip(text, limit)

    section_map = {section_id: block for section_id, block in sections}
    selected_ids: list[str] = []
    seen: set[str] = set()

    def _pick(section_id: str):
        if section_id in seen:
            return
        block = section_map.get(section_id)
        if not block:
            return
        seen.add(section_id)
        selected_ids.append(section_id)

    for sid in _BOOTSTRAP_BIBLE_CORE_SECTION_IDS:
        _pick(sid)

    for scope in ("characters", "worldbuilding", "outline", "chapters"):
        if scope not in scopes:
            continue
        for sid in _BOOTSTRAP_EXEC_SECTION_BY_SCOPE.get(scope, ()):
            _pick(sid)

    # 章节规划需要综合角色/世界观/大纲执行指令，避免仅凭 4.4 失真。
    if "chapters" in scopes:
        for sid in sorted(
            [section_id for section_id in section_map.keys() if section_id.startswith("4.")],
            key=_section_sort_key,
        ):
            _pick(sid)
        _pick("4")

    if not any(sid.startswith("4.") for sid in selected_ids):
        for sid in sorted(
            [section_id for section_id in section_map.keys() if section_id.startswith("4.")],
            key=_section_sort_key,
        ):
            _pick(sid)
        _pick("4")

    if not selected_ids:
        return _clip(text, limit)

    ordered_ids = sorted(selected_ids, key=_section_sort_key)
    blocks = [section_map[sid] for sid in ordered_ids if sid in section_map]
    selected_text = _compose_numbered_sections(prefix, blocks)
    return _clip(selected_text, limit)


def _extract_bible_section(content: str, section_id: str) -> str:
    text = str(content or "").strip()
    sid = str(section_id or "").strip()
    if not text or not sid:
        return ""
    _prefix, sections = _split_numbered_sections(text)
    if not sections:
        return ""
    matched: list[tuple[str, str]] = []
    for current_id, block in sections:
        if current_id == sid or current_id.startswith(f"{sid}."):
            matched.append((current_id, block))
    if not matched:
        return ""
    ordered = [block for _id, block in sorted(matched, key=lambda x: _section_sort_key(x[0]))]
    return _clip(_compose_numbered_sections("", ordered), 2400)


def _apply_volume_context_to_chapter_template(
    template: str,
    *,
    start_chapter: int,
    end_chapter: int,
    volume_index: Optional[int] = None,
    volume_title: str = "",
    volume_start_chapter: Optional[int] = None,
    volume_end_chapter: Optional[int] = None,
) -> str:
    text = str(template or "").strip()
    if not text:
        return ""

    effective_start = int(volume_start_chapter) if volume_start_chapter else int(start_chapter)
    effective_end = int(volume_end_chapter) if volume_end_chapter else int(end_chapter)
    if effective_end < effective_start:
        effective_end = effective_start
    range_label = f"第{effective_start}-{effective_end}章"

    resolved_volume = str(volume_title or "").strip()
    if not resolved_volume and volume_index is not None:
        try:
            idx = int(volume_index)
            if idx > 0:
                resolved_volume = f"第{idx}卷"
        except Exception:
            resolved_volume = ""
    if not resolved_volume:
        resolved_volume = f"{range_label}区间"

    combined_pattern = re.compile(
        r"第\s*[一二三四五六七八九十百两0-9]+\s*(?:卷|部)\s*[（(]\s*第\s*\d+\s*[-~～到至]\s*\d+\s*章\s*[)）]"
    )
    text = combined_pattern.sub(f"{resolved_volume}（{range_label}）", text)

    sample_tokens = ("第一卷", "第1卷", "卷一", "第一部", "第1部")
    for token in sample_tokens:
        text = text.replace(token, resolved_volume)

    text = re.sub(r"第\s*[一二三四五六七八九十百两0-9]+\s*(卷|部)", resolved_volume, text, count=2)
    text = re.sub(r"第\s*\d+\s*[-~～到至]\s*\d+\s*章", range_label, text, count=2)
    return _clip(text, 2400)


def _resolve_volume_label_and_range(
    *,
    start_chapter: int,
    end_chapter: int,
    volume_index: Optional[int] = None,
    volume_title: str = "",
    volume_start_chapter: Optional[int] = None,
    volume_end_chapter: Optional[int] = None,
) -> tuple[str, str]:
    effective_start = int(volume_start_chapter) if volume_start_chapter else int(start_chapter)
    effective_end = int(volume_end_chapter) if volume_end_chapter else int(end_chapter)
    if effective_end < effective_start:
        effective_end = effective_start
    range_label = f"第{effective_start}-{effective_end}章"
    resolved_volume = str(volume_title or "").strip()
    if not resolved_volume and volume_index is not None:
        try:
            idx = int(volume_index)
            if idx > 0:
                resolved_volume = f"第{idx}卷"
        except Exception:
            resolved_volume = ""
    if not resolved_volume:
        resolved_volume = f"{range_label}区间"
    return resolved_volume, range_label


def _text_has_first_volume_token(text: str) -> bool:
    if not text:
        return False
    normalized = str(text).replace(" ", "")
    tokens = ("第一卷", "第1卷", "卷一", "第一部", "第1部")
    return any(token in normalized for token in tokens)


def _detect_volume_label_mismatch(
    chapters: list[dict],
    *,
    expected_volume_label: str,
    target_volume_index: Optional[int] = None,
) -> bool:
    expected = str(expected_volume_label or "").replace(" ", "")
    requires_check = bool(expected and target_volume_index and int(target_volume_index) > 1)
    if not requires_check:
        return False
    for ch in chapters:
        title = str(ch.get("title") or "")
        synopsis = str(ch.get("synopsis") or "")
        combined = f"{title}\n{synopsis}"
        if _text_has_first_volume_token(combined) and expected not in combined.replace(" ", ""):
            return True
    return False


def _repair_volume_label_mismatch(
    chapters: list[dict],
    *,
    expected_volume_label: str,
    range_label: str,
) -> list[dict]:
    expected = str(expected_volume_label or "").strip()
    if not expected:
        return chapters
    sample_tokens = ("第一卷", "第1卷", "卷一", "第一部", "第1部")
    repaired: list[dict] = []
    for ch in chapters:
        item = dict(ch)
        title = str(item.get("title") or "")
        synopsis = str(item.get("synopsis") or "")
        fixed_title = title
        fixed_synopsis = synopsis
        for token in sample_tokens:
            fixed_title = fixed_title.replace(token, expected)
            fixed_synopsis = fixed_synopsis.replace(token, expected)
        fixed_title = re.sub(r"第\s*[一二三四五六七八九十百两0-9]+\s*(卷|部)", expected, fixed_title)
        fixed_synopsis = re.sub(r"第\s*[一二三四五六七八九十百两0-9]+\s*(卷|部)", expected, fixed_synopsis)
        if range_label:
            fixed_title = re.sub(r"第\s*\d+\s*[-~～到至]\s*\d+\s*章", range_label, fixed_title)
            fixed_synopsis = re.sub(r"第\s*\d+\s*[-~～到至]\s*\d+\s*章", range_label, fixed_synopsis)
        item["title"] = _clip(fixed_title, 80)
        item["synopsis"] = _clip(fixed_synopsis, 240)
        repaired.append(item)
    return repaired


async def _retry_volume_label_mismatch_with_llm(
    *,
    llm,
    model: str,
    chapters: list[dict],
    expected_volume_label: str,
    range_label: str,
) -> list[dict]:
    if not chapters:
        return chapters
    expected = str(expected_volume_label or "").strip()
    if not expected:
        return chapters

    payload = {"chapters": chapters}
    prompt = f"""
你是章节标签修复器。仅修复“卷标签误标”，禁止改写剧情语义。

目标卷标签：{expected}
目标章范围标签：{range_label}

输入 JSON：
{json.dumps(payload, ensure_ascii=False)}

规则：
1) 仅允许替换“第一卷/第1卷/卷一/第一部/第1部/第一册”等错误卷标签为目标卷标签；
2) 若出现错误章范围（如“第1-40章”），仅替换为目标章范围标签；
3) chapter_num、phase 不得修改；
4) 标题与梗概除标签替换外不得改写；
5) 只输出严格 JSON 对象，不要 Markdown，不要解释。
""".strip()
    try:
        raw = await llm.chat(
            model=model,
            messages=[
                {"role": "system", "content": "你是 JSON 修复器，只输出 JSON。"},
                {"role": "user", "content": prompt},
            ],
            temperature=0.0,
            max_tokens=min(3200, 600 + len(chapters) * 160),
        )
    except Exception:
        return chapters

    parsed = _parse_payload(raw)
    items = parsed.get("chapters", []) if isinstance(parsed.get("chapters"), list) else []
    if not items:
        return chapters
    chapter_nums: list[int] = []
    for ch in chapters:
        try:
            num = int(ch.get("chapter_num", 0))
        except Exception:
            num = 0
        if num > 0:
            chapter_nums.append(num)
    if not chapter_nums:
        return chapters
    fixed = _normalize_chapter_items_for_range(
        items,
        start_chapter=min(chapter_nums),
        end_chapter=max(chapter_nums),
        total_chapter_count=max(chapter_nums),
    )
    return fixed or chapters


def _build_chapter_format_anchor_from_bible(
    bible_text: str,
    *,
    start_chapter: int,
    end_chapter: int,
    volume_index: Optional[int] = None,
    volume_title: str = "",
    volume_start_chapter: Optional[int] = None,
    volume_end_chapter: Optional[int] = None,
) -> tuple[str, bool]:
    section_44 = _extract_bible_section(bible_text, "4.4")
    if not section_44:
        fallback = (
            "使用系统默认章节格式：输出 JSON 对象，包含 chapters 数组；"
            "元素字段固定为 chapter_num/title/phase/synopsis。"
        )
        return fallback, True

    adapted = _apply_volume_context_to_chapter_template(
        section_44,
        start_chapter=start_chapter,
        end_chapter=end_chapter,
        volume_index=volume_index,
        volume_title=volume_title,
        volume_start_chapter=volume_start_chapter,
        volume_end_chapter=volume_end_chapter,
    )
    return adapted, False


def _is_section_locked(section_id: str, locked_sections: list[str]) -> bool:
    for locked in locked_sections:
        if section_id == locked or section_id.startswith(f"{locked}."):
            return True
    return False


def _is_section_allowed(section_id: str, allowed_sections: list[str]) -> bool:
    for allowed in allowed_sections:
        if section_id == allowed or section_id.startswith(f"{allowed}."):
            return True
    return False


def _filter_existing_section_ids(raw: Any, base_content: str) -> list[str]:
    candidate_ids = _normalize_section_ids(raw)
    if not candidate_ids:
        return []
    _, base_sections = _split_numbered_sections(base_content)
    if not base_sections:
        return []
    base_ids = [section_id for section_id, _ in base_sections]
    base_set = set(base_ids)
    filtered: list[str] = []
    seen: set[str] = set()
    for section_id in candidate_ids:
        exists = section_id in base_set or any(b.startswith(f"{section_id}.") for b in base_set)
        if not exists or section_id in seen:
            continue
        seen.add(section_id)
        filtered.append(section_id)
    return sorted(filtered, key=_section_sort_key)


def _normalize_for_diff(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())


def _coerce_bible_revision_structure(base_content: str, revised_content: str, locked_sections: list[str]) -> str:
    base_prefix, base_sections = _split_numbered_sections(base_content)
    if not base_sections:
        return str(revised_content or "").strip() or str(base_content or "").strip()

    revised_prefix, revised_sections = _split_numbered_sections(revised_content)
    base_map = {section_id: block for section_id, block in base_sections}
    revised_map = {section_id: block for section_id, block in revised_sections}
    base_ids = [section_id for section_id, _ in base_sections]
    base_id_set = set(base_ids)

    blocks: list[str] = []
    for section_id in base_ids:
        if _is_section_locked(section_id, locked_sections):
            blocks.append(base_map[section_id])
            continue
        blocks.append(revised_map.get(section_id, base_map[section_id]))

    for section_id, block in revised_sections:
        if section_id in base_id_set:
            continue
        if _is_section_locked(section_id, locked_sections):
            continue
        b = str(block or "").strip()
        if b:
            blocks.append(b)

    preferred_prefix = revised_prefix if revised_prefix.strip() else base_prefix
    return _compose_numbered_sections(preferred_prefix, blocks)


def _coerce_bible_revision_structure_limited(
    base_content: str,
    revised_content: str,
    locked_sections: list[str],
    allowed_sections: list[str],
) -> str:
    allowed = _filter_existing_section_ids(allowed_sections, base_content)
    if not allowed:
        return _coerce_bible_revision_structure(base_content, revised_content, locked_sections)

    base_prefix, base_sections = _split_numbered_sections(base_content)
    if not base_sections:
        return _coerce_bible_revision_structure(base_content, revised_content, locked_sections)

    revised_prefix, revised_sections = _split_numbered_sections(revised_content)
    base_map = {section_id: block for section_id, block in base_sections}
    revised_map = {section_id: block for section_id, block in revised_sections}
    base_ids = [section_id for section_id, _ in base_sections]

    blocks: list[str] = []
    for section_id in base_ids:
        if _is_section_locked(section_id, locked_sections):
            blocks.append(base_map[section_id])
            continue
        if _is_section_allowed(section_id, allowed):
            blocks.append(revised_map.get(section_id, base_map[section_id]))
        else:
            blocks.append(base_map[section_id])

    preferred_prefix = revised_prefix if revised_prefix.strip() else base_prefix
    return _compose_numbered_sections(preferred_prefix, blocks)


def _detect_changed_sections(base_content: str, revised_content: str) -> list[str]:
    _, base_sections = _split_numbered_sections(base_content)
    _, revised_sections = _split_numbered_sections(revised_content)
    base_map = {section_id: block for section_id, block in base_sections}
    revised_map = {section_id: block for section_id, block in revised_sections}
    all_ids = sorted(set(base_map.keys()) | set(revised_map.keys()), key=_section_sort_key)
    changed = [
        section_id
        for section_id in all_ids
        if _normalize_for_diff(base_map.get(section_id, "")) != _normalize_for_diff(revised_map.get(section_id, ""))
    ]
    return changed


def _build_revise_summary(changed_sections: list[str]) -> str:
    if not changed_sections:
        return "未检测到有效变更，基线圣经保持不变。"
    preview = "、".join(changed_sections[:8])
    if len(changed_sections) > 8:
        preview += " 等"
    return f"已完成局部改写，变更章节 {len(changed_sections)} 处：{preview}。"


_STORY_BIBLE_REQUIRED_SECTION_PATTERNS: list[tuple[str, str]] = [
    ("1. 四个核心信息（P0）", r"(?m)^\s*(?:#{1,6}\s*)?1(?:[\.、])\s*四个核心信息"),
    ("1.1 已锁定信息（来自上下文）", r"(?m)^\s*(?:#{1,6}\s*)?1\.1\s*已锁定信息"),
    ("1.2 项目信息（题材、目标读者、篇幅）", r"(?m)^\s*(?:#{1,6}\s*)?1\.2\s*项目信息"),
    ("1.3 核心卖点（一句话）", r"(?m)^\s*(?:#{1,6}\s*)?1\.3\s*核心卖点"),
    ("1.4 一句话梗概（Logline）", r"(?m)^\s*(?:#{1,6}\s*)?1\.4\s*一句话梗概"),
    ("2. 禁止改动项（硬约束）", r"(?m)^\s*(?:#{1,6}\s*)?2(?:[\.、])\s*禁止改动项"),
    ("2.1 世界观硬规则", r"(?m)^\s*(?:#{1,6}\s*)?2\.1\s*世界观硬规则"),
    ("2.2 角色关系硬规则", r"(?m)^\s*(?:#{1,6}\s*)?2\.2\s*角色关系硬规则"),
    ("2.3 叙事风格硬规则", r"(?m)^\s*(?:#{1,6}\s*)?2\.3\s*叙事风格硬规则"),
    ("2.4 结局与主线硬规则", r"(?m)^\s*(?:#{1,6}\s*)?2\.4\s*结局与主线硬规则"),
    ("3. 可扩展项（软约束）", r"(?m)^\s*(?:#{1,6}\s*)?3(?:[\.、])\s*可扩展项"),
    ("3.1 允许扩展的角色支线", r"(?m)^\s*(?:#{1,6}\s*)?3\.1\s*允许扩展的角色支线"),
    ("3.2 允许扩展的世界设定", r"(?m)^\s*(?:#{1,6}\s*)?3\.2\s*允许扩展的世界设定"),
    ("4. 自动生成执行指令", r"(?m)^\s*(?:#{1,6}\s*)?4(?:[\.、])\s*自动生成执行指令"),
    ("4.1 角色自动生成指令", r"(?m)^\s*(?:#{1,6}\s*)?4\.1\s*角色自动生成指令"),
    ("4.2 世界观自动生成指令", r"(?m)^\s*(?:#{1,6}\s*)?4\.2\s*世界观自动生成指令"),
    ("4.3 大纲自动生成指令", r"(?m)^\s*(?:#{1,6}\s*)?4\.3\s*大纲自动生成指令"),
    ("4.4 章节规划自动生成指令", r"(?m)^\s*(?:#{1,6}\s*)?4\.4\s*章节规划自动生成指令"),
]


def _missing_story_bible_sections(content: str) -> list[str]:
    text = str(content or "")
    missing: list[str] = []
    for label, pattern in _STORY_BIBLE_REQUIRED_SECTION_PATTERNS:
        if not re.search(pattern, text):
            missing.append(label)
    return missing


def _is_story_bible_tail_broken(content: str) -> bool:
    text = str(content or "").rstrip()
    if not text:
        return True
    if re.search(r"[：:（\(\-、，,；;]$", text):
        return True
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return True
    if re.fullmatch(r"[-*+>]\s*", lines[-1]):
        return True
    return False


def _is_story_bible_complete(content: str) -> bool:
    if not str(content or "").strip():
        return False
    if _missing_story_bible_sections(content):
        return False
    if _is_story_bible_tail_broken(content):
        return False
    return True


def _load_planning_studio_state(project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT state_json, updated_at FROM planning_studio_states WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    if not row:
        return None
    try:
        payload = json.loads(row["state_json"] or "{}")
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "project_id": project_id,
        "state": payload,
        "updated_at": row["updated_at"],
    }


def _save_planning_studio_state(project_id: str, state: dict[str, Any]):
    safe_state = state if isinstance(state, dict) else {}
    state_json = json.dumps(safe_state, ensure_ascii=False)
    if len(state_json) > 350_000:
        raise HTTPException(400, "立项状态过大，请减少历史消息后重试")

    with get_db() as db:
        db.execute(
            "INSERT INTO planning_studio_states (project_id, state_json, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')",
            (project_id, state_json),
        )
        row = db.execute(
            "SELECT updated_at FROM planning_studio_states WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    return {
        "project_id": project_id,
        "state": safe_state,
        "updated_at": row["updated_at"] if row else "",
    }


def _load_active_profile(project_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT b.profile_id, b.enabled, p.name, p.genre, p.version, p.profile_json, p.text_summary "
            "FROM project_profile_binding b "
            "JOIN knowledge_profiles p ON p.id = b.profile_id "
            "WHERE b.project_id = ? AND b.enabled = 1 "
            "ORDER BY p.updated_at DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if not row:
            return None
        data = dict(row)
        raw_json = data.get("profile_json") or "{}"
        try:
            data["profile_json_obj"] = json.loads(raw_json)
        except Exception:
            data["profile_json_obj"] = {}
        return data


def _load_max_existing_chapter_num(project_id: str) -> int:
    with get_db() as db:
        row = db.execute(
            "SELECT COALESCE(MAX(chapter_num), 0) AS m FROM chapters WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    try:
        return max(0, int(row["m"] if row else 0))
    except Exception:
        return 0


def _extract_volume_chapter_count_from_text(text: str) -> Optional[int]:
    raw = str(text or "").strip()
    if not raw:
        return None

    def _clamp(n: int) -> int:
        return max(1, min(MAX_CHAPTER_INDEX_HARD_LIMIT, int(n)))

    explicit_hits: list[int] = []
    explicit_patterns = [
        r"(?:目标章节数|章节总数|总章节数|章节数量|章数)\s*[:：]?\s*(\d{1,4})\s*章",
        r"(?:全书|规划|预计|约|大约|共计|总计)\s*(\d{1,4})\s*章",
        r"(?:章节规划|章节规模)[^\n]{0,20}?(\d{1,4})\s*章",
    ]
    for pattern in explicit_patterns:
        for m in re.findall(pattern, raw, re.I):
            try:
                explicit_hits.append(int(m))
            except Exception:
                continue
    explicit_hits = [n for n in explicit_hits if 1 <= n <= MAX_CHAPTER_INDEX_HARD_LIMIT]
    if explicit_hits:
        return _clamp(explicit_hits[-1])

    chapter_heading_hits: list[int] = []
    for m in re.findall(r"第\s*(\d{1,4})\s*章", raw):
        try:
            chapter_heading_hits.append(int(m))
        except Exception:
            continue
    chapter_heading_hits = [n for n in chapter_heading_hits if 1 <= n <= MAX_CHAPTER_INDEX_HARD_LIMIT]
    if chapter_heading_hits:
        max_heading = max(chapter_heading_hits)
        if max_heading >= 6:
            return _clamp(max_heading)
    return None


def _resolve_volume_plan_total_chapters(
    *,
    project_id: str,
    word_target: int,
    requested_chapter_count: Optional[int] = None,
    existing_items: Optional[list[dict]] = None,
) -> int:
    if requested_chapter_count is not None and int(requested_chapter_count) > 0:
        return max(1, min(MAX_CHAPTER_INDEX_HARD_LIMIT, int(requested_chapter_count)))

    item_max = 0
    if existing_items:
        for item in existing_items:
            try:
                item_max = max(item_max, int(item.get("end_chapter", 0) or 0))
            except Exception:
                continue

    chapter_max = _load_max_existing_chapter_num(project_id)
    latest_bible = _load_latest_bible(project_id)
    bible_count = _extract_volume_chapter_count_from_text((latest_bible or {}).get("content", "")) if latest_bible else None
    estimated = max(6, min(MAX_CHAPTER_INDEX_HARD_LIMIT, int(round(max(12000, int(word_target or 0)) / 3600.0))))
    candidate = max(
        int(item_max or 0),
        int(chapter_max or 0),
        int(bible_count or 0),
        int(estimated or 0),
    )
    return max(1, min(MAX_CHAPTER_INDEX_HARD_LIMIT, int(candidate)))


def _load_agent_prompt_override(project_id: str, agent_type: str) -> str:
    with get_db() as db:
        row = db.execute(
            "SELECT system_prompt FROM agent_configs WHERE project_id = ? AND agent_type = ?",
            (project_id, agent_type),
        ).fetchone()
    if not row:
        return ""
    return str((row["system_prompt"] or "")).strip()


def _build_bootstrap_scope_agent_guidance(
    *,
    project_id: str,
    scopes: set[str],
    total_limit: int = 2400,
) -> str:
    mapping: list[tuple[str, str, str, str]] = [
        ("characters", "角色设计提示词", "character_designer", agent_prompts.CHARACTER_DESIGNER),
        ("outline", "大纲策划提示词", "outline_writer", agent_prompts.OUTLINE_WRITER),
        ("chapters", "章节写作提示词", "chapter_writer", agent_prompts.CHAPTER_WRITER),
    ]
    blocks: list[str] = []
    for scope_key, label, agent_type, default_prompt in mapping:
        if scope_key not in scopes:
            continue
        prompt = _load_agent_prompt_override(project_id, agent_type) or default_prompt
        if not str(prompt or "").strip():
            continue
        blocks.append(f"【{label}】\n{_clip(str(prompt), 800)}")
    if not blocks:
        return ""
    return _clip("\n\n".join(blocks), total_limit)


def _build_bible_agent_fusion_guidance(
    *,
    project_id: str,
    total_limit: int = 3000,
) -> str:
    character_prompt = _load_agent_prompt_override(project_id, "character_designer") or agent_prompts.CHARACTER_DESIGNER
    outline_prompt = _load_agent_prompt_override(project_id, "outline_writer") or agent_prompts.OUTLINE_WRITER
    blocks: list[str] = []
    if str(character_prompt or "").strip():
        blocks.append(
            "【4.1 角色自动生成指令融合增强（来源：character_designer）】\n"
            f"{_clip(str(character_prompt), 1200)}"
        )
    if str(outline_prompt or "").strip():
        blocks.append(
            "【4.3 大纲自动生成指令融合增强（来源：outline_writer）】\n"
            f"{_clip(str(outline_prompt), 1200)}"
        )
    if not blocks:
        return ""
    return _clip("\n\n".join(blocks), total_limit)


@router.get("/bible/latest")
def get_latest_bible(project_id: str):
    return _load_latest_bible(project_id)


@router.get("/volume-plans")
def list_volume_plans(project_id: str):
    project = _load_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    return _load_volume_plans(project_id)


@router.get("/volume-plans/check", response_model=VolumePlanCheckResponse)
def check_volume_plans(project_id: str, chapter_count: Optional[int] = None):
    project = _load_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    items = _load_volume_plans(project_id)
    total_chapter_count = _resolve_volume_plan_total_chapters(
        project_id=project_id,
        word_target=int(project["word_target"] or 100000),
        requested_chapter_count=chapter_count,
        existing_items=items,
    )
    ok, issues = _validate_volume_plan_consistency(items, total_chapters=total_chapter_count)
    return VolumePlanCheckResponse(
        ok=ok,
        issues=issues,
        total_chapter_count=total_chapter_count,
    )


@router.post("/world-model/check", response_model=WorldModelCheckResponse)
async def world_model_check(req: WorldModelCheckRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    text = _clip(str(req.text or "").strip(), 16_000)
    if not text:
        raise HTTPException(400, "待审文本不能为空")

    try:
        chapter_num = int(req.chapter_num) if req.chapter_num is not None else None
    except Exception:
        chapter_num = None
    if chapter_num is not None and chapter_num <= 0:
        chapter_num = None
    chapter_title = _clip(str(req.chapter_title or "").strip(), 80)

    latest_bible = _load_latest_bible(req.project_id) if req.use_bible else None
    bible_text = latest_bible["content"] if latest_bible else ""
    bible_context = _build_bootstrap_bible_context(
        bible_text,
        scopes={"outline", "characters", "worldbuilding", "chapters"},
        limit=9000,
    )
    bible_block = f"\n\n【小说圣经硬约束】\n{bible_context}" if bible_context else ""

    active_profile = _load_active_profile(req.project_id) if req.use_profile else None
    profile_block = _build_world_model_profile_block(active_profile, total_limit=2200)
    if profile_block:
        profile_block = f"\n\n{profile_block}"

    planning_block = ""
    if req.use_planning_material:
        outlines, characters, worldbuilding = _load_existing_planning_material(req.project_id)
        planning_material = _build_planning_material_block(
            outlines,
            characters,
            worldbuilding,
            total_limit=3000,
        )
        if planning_material.strip():
            planning_block = f"\n\n【现有设定快照】\n{planning_material}"

    recent_block = ""
    if req.use_recent_chapters:
        safe_recent_limit = max(3, min(20, int(req.recent_limit or 12)))
        if chapter_num and chapter_num > 1:
            recent_anchor = chapter_num - 1
        else:
            recent_anchor = MAX_CHAPTER_INDEX_HARD_LIMIT
        recent_chain = _load_recent_chapter_chain(
            req.project_id,
            upto_chapter=recent_anchor,
            limit=safe_recent_limit,
        )
        recent_chain_block = _build_recent_chapter_chain_block(recent_chain, total_limit=1400)
        if recent_chain_block:
            recent_block = f"\n\n{recent_chain_block}"

    target_label = "待审文本"
    if chapter_num is not None:
        target_label = f"第{chapter_num}章"
        if chapter_title:
            target_label += f"《{chapter_title}》"

    model_name, temperature, _system_prompt, max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "bootstrap",
        0.25,
        PIPELINE_DEFAULT_SYSTEM_PROMPTS["bootstrap"],
        2600,
        llm=llm,
    )
    checker_system_prompt = """
你是“长篇小说世界模型一致性审校器”。
目标：只识别“明确冲突或高风险不一致”，不要做泛泛建议。
审查优先级：
1) 小说圣经硬约束
2) 规则包中的世界模型法则/道具法则
3) 已有角色、世界观、大纲、最近章节连续性

输出要求（仅 JSON 对象，不要 Markdown）：
{
  "summary": "一句话结论",
  "conflicts": [
    {
      "type": "world|prop|character|timeline|plot|other",
      "severity": "high|medium|low",
      "quote": "冲突文本片段（可选）",
      "description": "冲突描述（必须具体）",
      "suggestion": "最小改动修复建议"
    }
  ]
}
无冲突时 conflicts 返回空数组。
""".strip()
    user_prompt = f"""
请审查以下小说文本的一致性冲突。

项目名：{project['name']}
题材：{project['genre'] or '未指定'}
审查对象：{target_label}
{bible_block}
{profile_block}
{planning_block}
{recent_block}

【待审文本】
{text}
""".strip()
    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": checker_system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=min(max(temperature, 0.0), 0.35),
            max_tokens=max(900, min(4200, int(max_tokens or 2600))),
        )
    except Exception as e:
        raise HTTPException(500, f"一致性审查失败（model={model_name}）: {e}")

    summary, issues = _parse_world_model_check_payload(raw)
    if not summary:
        summary = "未发现明显一致性冲突。" if not issues else f"发现 {len(issues)} 项一致性风险。"

    return WorldModelCheckResponse(
        ok=len(issues) == 0,
        summary=summary,
        issues=[WorldModelCheckIssue(**x) for x in issues],
        context_flags={
            "bible": bool(bible_context),
            "profile": bool(profile_block.strip()),
            "planning_material": bool(planning_block.strip()),
            "recent_chapters": bool(recent_block.strip()),
        },
        resolved_model=model_name,
    )


@router.post("/volume-plans/generate", response_model=VolumePlanResponse)
async def generate_volume_plans(req: VolumePlanGenerateRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    try:
        target_volume_count = max(1, min(36, int(req.target_volume_count or 8)))
    except Exception:
        target_volume_count = 8
    target_word_count = max(12_000, int(req.target_word_count or project["word_target"] or 100000))
    total_chapter_count = _resolve_volume_plan_total_chapters(
        project_id=req.project_id,
        word_target=target_word_count,
        requested_chapter_count=req.chapter_count,
        existing_items=_load_volume_plans(req.project_id),
    )

    latest_bible = _load_latest_bible(req.project_id) if req.use_bible else None
    bible_text = latest_bible["content"] if latest_bible else ""
    active_profile = _load_active_profile(req.project_id) if req.use_profile else None
    outlines, characters, worldbuilding = _load_existing_planning_material(req.project_id)
    planning_material_block = _build_planning_material_block(
        outlines,
        characters,
        worldbuilding,
        total_limit=5200,
    )
    bible_context = _build_bootstrap_bible_context(bible_text, scopes={"outline", "chapters"}, limit=12000)
    bible_block = f"\n\n【必须遵守的小说圣经】\n{bible_context}" if bible_context else ""
    profile_block = _build_profile_block(active_profile, json_limit=2200, summary_limit=220)
    planning_block = (
        f"\n\n【已生成/已有设定（卷级规划必须参考）】\n{planning_material_block}"
        if planning_material_block.strip()
        else ""
    )
    model_name, temperature, system_prompt, _max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "bootstrap",
        float(project["temperature"] if project["temperature"] is not None else 0.6),
        PIPELINE_DEFAULT_SYSTEM_PROMPTS["bootstrap"],
        6000,
        llm=llm,
    )
    prompt = f"""
你现在只负责“卷级规划”生成。

项目名：{project['name']}
题材：{project['genre'] or '未指定'}
项目简介：{project['description'] or '未填写'}
目标总字数：{target_word_count}
目标总章节数：{total_chapter_count}
目标卷数：{target_volume_count}
{bible_block}
{profile_block}
{planning_block}

只输出严格 JSON 对象（不要 Markdown，不要额外说明）：
{{
  "volumes": [
    {{
      "volume_index": 1,
      "title": "卷名",
      "start_chapter": 1,
      "end_chapter": 30,
      "goal": "本卷目标",
      "key_turning_point": "关键转折",
      "end_hook": "卷尾钩子"
    }}
  ]
}}

硬约束：
1) 必须输出 {target_volume_count} 卷，volume_index 从 1 连续到 {target_volume_count}；
2) 章范围必须完整覆盖第 1 到第 {total_chapter_count} 章；
3) 各卷章范围必须连续、无重叠、无缺口；
4) 每卷都要有 goal、key_turning_point、end_hook；
5) 禁止输出 JSON 以外的任何说明文本。
""".strip()
    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.25), 0.65),
            max_tokens=9000,
        )
    except Exception as e:
        raise HTTPException(500, f"卷级规划生成失败（model={model_name}）: {e}")

    parsed = _parse_payload(raw)
    raw_items = parsed.get("volumes", []) if isinstance(parsed.get("volumes"), list) else []
    normalized = _normalize_volume_plan_items(
        raw_items,
        total_chapters=total_chapter_count,
        target_volume_count=target_volume_count,
    )
    if not normalized:
        normalized = _fallback_volume_plan_items(total_chapter_count, target_volume_count)
    ok, issues = _validate_volume_plan_consistency(normalized, total_chapters=total_chapter_count)
    auto_fix = False
    if not ok:
        normalized = _fallback_volume_plan_items(total_chapter_count, target_volume_count)
        ok, issues = _validate_volume_plan_consistency(normalized, total_chapters=total_chapter_count)
        auto_fix = True
    saved_count = _save_volume_plan_items(req.project_id, normalized, force=req.force)
    issue_tail = f"（已自动修复：{'；'.join(issues[:2])}）" if auto_fix and issues else ""
    return VolumePlanResponse(
        items=normalized,
        message=f"卷级规划已生成并保存：共 {saved_count} 卷，覆盖第1-{total_chapter_count}章。{issue_tail}",
    )


@router.get("/planning-state")
def get_planning_state(project_id: str):
    project = _load_project(project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    return _load_planning_studio_state(project_id)


@router.post("/planning-state", response_model=PlanningStudioStateResponse)
def save_planning_state(req: PlanningStudioStateUpsertRequest):
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    saved = _save_planning_studio_state(req.project_id, req.state or {})
    return PlanningStudioStateResponse(
        project_id=saved["project_id"],
        state=saved["state"],
        updated_at=saved["updated_at"],
    )


@router.post("/bible/save", response_model=StoryBibleResponse)
def save_story_bible(req: SaveBibleRequest):
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    content = _strip_fence(req.content or "")
    if not content.strip():
        raise HTTPException(400, "小说圣经内容不能为空")
    saved = _save_story_bible(req.project_id, content.strip(), source_brief=req.brief)
    return StoryBibleResponse(
        version=int(saved["version"]),
        content=saved["content"],
        created_at=saved["created_at"],
    )


@router.post("/bible/revise", response_model=ReviseBibleResponse)
async def revise_story_bible(req: ReviseBibleRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    instruction = str(req.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "改写指令不能为空")

    base = None
    if req.base_version is not None:
        try:
            base = _load_bible_by_version(req.project_id, int(req.base_version))
        except Exception:
            base = None
    if not base:
        base = _load_latest_bible(req.project_id)
    if not base:
        raise HTTPException(404, "未找到可改写的小说圣经，请先生成并保存版本")

    base_version = int(base.get("version") or 0)
    base_content = _strip_fence(str(base.get("content") or "")).strip()
    if not base_content:
        raise HTTPException(400, "基线圣经内容为空，无法改写")

    locked_sections = _normalize_section_ids(req.locked_sections)
    instruction_sections = _filter_existing_section_ids(instruction, base_content)
    emphasis_ids = instruction_sections[:8]
    emphasis_blocks: list[str] = []
    for sid in emphasis_ids:
        block = _extract_bible_section(base_content, sid)
        if block.strip():
            emphasis_blocks.append(f"【{sid} 原文】\n{block}")
    emphasis_text = "\n\n".join(emphasis_blocks).strip()
    locked_text = "、".join(locked_sections) if locked_sections else "（无）"

    user_prompt = f"""
请基于当前小说圣经执行“局部改写预览”，并严格输出 JSON。

【改写指令】
{instruction}

【锁定段落（这些编号及其子编号必须保持原文）】
{locked_text}

【重点改写段落原文（优先参考；若与全量基线冲突，以此块为准）】
{emphasis_text or "（未指定具体编号）"}

【当前圣经基线（v{base_version}）】
{_clip(base_content, 18000)}

仅输出 JSON 对象（不要 Markdown，不要额外解释）：
{{
  "revised_content": "改写后的完整圣经文本（保持编号结构）",
  "changed_sections": ["2.3", "4.1"],
  "change_summary": "本次改写摘要"
}}

硬约束：
1) 仅修改与指令直接相关的章节；未提及章节尽量不动；
2) 保持编号结构一致，尽量不新增/删除既有编号；
3) 锁定段落必须保持原文；
4) 若无法确定改写内容，revised_content 返回基线原文。
""".strip()

    model_name = ""
    try:
        model_name, temperature, system_prompt, revise_max_tokens = _resolve_pipeline_runtime(
            req.project_id,
            project,
            "bible_generate",
            0.35,
            PIPELINE_DEFAULT_SYSTEM_PROMPTS["bible_generate"],
            4200,
            llm=llm,
        )
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=min(max(temperature, 0.2), 0.55),
            max_tokens=revise_max_tokens,
        )
    except Exception as e:
        raise HTTPException(500, f"圣经改写预览失败（model={model_name or 'unknown'}）：{e}")

    payload = _parse_payload(raw)
    revised_content = _strip_fence(str(payload.get("revised_content") or "")).strip()
    if not revised_content:
        raw_text = _strip_fence(raw).strip()
        if raw_text and not raw_text.startswith("{") and not raw_text.startswith("["):
            revised_content = raw_text
    if not revised_content:
        revised_content = base_content

    model_sections = _filter_existing_section_ids(payload.get("changed_sections", []), base_content)
    allowed_sections = sorted(
        set(instruction_sections) | set(model_sections),
        key=_section_sort_key,
    )
    if allowed_sections:
        revised_content = _coerce_bible_revision_structure_limited(
            base_content,
            revised_content,
            locked_sections,
            allowed_sections,
        )
    else:
        revised_content = _coerce_bible_revision_structure(base_content, revised_content, locked_sections)

    base_missing = set(_missing_story_bible_sections(base_content))
    revised_missing = set(_missing_story_bible_sections(revised_content))
    regressed_missing = sorted(revised_missing - base_missing)
    if regressed_missing:
        if allowed_sections:
            revised_content = _coerce_bible_revision_structure_limited(
                base_content,
                revised_content,
                locked_sections,
                allowed_sections,
            )
        recheck_missing = set(_missing_story_bible_sections(revised_content))
        if recheck_missing - base_missing:
            revised_content = base_content

    base_len = max(1, len(base_content))
    revised_len = len(revised_content)
    if revised_len < int(base_len * 0.55):
        if allowed_sections:
            revised_content = _coerce_bible_revision_structure_limited(
                base_content,
                revised_content,
                locked_sections,
                allowed_sections,
            )
        if len(revised_content) < int(base_len * 0.55):
            revised_content = base_content

    if not revised_content.strip():
        revised_content = base_content

    changed_sections = _detect_changed_sections(base_content, revised_content)
    if not changed_sections and _normalize_for_diff(base_content) != _normalize_for_diff(revised_content):
        changed_sections = ["全文"]

    if model_sections and changed_sections:
        changed_sections = sorted(set(changed_sections) | set(model_sections), key=_section_sort_key)
    elif model_sections and not changed_sections:
        changed_sections = model_sections

    if allowed_sections:
        changed_sections = [
            sec for sec in changed_sections
            if sec == "全文" or _is_section_allowed(sec, allowed_sections)
        ]
        if not changed_sections and _normalize_for_diff(base_content) != _normalize_for_diff(revised_content):
            changed_sections = allowed_sections

    if locked_sections:
        changed_sections = [sec for sec in changed_sections if sec == "全文" or not _is_section_locked(sec, locked_sections)]

    change_summary = str(payload.get("change_summary") or "").strip() or _build_revise_summary(changed_sections)

    return ReviseBibleResponse(
        base_version=base_version,
        revised_content=revised_content,
        changed_sections=changed_sections,
        change_summary=change_summary,
    )


@router.post("/brainstorm", response_model=BrainstormResponse)
async def brainstorm(req: BrainstormRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    if not req.message.strip():
        return BrainstormResponse(reply="请先说一下你的题材、主角或核心冲突。", ready_for_bible=False)

    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    latest_bible = _load_latest_bible(req.project_id)
    bible_context = ""
    if latest_bible:
        bible_context = f"\n\n【已有小说圣经 v{latest_bible['version']}（摘要）】\n{_clip(latest_bible['content'], 1500)}"
    active_profile = _load_active_profile(req.project_id)
    profile_block = _build_profile_block(active_profile, json_limit=1800, summary_limit=180)
    selected_sources = _load_selected_knowledge_sources(req.project_id, req.selected_source_ids, max_sources=8)
    selected_sources_block = _build_selected_sources_block(
        selected_sources,
        total_limit=7200,
        per_source_limit=900,
    )

    model_name, temperature, system_prompt, brainstorm_max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "brainstorm",
        0.5,
        PIPELINE_DEFAULT_SYSTEM_PROMPTS["brainstorm"],
        BRAINSTORM_MAX_TOKENS,
        llm=llm,
    )
    mode = _normalize_brainstorm_mode(req.mode)
    mode_cfg = _brainstorm_mode_config(mode)
    max_questions = int(mode_cfg["max_questions"])
    confirmed_slots = _collect_confirmed_core_slots(req.history, req.message)
    missing_slots = _missing_core_slots_for_questions(confirmed_slots)
    core_ready = all(confirmed_slots.values())
    effective_word_target = _resolve_effective_word_target(
        req.history,
        req.message,
        int(project["word_target"] or 100000),
    )
    auto_chapter_count, auto_chapter_words = _estimate_chapter_scale_baseline(effective_word_target)
    incremental_points = _extract_incremental_brainstorm_points(req.message, limit=6)
    slot_status_text = "\n".join(
        f"- {label}：{'已确认' if confirmed_slots.get(key) else '待确认'}"
        for key, label in BRAINSTORM_CORE_SLOT_LABELS.items()
    )
    question_rule = (
        "4) 核心项未齐时：只能追问“待确认优先级”里的项目，禁止重复追问已确认项；"
        "核心项已齐时：可给 0-2 个“增强可选题”（不阻塞圣经生成），避免再问核心项；\n"
        "4.1) 核心项提问必须分槽：主角定位/主角目标必须拆开；"
        "“预估章节数+每章字数”必须合并为一题，选项格式为“约X章（每章约Y字）”；\n"
    )
    ready_rule = (
        "8) 当核心项已齐（题材/主角定位/主角目标/主冲突/篇幅/小说结构/预估章节数/每章字数/结局倾向）时，ready_for_bible 必须为 true；"
        "此时 questions 可为空，或返回最多2条增强可选题。"
    )

    messages = [{"role": "system", "content": system_prompt}]

    if req.history:
        for h in req.history[-12:]:
            if h.content.strip():
                messages.append({"role": h.role, "content": _clip(h.content, 1200)})

    messages.append(
        {
            "role": "user",
            "content": (
                f"项目信息：\n"
                f"- 名称：{project['name']}\n"
                f"- 类型：{project['genre'] or '未指定'}\n"
                f"- 描述：{project['description'] or '无'}\n"
                f"- 目标字数：{project['word_target'] or 100000}\n"
                f"- 章节规模自动估算：约{auto_chapter_count}章（每章约{auto_chapter_words}字）\n"
                f"\n【核心项判定（由系统根据用户输入提取）】\n{slot_status_text}\n"
                f"待确认优先级：{' / '.join(BRAINSTORM_CORE_SLOT_LABELS[s] for s in missing_slots) if missing_slots else '无'}\n"
                f"\n【立项模式】{mode_cfg['label']}\n"
                f"- 提问范围：{mode_cfg['ask_scope']}\n"
                f"- 补充规则：{mode_cfg['extra_rule']}\n"
                f"{bible_context}"
                f"{profile_block}"
                f"{selected_sources_block}\n\n"
                f"用户本轮输入：\n{req.message}"
                "\n\n请仅输出 JSON 对象（不要 Markdown，不要额外解释）：\n"
                "{\n"
                "  \"reply\": \"给用户看的简洁文本，使用：本轮确认/待确认问题/结论与下一步\",\n"
                "  \"ready_for_bible\": false,\n"
                "  \"questions\": [\n"
                "    {\n"
                "      \"id\": \"q1\",\n"
                "      \"title\": \"需要用户回答的问题\",\n"
                "      \"qtype\": \"single|multi|text|number\",\n"
                "      \"options\": [{\"label\": \"选项A\", \"value\": \"A\"}],\n"
                "      \"required\": true,\n"
                "      \"max_select\": 2,\n"
                "      \"placeholder\": \"文本输入提示\"\n"
                "    }\n"
                "  ]\n"
                "}\n"
                "规则：\n"
                f"1) questions 最多{max_questions}条；\n"
                "2) 若本轮不需要追问，questions 返回空数组；\n"
                "3) single/multi 必须给 options；text/number 不要 options；\n"
                f"{question_rule}"
                "5) 优先使用 single/multi 选择题，让用户点选；仅在无法枚举选项时使用 text/number；\n"
                "6) 同一轮禁止重复同一核心项；尽量给出3题，不足时可少于3题；\n"
                "7) “主角定位”和“主角目标”必须拆成两条问题；“预估章节数+每章字数”必须合并为一条“章节规模”问题；\n"
                f"{ready_rule}"
            ),
        }
    )

    try:
        raw_reply = await llm.chat(
            model=model_name,
            messages=messages,
            temperature=temperature,
            max_tokens=brainstorm_max_tokens,
        )
    except Exception as e:
        raise HTTPException(500, f"立项对话失败（model={model_name}）: {e}")

    parsed = _parse_payload(raw_reply)
    if parsed and isinstance(parsed.get("reply"), str):
        reply = str(parsed.get("reply", "")).strip()
        questions = _sanitize_brainstorm_questions(parsed.get("questions", []))
        questions = [
            _prefer_select_question(
                q,
                genre_hint=str(project["genre"] or ""),
                description_hint=str(project["description"] or ""),
            )
            for q in questions
        ]
        ready_for_bible = _coerce_bool(parsed.get("ready_for_bible"))
        if core_ready:
            questions = _filter_questions_by_confirmed_slots(questions, confirmed_slots, max_questions=max_questions)
            questions = _dedupe_questions(questions, max_questions=max_questions)
            ready_for_bible = True
            questions = _optionalize_followup_questions(questions, max_questions=min(max_questions, 2))
            if not questions and _needs_followup_option_question(req.message):
                questions = [_build_followup_option_question(req.message)]
        else:
            ready_for_bible = False
            questions = _enforce_missing_core_slot_questions(
                questions,
                confirmed_slots,
                max_questions=max_questions,
                word_target=effective_word_target,
                genre_hint=str(project["genre"] or ""),
                description_hint=str(project["description"] or ""),
            )

        reply = _inject_points_into_reply(reply, incremental_points, max_points=4)
        if not ready_for_bible and not questions:
            missing = _missing_core_slots_for_questions(confirmed_slots)
            if missing:
                questions = _fill_questions_with_missing_slots(
                    [],
                    missing,
                    max_questions=max_questions,
                    word_target=effective_word_target,
                    genre_hint=str(project["genre"] or ""),
                    description_hint=str(project["description"] or ""),
                )
        if _blocking_brainstorm_questions(questions):
            ready_for_bible = False
        reply = _append_brainstorm_state_hint(
            reply,
            ready_for_bible=ready_for_bible,
            questions=questions,
        )
        return BrainstormResponse(
            reply=reply or "我建议先明确题材、主角定位、主角目标和终局，再生成小说圣经。",
            questions=questions,
            ready_for_bible=ready_for_bible,
            resolved_model=model_name,
        )

    fallback_reply = _extract_brainstorm_reply_from_jsonish(raw_reply)
    if not fallback_reply:
        fallback_reply = raw_reply.strip() or "我建议先明确题材、主角定位、主角目标和终局，再生成小说圣经。"
    fallback_reply = _inject_points_into_reply(fallback_reply, incremental_points, max_points=4)
    fallback_ready = _reply_ready_for_bible(fallback_reply, [])
    fallback_questions: list[BrainstormQuestion] = []
    if core_ready:
        fallback_ready = True
        fallback_questions = [_build_followup_option_question(req.message)] if _needs_followup_option_question(req.message) else []
    else:
        fallback_ready = False
        missing = _missing_core_slots_for_questions(confirmed_slots)
        if missing:
            fallback_questions = _fill_questions_with_missing_slots(
                [],
                missing,
                max_questions=max_questions,
                word_target=effective_word_target,
                genre_hint=str(project["genre"] or ""),
                description_hint=str(project["description"] or ""),
            )
    if _blocking_brainstorm_questions(fallback_questions):
        fallback_ready = False
    fallback_reply = _append_brainstorm_state_hint(
        fallback_reply,
        ready_for_bible=fallback_ready,
        questions=fallback_questions,
    )
    return BrainstormResponse(
        reply=fallback_reply,
        questions=fallback_questions,
        ready_for_bible=fallback_ready,
        resolved_model=model_name,
    )


@router.post("/brainstorm/options/refresh", response_model=BrainstormOptionRefreshResponse)
async def refresh_brainstorm_options(req: BrainstormOptionRefreshRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    slot = _slot_from_title(req.title)
    effective_word_target = _resolve_effective_word_target(req.history, "", int(project["word_target"] or 100000))
    existing_options = _sanitize_question_options(req.options, max_items=12)
    existing_values = {
        (opt.value or "").strip().lower()
        for opt in existing_options
        if (opt.value or "").strip()
    }

    if slot == "chapter_scale":
        template_options = _build_chapter_scale_options(effective_word_target, limit=8)
    else:
        template_options = _build_slot_options(
            slot,
            genre_hint=str(project["genre"] or ""),
            description_hint=str(project["description"] or ""),
        ) if slot else []
    template_filtered = [
        opt for opt in template_options
        if (opt.value or "").strip().lower() not in existing_values
    ]
    if len(template_filtered) < 2:
        template_filtered = list(template_options)
    template_filtered = _shuffle_options(template_filtered)

    convo = []
    for m in req.history[-10:]:
        text = (m.content or "").strip()
        if not text:
            continue
        who = "用户" if m.role == "user" else "助手"
        convo.append(f"{who}: {_clip(text, 220)}")
    convo_text = "\n".join(convo) if convo else "（暂无）"
    latest_bible = _load_latest_bible(req.project_id)
    bible_hint = _clip((latest_bible or {}).get("content", ""), 700) if latest_bible else ""
    active_profile = _load_active_profile(req.project_id)
    profile_block = _build_profile_block(active_profile, json_limit=1200, summary_limit=120)

    model_name, temperature, system_prompt, option_max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "brainstorm",
        0.55,
        PIPELINE_DEFAULT_SYSTEM_PROMPTS["brainstorm"],
        900,
        llm=llm,
    )
    option_max_tokens = min(1600, max(400, option_max_tokens))
    mode = _normalize_brainstorm_mode(req.mode)
    mode_cfg = _brainstorm_mode_config(mode)
    slot_label = BRAINSTORM_CORE_SLOT_LABELS.get(slot or "", req.title.strip() or "该问题")
    slot_guardrail = _slot_refresh_guardrail(slot)
    existing_text = "；".join(opt.label for opt in existing_options) or "（无）"
    template_hint = " / ".join(opt.label for opt in template_options[:12]) or "（无）"
    prompt = f"""
你要为“立项问答”的单个问题刷新可点击选项。

仅输出严格 JSON 对象（不要 Markdown，不要解释）：
{{
  "options": [
    {{"label": "选项A", "value": "选项A"}}
  ]
}}

要求：
1) 返回 4-8 个候选，短句、互斥、可点击；
2) 必须紧扣当前问题，不要扩展到执行细节；
3) 不能重复“已展示选项”；
4) 禁止输出“交给AI决定”和“其他（手动填写）”（这两项由前端自动补）；
5) 输出中文；
6) 立项模式：{mode_cfg['label']}；
7) 选项必须“具体且可执行”，避免空泛词（如：成长/逆袭/守护重要之人/查明真相）；
8) 每个选项建议 6-18 字，尽量体现“对象 + 行动 + 结果/代价”。
{slot_guardrail}

项目信息：
- 题材：{project['genre'] or '未指定'}
- 描述：{_clip(project['description'] or '无', 220)}
- 当前推导总字数：{effective_word_target}
- 问题主题：{slot_label}
- 问题标题：{req.title}
- 已展示选项：{existing_text}
- 可参考候选池：{template_hint}
{profile_block}
- 已有圣经摘要：{bible_hint or '（暂无）'}

最近上下文：
{convo_text}
""".strip()

    refreshed_options: list[BrainstormQuestionOption] = []
    refresh_exception: Optional[Exception] = None
    try:
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            temperature=min(max(temperature, 0.35), 0.65),
            max_tokens=option_max_tokens,
        )
        payload = _parse_payload(raw)
        llm_options = _filter_refresh_options(
            _sanitize_question_options(payload.get("options", []), max_items=10),
            slot=slot,
            existing_values=existing_values,
            limit=8,
        )
        if len(llm_options) < 3:
            retry_prompt = f"""
你上一次给出的候选仍偏泛化。请只输出更具体、更可执行的版本（严格 JSON）。

规则：
1) 返回 4-8 个候选；
2) 每个选项 6-18 字；
3) 禁止泛词：成长、逆袭、守护重要之人、查明真相、保持当前方向；
4) 不要复用已展示选项；
5) 不要输出解释、不要输出 Markdown。
{slot_guardrail}

问题主题：{slot_label}
问题标题：{req.title}
已展示选项：{existing_text}
最近上下文：{convo_text}
""".strip()
            raw_retry = await llm.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": retry_prompt},
                ],
                temperature=min(max(temperature, 0.35), 0.6),
                max_tokens=option_max_tokens,
            )
            retry_payload = _parse_payload(raw_retry)
            retry_options = _filter_refresh_options(
                _sanitize_question_options(retry_payload.get("options", []), max_items=10),
                slot=slot,
                existing_values=existing_values,
                limit=8,
            )
            if len(retry_options) > len(llm_options):
                llm_options = retry_options
        if llm_options:
            if slot == "goal":
                refreshed_options = _blend_goal_options_half_ai(llm_options, template_filtered, limit=8)
            else:
                refreshed_options = _merge_and_dedupe_options(llm_options, template_filtered, limit=8)
    except Exception as e:
        refresh_exception = e
        logger.warning(
            "Brainstorm option refresh LLM call failed: project_id=%s title=%s slot=%s",
            req.project_id,
            req.title,
            slot or "unknown",
            exc_info=True,
        )
        refreshed_options = []

    if len(refreshed_options) < 2:
        quality_template = _filter_refresh_options(
            template_filtered,
            slot=slot,
            existing_values=existing_values,
            limit=8,
        )
        preserved_existing = [
            opt for opt in existing_options
            if not _is_low_quality_refresh_option(opt.label, slot=slot)
        ]
        refreshed_options = _merge_and_dedupe_options(quality_template, preserved_existing, limit=8)
    if len(refreshed_options) < 2:
        refreshed_options = _merge_and_dedupe_options(template_options, existing_options, limit=8)
    if _option_signature(refreshed_options) == _option_signature(existing_options):
        forced_prompt = f"""
你刚才给出的选项与“已展示选项”重复，用户刷新后看不到变化。

请重新只输出严格 JSON：
{{
  "options": [
    {{"label": "选项A", "value": "选项A"}}
  ]
}}

硬约束：
1) 返回 4-8 个候选；
2) 必须全部不同于“已展示选项”；
3) 候选短句可点击，6-20字；
4) 禁止输出解释和 Markdown；
5) 禁止输出“交给AI决定”“其他（手动填写）”。
{slot_guardrail}

问题主题：{slot_label}
问题标题：{req.title}
已展示选项：{existing_text}
最近上下文：{convo_text}
""".strip()
        try:
            forced_raw = await llm.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": forced_prompt},
                ],
                temperature=min(max(temperature, 0.55), 0.8),
                max_tokens=option_max_tokens,
            )
            forced_payload = _parse_payload(forced_raw)
            forced_options = _filter_refresh_options(
                _sanitize_question_options(forced_payload.get("options", []), max_items=12),
                slot=slot,
                existing_values=existing_values,
                limit=8,
            )
            if len(forced_options) >= 2:
                if slot == "goal":
                    refreshed_options = _blend_goal_options_half_ai(forced_options, template_filtered, limit=8)
                else:
                    refreshed_options = _merge_and_dedupe_options(forced_options, template_filtered, limit=8)
        except Exception:
            logger.warning(
                "Forced brainstorm option refresh failed: project_id=%s title=%s slot=%s",
                req.project_id,
                req.title,
                slot or "unknown",
                exc_info=True,
            )
    if _option_signature(refreshed_options) == _option_signature(existing_options):
        if slot != "chapter_scale":
            emergency = _filter_refresh_options(
                _build_emergency_refresh_options(
                    slot,
                    req.title,
                    genre_hint=str(project["genre"] or ""),
                    description_hint=str(project["description"] or ""),
                ),
                slot=slot,
                existing_values=existing_values,
                limit=8,
            )
            if len(emergency) >= 2:
                refreshed_options = emergency
    if len(refreshed_options) < 2 and slot:
        fallback_pool = (
            _build_chapter_scale_options(effective_word_target, limit=8)
            if slot == "chapter_scale"
            else _build_slot_options(
                slot,
                genre_hint=str(project["genre"] or ""),
                description_hint=str(project["description"] or ""),
            )
        )
        strict_slot_fallback = _filter_refresh_options(
            fallback_pool,
            slot=slot,
            existing_values=existing_values,
            limit=8,
        )
        if strict_slot_fallback:
            refreshed_options = _merge_and_dedupe_options(strict_slot_fallback, refreshed_options, limit=8)
    if len(refreshed_options) < 2:
        refreshed_options = [
            BrainstormQuestionOption(label="聚焦主线并明确代价", value="聚焦主线并明确代价"),
            BrainstormQuestionOption(label="推动冲突升级并保留反转", value="推动冲突升级并保留反转"),
            BrainstormQuestionOption(label="保持人设一致并强化动机", value="保持人设一致并强化动机"),
        ]
    if refresh_exception is not None and _option_signature(refreshed_options) == _option_signature(existing_options):
        logger.warning(
            "Brainstorm option refresh returned unchanged fallback after exception: project_id=%s title=%s slot=%s",
            req.project_id,
            req.title,
            slot or "unknown",
        )

    return BrainstormOptionRefreshResponse(options=refreshed_options[:8])


@router.post("/project-autofill", response_model=ProjectAutofillResponse)
async def project_autofill(req: ProjectAutofillRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    convo = []
    for m in req.history[-20:]:
        text = (m.content or "").strip()
        if not text:
            continue
        who = "用户" if m.role == "user" else "助手"
        convo.append(f"{who}: {_clip(text, 350)}")
    convo_text = "\n".join(convo) if convo else "（暂无立项对话）"

    bible_text = (req.bible or "").strip()
    if not bible_text:
        latest_bible = _load_latest_bible(req.project_id)
        bible_text = (latest_bible or {}).get("content", "") if latest_bible else ""

    default_word_target = int(project["word_target"] or 100000)
    default_chapter_words = max(1500, min(12000, int(round(max(default_word_target, 12000) / 22))))
    project_structure, project_custom_structure = _normalize_story_structure(
        project["structure"] if "structure" in project.keys() else "起承转合",
        project["custom_structure"] if "custom_structure" in project.keys() else "",
    )
    project_structure_desc = (
        f"{project_structure}（{project_custom_structure}）"
        if project_structure == "自定义" and project_custom_structure
        else project_structure
    )

    prompt = f"""
请根据项目资料、立项对话和小说圣经，提炼“项目设置自动填充建议”。

当前项目：
- 名称：{project['name'] or '未命名'}
- 类型：{project['genre'] or '未指定'}
- 描述：{project['description'] or '无'}
- 目标字数：{default_word_target}
- 当前叙事结构：{project_structure_desc}

立项对话：
{convo_text}

小说圣经（可为空）：
{_clip(bible_text, 2600) if bible_text else '（暂无）'}

只输出 JSON 对象，字段如下：
{{
  "name": "项目名",
  "name_candidates": ["候选书名1", "候选书名2", "候选书名3"],
  "genre": "题材",
  "description": "项目描述（60-220字）",
  "word_target": 100000,
  "structure": "起承转合/三幕式/英雄之旅/自定义",
  "custom_structure": "当 structure=自定义 时填写阶段说明，其它情况留空",
  "chapter_words": 4500,
  "priority": "品质优先/速度优先/均衡",
  "reason": "建议依据（不超过120字）"
}}

要求：
1) 字段必须完整，禁止空字符串；
2) word_target 范围 10000-500000；
3) chapter_words 范围 1500-12000；
4) 若无把握，除 name/name_candidates 外优先沿用当前项目值，尤其是 structure；
5) name_candidates 给 3~5 个，优先短、可传播、贴合题材；不要全都与当前名称完全一致。
""".strip()

    try:
        model_name, temperature, system_prompt, autofill_max_tokens = _resolve_pipeline_runtime(
            req.project_id,
            project,
            "autofill",
            0.35,
            PIPELINE_DEFAULT_SYSTEM_PROMPTS["autofill"],
            1000,
            llm=llm,
        )
        raw = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            max_tokens=autofill_max_tokens,
        )
    except Exception as e:
        raise HTTPException(500, f"自动填充建议生成失败（model={model_name}）: {e}")

    payload = _parse_payload(raw)

    def _to_int(v, default: int, lo: int, hi: int) -> int:
        try:
            iv = int(float(v))
        except Exception:
            iv = default
        return max(lo, min(hi, iv))

    raw_candidates = payload.get("name_candidates")
    candidates_input: list[str] = []
    if isinstance(raw_candidates, list):
        candidates_input = [str(x or "").strip() for x in raw_candidates]
    elif isinstance(raw_candidates, str):
        candidates_input = [x.strip() for x in re.split(r"[,\n，；;]+", raw_candidates) if str(x or "").strip()]
    raw_name = _clip(str(payload.get("name") or "").strip(), 80)
    fallback_name = _clip(str(project["name"] or "未命名项目").strip(), 80)
    candidate_pool: list[str] = []
    seen_names: set[str] = set()
    for candidate in [raw_name, *candidates_input, fallback_name]:
        c = _clip(str(candidate or "").strip(), 80)
        if len(c) < 2:
            continue
        key = c.lower()
        if key in seen_names:
            continue
        seen_names.add(key)
        candidate_pool.append(c)
        if len(candidate_pool) >= 5:
            break
    name_candidates = candidate_pool[:5]
    name = name_candidates[0] if name_candidates else fallback_name
    genre = _clip(str(payload.get("genre") or project["genre"] or "").strip(), 40)
    description = _clip(
        str(payload.get("description") or project["description"] or "").strip(),
        800,
    )
    if not description:
        description = "待补充：核心卖点、主角目标与主要冲突。"

    word_target = _to_int(payload.get("word_target"), default_word_target, 10000, 500000)
    chapter_words = _to_int(payload.get("chapter_words"), default_chapter_words, 1500, 12000)

    structure_raw = str(payload.get("structure") or "").strip()
    custom_structure_raw = str(payload.get("custom_structure") or "").strip()
    if not structure_raw and not custom_structure_raw:
        structure_raw = project_structure
        custom_structure_raw = project_custom_structure
    structure, custom_structure = _normalize_story_structure(
        structure_raw or project_structure,
        custom_structure_raw or project_custom_structure,
    )
    if structure != "自定义":
        custom_structure = ""
    elif not custom_structure and structure_raw and structure_raw not in {"起承转合", "三幕式", "英雄之旅", "自定义"}:
        custom_structure = _clip(structure_raw, 120)

    priority_raw = str(payload.get("priority") or "品质优先").strip()
    priority = priority_raw if priority_raw in {"品质优先", "速度优先", "均衡"} else "品质优先"

    reason = _clip(str(payload.get("reason") or "").strip(), 180)

    return ProjectAutofillResponse(
        name=name,
        name_candidates=name_candidates,
        genre=genre,
        description=description,
        word_target=word_target,
        structure=structure,
        custom_structure=_clip(custom_structure, 240),
        chapter_words=chapter_words,
        priority=priority,
        reason=reason,
    )


@router.post("/bible/generate", response_model=StoryBibleResponse)
async def generate_story_bible(req: GenerateBibleRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()
    project = _load_project(req.project_id)
    if not project:
        raise HTTPException(404, "项目不存在")

    convo = []
    for m in req.history[-20:]:
        if m.content.strip():
            who = "用户" if m.role == "user" else "助手"
            convo.append(f"{who}: {_clip(m.content, 500)}")
    convo_text = "\n".join(convo) if convo else "（暂无额外对话）"
    active_profile = _load_active_profile(req.project_id)
    profile_block = _build_profile_block(active_profile, json_limit=2800, summary_limit=260)
    selected_sources = _load_selected_knowledge_sources(req.project_id, req.selected_source_ids, max_sources=10)
    selected_sources_block = _build_selected_sources_block(
        selected_sources,
        total_limit=9000,
        per_source_limit=1200,
    )
    option_history_block = _build_option_history_block(req.option_history, max_items=16, total_limit=3200)
    bible_agent_fusion = _build_bible_agent_fusion_guidance(project_id=req.project_id)
    bible_agent_fusion_block = f"\n\n【4.1/4.3 Agent 提示词融合增强】\n{bible_agent_fusion}" if bible_agent_fusion else ""

    prompt = f"""
请基于以下信息生成一份“小说圣经”（Markdown），用于后续自动生成角色、世界观、大纲与章节。

【项目基础】
- 作品名：{project['name']}
- 题材：{project['genre'] or '未指定'}
- 项目描述：{project['description'] or '无'}
- 目标字数：{project['word_target'] or 100000}
- 用户补充：{req.brief or '无'}

【立项对话摘要】
{convo_text}
{option_history_block}
{profile_block}
{selected_sources_block}
{bible_agent_fusion_block}

请严格按以下结构输出（保留编号标题）：
1. 四个核心信息（P0）
1.1 已锁定信息（来自上下文）
1.2 项目信息（题材、目标读者、篇幅）
1.3 核心卖点（一句话）
1.4 一句话梗概（Logline）
2. 禁止改动项（硬约束）
2.1 世界观硬规则
2.2 角色关系硬规则
2.3 叙事风格硬规则
2.4 结局与主线硬规则
3. 可扩展项（软约束）
3.1 允许扩展的角色支线
3.2 允许扩展的世界设定
4. 自动生成执行指令
4.1 角色自动生成指令（必须覆盖：角色档案 / 关系网络 / 角色弧线 / 使用建议）
4.2 世界观自动生成指令
4.3 大纲自动生成指令
4.4 章节规划自动生成指令

要求：
- 内容要可执行，避免空泛措辞。
- 硬约束必须可检查（尽量量化或可判定）。
- 与项目题材强绑定。
- 4.1 必须按角色设计规范编写，明确“角色档案/关系网络/角色弧线/使用建议”四块执行要求。
- 4.1 角色档案字段必须覆盖：姓名(name)、角色定位(category)、性别(gender)、年龄(age)、身份(identity)、外貌(appearance)、性格(personality)、动机(motivation)、背景(backstory)、弧线(arc)、使用建议(usage_notes)、关系(relations)。
- 4.1 必须给出“角色规模建议”，至少包含主角/反派/关键配角/功能(路人)角色数量区间，不得只给 2-3 个角色模板。
- 若上下文已明确角色性别（如男主/女主/某角色性别），必须在 2.2 与 4.1 显式写明；未明确默认写“男”。
- 角色年龄 age 必须为纯数字（不带“岁”）；未明确默认写 18。
""".strip()

    model_name, temperature, system_prompt, bible_max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "bible_generate",
        0.45,
        PIPELINE_DEFAULT_SYSTEM_PROMPTS["bible_generate"],
        8000,
        llm=llm,
    )
    try:
        content = await llm.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            max_tokens=bible_max_tokens,
        )
    except Exception as e:
        raise HTTPException(500, f"小说圣经生成失败（model={model_name}）: {e}")

    content = _strip_fence(content)
    if content and not _is_story_bible_complete(content):
        retry_prompt = (
            f"{prompt}\n\n"
            "补充硬约束：必须完整覆盖 1.1 到 4.4 的全部编号标题；"
            "如果上次输出被截断，请这次优先保证结构完整，单节可适当精炼。"
        )
        try:
            retry_raw = await llm.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": retry_prompt},
                ],
                temperature=max(0.2, min(temperature, 0.55)),
                max_tokens=bible_max_tokens,
            )
            retry_content = _strip_fence(retry_raw)
            if _is_story_bible_complete(retry_content):
                content = retry_content
            elif len(retry_content) > len(content):
                content = retry_content
        except Exception:
            pass

    if not content:
        raise HTTPException(500, "小说圣经为空，请重试")
    if not _is_story_bible_complete(content):
        missing = _missing_story_bible_sections(content)
        if missing:
            tip = "、".join(missing[:4]) + (" 等" if len(missing) > 4 else "")
            raise HTTPException(500, f"小说圣经输出不完整（缺少：{tip}），请重试一次或切换更高上下文模型。")
        raise HTTPException(500, "小说圣经输出疑似截断，请重试一次。")

    saved = _save_story_bible(req.project_id, content, source_brief=req.brief)
    return StoryBibleResponse(
        version=int(saved["version"]),
        content=saved["content"],
        created_at=saved["created_at"],
    )


@router.post("/bootstrap", response_model=BootstrapResponse)
async def bootstrap_project(req: BootstrapRequest):
    agent_router._init_services()
    llm = _get_llm_or_raise()

    with get_db() as db:
        project = db.execute(
            "SELECT id, name, genre, description, structure, custom_structure, chapter_words, priority, "
            "word_target, model_main, temperature FROM projects WHERE id = ?",
            (req.project_id,),
        ).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")

        existing_outline = db.execute(
            "SELECT COUNT(*) AS c FROM outlines WHERE project_id = ?",
            (req.project_id,),
        ).fetchone()["c"]
        existing_chars = db.execute(
            "SELECT COUNT(*) AS c FROM characters WHERE project_id = ?",
            (req.project_id,),
        ).fetchone()["c"]
        existing_world = db.execute(
            "SELECT COUNT(*) AS c FROM worldbuilding WHERE project_id = ?",
            (req.project_id,),
        ).fetchone()["c"]
        existing_chapters = db.execute(
            "SELECT COUNT(*) AS c FROM chapters WHERE project_id = ?",
            (req.project_id,),
        ).fetchone()["c"]

    scopes = _normalized_scope(req.scope)
    range_mode_requested = _has_chapter_range_params(req)
    if range_mode_requested and scopes != {"chapters"}:
        raise HTTPException(400, "start_chapter/end_chapter/batch_size 仅支持 scope=chapters")
    if range_mode_requested and req.scope == "planning":
        raise HTTPException(400, "scope=planning 不支持章节区间参数，请改用 scope=chapters")

    latest_bible = _load_latest_bible(req.project_id) if req.use_bible else None
    bible_text = latest_bible["content"] if latest_bible else ""
    chapter_count = _resolve_bootstrap_chapter_count(
        word_target=int(project["word_target"] or 100000),
        existing=int(existing_chapters),
        requested=req.chapter_count,
        bible_text=bible_text,
    )
    active_profile = _load_active_profile(req.project_id) if req.use_profile else None
    existing_outline_material: list[dict] = []
    existing_character_material: list[dict] = []
    existing_world_material: list[dict] = []
    if "outline" in scopes or "characters" in scopes or "chapters" in scopes:
        (
            existing_outline_material,
            existing_character_material,
            existing_world_material,
        ) = _load_existing_planning_material(req.project_id)
    global_agent_guidance_block = _build_bootstrap_scope_agent_guidance(
        project_id=req.project_id,
        scopes=scopes,
    )

    default_system_prompt = PIPELINE_DEFAULT_SYSTEM_PROMPTS["bootstrap"]

    default_temperature = float(project["temperature"] if project["temperature"] is not None else 0.6)
    bootstrap_default_max_tokens = min(24000, max(4200, 1200 + chapter_count * 110))
    model, temperature, system_prompt, bootstrap_max_tokens = _resolve_pipeline_runtime(
        req.project_id,
        project,
        "bootstrap",
        default_temperature,
        default_system_prompt,
        bootstrap_default_max_tokens,
        llm=llm,
    )

    if range_mode_requested and scopes == {"chapters"}:
        start_chapter, end_chapter = _resolve_requested_chapter_range(
            req,
            default_chapter_count=chapter_count,
            existing_chapters=int(existing_chapters),
        )
        effective_total_chapter_count = max(int(chapter_count or 1), end_chapter, int(existing_chapters or 0))
        batch_size = _normalize_batch_size(req.batch_size)
        planning_material_block = _build_planning_material_block(
            existing_outline_material,
            existing_character_material,
            existing_world_material,
        )

        try:
            inserted_chapters, skipped_chapters, batch_stats, failed_range, retry_count, format_degraded = (
                await _generate_and_persist_chapter_range_batches(
                    req=req,
                    llm=llm,
                    model=model,
                    system_prompt=system_prompt,
                    temperature=temperature,
                    project=dict(project),
                    bible_text=bible_text,
                    active_profile=active_profile,
                    planning_material_block=planning_material_block,
                    start_chapter=start_chapter,
                    end_chapter=end_chapter,
                    batch_size=batch_size,
                    total_chapter_count=effective_total_chapter_count,
                )
            )
        except Exception as e:
            status_code = e.status_code if isinstance(e, HTTPException) else 500
            raise HTTPException(
                status_code,
                _normalize_bootstrap_error_message(e, fallback="AI 章节区间规划失败"),
            )

        inserted = {"outline": 0, "characters": 0, "worldbuilding": 0, "chapters": inserted_chapters}
        skipped = {"outline": 0, "characters": 0, "worldbuilding": 0, "chapters": skipped_chapters}
        bible_tag = f"（遵循小说圣经 v{latest_bible['version']}）" if latest_bible else ""
        profile_tag = ""
        if active_profile:
            profile_tag = f"（规则包: {active_profile.get('name', '未命名')} v{active_profile.get('version', 1)}）"
        failed_hint = ""
        if failed_range:
            failed_hint = (
                f"；已在区间第{failed_range['start_chapter']}-{failed_range['end_chapter']}章停止，"
                "可从失败区间继续重试（建议每次 10-20 章）"
            )
        degraded_tag = "（4.4 缺失，已降级到系统默认章节格式）" if format_degraded else ""
        message = (
            f"AI 章节区间规划完成{bible_tag}{profile_tag}{degraded_tag}："
            f"区间 第{start_chapter}-{end_chapter}章，"
            f"新增/更新 章节 {inserted_chapters}，跳过 章节 {skipped_chapters}，"
            f"批次成功 {batch_stats.get('success_batches', 0)}/{batch_stats.get('planned_batches', 0)}，"
            f"降批重试 {retry_count} 次{failed_hint}。"
        )
        return BootstrapResponse(
            inserted=inserted,
            skipped=skipped,
            message=message,
            effective_range={"start_chapter": start_chapter, "end_chapter": end_chapter},
            batch_stats=batch_stats,
            failed_range=failed_range,
            retry_count=retry_count,
            format_degraded=format_degraded,
        )

    auto_split_bootstrap = (
        chapter_count > BOOTSTRAP_AUTO_SPLIT_CHAPTER_THRESHOLD
        and len(scopes) > 1
        and "chapters" in scopes
    )
    split_bootstrap_by_scope = auto_split_bootstrap or (
        len(scopes) > 1 and "outline" in scopes and "characters" in scopes
    )
    degraded_bootstrap = False
    payload = _empty_bootstrap_payload()

    if split_bootstrap_by_scope:
        for scope_name in ("worldbuilding", "characters", "outline", "chapters"):
            if scope_name not in scopes:
                continue
            key = _BOOTSTRAP_SCOPE_TO_KEY.get(scope_name)
            if not key:
                continue
            scope_set = {scope_name}
            planning_material_block = ""
            if scope_name in {"characters", "outline", "chapters"}:
                context_outlines = (
                    payload.get("outlines")
                    if isinstance(payload.get("outlines"), list) and payload.get("outlines")
                    else existing_outline_material
                )
                context_characters = (
                    payload.get("characters")
                    if isinstance(payload.get("characters"), list) and payload.get("characters")
                    else existing_character_material
                )
                context_world = (
                    payload.get("worldbuilding")
                    if isinstance(payload.get("worldbuilding"), list) and payload.get("worldbuilding")
                    else existing_world_material
                )
                if scope_name == "characters":
                    context_outlines = []
                    context_characters = []
                if scope_name == "outline":
                    context_outlines = []
                planning_material_block = _build_planning_material_block(
                    context_outlines or [],
                    context_characters or [],
                    context_world or [],
                )
            partial_payload, partial_degraded = await _generate_bootstrap_payload_for_scopes(
                llm=llm,
                model=model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=_bootstrap_generation_max_tokens(bootstrap_max_tokens, chapter_count, scope_set),
                project_id=req.project_id,
                project=dict(project),
                chapter_count=chapter_count,
                bible_text=bible_text,
                scopes=scope_set,
                active_profile=active_profile,
                planning_material_block=planning_material_block,
                agent_guidance_block=_build_bootstrap_scope_agent_guidance(
                    project_id=req.project_id,
                    scopes=scope_set,
                ),
            )
            normalized_partial_payload = _normalize_bootstrap_payload(partial_payload)
            payload[key] = normalized_partial_payload.get(key, [])
            degraded_bootstrap = degraded_bootstrap or partial_degraded
    else:
        planning_material_block = ""
        if "characters" in scopes or "outline" in scopes or "chapters" in scopes:
            if "characters" in scopes and scopes == {"characters"}:
                planning_outlines = []
                planning_characters = []
            else:
                planning_outlines = existing_outline_material if "chapters" in scopes else []
                planning_characters = existing_character_material
            planning_material_block = _build_planning_material_block(
                planning_outlines,
                planning_characters,
                existing_world_material,
            )
        payload, degraded_bootstrap = await _generate_bootstrap_payload_for_scopes(
            llm=llm,
            model=model,
            system_prompt=system_prompt,
            temperature=temperature,
            max_tokens=_bootstrap_generation_max_tokens(bootstrap_max_tokens, chapter_count, scopes),
            project_id=req.project_id,
            project=dict(project),
            chapter_count=chapter_count,
            bible_text=bible_text,
            scopes=scopes,
            active_profile=active_profile,
            planning_material_block=planning_material_block,
            agent_guidance_block=global_agent_guidance_block,
        )

    project_structure, project_custom_structure = _normalize_story_structure(
        project["structure"] if "structure" in project.keys() else "起承转合",
        project["custom_structure"] if "custom_structure" in project.keys() else "",
    )
    normalized = _normalize_bootstrap_payload(payload)
    outlines = _normalize_outline_items(
        normalized["outlines"],
        structure=project_structure,
        custom_structure=project_custom_structure,
    )
    characters = _normalize_character_items(normalized["characters"])
    worldbuilding = _normalize_worldbuilding_items(normalized["worldbuilding"])
    chapters = _normalize_chapter_items(normalized["chapters"], chapter_count)
    char_min_count, _char_max_count = _target_character_count_range(chapter_count)
    character_mix_shortfalls = _character_mix_shortfalls(characters, chapter_count)
    character_generation_required = "characters" in scopes and (req.force or existing_chars == 0)
    if (
        character_generation_required
        and (len(characters) < char_min_count or bool(character_mix_shortfalls))
    ):
        # 若首次结果已降级且角色为空，外层补齐重试通常只会重复烧 token。
        character_retry_limit = 0 if (not characters and degraded_bootstrap) else 2
        character_retry_round = 0
        while character_retry_round < character_retry_limit:
            character_mix_shortfalls = _character_mix_shortfalls(characters, chapter_count)
            if len(characters) >= char_min_count and not character_mix_shortfalls:
                break
            missing_count = max(0, char_min_count - len(characters))
            existing_names = [
                _clip(str(item.get("name") or "").strip(), 20)
                for item in characters
                if str(item.get("name") or "").strip()
            ][:20]
            existing_name_hint = "、".join(existing_names) if existing_names else "无"
            mix_target_text = _format_character_role_mix_targets(chapter_count)
            mix_shortfall_text = _format_character_mix_shortfalls(character_mix_shortfalls)
            character_planning_block = _build_planning_material_block(
                outlines if outlines else existing_outline_material,
                characters if characters else [],
                worldbuilding if worldbuilding else existing_world_material,
            )
            base_character_guidance = _build_bootstrap_scope_agent_guidance(
                project_id=req.project_id,
                scopes={"characters"},
            )
            guidance_lines = [
                "【角色补齐硬约束】",
                f"- 当前已生成 {len(characters)} 个角色，建议不少于 {char_min_count} 个。",
                f"- 角色结构目标：{mix_target_text}。",
                f"- 本轮至少补充 {max(1, missing_count)} 个新角色，姓名不得与已有角色重复：{existing_name_hint}。",
                "- 输出时请保留已有角色，并继续补齐，不要只返回 2-3 个模板角色。",
            ]
            if mix_shortfall_text:
                guidance_lines.insert(3, f"- 当前结构缺口：{mix_shortfall_text}。本轮必须优先补齐这些类型。")
            character_repair_guidance = "\n".join(guidance_lines)
            character_guidance_block = (
                f"{base_character_guidance}\n\n{character_repair_guidance}"
                if base_character_guidance.strip()
                else character_repair_guidance
            )
            character_payload, character_degraded = await _generate_bootstrap_payload_for_scopes(
                llm=llm,
                model=model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=_bootstrap_generation_max_tokens(bootstrap_max_tokens, chapter_count, {"characters"}),
                project_id=req.project_id,
                project=dict(project),
                chapter_count=chapter_count,
                bible_text=bible_text,
                scopes={"characters"},
                active_profile=active_profile,
                planning_material_block=character_planning_block,
                agent_guidance_block=character_guidance_block,
            )
            fallback_characters = _normalize_character_items(
                _normalize_bootstrap_payload(character_payload).get("characters", [])
            )
            merged_characters = _merge_character_items(
                characters,
                fallback_characters,
                limit=max(24, char_min_count + 6),
            )
            if len(merged_characters) > len(characters):
                characters = merged_characters
            elif len(fallback_characters) > len(characters):
                characters = fallback_characters
            degraded_bootstrap = degraded_bootstrap or character_degraded
            character_retry_round += 1
        character_mix_shortfalls = _character_mix_shortfalls(characters, chapter_count)
    if character_generation_required and not characters:
        logger.warning(
            "Bootstrap characters empty after generation: project_id=%s model=%s scopes=%s",
            req.project_id,
            model,
            ",".join(sorted(scopes)),
        )
        raise HTTPException(
            500,
            f"AI 角色生成失败：模型输出无法解析为有效角色数据（model={_clip(str(model or DEFAULT_MODEL), 80)}）。"
            "请切换结构化输出更稳定的模型后重试。",
        )
    if "chapters" in scopes:
        if _needs_chapter_fallback(chapters, chapter_count):
            fallback_chapters = await _generate_chapters_only_with_fallback(
                llm=llm,
                model=model,
                temperature=temperature,
                project=dict(project),
                chapter_count=chapter_count,
                bible_text=bible_text,
                active_profile=active_profile,
            )
            normalized_fallback = _normalize_chapter_items(fallback_chapters, chapter_count)
            if normalized_fallback:
                chapters = normalized_fallback
        chapters = _ensure_chapter_coverage(chapters, chapter_count)
    if "outline" in scopes and (req.force or existing_outline == 0) and not outlines:
        outline_planning_block = _build_planning_material_block(
            [],
            characters if characters else existing_character_material,
            worldbuilding if isinstance(worldbuilding, list) and worldbuilding else existing_world_material,
        )
        outline_payload, outline_degraded = await _generate_bootstrap_payload_for_scopes(
            llm=llm,
            model=model,
            system_prompt=system_prompt,
            temperature=temperature,
            max_tokens=_bootstrap_generation_max_tokens(bootstrap_max_tokens, chapter_count, {"outline"}),
            project_id=req.project_id,
            project=dict(project),
            chapter_count=chapter_count,
            bible_text=bible_text,
            scopes={"outline"},
            active_profile=active_profile,
            planning_material_block=outline_planning_block,
            agent_guidance_block=_build_bootstrap_scope_agent_guidance(
                project_id=req.project_id,
                scopes={"outline"},
            ),
        )
        outlines = _normalize_outline_items(
            _normalize_bootstrap_payload(outline_payload).get("outlines", []),
            structure=project_structure,
            custom_structure=project_custom_structure,
        )
        degraded_bootstrap = degraded_bootstrap or outline_degraded
    if "outline" in scopes and not outlines:
        phase_labels = _resolve_outline_phase_labels(
            project_structure,
            project_custom_structure,
            max_count=12,
        ) or ["起", "承", "转", "合"]
        outlines = []
        for idx, phase_label in enumerate(phase_labels[:12], start=1):
            title = (
                f"{phase_label}：阶段目标与关键转折"
                if project_structure != "起承转合"
                else f"{phase_label}：开局与推进"
            )
            outlines.append(
                {
                    "phase": phase_label,
                    "title": title,
                    "content": "",
                    "word_range": "",
                }
            )

    inserted = {"outline": 0, "characters": 0, "worldbuilding": 0, "chapters": 0}
    skipped = {"outline": 0, "characters": 0, "worldbuilding": 0, "chapters": 0}

    with get_db() as db:
        if "outline" in scopes:
            if req.force:
                db.execute("DELETE FROM outlines WHERE project_id = ?", (req.project_id,))
                existing_outline = 0
            if existing_outline > 0 and not req.force:
                skipped["outline"] = int(existing_outline)
            else:
                phase_order = 0
                for o in outlines:
                    phase = _clip(str(o.get("phase") or "").strip(), 20)
                    if not phase:
                        phase = _phase_for_outline_by_structure(
                            phase_order + 1,
                            max(1, len(outlines)),
                            structure=project_structure,
                            custom_structure=project_custom_structure,
                        )
                    db.execute(
                        "INSERT INTO outlines (project_id, structure, phase, phase_order, title, content, word_range) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (
                            req.project_id,
                            project_structure,
                            phase,
                            phase_order,
                            _clip(str(o.get("title", f"{phase}阶段")), 80),
                            _clip(str(o.get("content", "")), 1000),
                            _clip(str(o.get("word_range", "")), 60),
                        ),
                    )
                    phase_order += 1
                    inserted["outline"] += 1

        if "characters" in scopes:
            if req.force:
                db.execute("DELETE FROM characters WHERE project_id = ?", (req.project_id,))
                existing_chars = 0
            if existing_chars > 0 and not req.force:
                skipped["characters"] = int(existing_chars)
            else:
                seen = set()
                inserted_character_rows: list[tuple[str, dict, str]] = []
                for c in characters:
                    name = _clip(str(c.get("name", "")).strip(), 30)
                    if not name or name in seen:
                        continue
                    seen.add(name)
                    appearance = _clip(
                        str(
                            c.get("appearance")
                            or c.get("looks")
                            or c.get("look")
                            or c.get("external")
                            or c.get("外貌")
                            or ""
                        ),
                        600,
                    )
                    backstory = _clip(
                        str(
                            c.get("backstory")
                            or c.get("history")
                            or c.get("past")
                            or c.get("背景")
                            or ""
                        ),
                        600,
                    )
                    db.execute(
                        "INSERT INTO characters (project_id, name, category, gender, age, identity, appearance, personality, motivation, backstory, arc, usage_notes) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            req.project_id,
                            name,
                            _safe_category(str(c.get("category", "配角"))),
                            _safe_gender(str(c.get("gender", ""))),
                            _safe_age(str(c.get("age", ""))),
                            _clip(str(c.get("identity", "")), 120),
                            appearance,
                            _clip(str(c.get("personality", "")), 600),
                            _clip(str(c.get("motivation", "")), 300),
                            backstory,
                            _clip(str(c.get("arc", "")), 300),
                            _clip(str(c.get("usage_notes", c.get("usage_advice", ""))), 600),
                        ),
                    )
                    row = db.execute(
                        "SELECT id FROM characters WHERE project_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1",
                        (req.project_id, name),
                    ).fetchone()
                    if row:
                        inserted_character_rows.append((name, c, str(row["id"])))
                    inserted["characters"] += 1

                inserted_by_name = {
                    re.sub(r"\s+", "", name).lower(): char_id
                    for name, _raw, char_id in inserted_character_rows
                }
                relation_seen: set[tuple[str, str, str, str]] = set()
                for source_name, raw_char, source_id in inserted_character_rows:
                    raw_relations = raw_char.get("relations", [])
                    if not isinstance(raw_relations, list):
                        continue
                    for rel in raw_relations:
                        if not isinstance(rel, dict):
                            continue
                        target_name = _clip(
                            str(
                                rel.get("target")
                                or rel.get("target_name")
                                or rel.get("name")
                                or rel.get("character")
                                or ""
                            ).strip(),
                            30,
                        )
                        if not target_name:
                            continue
                        target_key = re.sub(r"\s+", "", target_name).lower()
                        target_id = inserted_by_name.get(target_key)
                        if not target_id or target_id == source_id:
                            continue
                        relation_type = _clip(str(rel.get("relation_type", rel.get("type", ""))).strip(), 60)
                        description = _clip(str(rel.get("description", "")).strip(), 260)
                        dedupe_key = (source_id, target_id, relation_type, description)
                        if dedupe_key in relation_seen:
                            continue
                        relation_seen.add(dedupe_key)
                        db.execute(
                            "INSERT INTO character_relations (character_a_id, character_b_id, relation_type, description) "
                            "VALUES (?,?,?,?)",
                            (source_id, target_id, relation_type, description),
                        )

        if "worldbuilding" in scopes:
            if req.force:
                db.execute("DELETE FROM worldbuilding WHERE project_id = ?", (req.project_id,))
                existing_world = 0
            if existing_world > 0 and not req.force:
                skipped["worldbuilding"] = int(existing_world)
            else:
                for w in worldbuilding:
                    title = _clip(str(w.get("title", "")).strip(), 80)
                    if not title:
                        continue
                    db.execute(
                        "INSERT INTO worldbuilding (project_id, category, title, content) VALUES (?,?,?,?)",
                        (
                            req.project_id,
                            _clip(str(w.get("category", "其他")), 30),
                            title,
                            _clip(str(w.get("content", "")), 1200),
                        ),
                    )
                    inserted["worldbuilding"] += 1

        if "chapters" in scopes:
            chapter_rows = db.execute(
                "SELECT id, chapter_num, title, synopsis FROM chapters WHERE project_id = ?",
                (req.project_id,),
            ).fetchall()
            existing_by_num = {int(r["chapter_num"]): dict(r) for r in chapter_rows}
            for idx, ch in enumerate(chapters, start=1):
                try:
                    num = int(ch.get("chapter_num", idx))
                except Exception:
                    num = idx
                if num < 1:
                    continue
                title = _clip(str(ch.get("title", f"第{num}章")), 80)
                synopsis = _clip(str(ch.get("synopsis", "")), 240)
                phase = str(ch.get("phase", "")).strip()
                if phase not in {"起", "承", "转", "合"}:
                    phase = ""

                if num in existing_by_num:
                    row = existing_by_num[num]
                    can_update = req.force or (
                        (not row.get("synopsis"))
                        and (row.get("title", "").startswith("第") or row.get("title", "") == f"第{num}章")
                    )
                    if can_update:
                        db.execute(
                            "UPDATE chapters SET title = ?, phase = ?, synopsis = ?, updated_at = datetime('now') WHERE id = ?",
                            (title, phase, synopsis, row["id"]),
                        )
                        inserted["chapters"] += 1
                    else:
                        skipped["chapters"] += 1
                else:
                    if _insert_chapter_row_with_guard(
                        db,
                        project_id=req.project_id,
                        chapter_num=num,
                        title=title,
                        phase=phase,
                        synopsis=synopsis,
                        sort_order=num,
                    ):
                        inserted["chapters"] += 1
                    else:
                        skipped["chapters"] += 1

    bible_tag = f"（遵循小说圣经 v{latest_bible['version']}）" if latest_bible else ""
    profile_tag = ""
    if active_profile:
        profile_tag = f"（规则包: {active_profile.get('name', '未命名')} v{active_profile.get('version', 1)}）"
    split_tag = (
        f"（章节数 {chapter_count} > {BOOTSTRAP_AUTO_SPLIT_CHAPTER_THRESHOLD}，已自动分块生成）"
        if auto_split_bootstrap
        else "（已按能力分步生成，降低解析缺项风险）"
        if split_bootstrap_by_scope and len(scopes) > 1
        else ""
    )
    character_count_tag = (
        f"（角色数量偏少：当前 {inserted['characters']}，建议不少于 {char_min_count}）"
        if "characters" in scopes and inserted["characters"] > 0 and inserted["characters"] < char_min_count
        else ""
    )
    character_mix_tag = (
        f"（角色结构偏少：{_format_character_mix_shortfalls(character_mix_shortfalls)}）"
        if "characters" in scopes and inserted["characters"] > 0 and character_mix_shortfalls
        else ""
    )
    degraded_tag = "（AI输出格式异常，已自动降级修复）" if degraded_bootstrap else ""
    return BootstrapResponse(
        inserted=inserted,
        skipped=skipped,
        message=(
            f"AI 流水线完成{bible_tag}{profile_tag}{split_tag}{character_count_tag}{character_mix_tag}{degraded_tag}：新增/更新 "
            f"大纲 {inserted['outline']}，角色 {inserted['characters']}，世界观 {inserted['worldbuilding']}，章节 {inserted['chapters']}；"
            f"跳过 大纲 {skipped['outline']}，角色 {skipped['characters']}，世界观 {skipped['worldbuilding']}，章节 {skipped['chapters']}。"
        ),
    )
