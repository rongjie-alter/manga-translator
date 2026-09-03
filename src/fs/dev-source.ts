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

import { clearPageBlobs, getPageBlob, listPageBlobNames, putPageBlob } from './blob-store'
import {
  sortPageNames,
  type AddedImage,
  type PageSource,
  type ProjectSource,
} from './source'
import { uniqueName } from './add-images'

const STORAGE_KEY = 'comic-translator:dev-project'
/** Scope for pages added to the sample project, so they survive a reload like real ones. */
const BLOB_SCOPE = 'dev-sample'

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
    const sampled: PageSource[] = sortPageNames([...byName.keys()]).map((file) => ({
      file,
      getFile: async () => {
        const response = await fetch(byName.get(file)!)
        if (!response.ok) throw new Error('could not load sample page ' + file)
        const blob = await response.blob()
        return new File([blob], file, { type: blob.type })
      },
    }))

    // Added pages come last, matching where the project appended them.
    const added = sortPageNames(await listPageBlobNames(BLOB_SCOPE)).map((file) => ({
      file,
      getFile: () => readAdded(file),
    }))
    return [...sampled, ...added]
  }

  async addImage(name: string, blob: Blob): Promise<AddedImage> {
    const taken = new Set([
      ...Object.keys(sampleUrls).map((path) => path.slice(path.lastIndexOf('/') + 1)),
      ...(await listPageBlobNames(BLOB_SCOPE)),
    ])
    const finalName = uniqueName(name, taken)
    await putPageBlob(BLOB_SCOPE, finalName, blob)
    return { name: finalName, page: { file: finalName, getFile: () => readAdded(finalName) } }
  }
}

async function readAdded(file: string): Promise<File> {
  const blob = await getPageBlob(BLOB_SCOPE, file)
  if (!blob) throw new Error('could not load added page ' + file)
  return new File([blob], file, { type: blob.type })
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
  void clearPageBlobs(BLOB_SCOPE)
}
