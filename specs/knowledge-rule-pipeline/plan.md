# Implementation Plan

## Phase 0: Foundation Stabilization (must-pass)
1. Align `memory_chunks` schema and migration.
2. Verify long-memory write/read paths:
   - `ChunkManager.add_chunk`
   - `/rag/search`
   - workflow `store_memory`

## Phase 1: Knowledge Import MVP
1. DB:
   - `knowledge_collections` (folder-level datasets)
   - `knowledge_sources` (id, project_id, title, content, metadata, created_at)
     - extend with `collection_id`, `reference_type`, `enabled`
   - `knowledge_profiles` (id, project_id, name, genre, version, profile_json, source_ids, created_at)
   - `project_profile_binding` (project_id, profile_id, enabled, updated_at)
2. API:
   - collection CRUD endpoints
   - `POST /api/knowledge/import` (raw text import for MVP)
   - `POST /api/knowledge/profile/extract`
   - `GET /api/knowledge/profile/active`
   - `POST /api/knowledge/profile/bind`
3. Retrieval integration:
   - imported chunks use existing `ChunkManager.add_chunk(source_type="knowledge")`.

## Phase 2: Runtime Injection
1. `bootstrap` pipeline:
   - append active profile constraints to generation prompt.
2. chapter generation workflow:
   - append compact profile constraints to chapter planner + writer prompts.
   - append typed single-file references (`character/plot/scene/world/hook`) as prompt context.
3. guardrails:
   - token clipping
   - parse fallback to baseline behavior.

## Phase 3: UI Surface
1. Settings page:
   - import textarea/file pipeline entry
   - extract profile action
   - active profile switch
2. Workshop indicator:
   - show active profile label/version.

## Rollout Strategy
1. Ship Phase 0 first (safe migration).
2. Release Phase 1+2 under feature flag (`profile_enabled` per project).
3. Enable UI (Phase 3) after backend path is stable.
