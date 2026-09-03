/** Small pieces shared by more than one view. */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { Page, PageStatus } from '../state/schema'
import { hasPageBlob, loadPageBlob } from '../state/store'
import { observeOnce } from './visibility'

/**
 * Turn a page file into an object URL once it is nearly on screen, and revoke it on
 * unmount.
 *
 * The visibility gate is the point. `content-visibility: auto` on the card skips
 * layout and paint for offscreen pages, and `loading="lazy"` defers the network for
 * an ordinary URL -- but neither stops this component from mounting and reading the
 * page, and by the time the `<img>` exists the bytes are already in memory. Without
 * the gate, opening a 200-page project reads all 200 pages at once; when the pages
 * come from a PDF, that renders the entire book to look at a grid of thumbnails.
 */
export function PageImage({ file, alt }: { file: string; alt?: string }) {
  const target = useRef<Element | null>(null)
  // A callback ref, because the observed node changes element type as the image loads.
  const attach = (el: Element | null) => {
    target.current = el
  }
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setVisible(false)
    const el = target.current
    if (!el) {
      setVisible(true)
      return
    }
    return observeOnce(el, () => setVisible(true))
  }, [file])

  useEffect(() => {
    let revoked = false
    let objectUrl = ''
    setUrl(null)
    setError(false)
    if (!visible) return
    if (!hasPageBlob(file)) {
      setError(true)
      return
    }
    loadPageBlob(file)
      .then((blob) => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => !revoked && setError(true))
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file, visible])

  if (error) {
    return (
      <div class="empty" ref={attach}>
        {file} could not be loaded
      </div>
    )
  }
  if (!url) return <div class="empty page-placeholder" ref={attach} />
  return <img src={url} alt={alt ?? file} loading="lazy" ref={attach} />
}

export function StatusDot({ status }: { status: PageStatus }) {
  return <span class={'dot ' + status} title={status} />
}

export const STATUS_LABEL: Record<PageStatus, string> = {
  pending: 'not translated',
  translated: 'translated',
  failed: 'failed',
  blocked: 'blocked by the provider',
  stale: 'image changed since translating',
}

export function countByStatus(pages: Page[]): Record<PageStatus, number> {
  const counts: Record<PageStatus, number> = {
    pending: 0,
    translated: 0,
    failed: 0,
    blocked: 0,
    stale: 0,
  }
  for (const page of pages) counts[page.status]++
  return counts
}

/** Live "in 42s" countdown for rate-limit waits, so the app never looks frozen. */
export function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [until])
  const seconds = Math.max(0, Math.ceil((until - now) / 1000))
  return <span>{seconds}s</span>
}

export function Banner({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'error'
  children: preact.ComponentChildren
}) {
  return <div class={'banner ' + kind}>{children}</div>
}
