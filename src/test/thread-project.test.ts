import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fs/idb', () => ({
  idbGet: vi.fn(),
  idbSet: vi.fn(),
  idbDelete: vi.fn(),
  idbKeys: vi.fn(),
}))

vi.mock('../fs/blob-store', () => ({
  putPageBlob: vi.fn(),
  getPageBlob: vi.fn(),
  listPageBlobNames: vi.fn(async () => []),
  clearPageBlobs: vi.fn(),
}))

import {
  fetchThreadImages,
  openThreadProject,
  parseThreadUrl,
  threadProjectId,
} from '../fs/thread-project'
import { idbSet } from '../fs/idb'

describe('parseThreadUrl', () => {
  describe('Twitter / X URLs', () => {
    it('parses standard x.com status URLs', () => {
      expect(
        parseThreadUrl('https://x.com/kou446/status/2100071220813451657'),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })
    })

    it('parses twitter.com URLs with query parameters and trailing paths', () => {
      expect(
        parseThreadUrl(
          'https://twitter.com/kou446/status/2100071220813451657/photo/1?s=20',
        ),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })
    })

    it('parses fxtwitter and fixupx URLs', () => {
      expect(
        parseThreadUrl('https://fxtwitter.com/kou446/status/2100071220813451657'),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })

      expect(
        parseThreadUrl('https://fixupx.com/kou446/status/2100071220813451657'),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })
    })

    it('parses fxtwitter API URLs directly', () => {
      expect(
        parseThreadUrl('https://api.fxtwitter.com/2/thread/2100071220813451657'),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })

      expect(
        parseThreadUrl('https://api.fxtwitter.com/2/status/2100071220813451657'),
      ).toEqual({
        type: 'twitter',
        id: '2100071220813451657',
      })
    })
  })

  describe('Bluesky URLs', () => {
    it('parses standard bsky.app post URLs', () => {
      expect(
        parseThreadUrl('https://bsky.app/profile/nico32.bsky.social/post/3mvnqge7k7226'),
      ).toEqual({
        type: 'bluesky',
        handle: 'nico32.bsky.social',
        rkey: '3mvnqge7k7226',
      })
    })

    it('parses DID handle and query strings', () => {
      expect(
        parseThreadUrl(
          'https://bsky.app/profile/did:plc:otafc3kbbjqm72i2yqqrsj43/post/3mvnqge7k7226?ref_src=embed',
        ),
      ).toEqual({
        type: 'bluesky',
        handle: 'did:plc:otafc3kbbjqm72i2yqqrsj43',
        rkey: '3mvnqge7k7226',
      })
    })

    it('parses fxbsky web and API URLs', () => {
      expect(
        parseThreadUrl('https://fxbsky.app/profile/nico32.bsky.social/post/3mvnqge7k7226'),
      ).toEqual({
        type: 'bluesky',
        handle: 'nico32.bsky.social',
        rkey: '3mvnqge7k7226',
      })

      expect(
        parseThreadUrl('https://api.fxbsky.app/2/thread/nico32.bsky.social/3mvnqge7k7226'),
      ).toEqual({
        type: 'bluesky',
        handle: 'nico32.bsky.social',
        rkey: '3mvnqge7k7226',
      })
    })
  })

  describe('Invalid or unsupported URLs', () => {
    it('returns null for unrelated URLs or empty strings', () => {
      expect(parseThreadUrl('')).toBeNull()
      expect(parseThreadUrl('   ')).toBeNull()
      expect(parseThreadUrl('https://google.com')).toBeNull()
      expect(parseThreadUrl('https://x.com/home')).toBeNull()
      expect(parseThreadUrl('https://bsky.app/notifications')).toBeNull()
    })
  })
})

describe('threadProjectId', () => {
  it('is the same for the same tweet, so re-importing finds the same translation', () => {
    expect(threadProjectId({ type: 'twitter', id: '100' })).toBe(
      threadProjectId({ type: 'twitter', id: '100' }),
    )
  })

  it('is the same for the same bluesky post', () => {
    expect(
      threadProjectId({ type: 'bluesky', handle: 'user.bsky.social', rkey: 'post1' }),
    ).toBe(threadProjectId({ type: 'bluesky', handle: 'user.bsky.social', rkey: 'post1' }))
  })

  it('differs across tweets, posts, and thread types', () => {
    const twitter100 = threadProjectId({ type: 'twitter', id: '100' })
    const twitter101 = threadProjectId({ type: 'twitter', id: '101' })
    const bsky = threadProjectId({ type: 'bluesky', handle: 'user.bsky.social', rkey: 'post1' })

    expect(twitter100).not.toBe(twitter101)
    expect(twitter100).not.toBe(bsky)
  })
})

describe('openThreadProject', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('unrolls a Twitter thread, downloads all photos, and opens a project', async () => {
    const threadData = {
      code: 200,
      status: {
        id: '100',
        text: 'First tweet text\n#tag',
        author: { name: 'Artist', screen_name: 'artist_x' },
        media: {
          photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }],
        },
      },
      thread: [
        {
          id: '100',
          text: 'First tweet text',
          media: {
            photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }],
          },
        },
        {
          id: '101',
          text: 'Second tweet text',
          media: {
            photos: [
              { type: 'photo', url: 'https://pbs.twimg.com/p2.png' },
              { type: 'photo', url: 'https://pbs.twimg.com/p3.jpg' },
            ],
          },
        },
      ],
    }

    const progress: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxtwitter.com/2/thread/100')) {
        return new Response(JSON.stringify(threadData), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://pbs.twimg.com/p1.jpg') {
        return new Response(new Blob(['img1'], { type: 'image/jpeg' }), { status: 200 })
      }
      if (url === 'https://pbs.twimg.com/p2.png') {
        return new Response(new Blob(['img2'], { type: 'image/png' }), { status: 200 })
      }
      if (url === 'https://pbs.twimg.com/p3.jpg') {
        return new Response(new Blob(['img3'], { type: 'image/jpeg' }), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as any

    const source = await openThreadProject(
      { type: 'twitter', id: '100' },
      (msg) => progress.push(msg),
    )

    expect(source.name).toBe('@artist_x - First tweet text')
    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-01.jpg', 'page-02.png', 'page-03.jpg'])
    expect(progress).toContain('Fetching thread…')
    expect(progress).toContain('Downloading images (3/3)…')
  })

  it('re-importing the same tweet reuses the same saved-translation key', async () => {
    const singlePhotoThread = {
      code: 200,
      status: {
        id: '100',
        text: 'A tweet',
        author: { name: 'Artist', screen_name: 'artist_x' },
        media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] },
      },
    }
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxtwitter.com/2/thread/100')) {
        return new Response(JSON.stringify(singlePhotoThread), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
    }) as any

    vi.mocked(idbSet).mockClear()
    const first = await openThreadProject({ type: 'twitter', id: '100' })
    const second = await openThreadProject({ type: 'twitter', id: '100' })
    await first.writeJson('{"schemaVersion":1}')
    await second.writeJson('{"schemaVersion":1}')

    const [keyFirst] = vi.mocked(idbSet).mock.calls[0]!
    const [keySecond] = vi.mocked(idbSet).mock.calls[1]!
    expect(keyFirst).toBe(keySecond)
  })

  it('unrolls a Bluesky thread and extracts photos', async () => {
    const bskyData = {
      code: 200,
      status: {
        id: 'post1',
        text: 'Bluesky post title',
        author: { name: 'User', screen_name: 'user.bsky.social' },
      },
      thread: [
        {
          id: 'post1',
          media: {
            photos: [{ type: 'photo', url: 'https://cdn.bsky.app/img1' }],
          },
        },
        {
          id: 'post2',
          media: {
            photos: [{ type: 'photo', url: 'https://cdn.bsky.app/img2' }],
          },
        },
      ],
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post1')) {
        return new Response(JSON.stringify(bskyData), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(new Blob(['webpbytes'], { type: 'image/webp' }), { status: 200 })
    }) as any

    const source = await openThreadProject({
      type: 'bluesky',
      handle: 'user.bsky.social',
      rkey: 'post1',
    })

    expect(source.name).toBe('@user.bsky.social - Bluesky post title')
    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-01.webp', 'page-02.webp'])
  })

  it('downloads Bluesky photos via the author PDS getBlob endpoint, bypassing the CDN', async () => {
    const did = 'did:plc:otafc3kbbjqm72i2yqqrsj43'
    const cid = 'bafkreifjwisqs3xcduq5jgeiikz5x5mwgqhjccgv4bf3gr2gbjmkeg6eda'
    const cdnUrl = `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`

    const bskyData = {
      code: 200,
      status: { id: 'post1', text: 'Bluesky post title', author: { screen_name: 'user.bsky.social' } },
      thread: [{ id: 'post1', media: { photos: [{ type: 'photo', url: cdnUrl }] } }],
    }

    const calledUrls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calledUrls.push(url)
      if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post1')) {
        return new Response(JSON.stringify(bskyData), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `https://plc.directory/${did}`) {
        return new Response(
          JSON.stringify({
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' },
            ],
          }),
          { status: 200 },
        )
      }
      if (url === `https://pds.example/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`) {
        return new Response(new Blob(['original'], { type: 'image/jpeg' }), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as any

    const source = await openThreadProject({
      type: 'bluesky',
      handle: 'user.bsky.social',
      rkey: 'post1',
    })

    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-01.jpg'])
    expect(calledUrls).not.toContain(cdnUrl)
  })

  it('falls back to the direct CDN fetch when PDS resolution fails', async () => {
    const did = 'did:plc:otafc3kbbjqm72i2yqqrsj43'
    const cid = 'bafkreifjwisqs3xcduq5jgeiikz5x5mwgqhjccgv4bf3gr2gbjmkeg6eda'
    const cdnUrl = `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`

    const bskyData = {
      code: 200,
      status: { id: 'post1', text: 'Bluesky post title', author: { screen_name: 'user.bsky.social' } },
      thread: [{ id: 'post1', media: { photos: [{ type: 'photo', url: cdnUrl }] } }],
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post1')) {
        return new Response(JSON.stringify(bskyData), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `https://plc.directory/${did}`) {
        return new Response('Server error', { status: 500 })
      }
      if (url === cdnUrl) {
        return new Response(new Blob(['direct'], { type: 'image/jpeg' }), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as any

    const source = await openThreadProject({
      type: 'bluesky',
      handle: 'user.bsky.social',
      rkey: 'post1',
    })

    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-01.jpg'])
  })

  it('falls back to the image proxy when both PDS and direct fetch fail', async () => {
    const did = 'did:plc:otafc3kbbjqm72i2yqqrsj43'
    const cid = 'bafkreifjwisqs3xcduq5jgeiikz5x5mwgqhjccgv4bf3gr2gbjmkeg6eda'
    const cdnUrl = `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`

    const bskyData = {
      code: 200,
      status: { id: 'post1', text: 'Bluesky post title', author: { screen_name: 'user.bsky.social' } },
      thread: [{ id: 'post1', media: { photos: [{ type: 'photo', url: cdnUrl }] } }],
    }

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post1')) {
        return new Response(JSON.stringify(bskyData), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `https://plc.directory/${did}`) {
        return new Response('Server error', { status: 500 })
      }
      if (url === cdnUrl) {
        throw new TypeError('Failed to fetch')
      }
      if (url === `https://wsrv.nl/?url=${encodeURIComponent(cdnUrl)}`) {
        return new Response(new Blob(['proxied'], { type: 'image/webp' }), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as any

    const source = await openThreadProject({
      type: 'bluesky',
      handle: 'user.bsky.social',
      rkey: 'post1',
    })

    const pages = await source.listPages()
    expect(pages.map((p) => p.file)).toEqual(['page-01.webp'])
  })

  it('throws an error when no images are found in the thread', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 200,
          status: { id: '100', text: 'Text only tweet' },
          thread: [{ id: '100', text: 'Text only tweet' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as any

    await expect(openThreadProject({ type: 'twitter', id: '100' })).rejects.toThrow(
      'No images found in this thread.',
    )
  })

  it('throws an error when the thread API returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ code: 404, message: 'Tweet not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    }) as any

    await expect(openThreadProject({ type: 'twitter', id: '999' })).rejects.toThrow(
      'Tweet not found',
    )
  })

  it('throws an error if an image fails to download', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.fxtwitter.com')) {
        return new Response(
          JSON.stringify({
            code: 200,
            status: {
              media: { photos: [{ type: 'photo', url: 'https://bad.url/img.jpg' }] },
            },
          }),
          { status: 200 },
        )
      }
      return new Response('Server error', { status: 500 })
    }) as any

    await expect(openThreadProject({ type: 'twitter', id: '100' })).rejects.toThrow(
      'Failed to download image 1 (500)',
    )
  })

  // The real fxtwitter/fxbsky thread endpoint returns a windowed slice of the self-reply
  // chain anchored on whichever post id is queried, not the whole thread -- confirmed by
  // querying the live API for a real 14-post thread: anchoring on post 1 returned only
  // posts 1-7, anchoring on post 7 (the last post of that response) returned 1-8,
  // anchoring on 8 returned 1-13, and anchoring on 13 returned all 14. These tests mimic
  // that windowing behavior to exercise the chase-the-last-post's-own-URL loop.
  describe('thread chaining', () => {
    function twitterPost(id: number, extra: Record<string, unknown> = {}) {
      return {
        id: String(id),
        url: `https://x.com/artist/status/${id}`,
        text: `Post ${id}`,
        ...extra,
      }
    }

    it('chains through growing windows until the thread stops growing', async () => {
      // anchor 1 -> 1-7, anchor 7 -> 1-8, anchor 8 -> 1-13, anchor 13 -> 1-14 (converged:
      // post 14's own URL is a never-before-seen anchor, so one extra no-growth fetch on
      // anchor 14 confirms convergence before the loop stops).
      const windows: Record<number, number> = { 1: 7, 7: 8, 8: 13, 13: 14, 14: 14 }
      const threadCalls: number[] = []

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const m = url.match(/api\.fxtwitter\.com\/2\/thread\/(\d+)/)
        if (m) {
          const anchor = Number(m[1])
          threadCalls.push(anchor)
          const upTo = windows[anchor]!
          const posts = Array.from({ length: upTo }, (_, i) =>
            twitterPost(i + 1, i === 0 ? { media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] } } : {}),
          )
          return new Response(
            JSON.stringify({ code: 200, status: posts[anchor - 1], thread: posts }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      const source = await openThreadProject({ type: 'twitter', id: '1' })
      const pages = await source.listPages()
      expect(pages).toHaveLength(1) // only post 1 carries a photo in this fixture
      expect(threadCalls).toEqual([1, 7, 8, 13, 14])
    })

    it('names the project from the first response, not the final chained anchor', async () => {
      const windows: Record<number, { upTo: number; text: string; handle: string }> = {
        1: { upTo: 2, text: 'Original opening post', handle: 'author_one' },
        2: { upTo: 2, text: 'Post 2 own text', handle: 'author_one' },
      }

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const m = url.match(/api\.fxtwitter\.com\/2\/thread\/(\d+)/)
        if (m) {
          const anchor = Number(m[1])
          const w = windows[anchor]!
          const posts = Array.from({ length: w.upTo }, (_, i) =>
            twitterPost(i + 1, i === 0 ? { media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] } } : {}),
          )
          return new Response(
            JSON.stringify({
              code: 200,
              status: { id: String(anchor), text: w.text, author: { screen_name: w.handle } },
              thread: posts,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      const source = await openThreadProject({ type: 'twitter', id: '1' })
      expect(source.name).toBe('@author_one - Original opening post')
    })

    it('keeps pages already found when a continuation fetch fails', async () => {
      let anchor7Attempts = 0
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('api.fxtwitter.com/2/thread/1')) {
          const posts = Array.from({ length: 7 }, (_, i) =>
            twitterPost(i + 1, i === 0 ? { media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] } } : {}),
          )
          return new Response(
            JSON.stringify({ code: 200, status: posts[0], thread: posts }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('api.fxtwitter.com/2/thread/7')) {
          anchor7Attempts++
          return new Response('Server error', { status: 500 })
        }
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      const source = await openThreadProject({ type: 'twitter', id: '1' })
      const pages = await source.listPages()
      expect(pages).toHaveLength(1)
      expect(anchor7Attempts).toBe(1)
    })

    it('stops immediately when a single post links back to itself', async () => {
      const threadCalls: string[] = []
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('api.fxtwitter.com/2/thread/100')) {
          threadCalls.push(url)
          const post = twitterPost(100, {
            media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] },
          })
          return new Response(
            JSON.stringify({ code: 200, status: post, thread: [post] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      await fetchThreadImages({ type: 'twitter', id: '100' })
      expect(threadCalls).toHaveLength(1)
    })

    it('stops after a bounded number of continuations against a thread that never stops growing', async () => {
      const threadCalls: number[] = []
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const m = url.match(/api\.fxtwitter\.com\/2\/thread\/(\d+)/)
        if (m) {
          const anchor = Number(m[1])
          threadCalls.push(anchor)
          // Anchoring on N always returns posts 1..N+1 -- a window that keeps growing
          // forever, exercising the MAX_CHAIN_ITERATIONS safety cap.
          const posts = Array.from({ length: anchor + 1 }, (_, i) =>
            twitterPost(i + 1, i === 0 ? { media: { photos: [{ type: 'photo', url: 'https://pbs.twimg.com/p1.jpg' }] } } : {}),
          )
          return new Response(
            JSON.stringify({ code: 200, status: posts[posts.length - 1], thread: posts }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(new Blob(['img'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      const { files } = await fetchThreadImages({ type: 'twitter', id: '1' })
      expect(files).toHaveLength(1)
      // 1 initial fetch + at most MAX_CHAIN_ITERATIONS (20) continuations.
      expect(threadCalls.length).toBe(21)
    })

    it('chains a Bluesky thread the same way, using each post\'s own url', async () => {
      const bskyPost = (rkey: string, url: string, extra: Record<string, unknown> = {}) => ({
        id: rkey,
        url,
        text: `Post ${rkey}`,
        ...extra,
      })
      const post1 = bskyPost('post1', 'https://bsky.app/profile/user.bsky.social/post/post1', {
        media: { photos: [{ type: 'photo', url: 'https://cdn.bsky.app/img1' }] },
      })
      const post2 = bskyPost('post2', 'https://bsky.app/profile/user.bsky.social/post/post2')
      const post3 = bskyPost('post3', 'https://bsky.app/profile/user.bsky.social/post/post3')

      const threadCalls: string[] = []
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post1')) {
          threadCalls.push('post1')
          return new Response(
            JSON.stringify({ code: 200, status: post1, thread: [post1, post2] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post2')) {
          threadCalls.push('post2')
          return new Response(
            JSON.stringify({ code: 200, status: post2, thread: [post1, post2, post3] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('api.fxbsky.app/2/thread/user.bsky.social/post3')) {
          threadCalls.push('post3')
          return new Response(
            JSON.stringify({ code: 200, status: post3, thread: [post1, post2, post3] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(new Blob(['img1'], { type: 'image/jpeg' }), { status: 200 })
      }) as any

      const source = await openThreadProject({
        type: 'bluesky',
        handle: 'user.bsky.social',
        rkey: 'post1',
      })
      const pages = await source.listPages()
      expect(pages).toHaveLength(1)
      expect(threadCalls).toEqual(['post1', 'post2', 'post3'])
    })
  })
})
