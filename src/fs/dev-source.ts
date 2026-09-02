/**
 * A `ProjectSource` backed by the dev server, for testing the app end to end.
 *
 * `showDirectoryPicker()` opens an OS dialog that browser automation cannot click, which
 * would otherwise make every path through the app unreachable in an automated test. This
 * serves the sample pages in `test-img/` instead and keeps the project JSON in
 * localStorage, so the run loop, review editor and reader all work unchanged.
 *
 * Dev only. `openDevSource` throws in a production build.
 */

import { sortPageNames, type PageSource, type ProjectSource } from './source'

const STORAGE_KEY = 'comic-translator:dev-project'

const sampleUrls = import.meta.env.DEV
  ? (import.meta.glob('/test-img/*.{jpg,jpeg,png,webp,avif}', {
      query: '?url',
      import: 'default',
      eager: true,
    }) as Record<string, string>)
  : {}

class DevProjectSource implements ProjectSource {
  readonly name = 'test-img (sample)'
  readonly jsonName = 'translation.json'
  readonly writable = true

  async readJson(): Promise<string | null> {
    return localStorage.getItem(STORAGE_KEY)
  }

  async writeJson(text: string): Promise<void> {
    localStorage.setItem(STORAGE_KEY, text)
  }

  async listPages(): Promise<PageSource[]> {
    const byName = new Map<string, string>()
    for (const [path, url] of Object.entries(sampleUrls)) {
      byName.set(path.slice(path.lastIndexOf('/') + 1), url)
    }
    return sortPageNames([...byName.keys()]).map((file) => ({
      file,
      getFile: async () => {
        const response = await fetch(byName.get(file)!)
        if (!response.ok) throw new Error('could not load sample page ' + file)
        const blob = await response.blob()
        return new File([blob], file, { type: blob.type })
      },
    }))
  }
}

export function devSampleCount(): number {
  return Object.keys(sampleUrls).length
}

export function openDevSource(): ProjectSource {
  if (!import.meta.env.DEV) throw new Error('the sample project is only available in dev')
  return new DevProjectSource()
}

export function resetDevSource(): void {
  localStorage.removeItem(STORAGE_KEY)
}
