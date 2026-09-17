import { useEffect, useState } from 'preact/hooks'
import { navigate } from '../app'
import {
  forgetProject,
  isFsaSupported,
  listRememberedProjects,
  pickDirectoryProject,
  pickFileProject,
  reviveProject,
} from '../fs/handles'
import type { RememberedProject } from '../fs/handles'
import { projectSourceFromDrop } from '../fs/drop-project'
import { openThreadProject, parseThreadUrl } from '../fs/thread-project'
import { closeProject, openSource, useStore } from '../state/store'
import { Banner } from './common'

export function ProjectsView() {
  const { project, source } = useStore()
  const [recent, setRecent] = useState<RememberedProject[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [threadUrl, setThreadUrl] = useState('')
  const [dragging, setDragging] = useState(false)
  const supported = isFsaSupported()

  useEffect(() => {
    void listRememberedProjects().then(setRecent)
  }, [project])

  /**
   * Run an importer and show its project.
   *
   * `null` means the user dismissed the picker, which is not a problem and gets no
   * banner -- pressing Escape used to be reported as a permission failure. Real
   * failures throw. `whenEmpty` is for the callers where nothing came back but the
   * user did not cancel either, such as reopening a folder that has since moved.
   */
  async function open(
    fn: () => Promise<import('../fs/source').ProjectSource | null>,
    whenEmpty?: string,
  ) {
    setBusy(true)
    setProblem(null)
    try {
      const next = await fn()
      if (!next) {
        if (whenEmpty) setProblem(whenEmpty)
        return
      }
      // Navigating on a failed open would land on a view with no project to show.
      if (await openSource(next)) navigate('scan')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  async function openThread(urlToOpen: string) {
    const target = parseThreadUrl(urlToOpen)
    if (!target) {
      setProblem('Please enter a valid Twitter/X or Bluesky thread URL.')
      return
    }
    await open(() => openThreadProject(target, setProgress))
  }

  // A whole-page drop target: a folder, loose images, or a PDF dropped anywhere on
  // this screen starts a project, the same as the buttons below. Scoped to this
  // view's lifetime, so it never competes with the scan view's own drop handling --
  // only one of the two is ever mounted at a time.
  useEffect(() => {
    let depth = 0
    const isFileDrag = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'))

    function onDragEnter(event: DragEvent) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth++
      setDragging(true)
    }
    function onDragOver(event: DragEvent) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    function onDragLeave(event: DragEvent) {
      if (!isFileDrag(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    function onDrop(event: DragEvent) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const data = event.dataTransfer
      if (data) void open(() => projectSourceFromDrop(data))
    }

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div>
      {dragging && (
        <div class="drop-overlay">
          <strong>Drop a folder, images, or a PDF to open a project</strong>
        </div>
      )}
      <h1>Projects</h1>
      <p class="sub">
        A project is a folder of page images plus a <code>translation.json</code> written
        beside them. A single image or PDF works too, though its translation is kept in
        this browser until you export it. Nothing is uploaded except the pages you
        translate.
      </p>

      {!supported && (
        <Banner kind="warn">
          This browser cannot open folders — that needs the File System Access API, so
          Chrome, Edge or another Chromium desktop browser. Opening a single image or a
          PDF still works here, but its translation is kept in this browser rather than
          beside the file, so export it when you are done.
        </Banner>
      )}
      {progress && <Banner kind="info">{progress}</Banner>}
      {problem && <Banner kind="error">{problem}</Banner>}

      <div class="card">
        <h2>Open</h2>
        <div class="row">
          <button
            class="primary"
            disabled={!supported || busy}
            onClick={() => void open(pickDirectoryProject)}
          >
            Open folder of images…
          </button>
          {/* Not gated on File System Access: this path falls back to a file input. */}
          <button
            disabled={busy}
            onClick={() => void open(pickFileProject)}
            title="A single page, or a PDF rasterised into pages"
          >
            Open image or PDF…
          </button>
          {import.meta.env.DEV && (
            <button
              disabled={busy}
              onClick={() =>
                void open(async () => (await import('../fs/dev-source')).openDevSource())
              }
              title="Sample pages served by the dev server, saved to localStorage"
            >
              Open sample pages
            </button>
          )}
          {import.meta.env.DEV && (
            <button
              class="small"
              onClick={async () => {
                ;(await import('../fs/dev-source')).resetDevSource()
                await closeProject()
              }}
            >
              Reset sample
            </button>
          )}
        </div>
        <p class="muted" style="margin-bottom:0">
          Or drop a folder, a PDF, or a group of images anywhere on this page.
        </p>

        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">
          <label for="thread-url-input">Twitter / Bluesky thread URL</label>
          <div class="row" style="gap:8px">
            <input
              id="thread-url-input"
              type="url"
              placeholder="https://x.com/.../status/... or https://bsky.app/profile/.../post/..."
              value={threadUrl}
              disabled={busy}
              onInput={(e) => setThreadUrl((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && threadUrl.trim() && !busy) {
                  e.preventDefault()
                  void openThread(threadUrl)
                }
              }}
              style="flex:1"
            />
            <button
              disabled={busy || !threadUrl.trim()}
              onClick={() => void openThread(threadUrl)}
              style="white-space:nowrap"
            >
              {busy && progress ? progress : 'Import thread'}
            </button>
          </div>
        </div>
      </div>

      {project && source && (
        <div class="card">
          <h2>Open now</h2>
          <div class="row">
            <strong>{project.project.name}</strong>
            <span class="muted">
              {project.pages.length} pages · {source.jsonName}
            </span>
            <span class="spacer" style="flex:1" />
            <button onClick={() => navigate('scan')}>Scan</button>
            <button onClick={() => navigate('translate')}>Translate</button>
            <button onClick={() => navigate('read')}>Read</button>
            <button class="danger" onClick={() => void closeProject()}>
              Close
            </button>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div class="card">
          <h2>Recent</h2>
          <p class="muted" style="margin-top:-4px">
            Reopening asks for permission again — browsers do not keep folder or file
            access across sessions.
          </p>
          <table class="table">
            <tbody>
              {recent.map(({ key: name, kind }) => (
                <tr key={name}>
                  <td>
                    {name} <span class="muted">{kind}</span>
                  </td>
                  <td style="width:1%;white-space:nowrap">
                    <button
                      class="small"
                      disabled={busy}
                      onClick={() =>
                        void open(
                          () => reviveProject(name),
                          'Could not reopen that. Grant permission when the browser asks, ' +
                            'or it may have been moved or renamed.',
                        )
                      }
                    >
                      Open
                    </button>{' '}
                    <button
                      class="small"
                      onClick={() =>
                        void forgetProject(name).then(() =>
                          setRecent((r) => r.filter((x) => x.key !== name)),
                        )
                      }
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
