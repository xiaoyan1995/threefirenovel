# Tasks

## P0 Foundation
- [x] Add migration for `memory_chunks` runtime alignment.
- [x] Update base `schema.sql` to include runtime memory fields.
- [x] Validate migration on existing AppData DB and cold-start DB.
- [x] Add regression check script for memory write/search path.

## P1 Knowledge Import MVP
- [x] Add DB migration for knowledge tables.
- [x] Add collection(folder) CRUD API.
- [x] Implement `POST /api/knowledge/import` (text first).
- [x] Add single-file `reference_type` tagging (`character/plot/scene/world/hook/general`).
- [x] Chunk and store imported content into memory (`source_type=knowledge`).
- [x] Implement profile extraction endpoint (LLM -> JSON).
- [x] Implement profile binding endpoints.

## P2 Runtime Injection
- [x] Inject active profile in `/api/pipeline/bootstrap`.
- [x] Inject active profile in chapter writer flow.
- [x] Add safe clipping and parse fallback.

## P3 UI
- [x] Add knowledge/profile section in `Settings`.
- [x] Add active-profile badge in `Workshop`.
- [x] Add user feedback toasts for import/extract/bind.

## Done Definition
- [x] Existing projects continue to run without manual DB surgery.
- [x] Imported corpus（任意题材）可以产出并应用对应规则包（如推理/言情/玄幻）。
- [x] Toggle profile on/off shows observable generation difference.
