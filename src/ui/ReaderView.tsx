import { useEffect, useRef, useState } from 'preact/hooks'
import { effectiveStatus, orderedPages, type Line, type Page } from '../state/schema'
import { useStore } from '../state/store'
import { PageImage, STATUS_LABEL } from './common'

/**
 * Continuous reader: page image beside its translation, scrolling through the whole book.
 *
 * Only pages near the viewport are actually mounted. A 200-page project would otherwise
 * hold 200 decoded images at once, and `content-visibility` alone does not stop the
 * object URLs being created.
 */
const WINDOW_BEFORE = 2
const WINDOW_AFTER = 4

/**
 * Which page counts as "current" when several are intersecting at once (e.g. the
 * very first observer callback after mount, which can report every spread within
 * the lead-in margin as intersecting in one batch): the topmost one, since reading
 * order is top-to-bottom.
 */
export function currentPageFrom(intersecting: ReadonlySet<number>): number | undefined {
  if (intersecting.size === 0) return undefined
  return Math.min(...intersecting)
}

/**
 * Last-read page, kept in memory only (not the project JSON -- it's UI state, not
 * something a shared folder should carry). Views unmount on navigation, so this is
 * what survives switching to Settings and back instead of resetting to page 1.
 */
let lastPosition: { projectName: string; index: number } | null = null

export function ReaderView() {
  const { project } = useStore()
  const pages = project ? orderedPages(project) : []

  const initial =
    lastPosition && project && lastPosition.projectName === project.project.name
      ? Math.min(lastPosition.index, Math.max(pages.length - 1, 0))
      : 0
  const [visible, setVisible] = useState(initial)
  const containerRef = useRef<HTMLDivElement>(null)
  const initialScroll = useRef(initial)

  useEffect(() => {
    if (project) lastPosition = { projectName: project.project.name, index: visible }
  }, [visible, project])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const intersecting = new Set<number>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset['index'])
          if (!Number.isFinite(index)) continue
          if (entry.isIntersecting) intersecting.add(index)
          else intersecting.delete(index)
        }
        const current = currentPageFrom(intersecting)
        if (current !== undefined) setVisible(current)
      },
      { rootMargin: '200px 0px', threshold: 0.01 },
    )
    for (const el of container.querySelectorAll('[data-index]')) observer.observe(el)

    if (initialScroll.current > 0) {
      container.querySelector(`[data-index="${initialScroll.current}"]`)?.scrollIntoView({ block: 'start' })
      initialScroll.current = 0
    }

    return () => observer.disconnect()
  }, [pages.length])

  if (!project) return null
  if (pages.length === 0) return <div class="empty">No pages to read.</div>

  const rtl = project.project.readingDirection === 'rtl'

  return (
    <div>
      <div class="row" style="margin-bottom:14px">
        <h1 style="margin:0">{project.project.name}</h1>
        <span class="muted">
          page {Math.min(visible + 1, pages.length)} of {pages.length}
        </span>
        <span class="spacer" style="flex:1" />
        <span class="muted">
          {project.project.readingDirection === 'rtl' ? 'right to left' : 'left to right'}
        </span>
      </div>

      <div class="reader" ref={containerRef}>
        {pages.map((page, i) => (
          <Spread
            key={page.file}
            page={page}
            index={i}
            rtl={rtl}
            mounted={i >= visible - WINDOW_BEFORE && i <= visible + WINDOW_AFTER}
          />
        ))}
      </div>
    </div>
  )
}

function Spread({
  page,
  index,
  rtl,
  mounted,
}: {
  page: Page
  index: number
  rtl: boolean
  mounted: boolean
}) {
  return (
    <div class={'spread' + (rtl ? ' rtl' : '')} data-index={index}>
      <div>
        {mounted ? (
          <PageImage file={page.file} alt={'page ' + (index + 1)} />
        ) : (
          <div class="empty" style="min-height:600px">
            {index + 1}
          </div>
        )}
      </div>
      <div class="panel">
        <div class="row" style="margin-bottom:8px">
          <strong>{index + 1}</strong>
          <span class="muted mono" style="font-size:12px">
            {page.file}
          </span>
        </div>
        {page.lines.length === 0 ? (
          <p class="muted">
            {page.excluded ? 'excluded from translation' : (page.lastRun?.error ?? STATUS_LABEL[effectiveStatus(page)])}
          </p>
        ) : (
          <ol>
            {page.lines.map((line) => (
              <li key={line.id}>
                <ReaderLine line={line} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function ReaderLine({ line }: { line: Line }) {
  if (line.kind === 'sfx') return <span class="sfx">{line.translation}</span>
  return <span>{line.translation}</span>
}
