# Full-Spectrum Automation Improvement Plan

This plan turns the current Brow automation pipeline into a fuller browser automation system while keeping MV3 DOM-derived refs as the default path. Identity storage and identity-based filling are explicitly out of scope for this plan.

## Current Pipeline

- `browser_snapshot` captures a compact visible-page view with refs, role/name text, bounds, selectors, and selected attributes.
- Browser actions resolve refs through the snapshot engine, execute with MV3 DOM event synthesis, then return a fresh compact snapshot.
- Brow Action Memory can replay successful ref resolutions when the agent passes a stable intent.
- Workflow Demonstrations can provide Target Evidence and Pointer Evidence for adaptive replay.
- WebMCP Page Tools are preferred when a page exposes a semantic API.
- VLM tools are perception-only and should not choose raw click coordinates.

## Target Architecture

Brow should use a family of specialized semantic tools around the compact Browser Snapshot:

- `browser_find_targets`: rank likely targets for an intent and return Target Evidence candidates.
- `browser_form_snapshot`: return whole-form structure, Field Purpose, Safe Field Values, validation cues, submit controls, and fill-target refs.
- `browser_region_snapshot`: return an interaction map for canvas, SVG, map, board, video, and drawing-like surfaces.
- `browser_frame_snapshot`: expose frame boundaries and identify when helper-backed inspection is required.

Execution remains ref-backed:

- MV3 DOM refs are the default backend.
- A local helper backend is a first-class fallback for native pointer fidelity, file selection, downloads, cross-origin frames, native dialogs, and hard drawing/canvas cases.
- Tool visibility and execution permission are separate: the model can plan with automation tools, while execution remains approval-gated.

## Phase 1: Form Semantics

Implement `browser_form_snapshot` first because it exercises the semantic pipeline without requiring the helper backend.

Status: initial MV3-backed slice implemented. The tool now returns whole-document form controls with purpose evidence, safe value capture/omission, validation cues, submit refs, and fill-target refs backed by the existing Browser Snapshot registry.

Code changes:

- Add shared types for `FormSnapshot`, `FormSnapshotForm`, `FormSnapshotField`, `FieldPurpose`, `FieldPurposeEvidence`, and `SafeFieldValue`.
- Add a content-script form snapshot engine beside `browser-snapshot-engine.ts`.
- Add a sidepanel tab tool wrapper and LangChain tool definition.
- Update prompt guidance so the agent uses `browser_form_snapshot` before filling forms.
- Keep `browser_fill_form` as the executor; do not create a new fill executor yet.

Form snapshot behavior:

- Include whole-form fields, including hidden and offscreen fields as metadata.
- Mark only visible, enabled, user-meaningful fields as fill targets by default.
- Infer Field Purpose from labels, `autocomplete`, `name`, `id`, placeholder, ARIA, and surrounding text.
- Return evidence and confidence; ambiguous fields should be `unknown`.
- Expose Safe Field Values only; omit password, file, token, one-time-code, credit-card-like, and other sensitive values.
- Include submit controls and likely postconditions when detectable.

Tests:

- Unit-test field purpose inference.
- Unit-test safe value omission.
- Fixture-test visible, offscreen, and hidden form fields.
- Fixture-test label association through wrapping label, `for`, `aria-labelledby`, and nearby text.
- Tool result test for concise formatting.

## Phase 2: Target Search

Implement `browser_find_targets` to improve arbitrary-page target selection without making every Browser Snapshot larger.

Code changes:

- Reuse Browser Snapshot entries and add ranked intent matching over role, name, text, attributes, bounds, frame/shadow path, and actionability.
- Return Target Evidence candidates with score, evidence, confidence, and ambiguity notes.
- Add prompt guidance: use target search when compact snapshot has too many similar controls or no obvious target.

Tests:

- Ranking test for duplicate labels.
- Ambiguity test requiring clarification or fresh search.
- Test that low-confidence results are not treated as executable success.

## Phase 3: Region Semantics

Implement `browser_region_snapshot` for surface-like controls.

Code changes:

- Return ref, bounds, viewport, coordinate spaces, pointer model, SVG subtargets when available, canvas fallback metadata, and helper-needed likelihood.
- Keep `browser_visual_query` perception-only.
- Update `browser_click` and `browser_drag` guidance to prefer target-relative Pointer Evidence.

Tests:

- Canvas fixture with target-relative click point.
- SVG fixture with subtarget extraction.
- Layout resize test proving target fractions survive position changes.

## Phase 4: Frame And Helper Boundaries

Make frame handling explicit.

Code changes:

- Add frame metadata to snapshots even when the frame DOM is inaccessible.
- Add `browser_frame_snapshot` or fold frame details into `browser_region_snapshot` for frame regions.
- Return `helperRequired` when cross-origin frame interaction needs helper-backed inspection or native automation.
- Add UI copy for helper-required states and backend confidence.

Tests:

- Same-origin iframe remains MV3 inspectable.
- Cross-origin-like fixture is reported as bounded but opaque.
- Helper-required results are surfaced as actionable recovery information, not success.

## Phase 5: Tool Visibility And Approval

Split model visibility from execution permission.

Code changes:

- Keep automation tools in the agent graph for planning.
- Add tool permission state separate from disabled state.
- Preserve user approval before executing automation.
- Make the tool card distinguish hidden, visible-but-gated, enabled, and trusted-for-session/domain.

Tests:

- Disabled execution still lets the model plan with tool schemas.
- Approval denial returns a structured skipped result.
- Session allow applies only to execution permission, not hidden tool discovery.

## Done Criteria

- The agent can choose the right semantic view before acting.
- Form automation uses `browser_form_snapshot` plus batched `browser_fill_form`.
- Region automation is target-relative instead of raw coordinate-first.
- Cross-origin frames report helper-required rather than silently disappearing.
- VLM remains perception-only.
- Identity storage and identity-based filling remain out of scope.
