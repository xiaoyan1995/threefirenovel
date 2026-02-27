# Feature Spec: Knowledge -> Skill Profile -> Runtime Injection

## Context
Current project already has:
- project-level planning pipeline (`brainstorm` / `story bible` / `bootstrap`)
- agent workflow and retrieval hooks
- long-memory infra (`memory_chunks` + Chroma collections)

The requested capability is:
1) import reference novels/materials,
2) auto-extract domain writing rules (e.g. detective fiction),
3) auto-apply those rules during generation.

## Goals
- Keep existing memory system unchanged in behavior.
- Add a reusable domain-skill layer on top of current pipeline.
- Ensure backward compatibility for existing local databases.

## Non-Goals
- Full BMAD runtime integration.
- Replacing current workflow/pipeline endpoints.
- Style imitation of copyrighted source text.

## Functional Requirements
1. Memory compatibility hardening:
   - `memory_chunks` schema must match runtime usage fields.
   - Existing databases must migrate without data loss.
2. Knowledge import:
   - User can create "资料集（文件夹）" as collections.
   - User can import text/markdown/pdf-derived text as single-file knowledge sources under collections (or root).
   - Single files carry `reference_type` tags: `character/plot/scene/world/hook/general`.
   - Imported content is chunked and indexed into existing retrieval layer.
3. Skill profile extraction:
   - System can generate structured "genre/domain skill profile" from a collection or selected files.
   - Profile format is machine-readable JSON and versioned.
4. Project binding:
   - A project can bind one active skill profile (optional).
   - Binding can be switched/disabled.
5. Runtime injection:
   - During `bootstrap` and chapter generation, active profile rules are injected as constraints.
6. Transparency:
   - UI can show active profile name/version and last extraction status.

## Safety / Quality Constraints
- Only inject abstracted rules and compact examples, not long source passages.
- Keep retrieval/token overhead bounded.
- On profile parse failure, fallback to default generation path.

## Acceptance Criteria
- No `memory_chunks` column mismatch errors on existing user DB.
- Importing any genre collection can produce a valid corresponding writing-rule profile (e.g. 推理/言情/玄幻).
- With profile enabled, chapter generation prompt includes profile constraints.
- With profile disabled, behavior equals current baseline.
