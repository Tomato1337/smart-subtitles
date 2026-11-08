# Quick Anki Add, Image Failover, and Expressive Toasts

Date: 2026-11-08
Status: Workflow approved; written specification awaiting user review.

## Goal and approved choices

The user approved quick Anki adding with a five-second cancellation window instead of an automatically opened modal. The user also requested image-generation retries, configurable provider priority including Runware, and Material 3 Expressive toast styling consistent with the application.

Quick adding must not pause the film. Editing remains explicit. Both pending work and an already-created note remain accessible after the toast disappears.

## Current implementation and reuse

- `src/modules/Watch/WatchScreen.tsx`: `cardFor` currently pauses playback and opens the draft modal.
- `src/modules/Cards/ui/CardDraftModal.tsx`: generates a draft, edits fields, renders `CardPreview`, and submits a proposal to the background queue. Reuse the editor and preview rather than introduce another card form.
- `src-tauri/src/anki/cards.rs`: proposals and sequential background adding already exist. The worker currently captures its draft before execution, discards `addNote` IDs, allows duplicates, and continues without an image after image failure.
- `src-tauri/src/commands.rs`: `cards_dismiss` changes proposal status but does not cancel an active worker. It is not sufficient for the new cancellation contract.
- `src-tauri/src/anki/images.rs`: resolves one provider, generates one image, and caches it by settings and prompt. Tutor may own the primary image settings.
- `../m3e/packages/react/src/snackbar/`: the shared `Snackbar` already renders a manual popover with entry/exit motion. Its store replaces one current message; the API currently supports one action, and its dismissal timer does not pause on hover or focus.
- `src/app/router.tsx`: mounts the kit's `Snackbar`. Keep that shared host; do not copy a toast implementation into Smart Subtitles.

## Scope

1. Bounded image retries and ordered fallback for automatic card images and explicit preview generation.
2. Optional quick-add mode with cancellation, progress, recent-task access, and editing before or after addition.
3. Shared Material 3 Expressive snackbar presentation and the generic interaction capabilities required by quick adding.

No automatic additions based merely on watching a word, no new image providers, no parallel requests racing providers, and no wholesale redesign of the player or notification center.

## Image retry and priority policy

### Routing and configuration

Retain the existing primary-provider settings and provider-specific credentials/models. Add an ordered `images.fallbacks` list containing `openai`, `runware`, `gemini`, or `omp`; its default is empty. A resolved primary of `none` disables image generation and does not invoke fallbacks. Existing installations continue resolving the same primary and do not spend on additional providers until fallback is configured.

The settings UI presents a primary provider followed by enabled fallback providers, with up/down controls, provider model details, and credential readiness. Selecting another primary and reordering fallbacks changes priority; duplicate providers and `none` entries in the fallback list are rejected.

When `tutor.enabled && tutor.useImageSettings` is true, existing Tutor resolution supplies the primary. Display that ownership explicitly, and allow switching ownership off to choose an application-owned primary. Application-configured fallbacks still apply. Resolve settings once per generation operation without storing credentials in card-job records.

A fallback used for one picture must not mutate the saved primary-provider choice.

### Attempts and errors

- At most three attempts per provider, with delays of two and five seconds before attempts two and three.
- Each provider has one 120-second budget including requests and waiting; stop that provider when its budget expires and move to the next enabled provider.
- Retry network failures, timeouts, HTTP 429, and HTTP 5xx. Honor `Retry-After` if it fits inside the remaining provider budget; otherwise move to the next provider.
- A missing credential, rejected credential, unsupported model, or provider-specific configuration error skips that provider without repeated calls.
- Invalid prompt and explicit safety-policy refusal stop the chain with an actionable error. Do not switch providers to circumvent a safety refusal.
- Malformed or missing image data is a provider failure. Filesystem failures or Anki media-upload failures are not image-provider failures and must not trigger another paid generation.
- Cancellation interrupts waits and cancellable network/process work. Already-performed remote work may still be billed.
- Introduce structured error categories at provider boundaries; do not decide retryability by matching localized error strings.

The existing sequence of image providers is not raced. Expose provider and attempt progress in the task, but do not issue a user notification for every transient retry. One final error/warning includes the providers attempted and redacted reasons.

### Assets and partial success

Build the provider-specific prompt from the same raw subject and style for each attempt; do not pass an already-decorated prompt from one provider into the next.

Persist the selected asset reference and actual provider/model with the draft revision. Preview and addition reuse that asset, including a fallback-produced asset. Provider credentials never go into progress events or asset metadata.

If the whole chain fails during automatic addition, continue adding the otherwise valid card without its image and show a warning, matching the current partial-success policy. Explicit preview generation reports failure without claiming a picture exists. Editing only regenerates media whose relevant input changed.

All config surfaces change together: Rust defaults and validation, setup API and guide, IPC mirrors, settings/wizard summaries, and the user manual. The same routing service is used by background adding and explicit generation.

## Quick-add interaction

### Modes and grace period

Add `anki.quickAdd`, default `false`, so old configurations preserve the current preview-first workflow. Quick mode is selectable in Anki settings. The selected mode applies to the existing word/phrase and cue add entrypoints.

A quick-add click creates a persisted task immediately and returns its task identity. It does not pause playback or invoke draft, image, clip, or audio generation during the five-second grace period.

Show a top-positioned player toast with the selected word/phrase, remaining grace time, **Отменить**, and **Редактировать**. A cue-level add with no selected span is labeled with its source phrase until the draft resolves the target word.

Hover and keyboard focus pause the grace countdown without restoring elapsed time. Resume only when neither condition holds. Hide/replace/close of a toast does not itself cancel its task or reset the grace period. A recent-tasks panel retains access to it. A user-requested hold and the remaining grace time belong to the backend task; the UI does not independently schedule the add.

On leaving a view, clear holds owned by that view. Expire a disconnected client's hold after ten seconds without its heartbeat so a vanished UI cannot block a task forever. Normal countdown and releases use monotonic elapsed time while the process runs.

After the grace period, the task enters the existing background worker. Show draft, preparation, image provider/attempt, audio, Anki, and optional sync progress without opening a modal.

### Recent cards

Add a compact entry to the player's top bar showing active-task count and opening **Последние карточки**. Its list is restored from persisted job records and is not a second toast queue.

Load the latest 20 tasks, with a **Показать ещё** page action. Each row shows the word, film/cue context, state, and available actions. Tasks remain actionable across film changes; their original source and audio track are captured when enqueued, never taken from a later current session.

Completed and failed tasks remain in history after toast dismissal. Errors and partial-media warnings use the existing notification center; successful confirmations use the shared snackbar.

### Cancellation and deletion

During grace, queueing, or preparation, **Отменить** requests cancellation and prevents any future Anki commit. Interrupt external work where supported and discard stale results. Do not claim that paid remote work was undone.

An Anki request already sent may have an unknown outcome. Keep the task in a resolving state, identify its own note, and delete it if cancellation was requested. Display **Отменено** only after confirming that no note created by the task remains. If Anki is unavailable, retain a retryable unresolved cancellation and report the error rather than silently mark success.

After confirmed addition, label the action **Удалить из Anki**, not **Отменить**. It deletes only note IDs owned by that task, updates the local index, and preserves the user's unrelated existing notes.

Do not delete shared cached or Anki media files during cancellation: another card may reference them.

### Editing

Selecting **Редактировать** before commit atomically holds automatic submission, then opens the existing editor with the stored draft or an explicitly initiated draft request. Editing during grace is an explicit exception to delayed generation.

The worker may finish useful media generation, but no edited task commits without **Сохранить и добавить**. Closing the editor leaves a paused draft in recent cards; it does not silently resume automatic addition.

Each save advances the draft revision. Results of older revisions cannot replace current fields or assets. Reuse unaffected media; changing image subject/style invalidates the image, and changing speech inputs invalidates their dependent audio/clip artifacts.

If **Редактировать** races with an already-sent `addNote`, reconcile the result and open the resulting note for editing rather than create another one.

After addition, read the actual note fields and update the same note through AnkiConnect, applying the saved field mapping for that task. Preserve note/card identities, unrelated fields, and review history. A save conflict caused by external edits to owned fields is shown to the user and must not silently overwrite external changes.

## Backend ownership and persistence

Add a numbered SQLite migration; never modify the original schema for existing installs. Keep proposals as the existing batch/group abstraction and add a `card_job` record per selected card. Both manual proposal submission and quick-add intents use the same task scheduler and commit path.

A job stores its task identity, optional proposal/word index, media/cue/span, captured source/audio context, state, remaining grace, revision, draft, field mapping, selected asset references, warnings/error, cancellation intent, Anki note identity, and creation/update timestamps. Do not persist API keys.

States distinguish grace, queued, drafting, generating, editing, committing, resolving, added, cancel-requested, cancelled, deleting, deleted, failed, and interrupted. Phase events are projections of persisted state, not the authority for whether a job may commit.

Transitions into editing, cancellation, and committing are atomic compare-and-set operations. A single task owner serializes side-effecting commits; database transactions are not held open over network requests. Check cancellation and revision before each irreversible side effect and again when its result arrives.

Grace-period holds and editing do not hold the global card-queue mutex. The scheduler skips held tasks and lets other ready tasks proceed. Returning an edited task to the queue uses its latest revision and does not resume an obsolete captured draft.

Assign a stable task-specific Anki marker before the first add. Reconcile by that marker after a lost response or restart before attempting another add. Save returned positive note IDs instead of discarding them. Rapid repeated quick clicks for the same media/cue/span return the same active job; a previously added matching task opens its result instead of silently duplicating it.

On application restart, reconcile committing/resolving/cancel-requested work before retrying it. Other unfinished jobs become **Прервано** or a held draft, with explicit **Продолжить** or **Отменить** actions. Do not surprise the user by automatically spending money or adding stale grace-period work after a restart.

Batch reports preserve per-card outcomes: retrying a partially successful proposal must not add the already-successful cards again. Existing agent/manual callers migrate to the same safe scheduler.

Expose job retrieval, creation, hold/release, cancel, edit/save, delete, and reconciliation/retry operations through typed Tauri wrappers. Keep FEOD module boundaries. Persisted task state is fetched when the UI mounts; events update it incrementally.

## Material 3 Expressive snackbar

### Shared-kit boundary

Change `../m3e/packages/react/src/snackbar/Snackbar.tsx`, `toast.ts`, and `snackbar.css` in the kit. Smart Subtitles supplies app-specific task content and top placement through the public API. No local generic snackbar copy, extra animation library, or hardcoded palette.

Extend the shared API for a leading Material icon, two typed actions, stable message identity/update, an optional determinate progress indicator, persistent messages, and hover/focus lifecycle events. Migrate every affected kit demo/test and application callsite using exported-symbol references before editing.

A generic toast dismissal timer is separate from the backend's five-second commit countdown. The latter supplies progress to the toast and uses interaction callbacks to hold/release its task. Updating progress must not replace/reannounce the entire message or restart entry motion every tick.

### Appearance and placement

Use `surface-container-high` / `on-surface`, the kit's `extra-large` corner token, Roboto Flex body-medium and emphasized title/label roles, and a secondary-container/on-secondary-container leading icon surface. Actions use the kit's tonal/text button treatment and visible keyboard focus, with at least 48px interactive targets.

Use an 8px spacing rhythm, a maximum 560px width, and at least 16px viewport margins; stack actions on narrow views. Normal confirmations stay compact. A grace/task toast adds its progress rail and second action without changing the generic design language.

In the player, appear below the top bar and enter from above; reserve space from warning popups, stay away from subtitle lines and transport controls, and remain visible in fullscreen. Elsewhere preserve the shared host's bottom placement and notification-stack clearance.

Use the kit's entry/exit motion and reduced-motion behavior. No timer-based DOM removal, global motion kill switch, or backdrop-filter over playing video. A short fade remains valid under reduced motion. Native manual-popover/top-layer behavior and existing modal accessibility support are retained.

Screen readers hear the message and actions once on entry and meaningful state changes, not every countdown tick. Hover and focus pause ordinary auto-dismissal; ongoing task messages persist until replaced by their result or explicitly dismissed. Toast visibility never determines task success, cancellation, or commit permission.

### Distribution

Verify locally through the repository's supported linked-kit setup. Publish the kit change from the kit repository and bump both `@tomato1337/m3e-*` package versions together in Smart Subtitles before release delivery; a fresh registry install must receive the required API and styles. If publication is unavailable, report that exact release prerequisite rather than ship a local copy or pretend a linked dependency is distributable.

## Acceptance and verification

- One quick click leaves playback running and does not open a dialog or start generation during grace.
- Hover/focus overlap holds one countdown; release resumes the remaining time. Losing the view/client cannot hold it forever.
- Grace expiry starts exactly one job; rapid duplicate clicks and duplicate enqueue/retry calls do not create extra notes.
- Cancellation before commit creates no note; cancellation racing an accepted or lost-response add eventually removes only the owned note or shows an unresolved error.
- Editing during preparation prevents automatic commit; stale revisions cannot overwrite the edited draft. Editing an added note preserves its ID and review history.
- Image attempts obey count, ordering, time budget, error category, cancellation, and `Retry-After`; fallback never changes saved primary settings.
- Preview and addition reuse fallback-produced assets. Exhausted generation yields a partial-success warning rather than another full-card add.
- A film switch does not change queued card source/audio context. Restart reconciliation prevents duplicate additions and exposes interrupted work.
- Recent cards remain available after toast replacement, reload, and film changes.
- Generic toast entry, update, two actions, hover/focus dismissal pause, fullscreen placement, modal behavior, dark/light themes, compact width, and reduced motion are exercised.
- Add permanent deterministic behavioral tests for uncertain boundaries/races; do not test copied markup, API forwarding, or incidental text.
- Run actual ffmpeg/media and AnkiConnect smoke paths using an isolated temporary deck, including add/edit/delete and note-ID preservation. Exercise the actual UI in Chromium and native WebKitGTK; no permanent mock substitute for real Anki behavior.
- Run Smart Subtitles type-check, lint, frontend tests, and Rust tests once after integration; run the kit's `npm run check` after kit integration. Update setup guide, user manual, kit docs/release notes, and remove throwaway smoke artifacts.

## Review boundary

This document records the approved direction and concrete defaults. No implementation change for these features has been made yet. After the user reviews this specification, prepare the implementation plan and execute the approved slices.
