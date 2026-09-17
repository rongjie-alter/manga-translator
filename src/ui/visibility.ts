/**
 * Fire a callback the first time an element comes near the viewport.
 *
 * Split out from the components that use it so the gating logic can be tested
 * against a stub observer -- happy-dom has no real `IntersectionObserver`, and
 * rendering a component just to assert it did not load an image would need a
 * testing-library dependency the project does not have.
 */

/** How far outside the viewport counts as "near": roughly one screen of lead-in. */
const DEFAULT_ROOT_MARGIN = '150% 0px'

/**
 * How long to wait for the observer to say anything at all before deciding it is not
 * going to.
 *
 * A working `IntersectionObserver` reports on an observed element almost immediately,
 * even when the answer is "not visible" -- so silence past this point means the
 * observer is not running (an offscreen or non-compositing embedder, for instance),
 * not that the element is far away. Gating on an observer that never speaks would
 * leave the image blank forever, which is a worse failure than loading it eagerly.
 */
const SILENCE_TIMEOUT_MS = 1000

export function observeOnce(
  el: Element,
  onVisible: () => void,
  rootMargin: string = DEFAULT_ROOT_MARGIN,
): () => void {
  // No observer (older engine, or a test environment) means no gating: loading
  // eagerly is wasteful but correct, whereas never loading is a blank page.
  if (typeof IntersectionObserver === 'undefined') {
    onVisible()
    return () => undefined
  }

  // An element already on screen at the moment observation starts should not have
  // to wait for the observer's first callback: inside a `content-visibility: auto`
  // ancestor (see the `.spread`/`.page-card` comment in styles.css), that first
  // callback can report "not intersecting" -- or never arrive -- until a later
  // layout pass (e.g. a scroll) re-checks relevance, even though the element is
  // genuinely visible right now. `getBoundingClientRect()` forces a real layout
  // read regardless of that skipped-subtree state, so it gives an accurate answer
  // immediately. Guarded on a non-zero rect so this has no effect on a detached or
  // not-yet-laid-out element -- which is exactly the case in tests, where happy-dom
  // always reports an all-zero rect and every existing observer-driven assertion
  // below is unaffected.
  const rect = el.getBoundingClientRect()
  if (rect.width > 0 || rect.height > 0) {
    const margin = window.innerHeight
    if (rect.bottom >= -margin && rect.top <= window.innerHeight + margin) {
      onVisible()
      return () => undefined
    }
  }

  // `disconnect()` stops future notifications but does not unqueue one already
  // dispatched, so "once" is enforced here rather than left to the observer.
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(silence)
    observer.disconnect()
    onVisible()
  }

  const observer = new IntersectionObserver(
    (entries) => {
      // Any report at all proves the observer works, so stop waiting for silence.
      clearTimeout(silence)
      if (!entries.some((entry) => entry.isIntersecting)) return
      finish()
    },
    { rootMargin },
  )
  const silence = setTimeout(finish, SILENCE_TIMEOUT_MS)
  observer.observe(el)

  return () => {
    done = true
    clearTimeout(silence)
    observer.disconnect()
  }
}
