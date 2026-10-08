import { navigate } from '../app'
import { saveImagesToFolder, type CopyProgress } from '../fs/export'
import { isFsaSupported } from '../fs/handles'
import { FOLDER_JSON_NAME } from '../fs/source'
import { fetchThreadImages, parseThreadUrl } from '../fs/thread-project'
import { effectiveStatus, orderedPages, type Page, type PageLayout } from '../state/schema'
import {
  addImages,
  DUPLICATE_IMAGE_REASON,
  openSource,
  saveNow,
  updateProject,
  useStore,
} from '../state/store'
import { Banner, PageImage, StatusDot, clamp, countByStatus } from './common'
import { describeRejection, imagesFrom, isEditable } from './incoming'
import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * Splits `addImages`' `skipped` list into an informational note about images that were
 * silently deduplicated (expected, not a problem -- see `DUPLICATE_IMAGE_REASON`) and a
 * warning about anything that failed for a real reason.
 */
function describeSkipped(
  skipped: { type: string; reason: string }[],
): { note: string | null; problem: string | null } {
  const duplicates = skipped.filter((s) => s.reason === DUPLICATE_IMAGE_REASON)
  const other = skipped.filter((s) => s.reason !== DUPLICATE_IMAGE_REASON)
  return {
    note: duplicates.length > 0 ? `Skipped ${duplicates.length} image(s) already in the project.` : null,
    problem:
      other.length > 0
        ? `Could not add ${other.length} image(s): ` + other.map((s) => s.reason).join('; ')
        : null,
  }
}

export function ScanView() {
  const { project, source, report } = useStore()
  const [rescanning, setRescanning] = useState(false)
  // The page whose 4-koma box was clicked last: the other end of a shift-click range.
  const layoutAnchor = useRef<string | null>(null)
  if (!project || !source) return null

  function onLayoutClick(file: string, checked: boolean, range: boolean): void {
    const files = orderedPages(project!).map((p) => p.file)
    const from = range && layoutAnchor.current ? files.indexOf(layoutAnchor.current) : -1
    const to = files.indexOf(file)
    layoutAnchor.current = file
    const picked = from < 0 ? [file] : files.slice(Math.min(from, to), Math.max(from, to) + 1)
    setLayouts(picked, checked ? '4koma' : 'standard')
  }

  const counts = countByStatus(project.pages)
  const included = project.pages.filter((p) => !p.excluded).length
  const fourKoma = project.pages.filter((p) => p.layout === '4koma').length
  const canRescan = source.jsonName === FOLDER_JSON_NAME

  return (
    <div>
      <h1>{project.project.name}</h1>
      <p class="sub">
        {project.pages.length} pages found · {included} included · translations saved to{' '}
        <span class="mono">{source.jsonName}</span>
      </p>

      {report && (report.added.length > 0 || report.removed.length > 0 || report.changed.length > 0) && (
        <Banner kind="info">
          {report.added.length > 0 && <span>{report.added.length} new page(s). </span>}
          {report.removed.length > 0 && (
            <span>{report.removed.length} page(s) no longer on disk were dropped. </span>
          )}
          {report.changed.length > 0 && (
            <span>
              {report.changed.length} image(s) changed since translating and are marked stale.
            </span>
          )}
        </Banner>
      )}

      <PdfResolutionCard />

      <AddPagesCard />

      <AddThreadCard />

      <div class="card">
        <div class="row">
          <button class="primary" onClick={() => navigate('translate')}>
            Continue to translate
          </button>
          <button onClick={() => void saveNow()}>Save now</button>
          {canRescan && (
            <button
              disabled={rescanning}
              onClick={async () => {
                setRescanning(true)
                try {
                  await openSource(source)
                } finally {
                  setRescanning(false)
                }
              }}
            >
              {rescanning ? 'Rescanning…' : 'Rescan folder'}
            </button>
          )}
          <span class="muted">
            {counts.translated} translated · {counts.pending} pending · {counts.stale} stale ·{' '}
            {counts.failed} failed · {counts.blocked} blocked
          </span>
        </div>
      </div>

      <div class="card">
        <h2>Pages</h2>
        <p class="muted" style="margin-top:-6px">
          Excluded pages are skipped by the translator, but still shown in the reader. Use
          this for covers, ads and afterwords.
        </p>
        <p class="muted" style="margin-top:-6px">
          Tick <strong>4-koma</strong> on gag-strip pages: they are translated together with
          a prompt that reads each column top to bottom. Shift-click a second box to tick or
          untick every page in between
          {fourKoma > 0 && <strong> ({fourKoma} marked)</strong>}.
        </p>
        <div class="pages">
          {orderedPages(project).map((page, position) => (
            <PageCard
              key={page.file}
              page={page}
              position={position}
              last={position === project.pages.length - 1}
              onLayoutClick={onLayoutClick}
            />
          ))}
        </div>
      </div>

      <ExportCard />
    </div>
  )
}

/**
 * Getting more pages into an open project.
 *
 * Three gestures, one code path: paste, drop, and a file picker. The card hides
 * entirely unless the project was started by pasting into the Projects view --
 * every source implements `addImage`, but only a paste-started project treats
 * pasting more pages as its primary workflow.
 */
function AddPagesCard() {
  const { source } = useStore()
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const canAdd = Boolean(source?.startedFromClipboard)

  async function take(blobs: Blob[]) {
    setBusy(true)
    setNote(null)
    setProblem(null)
    try {
      const result = await addImages(blobs)
      const { note: dupNote, problem } = describeSkipped(result.skipped)
      const notes: string[] = []
      if (result.added.length > 0) {
        notes.push(`Added ${result.added.length} page(s): ${result.added.join(', ')}`)
      }
      if (dupNote) notes.push(dupNote)
      if (notes.length > 0) setNote(notes.join(' '))
      if (problem) setProblem(problem)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // A global paste listener, because there is no way to focus "the page" and
  // Ctrl+V is the gesture users reach for. It stays out of the way of text paste.
  useEffect(() => {
    if (!canAdd) return
    function onPaste(event: ClipboardEvent) {
      if (isEditable(event.target)) return
      const incoming = imagesFrom(event.clipboardData)
      if (incoming.blobs.length === 0) {
        // No preventDefault here: whatever this was, let the browser have it.
        const why = describeRejection(incoming)
        if (why) setProblem(why)
        return
      }
      event.preventDefault()
      void take(incoming.blobs)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [canAdd])

  // Without this, a drop that misses the zone makes the browser navigate away from
  // the app to display the dropped file -- losing an in-progress run.
  useEffect(() => {
    function block(event: DragEvent) {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    document.addEventListener('dragover', block)
    document.addEventListener('drop', block)
    return () => {
      document.removeEventListener('dragover', block)
      document.removeEventListener('drop', block)
    }
  }, [])

  if (!canAdd) return null

  return (
    <div class="card">
      <h2>Add pages</h2>
      {problem && <Banner kind="warn">{problem}</Banner>}
      <div
        class={'dropzone' + (dragging ? ' over' : '')}
        onDragOver={(event) => {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          const incoming = imagesFrom(event.dataTransfer)
          if (incoming.blobs.length === 0) {
            setProblem(describeRejection(incoming) ?? 'Nothing to add from that drop.')
            return
          }
          void take(incoming.blobs)
        }}
      >
        <strong>{busy ? 'Adding…' : 'Drop images here, or press Ctrl+V to paste'}</strong>
        <span class="muted">
          New pages are written into the project and appended at the end, not translated
          yet.
        </span>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          style="display:none"
          onChange={(event) => {
            const picked = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (picked.length > 0) void take(picked)
          }}
        />
        <button disabled={busy} onClick={() => input.current?.click()}>
          Add images…
        </button>
      </div>
      {note && (
        <p class="muted" style="margin-bottom:0">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * Manual fallback for a thread the automatic chase (`fetchThreadImages`) couldn't fully
 * unroll on its own -- e.g. a creator forced to start a new root tweet mid-series because
 * of X's reply-depth limit. Paste that tweet's (or a Bluesky post's) URL and its images
 * are appended as more pages, the same way pasted/dropped images are.
 *
 * Gated on `source.addImage` existing rather than `startedFromClipboard` like
 * `AddPagesCard`: appending thread images is useful for any writable project, not just
 * ones that started from a clipboard paste.
 */
function AddThreadCard() {
  const { source } = useStore()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  if (!source?.addImage) return null

  async function importThread() {
    const target = parseThreadUrl(url)
    if (!target) {
      setProblem('Please enter a valid Twitter/X or Bluesky thread URL.')
      return
    }
    setBusy(true)
    setProblem(null)
    setNote(null)
    try {
      const { files } = await fetchThreadImages(target, setProgress)
      const result = await addImages(files)
      const { note: dupNote, problem } = describeSkipped(result.skipped)
      const notes: string[] = []
      if (result.added.length > 0) notes.push(`Added ${result.added.length} page(s) from thread.`)
      if (dupNote) notes.push(dupNote)
      if (notes.length > 0) setNote(notes.join(' '))
      if (problem) setProblem(problem)
      setUrl('')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div class="card">
      <h2>Add thread</h2>
      <p class="muted" style="margin-top:-6px">
        For a thread split across a new root tweet -- X's reply-depth limit sometimes
        forces this -- paste that tweet's URL to pull its images in as more pages.
        Images already in the project (the thread-unrolling API isn't always
        consistent about how much of a thread it returns) are skipped automatically.
      </p>
      {problem && <Banner kind="warn">{problem}</Banner>}
      <div class="row" style="gap:8px">
        <input
          id="add-thread-url-input"
          type="url"
          placeholder="https://x.com/.../status/... or https://bsky.app/profile/.../post/..."
          value={url}
          disabled={busy}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() && !busy) {
              e.preventDefault()
              void importThread()
            }
          }}
          style="flex:1"
          autocomplete="off"
        />
        <button
          disabled={busy || !url.trim()}
          onClick={() => void importThread()}
          style="white-space:nowrap"
        >
          {busy && progress ? progress : 'Add thread pages'}
        </button>
      </div>
      {note && (
        <p class="muted" style="margin-bottom:0">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * A do-over for a PDF-backed project: re-render every page at a different resolution
 * without reopening the file.
 *
 * Hidden unless `source.reprocessPdf` exists, the same capability-check pattern
 * `AddPagesCard` uses for `addImage` -- a folder or single-image project has no
 * renderer to reconfigure.
 */
function PdfResolutionCard() {
  const { source } = useStore()
  const [edge, setEdge] = useState(source?.pdfRenderEdge ?? 2400)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (source?.pdfRenderEdge) setEdge(source.pdfRenderEdge)
  }, [source?.pdfRenderEdge])

  if (!source?.reprocessPdf) return null

  async function reprocess() {
    setBusy(true)
    setNote(null)
    setProblem(null)
    try {
      // Called through `source`, not a detached reference: `reprocessPdf` reads
      // instance state via `this`, which a bare function reference would lose.
      await source!.reprocessPdf!(edge)
      const ok = await openSource(source!)
      if (ok) {
        setNote(
          'Reprocessed at ' +
            edge +
            'px. Already-translated pages whose image changed are marked stale.',
        )
      }
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="card">
      <h2>PDF resolution</h2>
      <p class="muted" style="margin-top:-6px">
        Re-renders every page at a new resolution. Use this if pages came out too blurry
        to read; already-translated pages that change are marked stale so they can be
        retranslated against the sharper image.
      </p>
      {problem && <Banner kind="warn">{problem}</Banner>}
      <div class="row" style="margin-top:14px">
        <input
          type="number"
          min={800}
          max={4096}
          step={64}
          value={edge}
          onInput={(e) => setEdge(clamp(Number(e.currentTarget.value), 800, 4096))}
          style="width:100px"
        />
        <button disabled={busy} onClick={() => void reprocess()}>
          {busy ? 'Reprocessing…' : 'Reprocess pages'}
        </button>
        {!busy && note && <span class="muted">{note}</span>}
      </div>
    </div>
  )
}

/**
 * The images-only way out of the browser.
 *
 * Autosave already writes the JSON beside the images for a folder project, but a
 * project imported from a single file or a PDF has no folder to write into -- its
 * pages are in memory. This is offered for every project kind; grabbing the JSON
 * itself is a separate action on the Translate view.
 */
function ExportCard() {
  const { project, source } = useStore()
  const [progress, setProgress] = useState<CopyProgress | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  if (!project || !source) return null

  const canPickFolder = isFsaSupported()

  async function save() {
    setNote(null)
    setFailure(null)
    setProgress({ done: 0, total: project!.pages.length, name: '' })
    try {
      const result = await saveImagesToFolder(source!, project!, setProgress)
      if (result) setNote(`Saved ${result.pages} page(s) into ${result.folder}.`)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }

  return (
    <div class="card">
      <h2>Export</h2>
      <p class="muted" style="margin-top:-6px">
        Saves the page images into a folder you pick, under their current names. Grab{' '}
        <span class="mono">translation.json</span> from the Translate page to go with them.
      </p>
      {failure && <Banner kind="error">{failure}</Banner>}
      <div class="row" style="margin-top:14px">
        <button
          class="primary"
          disabled={!canPickFolder || progress !== null}
          onClick={() => void save()}
        >
          {progress ? 'Saving…' : 'Save images to folder…'}
        </button>
        {progress && (
          <span class="muted">
            {progress.done} / {progress.total} · {progress.name}
          </span>
        )}
        {!progress && note && <span class="muted">{note}</span>}
        {!canPickFolder && (
          <span class="muted">This browser cannot pick a folder to save into.</span>
        )}
      </div>
    </div>
  )
}

function PageCard({
  page,
  position,
  last,
  onLayoutClick,
}: {
  page: Page
  position: number
  last: boolean
  onLayoutClick: (file: string, checked: boolean, range: boolean) => void
}) {
  return (
    <div
      class={
        'page-card' + (page.excluded ? ' excluded' : '') + (page.layout === '4koma' ? ' fourkoma' : '')
      }
    >
      <PageImage file={page.file} />
      <div class="meta">
        <span
          title={page.file}
          style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
        >
          {position + 1}. {page.file}
        </span>
        <StatusDot status={effectiveStatus(page)} />
      </div>
      <div class="controls">
        <button class="small" disabled={position === 0} onClick={() => move(page.file, -1)}>
          ↑
        </button>
        <button class="small" disabled={last} onClick={() => move(page.file, 1)}>
          ↓
        </button>
        <button class="small" onClick={() => toggleExcluded(page.file)}>
          {page.excluded ? 'include' : 'exclude'}
        </button>
        <label
          class="layout-toggle"
          title="4-koma pages are translated together, with a prompt that reads each column top to bottom. Shift-click to set every page between this and the last one you clicked."
        >
          <input
            type="checkbox"
            checked={page.layout === '4koma'}
            // Shift-click would otherwise also select the text between the two clicks.
            onMouseDown={(e) => e.shiftKey && e.preventDefault()}
            // `onClick`, not `onChange`: only the click event carries `shiftKey`.
            onClick={(e) => onLayoutClick(page.file, e.currentTarget.checked, e.shiftKey)}
          />
          4-koma
        </label>
      </div>
    </div>
  )
}

/** Swap a page with its neighbour, then renumber so `index` stays contiguous. */
function move(file: string, delta: number): void {
  updateProject((project) => {
    const pages = orderedPages(project)
    const at = pages.findIndex((p) => p.file === file)
    const to = at + delta
    if (at < 0 || to < 0 || to >= pages.length) return project
    const swapped = pages.slice()
    swapped[at] = pages[to]!
    swapped[to] = pages[at]!
    return { ...project, pages: swapped.map((page, i) => ({ ...page, index: i })) }
  })
}

/**
 * Set the layout of several pages in one update, so one autosave covers a whole range.
 *
 * Nothing here touches `status`: a translated page whose layout now differs from the one
 * it was translated under reads as stale through `effectiveStatus`, and reads as translated
 * again if it is put back. Its lines stay until a retranslation lands, and hand edits
 * survive under the default `preserve` policy.
 */
function setLayouts(files: string[], layout: PageLayout): void {
  const wanted = new Set(files)
  updateProject((project) => ({
    ...project,
    pages: project.pages.map((p) =>
      wanted.has(p.file) && p.layout !== layout ? { ...p, layout } : p,
    ),
  }))
}

function toggleExcluded(file: string): void {
  updateProject((project) => ({
    ...project,
    pages: project.pages.map((p) => (p.file === file ? { ...p, excluded: !p.excluded } : p)),
  }))
}
