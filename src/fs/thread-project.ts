/**
 * Turn a Twitter/X or Bluesky thread URL into a translation project.
 *
 * Uses FxEmbed API (api.fxtwitter.com and api.fxbsky.app) to unroll the thread,
 * extract all attached images in order, and load them as a project source.
 */

import { extensionFor } from './add-images'
import { openImagesProject } from './file-source'
import type { ProjectSource } from './source'

export interface TwitterThread {
  type: 'twitter'
  id: string
}

export interface BlueskyThread {
  type: 'bluesky'
  handle: string
  rkey: string
}

export type ParsedThread = TwitterThread | BlueskyThread

/**
 * A stable id for a thread/post, so re-importing the same URL later finds the
 * translation it already saved instead of starting a new, unreachable project --
 * the same rationale `fileProjectId` uses for a re-saved file.
 */
export function threadProjectId(target: ParsedThread): string {
  return target.type === 'twitter'
    ? 'thread:twitter:' + target.id
    : 'thread:bluesky:' + target.handle + '/' + target.rkey
}

/**
 * Bound on how many continuation fetches `fetchFullThread` will issue when chasing a
 * thread that keeps growing, and on the total posts it will collect -- belt-and-suspenders
 * against a runaway loop if the chaining heuristic below ever misbehaves.
 */
const MAX_CHAIN_ITERATIONS = 20
const MAX_THREAD_POSTS = 50

const TWITTER_WEB =
  /^(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/(?:#!\/)?\w+\/status(?:es)?\/(\d+)/i
const TWITTER_API =
  /^(?:https?:\/\/)?api\.fxtwitter\.com\/2\/(?:thread|status)\/(\d+)/i

const BSKY_WEB =
  /^(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)?(?:bsky\.app|fxbsky\.app)\/profile\/([^/?#]+)\/post\/([^/?#]+)/i
const BSKY_API =
  /^(?:https?:\/\/)?api\.fxbsky\.app\/2\/(?:thread|status)\/([^/?#]+)\/([^/?#]+)/i

/**
 * Parse a user-pasted URL into a Twitter or Bluesky target descriptor.
 * Returns null if the string is not a recognized thread/post URL.
 */
export function parseThreadUrl(rawUrl: string): ParsedThread | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  const twitterMatch = trimmed.match(TWITTER_WEB) || trimmed.match(TWITTER_API)
  if (twitterMatch) {
    return { type: 'twitter', id: twitterMatch[1]! }
  }

  const bskyMatch = trimmed.match(BSKY_WEB) || trimmed.match(BSKY_API)
  if (bskyMatch) {
    return {
      type: 'bluesky',
      handle: decodeURIComponent(bskyMatch[1]!),
      rkey: decodeURIComponent(bskyMatch[2]!),
    }
  }

  return null
}

/**
 * Bluesky's image CDN (`cdn.bsky.app`) does not send CORS headers, so a plain
 * `fetch()` of its URLs fails cross-origin. The same bytes are also served,
 * with CORS enabled, straight from the post author's own PDS (Personal Data
 * Server) via the AT Protocol `com.atproto.sync.getBlob` endpoint -- and the
 * CDN URL already embeds the DID and CID that endpoint needs. This avoids
 * needing any proxy/backend for the common case.
 */
function parseBlueskyCdnUrl(url: string): { did: string; cid: string } | null {
  const match = url.match(
    /^https?:\/\/cdn\.bsky\.app\/img\/[^/]+\/plain\/([^/]+)\/([^/@?#]+)/i,
  )
  if (!match) return null
  return { did: match[1]!, cid: match[2]! }
}

interface DidDocument {
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>
}

async function fetchDidDocument(did: string): Promise<DidDocument | null> {
  let docUrl: string
  if (did.startsWith('did:plc:')) {
    docUrl = `https://plc.directory/${did}`
  } else if (did.startsWith('did:web:')) {
    const parts = did.slice('did:web:'.length).split(':').map(decodeURIComponent)
    const domain = parts[0]
    if (!domain) return null
    docUrl =
      parts.length > 1
        ? `https://${domain}/${parts.slice(1).join('/')}/did.json`
        : `https://${domain}/.well-known/did.json`
  } else {
    return null
  }

  try {
    const res = await fetch(docUrl)
    if (!res.ok) return null
    return (await res.json()) as DidDocument
  } catch {
    return null
  }
}

/** Resolves a DID to its PDS host. Results should be cached by the caller. */
async function resolvePds(did: string): Promise<string | null> {
  const doc = await fetchDidDocument(did)
  const pds = doc?.service?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint
  return pds || null
}

async function fetchBlueskyBlob(did: string, cid: string, pds: string): Promise<Blob> {
  const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`getBlob failed (${res.status})`)
  }
  return res.blob()
}

/** Last-resort CORS-enabled image proxy, for a self-hosted PDS with no CORS headers. */
async function fetchViaImageProxy(url: string): Promise<Blob> {
  const res = await fetch(`https://wsrv.nl/?url=${encodeURIComponent(url)}`)
  if (!res.ok) {
    throw new Error(`Image proxy failed (${res.status})`)
  }
  return res.blob()
}

/**
 * Downloads a single thread image, trying Bluesky's native PDS blob endpoint
 * first (to route around cdn.bsky.app's missing CORS headers), then the
 * direct URL, then a public CORS image proxy as a last resort.
 */
async function downloadThreadImage(
  imgUrl: string,
  index: number,
  target: ParsedThread,
  pdsCache: Map<string, string | null>,
): Promise<Blob> {
  if (target.type === 'bluesky') {
    const parsed = parseBlueskyCdnUrl(imgUrl)
    if (parsed) {
      try {
        let pds = pdsCache.get(parsed.did)
        if (pds === undefined) {
          pds = await resolvePds(parsed.did)
          pdsCache.set(parsed.did, pds)
        }
        if (pds) {
          return await fetchBlueskyBlob(parsed.did, parsed.cid, pds)
        }
      } catch {
        // Fall through to the direct fetch / proxy below.
      }
    }
  }

  let lastError: unknown
  try {
    const res = await fetch(imgUrl)
    if (!res.ok) {
      throw new Error(`Failed to download image ${index + 1} (${res.status})`)
    }
    return await res.blob()
  } catch (err) {
    lastError = err
  }

  if (target.type === 'bluesky') {
    try {
      return await fetchViaImageProxy(imgUrl)
    } catch (err) {
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

interface MediaPhoto {
  type?: string
  url?: string
}

interface ThreadPost {
  id?: string
  url?: string
  text?: string
  author?: {
    name?: string
    screen_name?: string
  }
  media?: {
    photos?: MediaPhoto[]
    all?: MediaPhoto[]
  }
}

interface ThreadApiResponse {
  code?: number
  message?: string
  status?: ThreadPost
  thread?: ThreadPost[]
  author?: {
    name?: string
    screen_name?: string
  }
}

function apiUrlFor(target: ParsedThread): string {
  return target.type === 'twitter'
    ? `https://api.fxtwitter.com/2/thread/${target.id}`
    : `https://api.fxbsky.app/2/thread/${encodeURIComponent(target.handle)}/${encodeURIComponent(target.rkey)}`
}

/** Issues the single underlying API fetch. The only step allowed to throw. */
async function fetchThreadJson(target: ParsedThread): Promise<ThreadApiResponse> {
  const res = await fetch(apiUrlFor(target))
  if (!res.ok) {
    let message = `Failed to fetch thread (${res.status} ${res.statusText})`
    try {
      const errJson = (await res.json()) as ThreadApiResponse
      if (errJson?.message) message = errJson.message
    } catch {
      // Ignore json parse error on non-json error responses
    }
    throw new Error(message)
  }

  const data = (await res.json()) as ThreadApiResponse
  if (data.code && data.code !== 200) {
    throw new Error(data.message || `API error code ${data.code}`)
  }
  return data
}

function extractThreadPosts(data: ThreadApiResponse): ThreadPost[] {
  return Array.isArray(data.thread) && data.thread.length > 0
    ? data.thread
    : data.status
      ? [data.status]
      : []
}

/**
 * The thread API returns a windowed slice of the self-reply chain anchored on
 * whichever post id was queried, not the whole thread -- confirmed empirically: querying
 * post 1 of a 14-post thread returns only posts 1-7, but re-querying anchored on post 7
 * (the last post of that response) returns 1-8, then anchored on 8 returns 1-13, then on
 * 13 returns all 14. So we keep re-querying anchored on the last post's own URL until the
 * response stops growing.
 *
 * Each response is a full replacement of `posts`, never a merge -- every response is
 * anchored back to post 1, so a longer response is simply adopted as-is.
 */
async function fetchFullThread(
  target: ParsedThread,
  onProgress?: (status: string) => void,
): Promise<{ firstData: ThreadApiResponse; posts: ThreadPost[] }> {
  const firstData = await fetchThreadJson(target)
  let posts = extractThreadPosts(firstData)
  const seen = new Set<string>([threadProjectId(target)])

  for (let i = 0; i < MAX_CHAIN_ITERATIONS && posts.length < MAX_THREAD_POSTS; i++) {
    const last = posts[posts.length - 1]
    if (!last?.url) break

    const nextAnchor = parseThreadUrl(last.url)
    if (!nextAnchor) break

    const nextKey = threadProjectId(nextAnchor)
    if (seen.has(nextKey)) break
    seen.add(nextKey)

    onProgress?.(`Fetching more of thread (${posts.length} posts so far)…`)

    let nextData: ThreadApiResponse
    try {
      nextData = await fetchThreadJson(nextAnchor)
    } catch {
      // The first fetch already succeeded -- a flaky continuation should not
      // throw away the pages already found, so stop chaining and use what we have.
      break
    }

    const nextPosts = extractThreadPosts(nextData)
    if (nextPosts.length <= posts.length) break
    posts = nextPosts
  }

  return { firstData, posts }
}

/**
 * Fetch thread metadata (chasing continuations, see `fetchFullThread`) and download all
 * attached images, without opening a project -- shared by `openThreadProject` (new
 * project) and the Scan view's "Add thread" fallback (append to an existing project).
 */
export async function fetchThreadImages(
  target: ParsedThread,
  onProgress?: (status: string) => void,
): Promise<{ files: File[]; projectName: string }> {
  onProgress?.('Fetching thread…')

  const { firstData: data, posts } = await fetchFullThread(target, onProgress)

  const imageUrls: string[] = []
  for (const post of posts) {
    const photos =
      post.media?.photos ??
      post.media?.all?.filter((m) => m.type === 'photo') ??
      []
    for (const photo of photos) {
      if (photo?.url && typeof photo.url === 'string') {
        imageUrls.push(photo.url)
      }
    }
  }

  if (imageUrls.length === 0) {
    throw new Error('No images found in this thread.')
  }

  // Derive a user-friendly project name from author and initial text snippet.
  const author = data.status?.author || data.author
  const authorHandle = author?.screen_name
    ? `@${author.screen_name}`
    : (author?.name ?? '')
  const rawText = (data.status?.text || '')
    .split('\n')[0]!
    .replace(/https?:\/\/\S+/g, '')
    .trim()
  const titleSnippet = rawText.slice(0, 40).trim()
  const fallbackId =
    target.type === 'twitter' ? `tweet-${target.id}` : `post-${target.rkey}`
  const projectNameRaw =
    [authorHandle, titleSnippet || fallbackId].filter(Boolean).join(' - ') ||
    'Thread Project'
  const projectName = projectNameRaw.replace(/[/\\?%*:|"<>]/g, '_')

  onProgress?.(`Downloading images (0/${imageUrls.length})…`)
  const width = Math.max(2, String(imageUrls.length).length)
  const files: File[] = []
  const pdsCache = new Map<string, string | null>()

  for (let i = 0; i < imageUrls.length; i++) {
    onProgress?.(`Downloading images (${i + 1}/${imageUrls.length})…`)
    const imgUrl = imageUrls[i]!
    const blob = await downloadThreadImage(imgUrl, i, target, pdsCache)

    let ext = extensionFor(blob.type)
    if (!ext) {
      const match = imgUrl.match(/\.(jpe?g|png|webp|gif|bmp|avif)(?=[?#]|$)/i)
      if (match) ext = '.' + match[1]!.toLowerCase()
    }
    if (!ext) ext = '.jpg'

    const fileName = `page-${String(i + 1).padStart(width, '0')}${ext}`
    files.push(new File([blob], fileName, { type: blob.type || 'image/jpeg' }))
  }

  return { files, projectName }
}

/**
 * Fetch thread metadata, download all attached images, and create a project source.
 */
export async function openThreadProject(
  target: ParsedThread,
  onProgress?: (status: string) => void,
): Promise<ProjectSource> {
  const { files, projectName } = await fetchThreadImages(target, onProgress)
  onProgress?.('Opening project…')
  return openImagesProject(files, projectName, threadProjectId(target))
}
