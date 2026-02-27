# Feature Spec: Planning Studio Persistence + Bible Edit Flow + Bootstrap Chapter Reliability

## Context
Current planning workflow supports:
- `brainstorm` Q&A
- story bible generation
- one-click bootstrap to `大纲/角色/世界观/章节`

Observed issues from real usage:
- planning panel context is lost after page switch
- bible can be generated but not edited/saved as an explicit version step
- bootstrap may complete while `chapters` remains empty
- users cannot easily see structured bootstrap result stats in panel UI

## Goals
1. Keep planning conversation/state recoverable per project after route switch/reopen.
2. Make story bible an editable artifact with explicit save-to-new-version.
3. Ensure one-click bootstrap can reliably output chapter rows.
4. Make bootstrap result visible in panel (not toast-only).
5. Keep existing model/runtime settings and existing routes backward compatible.

## Non-Goals
- Rebuild planning UX into a new screen.
- Introduce new DB tables for draft management.
- Force-overwrite existing structured content by default.

## Functional Requirements
1. Planning state persistence:
   - Save and restore per-project planning session in local storage:
     - messages, pending questions, selected answers, input box text, panel mode, ready flag.
   - Add backend persistence for planning studio state:
     - `GET /api/pipeline/planning-state?project_id=...`
     - `POST /api/pipeline/planning-state`
     - Store/recover per-project state snapshot so route/panel switching is recoverable even when local cache is unavailable.
2. Bible edit/save workflow:
   - Bible panel supports editing text directly.
   - Add explicit “保存圣经版本” action via API.
   - Saving bible creates next version in `story_bibles`.
   - Show dirty/unsaved status.
   - Add “AI改写预览” workflow:
     - input instruction + optional locked section ids
     - call `POST /api/pipeline/bible/revise` for local revision preview
     - return `revised_content`, `changed_sections`, `change_summary`
     - user explicitly applies preview to draft; no direct overwrite/save
     - keep section numbering structure stable and preserve locked sections.
3. Bootstrap preflight:
   - If bible has unsaved edits, user can choose:
     - save first then bootstrap, or
     - continue with latest saved bible version.
4. Chapter reliability:
   - Bootstrap keeps full 4-block output contract.
   - If bootstrap payload has empty/invalid chapters, run chapter-only fallback generation.
   - If chapter fallback still incomplete, fill missing chapter numbers with safe placeholders (non-destructive defaults).
5. Visible result:
   - Planning bible panel displays inserted/skipped counts after bootstrap.
6. Question option refresh:
   - Each single/multi planning question supports one-click option refresh.
   - Refresh updates only that question’s options without resetting other questions.

## Safety / Quality Constraints
- Do not reduce output scope or remove 4-block contract.
- Do not delete existing rows unless explicit `force=true`.
- Preserve existing API behavior for callers not using new fields/routes.

## Acceptance Criteria
- Route switch does not lose planning session for same project.
- Edited bible can be saved to a higher version number and reused by bootstrap.
- Bootstrap no longer ends with zero chapter rows when scope includes chapters (fallback guarantees rows).
- Panel shows structured bootstrap result stats for user verification.
