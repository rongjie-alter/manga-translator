/** Small pieces shared by more than one view. */

import { useEffect, useState } from 'preact/hooks'
import type { Page, PageStatus } from '../state/schema'
import { hasPageBlob, loadPageBlob } from '../state/store'

/**
 * Lazily turn a page file into an object URL, and revoke it on unmount.
 *
 * Pages are loaded one at a time on demand rather than all up front: a 200-page project
 * held in memory as blobs is hundreds of megabytes, and the browser only ever shows a
 * handful at once.
 */
export function PageImage({ file, alt }: { file: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let revoked = false
    let objectUrl = ''
    setUrl(null)
    setError(false)
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
  }, [file])

  if (error) return <div class="empty">{file} could not be loaded</div>
  if (!url) return <div class="empty" style="min-height:120px" />
  return <img src={url} alt={alt ?? file} loading="lazy" />
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
