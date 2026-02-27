"""导入/图谱轻量回归脚本（不依赖前端）"""
from __future__ import annotations

import time
from typing import Any

from db import get_db
from api.projects import _decode_text_bytes, _parse_plain_text_to_chapters, _insert_plain_text_as_project
from api.graph import get_relation_graph


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _test_decode_and_parse() -> None:
    utf8_text = "第1章 开场\n这是第一段。\n\n这是第二段。".encode("utf-8")
    gbk_text = "第2章 转折\n这里是GBK文本。".encode("gbk", errors="ignore")
    _assert("第1章" in _decode_text_bytes(utf8_text), "utf-8 解码失败")
    _assert("第2章" in _decode_text_bytes(gbk_text), "gbk 解码失败")

    chapters = _parse_plain_text_to_chapters(
        "第1章 开端\n甲。\n\n乙。\n\n第2章 反转\n丙。\n\n丁。"
    )
    _assert(len(chapters) >= 2, "章节解析失败")
    _assert("开端" in chapters[0]["title"], "章节标题解析失败")


def _test_import_smoke() -> dict[str, Any]:
    text = (
        "第1章 初到异界\n"
        "林舟醒来时，雨水顺着破庙瓦缝滴在眉心。\n\n"
        "他摸到腰间陌生玉牌，背面刻着‘归路已断’。\n\n"
        "第2章 暗线浮现\n"
        "镇口告示写着三日后封城，所有外来者需登记。\n\n"
        "林舟看见告示角落的暗记，与玉牌纹路一致。"
    )
    result = _insert_plain_text_as_project(text, project_name="SMOKE_IMPORT_TMP")
    project_id = str(result["project_id"])

    with get_db() as db:
        row = db.execute(
            "SELECT COUNT(*) AS c FROM chapters WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        chapter_count = int(row["c"] or 0) if row else 0

        row = db.execute(
            "SELECT COUNT(*) AS c FROM chapter_paragraphs "
            "WHERE chapter_id IN (SELECT id FROM chapters WHERE project_id = ?)",
            (project_id,),
        ).fetchone()
        para_count = int(row["c"] or 0) if row else 0

        row = db.execute(
            "SELECT COUNT(*) AS c FROM memory_chunks WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        memory_count = int(row["c"] or 0) if row else 0

        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    _assert(chapter_count >= 2, "导入后章节数异常")
    _assert(para_count >= 4, "导入后段落数异常")
    # memory_count 受本机 embedding 环境影响，允许为 0，但输出供人工确认。
    return {
        "project_id": project_id,
        "chapter_count": chapter_count,
        "paragraph_count": para_count,
        "memory_count": memory_count,
    }


def _test_relation_graph_perf() -> dict[str, Any]:
    with get_db() as db:
        row = db.execute(
            "INSERT INTO projects (name, genre, description) VALUES (?,?,?) RETURNING id",
            ("SMOKE_GRAPH_TMP", "测试", "关系图谱性能烟测"),
        ).fetchone()
        project_id = str(row["id"])

        char_ids: list[str] = []
        for idx in range(1, 121):
            c = db.execute(
                "INSERT INTO characters (project_id, name, category, identity, personality, sort_order) "
                "VALUES (?,?,?,?,?,?) RETURNING id",
                (
                    project_id,
                    f"角色{idx}",
                    "配角" if idx % 5 else "主角",
                    f"身份{idx}",
                    f"性格{idx}",
                    idx,
                ),
            ).fetchone()
            char_ids.append(str(c["id"]))

        rel_count = 0
        for idx in range(0, len(char_ids) - 1):
            if idx % 2 == 0:
                db.execute(
                    "INSERT INTO character_relations (character_a_id, character_b_id, relation_type, description) "
                    "VALUES (?,?,?,?)",
                    (char_ids[idx], char_ids[idx + 1], "同盟", f"关系{idx}"),
                )
                rel_count += 1
            if idx + 5 < len(char_ids) and idx % 3 == 0:
                db.execute(
                    "INSERT INTO character_relations (character_a_id, character_b_id, relation_type, description) "
                    "VALUES (?,?,?,?)",
                    (char_ids[idx], char_ids[idx + 5], "对立", f"冲突{idx}"),
                )
                rel_count += 1

    start = time.perf_counter()
    payload = get_relation_graph(project_id=project_id, include_evidence=False, max_evidence_per_edge=0)
    elapsed_ms = (time.perf_counter() - start) * 1000

    with get_db() as db:
        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))

    _assert(int(payload["stats"]["node_count"]) == 120, "图谱节点数异常")
    _assert(int(payload["stats"]["edge_count"]) == rel_count, "图谱边数异常")
    return {
        "project_id": project_id,
        "node_count": int(payload["stats"]["node_count"]),
        "edge_count": int(payload["stats"]["edge_count"]),
        "elapsed_ms": round(elapsed_ms, 2),
    }


def main() -> None:
    print("[SMOKE] decode/parse...")
    _test_decode_and_parse()
    print("[SMOKE] decode/parse OK")

    print("[SMOKE] import plain-text project...")
    import_result = _test_import_smoke()
    print("[SMOKE] import OK", import_result)

    print("[SMOKE] relation graph perf...")
    perf_result = _test_relation_graph_perf()
    print("[SMOKE] graph perf OK", perf_result)

    print("[SMOKE] all checks passed")


if __name__ == "__main__":
    main()

