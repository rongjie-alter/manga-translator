## What this is

A browser-only comic translator (Preact + Vite, no backend). It reads a folder of
manga/manhwa page images via the File System Access API, sends pages as images
(vision, not OCR-then-translate) to Gemini or any OpenAI-compatible endpoint, and
writes the translation back to a JSON file next to the images. No server component
ships with the app — `mock_server.py` exists purely to develop and test against
without burning a real API key or quota.

## Commands

```bash
pnpm dev          # vite dev server on :5173 (test-img/ is served for the in-app sample project)
pnpm build        # tsc --noEmit && vite build — build fails on type errors, not just bundling errors
pnpm test         # vitest run, once
pnpm test:watch   # vitest watch mode
npx vitest run src/test/batcher.test.ts   # single file
npx vitest run -t "re-requests only the pages"   # single test by name
npx tsc --noEmit  # typecheck only, faster than a full build
```

Mock server (Python, no dependencies beyond stdlib):

```bash
py mock_server.py --port 8787 --rpm 6 --truncate 0.2 --block-rate 0.1 --page-drop-rate 0.2 --fail-rate 0.1 --seed 1
```

It speaks both request shapes the app can send — plain OpenAI-compatible
`/v1/chat/completions` and Gemini's native `/v1beta/models/*:generateContent` — and
deliberately injects the failure modes that are hard to trigger against a real
endpoint: rate limits (`--rpm`), 503s (`--fail-rate`), dropped pages
(`--page-drop-rate`), truncated responses (`--truncate`), and safety blocks
(`--block-rate`). `--seed` makes a run reproducible. Point a Settings endpoint at
`http://localhost:8787/v1` (kind `openai`) or `http://localhost:8787/v1beta` (kind
`gemini`) to use it.

There is no lint script configured.

## Architecture

### The project file is the source of truth

A project is a folder of page images plus one JSON file living beside them — there is
no database and no backend. A single image/PDF gets `<base>.json`; a folder of images
gets a fixed `translation.json` inside it (see `fs/source.ts`). `state/schema.ts`
defines this format (`ProjectFile`) and owns forward-compatible migration
(`migrate()`) — it's deliberately forgiving of hand-edited or older-build files and
only throws on a schema version newer than the running build. Everything else
(IndexedDB, localStorage) is a cache that can be wiped without losing user data.

App-level config (API keys, endpoints, prompt template, defaults) lives in
`state/settings.ts` and is persisted to `localStorage`, separately from the project
JSON — an API key must never end up in a file a user might share alongside their
translated folder.

### Filesystem seam: `fs/source.ts`

`ProjectSource`/`PageSource` are the interface between "where files live" and
everything above it. `fs/handles.ts` implements it against File System Access
(`showDirectoryPicker`, permission re-grant on reopen, atomic write-via-temp-file
since FSA `createWritable()` truncates on open). `fs/dev-source.ts` implements the
same interface by `fetch`-ing `test-img/` and storing the JSON in `localStorage` —
this exists *only* because `showDirectoryPicker()` opens an OS dialog that browser
automation cannot click, which would otherwise make the app untestable end-to-end. It
is dynamically imported so it's dead-code-eliminated from the production bundle.
`fs/project-file.ts` sits on top and reconciles a project against a fresh directory
listing (`reconcile()`): new files are appended as pending pages in listing order,
missing files are dropped, and pages whose image hash changed are marked `stale`
(never `pending → stale` for a page that was never translated).

### Translation pipeline: `api/`

Read `api/batcher.ts` first — it's the run loop everything else feeds. Two
invariants shape it: every page ends in a state the user can act on
(`translated`/`failed`/`blocked`, never silently empty), and progress is saved after
every batch so closing the tab mid-run costs at most the in-flight batch.

Pipeline, in call order:
- `api/prompt.ts` renders the system prompt template, substituting
  `{sourceLanguage}`/`{targetLanguage}`/`{readingOrder}`/`{glossary}`.
- `api/request.ts` builds the provider-specific request body. Gemini and
  OpenAI-compatible endpoints get genuinely different shapes here — see below.
- `api/client.ts` (`chat()`) makes the HTTP call and classifies the outcome into an
  `ApiError` kind (`auth`/`request`/`too_large`/`rate_limit`/`server`/`network`/`aborted`);
  `withRetry()` wraps it with backoff, honoring `Retry-After` when present.
- `api/parse.ts` turns the response text into pages. The happy path is
  `JSON.parse`; on truncation it falls back to scanning out whichever complete
  `{...}` objects appear before the cut, so a batch that got cut off mid-array still
  yields the pages that finished — a hand-rolled brace-depth scanner, not a JSON
  streaming library, because it only needs to find complete objects.
- `api/merge.ts` folds a parsed response into the project: `mergeLines()` matches by
  model-assigned line id and keeps hand-edited lines untouched by default (`preserve`
  vs `overwrite` policy — overwrite is what "yes, replace my edits" in the UI passes),
  and `mergeGlossary()` lets the *first* translation of a term win so a name can't
  drift over a long project.
- Back in `batcher.ts`: a page the model didn't mention gets one targeted
  re-request for just the missing pages (not a full batch retry — see
  `translateBatch`'s repair path), and a batch that turns out oversized gets split in
  half recursively rather than failing outright.

**Gemini vs. OpenAI-compatible is a real fork, not a flag.** Gemini uses the native
`:generateContent` endpoint (not Google's OpenAI-compatibility shim — the shim
silently drops `safety_settings`, which defeats the whole point of turning them off
for comic content) with `x-goog-api-key`, `inlineData` image parts, and
`safetySettings`/`generationConfig` at the top level. Plain OpenAI-compatible
endpoints use `messages`/`image_url`/`response_format`. `Endpoint.kind` in
`state/settings.ts` selects the branch in both `request.ts` (building the body) and
`client.ts` (building the URL and parsing the response). When touching either file,
check both branches.

**Rate limits get their own backoff curve.** `Retry-After` is not a
CORS-safelisted response header, so unless a provider sends
`Access-Control-Expose-Headers: Retry-After` the browser hides it and the client
falls back to its own delay. A per-minute quota does not clear in a few seconds, so
`client.ts` uses a ~20s base for rate limits specifically (`RATE_LIMIT_BASE_DELAY_MS`)
rather than the fast backoff used for ordinary 5xx/network errors — don't collapse
these into one curve.

### State/UI: `state/store.ts`

A single module-level store (not context/Redux) — the run loop needs to push
progress from outside the component tree, and every view needs the same project.
Views subscribe via `useStore()`. Project edits go through `updateProject()`, which
marks the project dirty and schedules a debounced (800ms) autosave; `saveNow()` can
be called directly (e.g. before an action that discards state) to flush immediately.
`installUnloadGuard()` wires `beforeunload` to warn on an active run or unsaved
changes.

### Testing

The vitest suite (`src/test/`) covers the pure logic exhaustively — schema
migration, reconciliation, parsing/repair, merge semantics, retry/backoff, request
body construction — using `happy-dom`. UI components and `store.ts` are not
unit-tested; verification there is manual, driven against `mock_server.py` and the
in-app dev sample project (`import.meta.env.DEV`-only "Open sample pages" button on
the Projects view, backed by `fs/dev-source.ts`).
