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

interface MediaPhoto {
  type?: string
  url?: string
}

interface ThreadPost {
  id?: string
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

/**
 * Fetch thread metadata, download all attached images, and create a project source.
 */
export async function openThreadProject(
  target: ParsedThread,
  onProgress?: (status: string) => void,
): Promise<ProjectSource> {
  onProgress?.('Fetching thread…')

  const apiUrl =
    target.type === 'twitter'
      ? `https://api.fxtwitter.com/2/thread/${target.id}`
      : `https://api.fxbsky.app/2/thread/${encodeURIComponent(target.handle)}/${encodeURIComponent(target.rkey)}`

  const res = await fetch(apiUrl)
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

  const posts =
    Array.isArray(data.thread) && data.thread.length > 0
      ? data.thread
      : data.status
        ? [data.status]
        : []

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

  for (let i = 0; i < imageUrls.length; i++) {
    onProgress?.(`Downloading images (${i + 1}/${imageUrls.length})…`)
    const imgUrl = imageUrls[i]!
    const imgRes = await fetch(imgUrl)
    if (!imgRes.ok) {
      throw new Error(`Failed to download image ${i + 1} (${imgRes.status})`)
    }
    const blob = await imgRes.blob()

    let ext = extensionFor(blob.type)
    if (!ext) {
      const match = imgUrl.match(/\.(jpe?g|png|webp|gif|bmp|avif)(?=[?#]|$)/i)
      if (match) ext = '.' + match[1]!.toLowerCase()
    }
    if (!ext) ext = '.jpg'

    const fileName = `page-${String(i + 1).padStart(width, '0')}${ext}`
    files.push(new File([blob], fileName, { type: blob.type || 'image/jpeg' }))
  }

  onProgress?.('Opening project…')
  return openImagesProject(files, projectName, threadProjectId(target))
}
