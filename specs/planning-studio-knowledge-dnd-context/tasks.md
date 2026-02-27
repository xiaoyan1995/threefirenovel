# Tasks

## Backend
- [x] Extend `BrainstormRequest` with `selected_source_ids`.
- [x] Extend `GenerateBibleRequest` with `selected_source_ids`.
- [x] Add helper to load selected enabled knowledge sources.
- [x] Add helper to build clipped knowledge context block.
- [x] Inject selected knowledge + active profile blocks into `/brainstorm`.
- [x] Inject selected knowledge + active profile blocks into `/bible/generate`.

## Frontend - Knowledge Page
- [x] Add draggable source payload on card items.
- [x] Add draggable source payload on list items.

## Frontend - Planning Studio
- [x] Add knowledge source/active profile loading state.
- [x] Add selected knowledge source ids state + persistence.
- [x] Add planning drop zone for knowledge payload and local files.
- [x] Implement local file import via `/api/knowledge/import-file` in planning page.
- [x] Display active profile and selected references in planning panel.
- [x] Send `selected_source_ids` in brainstorm request.
- [x] Send `selected_source_ids` in bible generate request.
- [x] Reorder bible panel: preview compare first, rewrite input block at bottom.

## Verification
- [x] `python -m py_compile agent/api/pipeline.py` passes.
- [x] `npm run build` passes.
- [ ] Manual drag/import + context-injection smoke passes.
