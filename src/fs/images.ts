/**
 * Turning files on disk into something the API can eat: a content hash for change
 * detection, and a downscaled, re-encoded, base64 data URL for upload.
 */

/**
 * Short content hash used to notice that a page image changed on disk.
 *
 * 128 bits of SHA-256 rather than all 256: this is change detection, not integrity
 * against an adversary, and a 64-character hash per page adds up over a 200-page project.
 */
export async function hashFile(file: File | Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface Dimensions {
  width: number
  height: number
}

/**
 * Scale `size` down so neither edge exceeds `maxEdge`. Never scales up: a page that
 * is already small keeps its own resolution rather than being blurrily enlarged.
 */
export function fitWithin(size: Dimensions, maxEdge: number): Dimensions {
  const longest = Math.max(size.width, size.height)
  if (longest <= maxEdge || longest === 0) return { width: size.width, height: size.height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

/**
 * Gemini tiles images at 768x768 and charges 258 tokens per tile (a single tile for
 * anything under 384px on both edges). Everything about batching cost follows from this.
 */
export function imageTokens(size: Dimensions): number {
  if (size.width === 0 || size.height === 0) return 0
  if (size.width <= 384 && size.height <= 384) return 258
  const tiles = Math.ceil(size.width / 768) * Math.ceil(size.height / 768)
  return tiles * 258
}

export interface PreparedImage {
  /** `data:image/jpeg;base64,...`, ready to drop into an `image_url` content part. */
  dataUrl: string
  /** Length of the data URL in bytes, which is what counts against the request size cap. */
  encodedBytes: number
  width: number
  height: number
  /** True when the image was re-encoded rather than passed through as-is. */
  resampled: boolean
}

export interface PrepareOptions {
  /** Longest edge, in pixels, after downscaling. */
  maxEdge?: number
  /** JPEG quality for re-encoded images. */
  quality?: number
}

/**
 * A manga page is legible to the model well below its print resolution, and every extra
 * pixel is request size we cannot spend on more pages per call. 1600 keeps furigana
 * readable on a typical page while cutting a 3000px scan to a fraction of its size.
 */
const DEFAULT_MAX_EDGE = 1600
const DEFAULT_QUALITY = 0.85

export async function prepareImage(
  file: File | Blob,
  opts: PrepareOptions = {},
): Promise<PreparedImage> {
  const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE
  const quality = opts.quality ?? DEFAULT_QUALITY

  const bitmap = await createImageBitmap(file)
  try {
    const source: Dimensions = { width: bitmap.width, height: bitmap.height }
    const target = fitWithin(source, maxEdge)
    const needsResample =
      target.width !== source.width || target.height !== source.height || !isJpeg(file)

    if (!needsResample) {
      const dataUrl = await blobToDataUrl(file)
      return {
        dataUrl,
        encodedBytes: dataUrl.length,
        width: source.width,
        height: source.height,
        resampled: false,
      }
    }

    const canvas = new OffscreenCanvas(target.width, target.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('could not get a 2d context to resample the page')
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    const dataUrl = await blobToDataUrl(blob)
    return {
      dataUrl,
      encodedBytes: dataUrl.length,
      width: target.width,
      height: target.height,
      resampled: true,
    }
  } finally {
    bitmap.close()
  }
}

function isJpeg(file: File | Blob): boolean {
  return file.type === 'image/jpeg' || file.type === 'image/jpg'
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'))
    reader.readAsDataURL(blob)
  })
}
