"""焱书 Agent Service - FastAPI 入口"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from db import get_data_dir, get_db_path, get_db_with_path, init_db, set_db_path
from agents.router import agent_router, close_services
from rag.search import rag_router
from api.projects import router as projects_router
from api.chapters import router as chapters_router
from api.characters import router as characters_router
from api.content import router as content_router
from api.settings import router as settings_router
from api.beats import router as beats_router
from api.ner import router as ner_router
from api.conflict import router as conflict_router
from api.debate_room import router as debate_router
from api.butterfly import router as butterfly_router
from api.agents_chat import router as agents_chat_router
from api.pipeline import router as pipeline_router
from api.knowledge import router as knowledge_router
from api.graph import router as graph_router

LOCAL_TOKEN_HEADER = "X-Sanhuoai-Token"
LOCAL_TOKEN_ENV_KEY = "SANHUOAI_LOCAL_API_TOKEN"
LOCAL_TOKEN_DB_ENABLED_KEY = "local_api_auth_enabled"
LOCAL_TOKEN_DB_TOKEN_KEY = "local_api_auth_token"
AUTH_EXEMPT_PATHS = {"/health"}


def _resolve_cors_origins() -> list[str]:
    raw = os.environ.get("SANHUOAI_CORS_ORIGINS", "").strip()
    if raw:
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        if origins:
            return origins
    return [
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "http://127.0.0.1:1421",
        "http://localhost:1421",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库"""
    app.state.startup_ok = False
    app.state.startup_error = ""
    data_dir = get_data_dir()
    db_path = os.path.join(data_dir, "sanhuoai.db")
    set_db_path(db_path)

    # 查找 schema.sql
    schema_candidates = [
        os.path.join(os.path.dirname(__file__), "..", "database", "schema.sql"),
        os.path.join(os.path.dirname(__file__), "schema.sql"),
    ]
    schema_path = None
    for p in schema_candidates:
        if os.path.exists(p):
            schema_path = p
            break

    try:
        # 先进行基础的 schema 初始化
        init_db(schema_path)
        print("[System] Database initialized successfully.")
        
        # 随后执行增量迁移
        from migrate_db import run_migrations
        run_migrations(db_path)
        print("[System] Database migrations applied successfully.")
        app.state.startup_ok = True
    except Exception as e:
        print(f"[Error] Failed to initialize database: {e}")
        app.state.startup_error = str(e)
        # 在真实环境中这里可能需要中断启动，但由于使用了 sqlite，先尽力启动
    
    try:
        yield
    finally:
        close_services()


app = FastAPI(title="焱书 Agent Service", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_truthy(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_local_api_token() -> tuple[str, bool]:
    env_token = os.environ.get(LOCAL_TOKEN_ENV_KEY, "").strip()
    if env_token:
        return env_token, True

    db_path = get_db_path()
    if not db_path:
        return "", False

    try:
        with get_db_with_path(db_path) as db:
            rows = db.execute(
                "SELECT key, value FROM global_settings WHERE key IN (?, ?)",
                (LOCAL_TOKEN_DB_ENABLED_KEY, LOCAL_TOKEN_DB_TOKEN_KEY),
            ).fetchall()
        values = {r["key"]: str(r["value"] or "").strip() for r in rows}
        enabled = _is_truthy(values.get(LOCAL_TOKEN_DB_ENABLED_KEY, "0"))
        token = values.get(LOCAL_TOKEN_DB_TOKEN_KEY, "").strip()
        if enabled and token:
            return token, True
    except Exception:
        return "", False

    return "", False


@app.middleware("http")
async def local_api_auth_middleware(request: Request, call_next):
    """可选本地接口鉴权：默认关闭，可由环境变量或设置页开启。"""
    token, enabled = _resolve_local_api_token()
    if not enabled:
        return await call_next(request)

    if request.method == "OPTIONS" or request.url.path in AUTH_EXEMPT_PATHS:
        return await call_next(request)

    provided = request.headers.get(LOCAL_TOKEN_HEADER, "").strip()
    if not provided or provided != token:
        return JSONResponse(
            status_code=401,
            content={
                "status": "error",
                "message": f"Missing or invalid {LOCAL_TOKEN_HEADER}",
            },
        )

    return await call_next(request)

# Agent 工作流
app.include_router(agent_router, prefix="/agent", tags=["agent"])
# RAG 检索
app.include_router(rag_router, prefix="/rag", tags=["rag"])
# CRUD API
app.include_router(projects_router, prefix="/api/projects", tags=["projects"])
app.include_router(chapters_router, prefix="/api/chapters", tags=["chapters"])
app.include_router(characters_router, prefix="/api/characters", tags=["characters"])
app.include_router(content_router, prefix="/api/content", tags=["content"])
app.include_router(settings_router, prefix="/api/settings", tags=["settings"])
app.include_router(beats_router)
app.include_router(ner_router, prefix="/api/ner", tags=["ner"])
app.include_router(conflict_router, prefix="/api/conflict", tags=["conflict"])
app.include_router(debate_router, prefix="/api/debate", tags=["debate"])
app.include_router(butterfly_router, prefix="/api/butterfly", tags=["butterfly"])
app.include_router(agents_chat_router, prefix="/api/agents", tags=["agents"])
app.include_router(pipeline_router, prefix="/api/pipeline", tags=["pipeline"])
app.include_router(knowledge_router, prefix="/api/knowledge", tags=["knowledge"])
app.include_router(graph_router, prefix="/api/graph", tags=["graph"])


@app.get("/health")
def health_check():
    """健康检查端点，供 Tauri 轮询判断 Agent 是否就绪"""
    if getattr(app.state, "startup_ok", False):
        return {"status": "ok", "version": "0.1.0"}
    return JSONResponse(
        status_code=503,
        content={
            "status": "error",
            "version": "0.1.0",
            "message": getattr(app.state, "startup_error", "startup not ready"),
        },
    )
