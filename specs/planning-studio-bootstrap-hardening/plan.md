# Implementation Plan

## Phase 1: Backend API & Bootstrap Hardening
1. Add bible manual save endpoint:
   - `POST /api/pipeline/bible/save`
   - input: `project_id`, `content`, optional `brief`
   - output: same shape as `StoryBibleResponse`
2. Keep bootstrap full-output contract while hardening chapters:
   - normalize chapter payload
   - chapter-only fallback generation pass when chapters missing/invalid
   - fill missing chapter numbers with placeholders to guarantee continuity
3. Improve bootstrap response text:
   - include inserted + skipped summary for all 4 blocks

## Phase 2: Planning Studio UI State Persistence
1. Add per-project local storage cache for planning state:
   - conversation, questions, selected answers, ready flag, active panel, input content
2. Restore cached state on project load.
3. Keep mode selection persistence behavior.
4. Add backend snapshot sync:
   - fetch remote planning state on project load and reconcile by update time
   - debounce-save state snapshot to backend after local updates

## Phase 3: Bible Editable Flow in UI
1. Convert bible display area to editable textarea.
2. Add “保存圣经版本” and “还原到已保存版本” actions.
3. Add unsaved-change indicator.
4. Before bootstrap:
   - if dirty -> prompt save-first or continue-with-saved.

## Phase 3.5: Bible AI Revision Preview
1. Add backend route `POST /api/pipeline/bible/revise`:
   - input: `project_id`, `instruction`, `base_version`, `locked_sections`
   - output: `revised_content`, `changed_sections`, `change_summary`
2. Keep endpoint preview-only:
   - no direct save, no direct overwrite
   - preserve numbering structure and locked sections
3. Add bible panel revise UI:
   - instruction box + optional locked sections
   - before/after preview
   - explicit “应用到草稿” action

## Phase 4: Result Transparency
1. In bible panel, render last bootstrap inserted/skipped stats.
2. Keep toast messages for quick feedback.

## Phase 5: Question Option Refresh
1. Add backend endpoint to refresh options for a single planning question.
2. Add per-question refresh button in planning UI.
3. Keep current answer flow unchanged except refreshed question reset.

## Validation
1. `python -m py_compile agent/api/pipeline.py`
2. `npm run build`
3. Manual smoke checks:
   - edit bible -> save -> version increments
   - switch route -> planning state restored
   - one-click bootstrap produces chapter rows
