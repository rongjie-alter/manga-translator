import { navigate } from '../app'
import { downloadProjectJson, saveCopyToFolder, type CopyProgress } from '../fs/export'
import { isFsaSupported } from '../fs/handles'
import {
  SOURCE_LANG_NAMES,
  TARGET_LANG_NAMES,
  type Page,
  type ProjectFile,
  type ReadingDirection,
  type SourceLang,
  type TargetLang,
} from '../state/schema'
import { addImages, openSource, saveNow, updateProject, useStore } from '../state/store'
import { Banner, PageImage, StatusDot, countByStatus } from './common'
import { describeRejection, imagesFrom, isEditable } from './incoming'
import { useEffect, useRef, useState } from 'preact/hooks'

export function ScanView() {
  const { project, source, report } = useStore()
  const [rescanning, setRescanning] = useState(false)
  if (!project || !source) return null

  const counts = countByStatus(project.pages)
  const included = project.pages.filter((p) => !p.excluded).length

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

      <div class="card">
        <h2>Translation settings</h2>
        <div class="fields">
          <div>
            <label for="src">From</label>
            <select
              id="src"
              value={project.project.sourceLang}
              onChange={(e) =>
                setMeta({ sourceLang: e.currentTarget.value as SourceLang })
              }
            >
              {Object.entries(SOURCE_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="dst">To</label>
            <select
              id="dst"
              value={project.project.targetLang}
              onChange={(e) =>
                setMeta({ targetLang: e.currentTarget.value as TargetLang })
              }
            >
              {Object.entries(TARGET_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="dir">Reading direction</label>
            <select
              id="dir"
              value={project.project.readingDirection}
              onChange={(e) =>
                setMeta({ readingDirection: e.currentTarget.value as ReadingDirection })
              }
            >
              <option value="rtl">Right to left (manga)</option>
              <option value="ltr">Left to right</option>
            </select>
          </div>
          <div>
            <label for="batch">Pages per API call</label>
            <input
              id="batch"
              type="number"
              min={1}
              max={20}
              value={project.settings.batchSize}
              onInput={(e) =>
                updateProject((p) => ({
                  ...p,
                  settings: {
                    ...p.settings,
                    batchSize: clamp(Number(e.currentTarget.value), 1, 20),
                  },
                }))
              }
            />
          </div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="primary" onClick={() => navigate('translate')}>
            Continue to translate
          </button>
          <button onClick={() => void saveNow()}>Save now</button>
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
          <span class="muted">
            {counts.translated} translated · {counts.pending} pending · {counts.stale} stale ·{' '}
            {counts.failed} failed · {counts.blocked} blocked
          </span>
        </div>
      </div>

      <AddPagesCard />

      <ExportCard />

      <div class="card">
        <h2>Pages</h2>
        <p class="muted" style="margin-top:-6px">
          Excluded pages are skipped by the translator and hidden in the reader. Use this
          for covers, ads and afterwords.
        </p>
        <div class="pages">
          {ordered(project).map((page, position) => (
            <PageCard
              key={page.file}
              page={page}
              position={position}
              last={position === project.pages.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Getting more pages into an open project.
 *
 * Three gestures, one code path: paste, drop, and a file picker. The card hides
 * entirely when the source cannot accept pages, which is the whole reason
 * `addImage` is optional on `ProjectSource`.
 */
function AddPagesCard() {
  const { source } = useStore()
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const canAdd = Boolean(source?.addImage)

  async function take(blobs: Blob[]) {
    setBusy(true)
    setNote(null)
    setProblem(null)
    try {
      const result = await addImages(blobs)
      if (result.added.length > 0) {
        setNote(`Added ${result.added.length} page(s): ${result.added.join(', ')}`)
      }
      if (result.skipped.length > 0) {
        setProblem(
          `Could not add ${result.skipped.length} image(s): ` +
            result.skipped.map((s) => s.reason).join('; '),
        )
      }
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
 * Ways out of the browser.
 *
 * Autosave already writes the JSON beside the images for a folder project, but a
 * project imported from a single file or a PDF has no folder to write into -- its
 * pages are in memory and its JSON is in IndexedDB. These buttons are the only way
 * that work leaves this browser profile, so they are offered for every project kind.
 */
function ExportCard() {
  const { project, source } = useStore()
  const [progress, setProgress] = useState<CopyProgress | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  if (!project || !source) return null

  const canPickFolder = isFsaSupported()

  async function saveCopy() {
    setNote(null)
    setFailure(null)
    setProgress({ done: 0, total: project!.pages.length, name: '' })
    try {
      const result = await saveCopyToFolder(source!, project!, setProgress)
      if (result) setNote(`Copied ${result.pages} page(s) into ${result.folder}.`)
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
        Saving a copy writes the page images and <span class="mono">translation.json</span>{' '}
        into a folder you pick, renumbering the files if needed so the copy opens in this
        same reading order.
      </p>
      {failure && <Banner kind="error">{failure}</Banner>}
      <div class="row" style="margin-top:14px">
        <button onClick={() => downloadProjectJson(project)}>Download translation.json</button>
        <button
          class="primary"
          disabled={!canPickFolder || progress !== null}
          onClick={() => void saveCopy()}
        >
          {progress ? 'Saving…' : 'Save a copy to a folder…'}
        </button>
        {progress && (
          <span class="muted">
            {progress.done} / {progress.total} · {progress.name}
          </span>
        )}
        {!progress && note && <span class="muted">{note}</span>}
        {!canPickFolder && (
          <span class="muted">
            This browser cannot pick a folder, so only the JSON download is available.
          </span>
        )}
      </div>
    </div>
  )
}

function PageCard({ page, position, last }: { page: Page; position: number; last: boolean }) {
  return (
    <div class={'page-card' + (page.excluded ? ' excluded' : '')}>
      <PageImage file={page.file} />
      <div class="meta">
        <span title={page.file} style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {position + 1}. {page.file}
        </span>
        <StatusDot status={page.status} />
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
      </div>
    </div>
  )
}

function ordered(project: ProjectFile): Page[] {
  return project.pages.slice().sort((a, b) => a.index - b.index)
}

function setMeta(patch: Partial<ProjectFile['project']>): void {
  updateProject((p) => ({ ...p, project: { ...p.project, ...patch } }))
}

/** Swap a page with its neighbour, then renumber so `index` stays contiguous. */
function move(file: string, delta: number): void {
  updateProject((project) => {
    const pages = ordered(project)
    const at = pages.findIndex((p) => p.file === file)
    const to = at + delta
    if (at < 0 || to < 0 || to >= pages.length) return project
    const swapped = pages.slice()
    swapped[at] = pages[to]!
    swapped[to] = pages[at]!
    return { ...project, pages: swapped.map((page, i) => ({ ...page, index: i })) }
  })
}

function toggleExcluded(file: string): void {
  updateProject((project) => ({
    ...project,
    pages: project.pages.map((p) => (p.file === file ? { ...p, excluded: !p.excluded } : p)),
  }))
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}
