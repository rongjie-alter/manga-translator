import { useEffect, useState } from 'preact/hooks'
import { navigate } from '../app'
import {
  forgetProject,
  isFsaSupported,
  listRememberedProjects,
  pickDirectoryProject,
  reviveProject,
} from '../fs/handles'
import { closeProject, openSource, useStore } from '../state/store'
import { Banner } from './common'

export function ProjectsView() {
  const { project, source } = useStore()
  const [recent, setRecent] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const supported = isFsaSupported()

  useEffect(() => {
    void listRememberedProjects().then(setRecent)
  }, [project])

  async function open(fn: () => Promise<import('../fs/source').ProjectSource | null>) {
    setBusy(true)
    setProblem(null)
    try {
      const next = await fn()
      if (!next) {
        setProblem('Could not open that folder. Grant permission when the browser asks.')
        return
      }
      await openSource(next)
      navigate('scan')
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1>Projects</h1>
      <p class="sub">
        A project is a folder of page images plus a <code>translation.json</code> written
        beside them. Nothing is uploaded except the pages you translate.
      </p>

      {!supported && (
        <Banner kind="warn">
          This browser cannot open folders. The app needs the File System Access API —
          Chrome, Edge or another Chromium desktop browser.
        </Banner>
      )}
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
                closeProject()
              }}
            >
              Reset sample
            </button>
          )}
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
            <button class="danger" onClick={closeProject}>
              Close
            </button>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div class="card">
          <h2>Recent folders</h2>
          <p class="muted" style="margin-top:-4px">
            Reopening asks for permission again — browsers do not keep folder access
            across sessions.
          </p>
          <table class="table">
            <tbody>
              {recent.map((name) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td style="width:1%;white-space:nowrap">
                    <button
                      class="small"
                      disabled={busy}
                      onClick={() => void open(() => reviveProject(name))}
                    >
                      Open
                    </button>{' '}
                    <button
                      class="small"
                      onClick={() => void forgetProject(name).then(() => setRecent((r) => r.filter((x) => x !== name)))}
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
