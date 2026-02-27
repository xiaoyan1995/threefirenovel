# Tasks

## Backend
- [x] Add `SaveBibleRequest` and `POST /api/pipeline/bible/save`.
- [x] Add chapter normalization helpers in bootstrap flow.
- [x] Add chapter-only fallback generation when chapters are empty/invalid.
- [x] Ensure chapter continuity (1..N) with safe placeholders if needed.
- [x] Include skipped summary in bootstrap response message.
- [x] Add `planning_studio_states` table and `GET/POST /api/pipeline/planning-state` for per-project state snapshot persistence.
- [x] Add `ReviseBibleRequest`/`ReviseBibleResponse` and `POST /api/pipeline/bible/revise`.
- [x] Add bible revise guards: locked sections, numbering-structure coercion, changed-sections detection fallback.

## Frontend
- [x] Add planning state local cache (per project).
- [x] Restore planning cache on project load.
- [x] Add bible editable textarea and unsaved state indicator.
- [x] Add “保存圣经版本” + “还原到已保存版本”.
- [x] Add bootstrap preflight prompt for unsaved bible edits.
- [x] Show bootstrap inserted/skipped stats in bible panel.
- [x] Add per-question “刷新选项” button for single/multi questions.
- [x] Sync planning state snapshot with backend (load + debounce save) and reconcile by latest update time.
- [x] Add bible panel “对话改写” input + optional locked sections input.
- [x] Add “AI改写预览” before/after comparison, then explicit “应用到草稿” flow.

## Verification
- [x] Python compile passes.
- [x] Frontend build passes.
- [ ] Manual functional smoke checks pass.

## Additional
- [x] Add backend route `POST /api/pipeline/brainstorm/options/refresh`.
