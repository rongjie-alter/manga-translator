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

import { openThreadProject, parseThreadUrl } from '../fs/thread-project'

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
})
