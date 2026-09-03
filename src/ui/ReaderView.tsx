import { useEffect, useRef, useState } from 'preact/hooks'
import { orderedPages, type Line, type Page } from '../state/schema'
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

export function ReaderView() {
  const { project } = useStore()
  const [visible, setVisible] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const pages = project ? orderedPages(project) : []

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const index = Number((entry.target as HTMLElement).dataset['index'])
          if (Number.isFinite(index)) setVisible(index)
        }
      },
      { rootMargin: '200px 0px', threshold: 0.01 },
    )
    for (const el of container.querySelectorAll('[data-index]')) observer.observe(el)
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
            {page.excluded ? 'excluded from translation' : (page.lastRun?.error ?? STATUS_LABEL[page.status])}
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
