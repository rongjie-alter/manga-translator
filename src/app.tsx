import { useEffect, useState } from 'preact/hooks'
import { installUnloadGuard, saveNow, useStore } from './state/store'
import { ProjectsView } from './ui/ProjectsView'
import { ScanView } from './ui/ScanView'
import { TranslateView } from './ui/TranslateView'
import { ReviewView } from './ui/ReviewView'
import { ReaderView } from './ui/ReaderView'
import { SettingsView } from './ui/SettingsView'
import { Banner } from './ui/common'

const ROUTES = ['projects', 'scan', 'translate', 'review', 'read', 'settings'] as const
export type Route = (typeof ROUTES)[number]

function currentRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '')
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : 'projects'
}

export function navigate(route: Route): void {
  location.hash = '#/' + route
}

function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute())
  useEffect(() => {
    const onChange = () => setRoute(currentRoute())
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  const state = useStore()
  const hasProject = state.project !== null

  useEffect(installUnloadGuard, [])

  // Routes that need a project fall back to the project picker rather than rendering
  // an empty shell -- reachable by typing a URL, or by reloading after closing one.
  const effective: Route = !hasProject && route !== 'settings' ? 'projects' : route

  return (
    <div class="shell">
      <header class="topbar">
        <span class="brand">Comic Translator</span>
        <nav>
          <Link route="projects" current={effective} label="Projects" />
          <Link route="scan" current={effective} label="Scan" disabled={!hasProject} />
          <Link route="translate" current={effective} label="Translate" disabled={!hasProject} />
          <Link route="review" current={effective} label="Review" disabled={!hasProject} />
          <Link route="read" current={effective} label="Read" disabled={!hasProject} />
          <Link route="settings" current={effective} label="Settings" />
        </nav>
        <span class="spacer" />
        <span class="status">{saveStatus(state.saving, state.dirty, state.project !== null)}</span>
      </header>

      <main>
        {state.error && (
          <Banner kind="error">
            {state.error}{' '}
            <button class="small" onClick={() => void saveNow()}>
              retry save
            </button>
          </Banner>
        )}
        {effective === 'projects' && <ProjectsView />}
        {effective === 'scan' && <ScanView />}
        {effective === 'translate' && <TranslateView />}
        {effective === 'review' && <ReviewView />}
        {effective === 'read' && <ReaderView />}
        {effective === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}

function saveStatus(saving: boolean, dirty: boolean, open: boolean): string {
  if (!open) return ''
  if (saving) return 'saving…'
  if (dirty) return 'unsaved changes'
  return 'saved'
}

function Link({
  route,
  current,
  label,
  disabled,
}: {
  route: Route
  current: Route
  label: string
  disabled?: boolean
}) {
  return (
    <a
      href={'#/' + route}
      aria-current={current === route ? 'page' : undefined}
      aria-disabled={disabled ? 'true' : undefined}
    >
      {label}
    </a>
  )
}
