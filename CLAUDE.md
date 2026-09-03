## What this is

A browser-only comic translator (Preact + Vite, no backend). It reads a folder of
manga/manhwa page images via the File System Access API, sends pages as images
(vision, not OCR-then-translate) to Gemini or any OpenAI-compatible endpoint, and
writes the translation back to a JSON file next to the images. A single image or a
PDF can be opened instead of a folder, and pages can be pasted or dropped into an
open project. No server component ships with the app — `mock_server.py` exists purely
to develop and test against without burning a real API key or quota.

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
no database and no backend. A folder of images gets a fixed `translation.json` inside
it (see `fs/source.ts`). `state/schema.ts`
defines this format (`ProjectFile`) and owns forward-compatible migration
(`migrate()`) — it's deliberately forgiving of hand-edited or older-build files and
only throws on a schema version newer than the running build. Everything else
(IndexedDB, localStorage) is a cache that can be wiped without losing user data.

**A project opened from a single file is the one exception, and it is a real one.**
`showOpenFilePicker()` returns a handle to the file and no way to reach its parent
directory, so `<base>.json` cannot be written beside it. `fs/file-source.ts` therefore
keeps that project's JSON — and any pasted pages — in IndexedDB, where it is the only
copy until the user exports it. The scan view's export buttons (`fs/export.ts`:
"Download translation.json", "Save a copy to a folder…") are the way out, and the UI
says so. Consequence worth remembering: for this path IndexedDB is *not* a
throwaway cache, so `navigator.storage.persist()` is requested on import and
"Forget" deliberately leaves the stored JSON behind.

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
`fs/file-source.ts` implements it for a picked image or PDF, holding pages in memory
and the JSON in IndexedDB (see above); `fs/pdf.ts` rasterises PDF pages lazily with
`pdfjs-dist`.

`fs/project-file.ts` sits on top and reconciles a project against a fresh directory
listing (`reconcile()`): new files are appended as pending pages in listing order,
missing files are dropped, and pages whose image hash changed are marked `stale`
(never `pending → stale` for a page that was never translated). Note that `reconcile`
treats **array order** as authoritative and renumbers `index` from it — which is what
ScanView's move buttons maintain.

Two members of the seam are optional, and both exist for a reason:

- `PageSource.hash?()` — a hash the source can produce *without* materialising the
  file. `readDiskPages` hashes every page at open, so without this a PDF project
  would render the whole book just to be opened. `fs/pdf.ts`'s `pageHashSeed()`
  derives it from the document hash, the page number and `RASTER_VERSION` instead.
- `ProjectSource.addImage?()` — accept a new page. Its absence is the capability
  check the UI keys off to hide the paste/drop affordances. The source owns collision
  resolution and returns the name it actually used, because only it can see what is
  already there.

**Two invariants that will silently eat translations if broken.** `reconcile` matches
pages by name, so (1) a source's page names must be a pure function of page identity,
never of position — renumbering after a reorder reads as every page being removed and
a different set added; and (2) a memory-backed source must *list* the pages added to
it (`fs/file-source.ts` persists them via `fs/blob-store.ts`), because a page held
only in the store's private map comes back missing on the next rescan.

Pasted and dropped images go through `fs/add-images.ts` → `store.addImages()`. It
names new pages by continuing the project's existing numeric series, so that append
order and `sortPageNames` order agree — a timestamped name would sort somewhere else
entirely for anyone opening the folder without its JSON. Anything outside the
extensions `isImageName` recognises is re-encoded to JPEG, since a file written as
`.tiff` shows up now and is reported as vanished on the next rescan.

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
body construction, page naming, export planning, handle revival, and the store's
lifecycle — using `happy-dom`. UI components are not unit-tested; verification there
is manual, driven against `mock_server.py` and the in-app dev sample project
(`import.meta.env.DEV`-only "Open sample pages" button on the Projects view, backed
by `fs/dev-source.ts`, which implements `addImage` so paste and drop are testable).

`happy-dom` has no canvas, `createImageBitmap` or `OffscreenCanvas`, so anything that
rasterises is confined to one thin module (`fs/images.ts`, `fs/pdf.ts`) and stubbed
at that boundary — `toStorableImage` takes an injectable re-encoder, and
`file-source.test.ts` mocks `../fs/pdf` wholesale. **`fs/pdf.ts` itself has no
automated coverage**: `.gitignore` excludes `*.pdf` and happy-dom cannot rasterise
regardless, so it is verified by hand against a real PDF in a real browser.

Watch out for `src/test/store.test.ts`, which mocks `../fs/project-file` with a
factory listing only `loadProject` and `saveProject` — any *new* import `store.ts`
takes from that module is `undefined` at test runtime until the factory is extended.
