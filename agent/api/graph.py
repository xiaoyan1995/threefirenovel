"""角色关系图谱 API（独立模块）"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from db import get_db

router = APIRouter()


def _clip(text: str, limit: int) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\n", " ").strip()
    if len(value) <= limit:
        return value
    return value[:limit] + "..."


def _normalize_relation_type(text: str) -> str:
    value = str(text or "").strip().lower()
    return re.sub(r"\s+", "", value)


_RELATION_NOISE_TYPES = {
    "",
    "角色",
    "人物",
    "主角",
    "配角",
    "反派",
    "npc",
    "主要角色",
    "次要角色",
    "男主",
    "女主",
    "路人",
    "未知",
    "其他",
    "关系",
    "关联",
    "其他关系",
}


_WEAK_RELATION_LABELS = {
    "其他关联",
    "亲属（待细分）",
    "亲属",
    "家人",
    "关系",
    "关联",
}

_BIDIRECTIONAL_HINT_WORDS = (
    "夫妻",
    "配偶",
    "伴侣",
    "恋人",
    "情侣",
    "情人",
    "朋友",
    "闺蜜",
    "挚友",
    "密友",
    "发小",
    "同学",
    "同桌",
    "同事",
    "室友",
    "校友",
    "同乡",
    "网友",
    "队友",
    "战友",
    "搭档",
    "盟友",
    "同盟",
    "合伙人",
    "合作伙伴",
    "对手",
    "敌人",
    "宿敌",
    "死对头",
    "竞争对手",
    "竞争者",
    "宗亲",
    "同道",
    "同道中人",
)

_DIRECTED_HINT_WORDS = (
    "父",
    "母",
    "祖",
    "孙",
    "伯",
    "叔",
    "姑",
    "舅",
    "姨",
    "侄",
    "甥",
    "岳",
    "婿",
    "婆媳",
    "翁媳",
    "姐夫",
    "妹夫",
    "嫂子",
    "弟媳",
    "监护人",
    "被监护人",
    "上级",
    "下级",
    "上司",
    "下属",
    "老板",
    "员工",
    "雇主",
    "雇员",
    "客户",
    "供应商",
    "代理商",
    "投资人",
    "被投资人",
    "导师",
    "老师",
    "学生",
    "师徒",
    "医生",
    "患者",
    "律师",
    "法官",
    "警察",
    "嫌疑人",
    "证人",
    "司机",
    "乘客",
    "理发师",
    "顾客",
    "作者",
    "读者",
    "经纪人",
    "艺人",
    "快递员",
    "收件人",
    "寄件人",
    "房东",
    "租客",
    "导游",
    "游客",
    "偶像",
    "粉丝",
    "主人",
    "仆人",
    "加害人",
    "受害人",
    "委托人",
    "代理人",
    "担保人",
    "被担保人",
    "背叛者",
    "被背叛者",
    "复仇者",
    "被复仇者",
    "追随者",
    "拥护者",
    "反对者",
    "利用者",
    "被利用者",
    "仰慕者",
    "被仰慕者",
    "守护者",
    "被守护者",
    "君臣",
    "主仆",
    "将军",
    "士兵",
    "刺客",
    "目标",
    "间谍",
    "接头人",
    "卧底",
    "上线",
    "老大",
    "小弟",
    "线人",
    "管理员",
    "版主",
    "房管",
    "会长",
    "主席",
)

_KEYWORD_RELATION_RULES: list[tuple[str, str, int, tuple[str, ...]]] = [
    # 血缘与姻亲（细粒度优先）
    ("养父", "directed", 6, ("养父", "养父子", "养父女")),
    ("继父", "directed", 6, ("继父", "继父子", "继父女")),
    ("父亲", "directed", 6, ("父亲", "爸爸", "生父", "父子", "父女")),
    ("养母", "directed", 6, ("养母", "养母子", "养母女")),
    ("继母", "directed", 6, ("继母", "继母子", "继母女")),
    ("母亲", "directed", 6, ("母亲", "妈妈", "生母", "母子", "母女")),
    ("外曾祖父", "directed", 6, ("外曾祖父",)),
    ("外曾祖母", "directed", 6, ("外曾祖母",)),
    ("曾祖父", "directed", 6, ("曾祖父",)),
    ("曾祖母", "directed", 6, ("曾祖母",)),
    ("外祖父", "directed", 6, ("外祖父", "外公")),
    ("外祖母", "directed", 6, ("外祖母", "外婆")),
    ("祖父", "directed", 6, ("祖父", "爷爷")),
    ("祖母", "directed", 6, ("祖母", "奶奶")),
    ("儿子", "directed", 6, ("儿子", "长子", "次子", "干儿子")),
    ("女儿", "directed", 6, ("女儿", "闺女", "干女儿")),
    ("孙子", "directed", 5, ("孙子", "曾孙", "外孙", "侄孙", "甥孙")),
    ("孙女", "directed", 5, ("孙女", "曾孙女", "外孙女", "侄孙女", "甥孙女")),
    ("哥哥", "directed", 5, ("哥哥", "兄长", "学长", "师兄")),
    ("弟弟", "directed", 5, ("弟弟", "学弟", "师弟")),
    ("姐姐", "directed", 5, ("姐姐", "学姐", "师姐")),
    ("妹妹", "directed", 5, ("妹妹", "学妹", "师妹")),
    ("兄弟", "bidirectional", 5, ("兄弟", "亲兄弟", "堂兄弟", "表兄弟", "继兄弟", "养兄弟", "义兄弟", "干兄弟")),
    ("姐妹", "bidirectional", 5, ("姐妹", "亲姐妹", "堂姐妹", "表姐妹", "继姐妹", "养姐妹", "义姐妹", "干姐妹")),
    ("兄妹", "bidirectional", 5, ("兄妹", "堂兄妹", "表兄妹")),
    ("姐弟", "bidirectional", 5, ("姐弟", "堂姐弟", "表姐弟")),
    ("伯父", "directed", 5, ("伯父", "伯伯", "伯父子", "伯父女")),
    ("伯母", "directed", 5, ("伯母",)),
    ("叔叔", "directed", 5, ("叔叔", "叔父", "叔父子", "叔父女")),
    ("婶母", "directed", 5, ("婶母",)),
    ("姑姑", "directed", 5, ("姑姑", "姑母", "姑母子", "姑母女")),
    ("姑父", "directed", 5, ("姑父", "姑丈")),
    ("舅舅", "directed", 5, ("舅舅", "舅父", "舅父子", "舅父女")),
    ("舅妈", "directed", 5, ("舅妈", "舅母")),
    ("姨妈", "directed", 5, ("姨妈", "姨母", "姨母子", "姨母女")),
    ("姨父", "directed", 5, ("姨父", "姨丈", "姨夫")),
    ("侄子", "directed", 5, ("侄子",)),
    ("侄女", "directed", 5, ("侄女",)),
    ("外甥", "directed", 5, ("外甥",)),
    ("外甥女", "directed", 5, ("外甥女",)),
    ("夫妻", "bidirectional", 6, ("夫妻", "配偶", "伴侣", "复婚配偶", "分居配偶", "离异配偶")),
    ("丈夫", "directed", 5, ("丈夫", "老公")),
    ("妻子", "directed", 5, ("妻子", "老婆")),
    ("未婚夫", "directed", 5, ("未婚夫",)),
    ("未婚妻", "directed", 5, ("未婚妻",)),
    ("前夫", "directed", 5, ("前夫",)),
    ("前妻", "directed", 5, ("前妻",)),
    ("婆媳", "directed", 5, ("婆媳",)),
    ("翁媳", "directed", 5, ("翁媳",)),
    ("岳婿", "directed", 5, ("岳婿",)),
    ("姑嫂", "bidirectional", 5, ("姑嫂",)),
    ("叔嫂", "bidirectional", 5, ("叔嫂",)),
    ("妯娌", "bidirectional", 5, ("妯娌",)),
    ("连襟", "bidirectional", 5, ("连襟",)),
    ("姐夫", "directed", 5, ("姐夫",)),
    ("妹夫", "directed", 5, ("妹夫",)),
    ("嫂子", "directed", 5, ("嫂子",)),
    ("弟媳", "directed", 5, ("弟媳",)),
    # 情感与社交
    ("昔日恋人", "bidirectional", 5, ("前恋人", "前任恋人", "昔日恋人", "旧情人")),
    ("恋人", "bidirectional", 5, ("恋人", "情侣", "初恋", "复合恋人", "校园恋人", "办公室恋人", "同性恋人", "精神恋人", "虚拟恋人")),
    ("男友", "bidirectional", 5, ("男友", "前男友")),
    ("女友", "bidirectional", 5, ("女友", "前女友")),
    ("前任", "bidirectional", 5, ("前任",)),
    ("订婚对象", "bidirectional", 4, ("订婚对象", "婚约对象", "试婚对象")),
    ("相亲对象", "bidirectional", 4, ("相亲对象", "相亲成功对象")),
    ("网恋对象", "bidirectional", 4, ("网恋对象", "网恋奔现对象")),
    ("暧昧对象", "bidirectional", 4, ("暧昧对象", "暧昧")),
    ("暗恋者", "directed", 4, ("暗恋者",)),
    ("被暗恋者", "directed", 4, ("被暗恋者",)),
    ("追求者", "directed", 4, ("追求者",)),
    ("被追求者", "directed", 4, ("被追求者",)),
    ("备胎", "directed", 3, ("备胎",)),
    ("情人", "bidirectional", 4, ("情人", "婚外情对象")),
    ("知己", "bidirectional", 4, ("知己", "红颜知己", "蓝颜知己", "灵魂伴侣", "青梅竹马")),
    ("情敌", "bidirectional", 5, ("情敌", "暗恋者的情敌", "三角恋参与者", "四角恋参与者")),
    ("朋友", "bidirectional", 4, ("朋友", "好友", "挚友", "密友", "发小", "玩伴", "酒友", "牌友", "球友", "驴友", "邻居", "网友", "笔友", "旅伴")),
    ("闺蜜", "bidirectional", 5, ("闺蜜",)),
    ("同学", "bidirectional", 4, ("同学", "同班级同学", "同小组同学")),
    ("同桌", "bidirectional", 4, ("同桌",)),
    ("校友", "bidirectional", 4, ("校友", "同校校友", "同届校友", "同专业校友")),
    ("同乡", "bidirectional", 4, ("同乡",)),
    ("室友", "bidirectional", 4, ("室友", "合租伙伴", "宿舍长与室友")),
    # 校园与职场
    ("师生", "directed", 5, ("师生", "老师", "班主任与学生", "家教与学生", "代课老师与学生", "实习老师与学生")),
    ("导师与学生", "directed", 5, ("导师与学生", "导师", "研究生导师与研究生", "博士生导师与博士生", "博士后导师与博士后")),
    ("同门", "bidirectional", 4, ("同门", "同实验室师兄与师弟", "同实验室师姐与师妹")),
    ("同事", "bidirectional", 4, ("同事", "部门同事", "跨部门同事", "项目同事", "实习同事", "外包同事")),
    ("上级", "directed", 5, ("上级", "上司", "领导", "老板", "主管", "经理")),
    ("下级", "directed", 5, ("下级", "下属")),
    ("雇主", "directed", 5, ("雇主", "甲方", "甲方代表与乙方代表")),
    ("雇员", "directed", 5, ("雇员", "员工", "乙方")),
    ("合作伙伴", "bidirectional", 4, ("合作伙伴", "创业伙伴", "论文合作伙伴", "毕业设计搭档", "合作者", "合作方")),
    ("合伙人", "bidirectional", 5, ("合伙人",)),
    ("客户", "directed", 5, ("客户", "销售与客户")),
    ("供应商", "directed", 5, ("供应商", "采购与供应商")),
    ("代理商", "directed", 5, ("代理商", "经销商", "加盟商")),
    ("投资人", "directed", 5, ("投资人", "天使投资人", "风险投资人")),
    ("被投资人", "directed", 5, ("被投资人",)),
    ("竞争对手", "bidirectional", 5, ("竞争对手", "竞争者")),
    ("同行", "bidirectional", 4, ("同行",)),
    # 社会服务与公共身份
    ("医生与患者", "directed", 5, ("医生与患者", "牙医与患者", "眼科医生与患者", "心理医生与患者")),
    ("护士与患者", "directed", 5, ("护士与患者",)),
    ("律师与当事人", "directed", 5, ("律师与当事人",)),
    ("警察与嫌疑人", "directed", 5, ("警察与嫌疑人",)),
    ("警察与证人", "directed", 5, ("警察与证人",)),
    ("法官与当事人", "directed", 5, ("法官与当事人",)),
    ("司机与乘客", "directed", 5, ("司机与乘客", "网约车司机与乘客", "出租车司机与乘客")),
    ("理发师与顾客", "directed", 5, ("理发师与顾客", "发型师与顾客")),
    ("主播与观众", "directed", 5, ("主播与观众", "电竞解说与观众")),
    ("作者与读者", "directed", 5, ("作者与读者",)),
    ("经纪人与艺人", "directed", 5, ("经纪人与艺人",)),
    ("快递员与收件人", "directed", 5, ("快递员与收件人",)),
    ("快递员与寄件人", "directed", 5, ("快递员与寄件人",)),
    ("房东与租客", "directed", 5, ("房东与租客", "民宿房东与房客")),
    ("厨师与食客", "directed", 5, ("厨师与食客", "西餐厨师与食客", "中餐厨师与食客")),
    ("顾问与客户", "directed", 5, ("顾问与客户",)),
    ("宠物医生与宠物主人", "directed", 5, ("宠物医生与宠物主人",)),
    ("导游与游客", "directed", 5, ("导游与游客",)),
    ("偶像与粉丝", "directed", 5, ("偶像与粉丝", "网红与粉丝", "主播与粉丝", "虚拟偶像与粉丝")),
    ("明星与追随者", "directed", 5, ("明星与追随者", "明星与私生饭", "明星与站姐")),
    ("UP主与粉丝", "directed", 5, ("up主与粉丝", "游戏up主与粉丝", "动漫up主与粉丝", "影视up主与粉丝", "知识up主与粉丝", "美食up主与粉丝", "旅行up主与粉丝", "美妆up主与粉丝", "健身up主与粉丝", "学习up主与粉丝")),
    ("主人与仆人", "directed", 5, ("主人与仆人", "主仆")),
    ("监护人", "directed", 5, ("监护人",)),
    ("被监护人", "directed", 5, ("被监护人",)),
    ("委托人", "directed", 5, ("委托人",)),
    ("代理人", "directed", 5, ("代理人",)),
    ("担保人", "directed", 5, ("担保人",)),
    ("被担保人", "directed", 5, ("被担保人",)),
    # 剧情与虚拟关系
    ("战友", "bidirectional", 5, ("战友",)),
    ("队友", "bidirectional", 5, ("队友", "游戏队友", "手游战队队友", "端游战队队友", "电竞选手与队友")),
    ("搭档", "bidirectional", 5, ("搭档", "科幻人机搭档")),
    ("盟友", "bidirectional", 5, ("盟友", "同盟", "外星人与地球人盟友")),
    ("对手", "bidirectional", 5, ("对手", "游戏对手")),
    ("敌人", "bidirectional", 5, ("敌人",)),
    ("宿敌", "bidirectional", 5, ("宿敌", "死对头")),
    ("救命恩人", "directed", 5, ("救命恩人", "侠客与恩人")),
    ("被救者", "directed", 5, ("被救者",)),
    ("引荐人", "directed", 5, ("引荐人",)),
    ("被引荐者", "directed", 5, ("被引荐者",)),
    ("背叛者", "directed", 5, ("背叛者", "背叛")),
    ("被背叛者", "directed", 5, ("被背叛者",)),
    ("复仇者", "directed", 5, ("复仇者",)),
    ("被复仇者", "directed", 5, ("被复仇者",)),
    ("追随者", "directed", 5, ("追随者",)),
    ("领导者", "directed", 5, ("领导者",)),
    ("拥护者", "directed", 5, ("拥护者",)),
    ("反对者", "directed", 5, ("反对者",)),
    ("利用者", "directed", 5, ("利用者", "利用", "操控", "控制", "算计", "欺骗")),
    ("被利用者", "directed", 5, ("被利用者",)),
    ("仰慕者", "directed", 5, ("仰慕者",)),
    ("被仰慕者", "directed", 5, ("被仰慕者",)),
    ("守护者", "directed", 5, ("守护者",)),
    ("被守护者", "directed", 5, ("被守护者",)),
    ("君臣", "directed", 5, ("君臣", "主公与谋士", "幕僚与主公", "门客与主人", "将军与士兵")),
    ("刺客与目标", "directed", 5, ("刺客与目标",)),
    ("间谍与接头人", "directed", 5, ("间谍与接头人",)),
    ("卧底与上线", "directed", 5, ("卧底与上线",)),
    ("黑帮老大与小弟", "directed", 5, ("黑帮老大与小弟",)),
    ("警察与线人", "directed", 5, ("警察与线人",)),
    ("游戏师徒", "directed", 5, ("游戏师徒", "修仙师徒")),
    ("游戏公会会长与会员", "directed", 5, ("游戏公会会长与会员",)),
    ("AI与使用者", "directed", 5, ("ai与使用者",)),
    ("元宇宙好友", "bidirectional", 4, ("元宇宙好友",)),
    ("论坛版主与网友", "directed", 4, ("论坛版主与网友",)),
    ("群管理员与群成员", "directed", 4, ("群管理员与群成员",)),
    ("直播间房管与观众", "directed", 4, ("直播间房管与观众",)),
    ("游戏代练与雇主", "directed", 4, ("游戏代练与雇主",)),
    ("游戏陪玩与雇主", "directed", 4, ("游戏陪玩与雇主",)),
    ("宗族族长与族人", "directed", 4, ("宗族族长与族人", "宗族理事会成员与族人", "宗族祭祀组织者与族人", "宗族族谱编撰者与族人")),
    ("宗亲", "bidirectional", 4, ("宗亲", "宗亲会会长与宗亲")),
]


def _contains_any(source_norm: str, keywords: tuple[str, ...] | list[str]) -> bool:
    return any(_normalize_relation_type(key) in source_norm for key in keywords if key)


def _guess_relation_direction(label: str, section: str = "") -> str:
    text_norm = _normalize_relation_type(label)
    section_norm = _normalize_relation_type(section)
    has_directed_hint = _contains_any(text_norm, _DIRECTED_HINT_WORDS)
    has_bidir_hint = _contains_any(text_norm, _BIDIRECTIONAL_HINT_WORDS)

    if has_directed_hint and not has_bidir_hint:
        return "directed"
    if has_bidir_hint and not has_directed_hint:
        return "bidirectional"
    if has_directed_hint and has_bidir_hint:
        return "directed"

    if _contains_any(section_norm, ("朋友社交",)):
        return "bidirectional"
    if _contains_any(section_norm, ("情感婚恋",)):
        return "bidirectional"
    if _contains_any(section_norm, ("血缘亲属", "婚姻姻亲", "收养与干亲", "校园师承", "职场商业", "社会服务关系", "身份与公共关系", "剧情与特殊关系", "网络与虚拟关系", "文化地域特色关系")):
        return "directed"

    if _contains_any(text_norm, ("与", "和")):
        return "directed"
    return "unknown"


def _load_reference_relation_rules() -> list[tuple[str, str, str, int]]:
    candidates = [
        Path(__file__).resolve().parents[2] / "参考" / "人物关系大全500种.txt.md",
        Path.cwd() / "参考" / "人物关系大全500种.txt.md",
    ]
    ref_path = next((item for item in candidates if item.exists()), None)
    if ref_path is None:
        return []

    try:
        content = ref_path.read_text(encoding="utf-8")
    except Exception:
        return []

    section = ""
    seen: set[str] = set()
    rules: list[tuple[str, str, str, int]] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("## "):
            section = stripped[3:].strip()
            continue
        m = re.match(r"^\d+\.\s*(.+?)\s*$", stripped)
        if not m:
            continue
        label = str(m.group(1) or "").strip()
        if not label:
            continue
        label_norm = _normalize_relation_type(label)
        if not label_norm or label_norm in seen:
            continue
        seen.add(label_norm)
        direction = _guess_relation_direction(label, section)
        quality = 5 if direction != "unknown" else 4
        rules.append((label_norm, label, direction, quality))

    rules.sort(key=lambda item: len(item[1]), reverse=True)
    return rules


_REFERENCE_RELATION_RULES = _load_reference_relation_rules()
_REFERENCE_RELATION_MAP = {item[0]: (item[1], item[2], item[3]) for item in _REFERENCE_RELATION_RULES}


def _build_text_relation_keywords() -> tuple[str, ...]:
    words: set[str] = set()
    for _, _, _, keys in _KEYWORD_RELATION_RULES:
        for key in keys:
            token = str(key or "").strip()
            if 1 <= len(token) <= 10:
                words.add(token)
    for _, label, _, _ in _REFERENCE_RELATION_RULES:
        token = str(label or "").strip()
        if 1 <= len(token) <= 10:
            words.add(token)
    for weak in _WEAK_RELATION_LABELS:
        words.discard(weak)
    words.discard("关系")
    words.discard("关联")
    return tuple(sorted(words, key=len, reverse=True))


_TEXT_RELATION_KEYWORDS = _build_text_relation_keywords()


def _match_keyword_rule(text_norm: str) -> tuple[str, str, int] | None:
    for label, direction, quality, keywords in _KEYWORD_RELATION_RULES:
        if _contains_any(text_norm, keywords):
            return label, direction, quality
    return None


def _match_reference_rule(text_norm: str) -> tuple[str, str, int] | None:
    for label_norm, label, direction, quality in _REFERENCE_RELATION_RULES:
        if label_norm in text_norm:
            return label, direction, quality
    return None


def _classify_relation_label(raw_type: str, description: str) -> tuple[str, str, int]:
    raw = str(raw_type or "").strip()
    desc = str(description or "").strip()
    text_norm = _normalize_relation_type(f"{raw} {desc}")
    raw_norm = _normalize_relation_type(raw)

    has_breakup_signal = _contains_any(
        text_norm,
        (
            "分手",
            "已分手",
            "前任",
            "前男友",
            "前女友",
            "前夫",
            "前妻",
            "曾为情侣",
            "曾经恋人",
            "旧情",
            "昔日恋人",
            "感情破裂",
        ),
    )
    has_romance_signal = _contains_any(
        text_norm,
        (
            "恋人",
            "情侣",
            "男友",
            "女友",
            "情人",
            "伴侣",
            "婚外情",
            "暧昧",
            "相亲对象",
            "订婚对象",
            "相爱",
            "感情",
            "旧情",
            "复合",
        ),
    )

    # 若用户明确录入了500关系词典中的具体关系，优先按原标签输出。
    exact = _REFERENCE_RELATION_MAP.get(raw_norm)
    if exact is not None:
        exact_label = str(exact[0] or "")
        if has_breakup_signal and exact_label in {"恋人", "男友", "女友", "伴侣", "情侣"}:
            return "昔日恋人", "bidirectional", 5
        return exact

    # 分手/前任语义优先于“恋人”。
    if has_breakup_signal and has_romance_signal:
        return "昔日恋人", "bidirectional", 5

    # 先看实际文本语义（关系类型 + 描述），再用500常见关系词典补全。
    hit = _match_keyword_rule(text_norm)
    if hit is not None:
        return hit

    ref_hit = _match_reference_rule(text_norm)
    if ref_hit is not None:
        return ref_hit

    if _contains_any(text_norm, ("陌生", "点头之交", "不熟", "偶遇", "萍水相逢")):
        return "陌生", "bidirectional", 2
    if _contains_any(text_norm, ("表面和谐", "表面友好", "客套", "貌合神离", "逢场作戏")):
        return "貌合神离", "bidirectional", 3
    if _contains_any(text_norm, ("亲属", "家人", "亲戚", "血缘")):
        return "亲属（待细分）", "bidirectional", 1

    # 兜底：保留用户自定义关系，不把非常见关系强行覆盖。
    if raw and raw_norm not in _RELATION_NOISE_TYPES and len(raw) <= 30:
        guessed = _guess_relation_direction(raw)
        quality = 3 if guessed != "unknown" else 2
        return raw, guessed, quality
    return "其他关联", "unknown", 0


def _infer_identity_relation(identity_text: str, target_name: str) -> tuple[str, str, str] | None:
    source = str(identity_text or "")
    target = str(target_name or "").strip()
    if not source.strip() or not target:
        return None

    # 严格模板：`某某的XXX`，再交由关系分类器判定。
    m = re.search(rf"{re.escape(target)}的([^，。；、\s]{{1,14}})", source)
    if not m:
        return None

    rel = str(m.group(1) or "").strip()
    if not rel:
        return None

    relation_type, direction, quality = _classify_relation_label(rel, "")
    if quality < 3:
        return None
    if direction == "unknown":
        direction = "directed"
    return relation_type, direction, rel


def _infer_content_relation_between_names(
    paragraph: str,
    name_a: str,
    name_b: str,
) -> tuple[str, str, int, str, str, str] | None:
    text = str(paragraph or "").strip()
    a = str(name_a or "").strip()
    b = str(name_b or "").strip()
    if not text or not a or not b or a == b:
        return None
    if a not in text or b not in text:
        return None

    # 方向明确：A是B的XX / B是A的XX
    pattern_a_to_b = re.search(
        rf"{re.escape(a)}[^。！？；\n]{{0,18}}(?:是|为|算是|作为)?{re.escape(b)}的([^，。！？；、\s]{{1,12}})",
        text,
    )
    if pattern_a_to_b:
        rel_word = str(pattern_a_to_b.group(1) or "").strip()
        rel_type, rel_dir, quality = _classify_relation_label(rel_word, text)
        if quality >= 3:
            direction = "directed" if rel_dir == "unknown" else rel_dir
            return rel_type, direction, quality, rel_word, a, b

    pattern_b_to_a = re.search(
        rf"{re.escape(b)}[^。！？；\n]{{0,18}}(?:是|为|算是|作为)?{re.escape(a)}的([^，。！？；、\s]{{1,12}})",
        text,
    )
    if pattern_b_to_a:
        rel_word = str(pattern_b_to_a.group(1) or "").strip()
        rel_type, rel_dir, quality = _classify_relation_label(rel_word, text)
        if quality >= 3:
            direction = "directed" if rel_dir == "unknown" else rel_dir
            return rel_type, direction, quality, rel_word, b, a

    # 对称关系：A和B是同学/搭档/盟友...
    pair_pattern = re.search(
        rf"{re.escape(a)}[^。！？；\n]{{0,8}}(?:与|和|跟){re.escape(b)}[^。！？；\n]{{0,12}}(?:是|为)?([^，。！？；、\s]{{1,12}})",
        text,
    )
    if pair_pattern:
        rel_word = str(pair_pattern.group(1) or "").strip()
        rel_type, rel_dir, quality = _classify_relation_label(rel_word, text)
        if quality >= 3 and rel_dir == "bidirectional":
            return rel_type, "bidirectional", quality, rel_word, a, b

    # 兜底：若段落同时提到两人且出现明确双向关系词，允许推断。
    for rel_word in _TEXT_RELATION_KEYWORDS:
        if rel_word and rel_word in text:
            rel_type, rel_dir, quality = _classify_relation_label(rel_word, text)
            if quality >= 4 and rel_dir == "bidirectional":
                return rel_type, "bidirectional", quality, rel_word, a, b

    return None


@router.get("/relations")
def get_relation_graph(
    project_id: str,
    include_evidence: bool = True,
    max_evidence_per_edge: int = 2,
    view_mode: str = "global",
    chapter_id: str = "",
):
    pid = str(project_id or "").strip()
    if not pid:
        raise HTTPException(400, "project_id 不能为空")

    mode = str(view_mode or "global").strip().lower()
    if mode not in {"global", "chapter"}:
        raise HTTPException(400, "view_mode 仅支持 global 或 chapter")
    requested_chapter_id = str(chapter_id or "").strip()

    safe_evidence_limit = max(0, min(5, int(max_evidence_per_edge or 2)))

    with get_db() as db:
        project = db.execute("SELECT id, name FROM projects WHERE id = ?", (pid,)).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在")

        chapter_rows = db.execute(
            "SELECT id, chapter_num, title FROM chapters WHERE project_id = ? "
            "ORDER BY chapter_num ASC, sort_order ASC, created_at ASC",
            (pid,),
        ).fetchall()
        chapter_meta = [dict(r) for r in chapter_rows]
        selected_chapter_id = ""
        selected_chapter_num = 0
        selected_chapter_title = ""
        if mode == "chapter" and chapter_meta:
            selected = None
            if requested_chapter_id:
                selected = next((r for r in chapter_meta if str(r.get("id", "")) == requested_chapter_id), None)
                if selected is None:
                    raise HTTPException(404, "章节不存在")
            else:
                selected = chapter_meta[0]
            selected_chapter_id = str(selected.get("id", ""))
            selected_chapter_num = int(selected.get("chapter_num", 0) or 0)
            selected_chapter_title = str(selected.get("title", "") or "").strip()

        characters = db.execute(
            "SELECT id, name, category, gender, age, identity, personality "
            "FROM characters WHERE project_id = ? "
            "ORDER BY sort_order ASC, created_at ASC",
            (pid,),
        ).fetchall()

        relations = db.execute(
            "SELECT cr.id, cr.character_a_id, cr.character_b_id, cr.relation_type, cr.description, "
            "ca.name AS name_a, cb.name AS name_b "
            "FROM character_relations cr "
            "JOIN characters ca ON ca.id = cr.character_a_id "
            "JOIN characters cb ON cb.id = cr.character_b_id "
            "WHERE ca.project_id = ? AND cb.project_id = ? "
            "ORDER BY cr.created_at ASC",
            (pid, pid),
        ).fetchall()

        char_rows: list[dict[str, Any]] = [dict(row) for row in characters]

        relation_count: dict[str, int] = {}
        explicit_pair_keys: set[tuple[str, str]] = set()

        def _bump_degree(a_id: str, b_id: str) -> None:
            relation_count[a_id] = relation_count.get(a_id, 0) + 1
            relation_count[b_id] = relation_count.get(b_id, 0) + 1

        relation_rows: list[dict[str, Any]] = []
        for rel in relations:
            source = str(rel["character_a_id"])
            target = str(rel["character_b_id"])
            raw_type = str(rel["relation_type"] or "").strip()
            description = str(rel["description"] or "").strip()
            disp_type, hint_direction, quality = _classify_relation_label(raw_type, description)
            type_norm = _normalize_relation_type(disp_type)
            relation_rows.append(
                {
                    "id": str(rel["id"]),
                    "source": source,
                    "target": target,
                    "source_label": str(rel["name_a"] or "").strip(),
                    "target_label": str(rel["name_b"] or "").strip(),
                    "raw_type": raw_type,
                    "description": description,
                    "disp_type": disp_type,
                    "disp_type_norm": type_norm,
                    "hint_direction": hint_direction,
                    "quality": int(quality),
                }
            )
            explicit_pair_keys.add(tuple(sorted((source, target))))

        reciprocal_keys: set[tuple[str, str, str]] = set()
        for item in relation_rows:
            reciprocal_keys.add((item["source"], item["target"], item["disp_type_norm"]))

        explicit_edge_map: dict[tuple[str, str, str], dict[str, Any]] = {}
        for item in relation_rows:
            source = item["source"]
            target = item["target"]
            pair_sorted = tuple(sorted((source, target)))
            edge_key = (pair_sorted[0], pair_sorted[1], item["disp_type_norm"])

            direction = "directed"
            if item["hint_direction"] == "bidirectional":
                direction = "bidirectional"
            elif (target, source, item["disp_type_norm"]) in reciprocal_keys:
                direction = "bidirectional"

            if edge_key not in explicit_edge_map:
                explicit_edge_map[edge_key] = {
                    "id": item["id"],
                    "source": source,
                    "target": target,
                    "type": item["disp_type"],
                    "raw_type": item["raw_type"],
                    "description": _clip(item["description"], 180),
                    "source_label": item["source_label"],
                    "target_label": item["target_label"],
                    "direction": direction,
                    "relation_source": "explicit",
                    "quality": item["quality"],
                    "evidence": [],
                }
                continue

            existing = explicit_edge_map[edge_key]
            # 取更高质量的标签与更具体的描述。
            if item["quality"] > int(existing.get("quality", 0)):
                existing["type"] = item["disp_type"]
                existing["raw_type"] = item["raw_type"]
                existing["quality"] = item["quality"]
            if len(item["description"]) > len(str(existing.get("description", ""))):
                existing["description"] = _clip(item["description"], 180)
            if direction == "bidirectional":
                existing["direction"] = "bidirectional"

        edges: list[dict[str, Any]] = list(explicit_edge_map.values())

        # 同一对角色若已有明确关系，去掉“其他关联”这种弱标签，减少噪声。
        grouped_by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for edge in edges:
            pair = tuple(sorted((str(edge["source"]), str(edge["target"]))))
            grouped_by_pair.setdefault(pair, []).append(edge)

        cleaned_edges: list[dict[str, Any]] = []
        for pair_edges in grouped_by_pair.values():
            has_strong = any(int(e.get("quality", 0)) >= 3 for e in pair_edges)
            for edge in pair_edges:
                quality = int(edge.get("quality", 0))
                if quality <= 0:
                    continue
                if has_strong and str(edge.get("type", "")) in _WEAK_RELATION_LABELS:
                    continue
                cleaned_edges.append(edge)
        edges = cleaned_edges

        # 基于角色身份文本补充“可解释的推断关系”，解决例如“某角色是X的父亲”但未建关系边的场景。
        inferred_dedupe: set[tuple[str, str, str]] = set()
        names = [(str(row.get("id", "")), str(row.get("name", "")).strip()) for row in char_rows]
        names = [(cid, name) for cid, name in names if cid and name]
        names.sort(key=lambda item: len(item[1]), reverse=True)
        chapter_title_by_num = {
            int(item.get("chapter_num", 0) or 0): str(item.get("title", "") or "").strip()
            for item in chapter_meta
            if int(item.get("chapter_num", 0) or 0) > 0
        }

        for owner in char_rows:
            owner_id = str(owner.get("id", "")).strip()
            owner_name = str(owner.get("name", "")).strip()
            identity = str(owner.get("identity", "") or "")
            if not owner_id or not owner_name or not identity.strip():
                continue

            for target_id, target_name in names:
                if target_id == owner_id:
                    continue
                if target_name not in identity:
                    continue
                pair_key = tuple(sorted((owner_id, target_id)))
                if pair_key in explicit_pair_keys:
                    continue

                inferred = _infer_identity_relation(identity, target_name)
                if not inferred:
                    continue
                relation_type, direction, rel_word = inferred
                dedupe_key = (pair_key[0], pair_key[1], _normalize_relation_type(relation_type))
                if dedupe_key in inferred_dedupe:
                    continue
                inferred_dedupe.add(dedupe_key)

                edge_id = f"infer:{owner_id}:{target_id}:{_normalize_relation_type(rel_word)}"
                edge = {
                    "id": edge_id,
                    "source": owner_id,
                    "target": target_id,
                    "type": relation_type,
                    "raw_type": rel_word,
                    "description": _clip(f"身份推断：{owner_name}是{target_name}的{rel_word}。", 180),
                    "source_label": owner_name,
                    "target_label": target_name,
                    "direction": direction,
                    "relation_source": "identity_inferred",
                    "quality": 4,
                    "evidence": [],
                }
                edges.append(edge)
                _bump_degree(owner_id, target_id)

        # 基于正文内容自动识别关系（AI/规则融合推断），降低手工录入成本。
        existing_edge_dedupe: set[tuple[str, str, str]] = set()
        content_relation_chapters: dict[tuple[str, str, str], set[int]] = {}
        content_pair_chapter_types: dict[tuple[str, str], dict[int, set[str]]] = {}
        for edge in edges:
            source_id = str(edge.get("source") or "").strip()
            target_id = str(edge.get("target") or "").strip()
            rel_norm = _normalize_relation_type(str(edge.get("type") or ""))
            if not source_id or not target_id or not rel_norm:
                continue
            pair_sorted = tuple(sorted((source_id, target_id)))
            existing_edge_dedupe.add((pair_sorted[0], pair_sorted[1], rel_norm))

        para_limit = max(240, min(2000, len(char_rows) * 20))
        para_rows = db.execute(
            "SELECT ch.id AS chapter_id, ch.chapter_num, ch.title AS chapter_title, cp.para_index, cp.content "
            "FROM chapter_paragraphs cp "
            "JOIN chapters ch ON ch.id = cp.chapter_id "
            "WHERE ch.project_id = ? "
            "ORDER BY ch.chapter_num ASC, cp.para_index ASC "
            "LIMIT ?",
            (pid, para_limit),
        ).fetchall()

        for para in para_rows:
            text = str(para["content"] or "").strip()
            if len(text) < 6:
                continue
            mentioned: list[tuple[str, str]] = []
            for cid, cname in names:
                if cname in text:
                    mentioned.append((cid, cname))
                    if len(mentioned) >= 8:
                        break
            if len(mentioned) < 2:
                continue

            for idx in range(len(mentioned) - 1):
                for jdx in range(idx + 1, len(mentioned)):
                    a_id, a_name = mentioned[idx]
                    b_id, b_name = mentioned[jdx]
                    pair_key = tuple(sorted((a_id, b_id)))
                    if pair_key in explicit_pair_keys:
                        continue
                    inferred = _infer_content_relation_between_names(text, a_name, b_name)
                    if not inferred:
                        continue

                    relation_type, direction, quality, rel_word, src_name, tgt_name = inferred
                    if src_name == a_name and tgt_name == b_name:
                        source_id = a_id
                        target_id = b_id
                    elif src_name == b_name and tgt_name == a_name:
                        source_id = b_id
                        target_id = a_id
                    else:
                        continue

                    type_norm = _normalize_relation_type(relation_type)
                    chapter_num = int(para["chapter_num"] or 0)
                    if chapter_num > 0:
                        rel_key = (pair_key[0], pair_key[1], type_norm)
                        content_relation_chapters.setdefault(rel_key, set()).add(chapter_num)
                        pair_chapters = content_pair_chapter_types.setdefault(pair_key, {})
                        pair_chapters.setdefault(chapter_num, set()).add(relation_type)
                    dedupe_key = (pair_key[0], pair_key[1], type_norm)
                    if dedupe_key in existing_edge_dedupe:
                        continue
                    existing_edge_dedupe.add(dedupe_key)

                    chapter_title = str(para["chapter_title"] or "").strip()
                    para_index = int(para["para_index"] or 0)
                    edge_id = (
                        f"text:{str(para['chapter_id'])}:{para_index}:"
                        f"{source_id}:{target_id}:{_normalize_relation_type(rel_word)}"
                    )
                    edges.append(
                        {
                            "id": edge_id,
                            "source": source_id,
                            "target": target_id,
                            "type": relation_type,
                            "raw_type": rel_word,
                            "description": _clip(
                                f"正文推断：第{chapter_num}章《{chapter_title or '未命名'}》段落出现“{rel_word}”语义。",
                                180,
                            ),
                            "source_label": src_name,
                            "target_label": tgt_name,
                            "direction": direction,
                            "relation_source": "content_inferred",
                            "quality": int(quality),
                            "chapter_nums": [chapter_num] if chapter_num > 0 else [],
                            "evidence": [
                                {
                                    "chapter_id": str(para["chapter_id"]),
                                    "chapter_num": chapter_num,
                                    "chapter_title": chapter_title,
                                    "snippet": _clip(text, 180),
                                }
                            ],
                        }
                    )

        # 统一为最终输出补证据（只在需要时查库）
        if include_evidence and safe_evidence_limit > 0:
            for edge in edges:
                if edge.get("evidence"):
                    continue
                name_a = str(edge.get("source_label") or "").strip()
                name_b = str(edge.get("target_label") or "").strip()
                if not name_a or not name_b:
                    continue
                rows = db.execute(
                    "SELECT ch.id AS chapter_id, ch.chapter_num, ch.title AS chapter_title, cp.content "
                    "FROM chapter_paragraphs cp "
                    "JOIN chapters ch ON ch.id = cp.chapter_id "
                    "WHERE ch.project_id = ? AND instr(cp.content, ?) > 0 AND instr(cp.content, ?) > 0 "
                    "ORDER BY ch.chapter_num ASC, cp.para_index ASC "
                    "LIMIT ?",
                    (pid, name_a, name_b, safe_evidence_limit),
                ).fetchall()
                edge["evidence"] = [
                    {
                        "chapter_id": str(item["chapter_id"]),
                        "chapter_num": int(item["chapter_num"] or 0),
                        "chapter_title": str(item["chapter_title"] or "").strip(),
                        "snippet": _clip(str(item["content"] or ""), 180),
                    }
                    for item in rows
                ]

        # 聚合“章节维度”关系信息：首次出现、最近出现、变化章节。
        pair_mention_cache: dict[tuple[str, str], list[dict[str, Any]]] = {}

        def _load_pair_mentions(name_a: str, name_b: str) -> list[dict[str, Any]]:
            na = str(name_a or "").strip()
            nb = str(name_b or "").strip()
            if not na or not nb:
                return []
            key = tuple(sorted((na, nb)))
            if key in pair_mention_cache:
                return pair_mention_cache[key]
            rows = db.execute(
                "SELECT ch.id AS chapter_id, ch.chapter_num, ch.title AS chapter_title "
                "FROM chapter_paragraphs cp "
                "JOIN chapters ch ON ch.id = cp.chapter_id "
                "WHERE ch.project_id = ? AND instr(cp.content, ?) > 0 AND instr(cp.content, ?) > 0 "
                "GROUP BY ch.id, ch.chapter_num, ch.title "
                "ORDER BY ch.chapter_num ASC",
                (pid, key[0], key[1]),
            ).fetchall()
            result = [
                {
                    "chapter_id": str(item["chapter_id"]),
                    "chapter_num": int(item["chapter_num"] or 0),
                    "chapter_title": str(item["chapter_title"] or "").strip(),
                }
                for item in rows
                if int(item["chapter_num"] or 0) > 0
            ]
            pair_mention_cache[key] = result
            return result

        for edge in edges:
            source_label = str(edge.get("source_label") or "").strip()
            target_label = str(edge.get("target_label") or "").strip()
            mentions = _load_pair_mentions(source_label, target_label)
            chapter_nums = [int(item.get("chapter_num") or 0) for item in mentions if int(item.get("chapter_num") or 0) > 0]
            if str(edge.get("relation_source", "")) == "content_inferred":
                source_id = str(edge.get("source") or "").strip()
                target_id = str(edge.get("target") or "").strip()
                rel_norm = _normalize_relation_type(str(edge.get("type") or ""))
                rel_key = (*tuple(sorted((source_id, target_id))), rel_norm)
                rel_specific_nums = sorted(content_relation_chapters.get(rel_key, set()))
                if rel_specific_nums:
                    chapter_nums = rel_specific_nums
            edge["chapter_nums"] = chapter_nums
            if chapter_nums:
                edge["first_chapter_num"] = int(chapter_nums[0])
                edge["first_chapter_title"] = str(chapter_title_by_num.get(int(chapter_nums[0]), "") or "")
                edge["last_chapter_num"] = int(chapter_nums[-1])
                edge["last_chapter_title"] = str(chapter_title_by_num.get(int(chapter_nums[-1]), "") or "")
            else:
                edge["first_chapter_num"] = 0
                edge["first_chapter_title"] = ""
                edge["last_chapter_num"] = 0
                edge["last_chapter_title"] = ""

        pair_change_chapters: dict[tuple[str, str], list[int]] = {}
        for pair_key, chapter_map in content_pair_chapter_types.items():
            ordered = sorted(chapter_map.keys())
            prev_signature = ""
            changes: list[int] = []
            for cnum in ordered:
                signature = "|".join(sorted(chapter_map.get(cnum, set())))
                if prev_signature and signature != prev_signature:
                    changes.append(int(cnum))
                prev_signature = signature
            pair_change_chapters[pair_key] = changes

        for edge in edges:
            source_id = str(edge.get("source") or "").strip()
            target_id = str(edge.get("target") or "").strip()
            pair_key = tuple(sorted((source_id, target_id)))
            edge["change_chapter_nums"] = list(pair_change_chapters.get(pair_key, []))

        if mode == "chapter" and selected_chapter_num > 0:
            chapter_filtered: list[dict[str, Any]] = []
            for edge in edges:
                chapter_nums = [int(v) for v in edge.get("chapter_nums", []) if int(v) > 0]
                if selected_chapter_num in chapter_nums:
                    chapter_filtered.append(edge)
                    continue
                evidence_nums = [int(ev.get("chapter_num") or 0) for ev in edge.get("evidence", []) if int(ev.get("chapter_num") or 0) > 0]
                if selected_chapter_num in evidence_nums:
                    chapter_filtered.append(edge)
            edges = chapter_filtered

        # 度数按最终边集合重算（包含显式 + 推断 + 去噪后的结果）。
        relation_count.clear()
        for edge in edges:
            source_id = str(edge.get("source") or "").strip()
            target_id = str(edge.get("target") or "").strip()
            if source_id and target_id:
                _bump_degree(source_id, target_id)

        for edge in edges:
            if "quality" in edge:
                edge.pop("quality", None)

        node_id_filter: set[str] | None = None
        if mode == "chapter":
            node_id_filter = set()
            for edge in edges:
                source_id = str(edge.get("source") or "").strip()
                target_id = str(edge.get("target") or "").strip()
                if source_id:
                    node_id_filter.add(source_id)
                if target_id:
                    node_id_filter.add(target_id)

        nodes: list[dict[str, Any]] = []
        for row in char_rows:
            cid = str(row.get("id", ""))
            if node_id_filter is not None and cid not in node_id_filter:
                continue
            nodes.append(
                {
                    "id": cid,
                    "label": str(row.get("name", "")).strip() or "未命名角色",
                    "category": str(row.get("category", "")).strip() or "其他",
                    "gender": str(row.get("gender", "")).strip(),
                    "age": str(row.get("age", "")).strip(),
                    "identity": _clip(str(row.get("identity", "")).strip(), 120),
                    "personality": _clip(str(row.get("personality", "")).strip(), 120),
                    "degree": int(relation_count.get(cid, 0)),
                }
            )

    return {
        "project_id": pid,
        "project_name": str(project["name"] or "").strip(),
        "view": {
            "mode": mode,
            "chapter_id": selected_chapter_id if mode == "chapter" else "",
            "chapter_num": int(selected_chapter_num if mode == "chapter" else 0),
            "chapter_title": selected_chapter_title if mode == "chapter" else "",
        },
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "isolated_count": sum(1 for n in nodes if int(n.get("degree") or 0) == 0),
        },
    }
