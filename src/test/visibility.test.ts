import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeOnce } from '../ui/visibility'

type Callback = (entries: { isIntersecting: boolean }[]) => void

class StubObserver {
  static last: StubObserver | null = null
  readonly observed: Element[] = []
  disconnected = false

  constructor(
    private readonly callback: Callback,
    readonly options: { rootMargin?: string },
  ) {
    StubObserver.last = this
  }

  observe(el: Element): void {
    this.observed.push(el)
  }

  disconnect(): void {
    this.disconnected = true
  }

  fire(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }])
  }
}

function withObserver(): typeof StubObserver {
  ;(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
    StubObserver
  return StubObserver
}

afterEach(() => {
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
  StubObserver.last = null
})

const element = () => document.createElement('div')

describe('observeOnce', () => {
  it('does not fire until the element intersects', () => {
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)

    expect(onVisible).not.toHaveBeenCalled()
    expect(StubObserver.last!.observed).toHaveLength(1)
  })

  it('fires once the element intersects', () => {
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)
    StubObserver.last!.fire(true)

    expect(onVisible).toHaveBeenCalledOnce()
  })

  it('ignores a non-intersecting report', () => {
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)
    StubObserver.last!.fire(false)

    expect(onVisible).not.toHaveBeenCalled()
  })

  it('stops observing after the first hit, so it never fires twice', () => {
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)
    StubObserver.last!.fire(true)
    StubObserver.last!.fire(true)

    expect(onVisible).toHaveBeenCalledOnce()
    expect(StubObserver.last!.disconnected).toBe(true)
  })

  it('disconnects when torn down before ever intersecting', () => {
    withObserver()

    observeOnce(element(), vi.fn())()

    expect(StubObserver.last!.disconnected).toBe(true)
  })

  it('loads anyway when the observer never reports at all', () => {
    vi.useFakeTimers()
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)
    vi.advanceTimersByTime(1000)

    expect(onVisible).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('keeps waiting once the observer has reported the element is far away', () => {
    vi.useFakeTimers()
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)
    StubObserver.last!.fire(false)
    vi.advanceTimersByTime(5000)

    expect(onVisible).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('does not load after teardown, even if nothing ever reported', () => {
    vi.useFakeTimers()
    withObserver()
    const onVisible = vi.fn()

    observeOnce(element(), onVisible)()
    vi.advanceTimersByTime(5000)

    expect(onVisible).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('loads eagerly when the engine has no IntersectionObserver', () => {
    const onVisible = vi.fn()

    const teardown = observeOnce(element(), onVisible)

    expect(onVisible).toHaveBeenCalledOnce()
    expect(() => teardown()).not.toThrow()
  })

  it('resolves immediately, without waiting for the observer, when already laid out on screen', () => {
    withObserver()
    const onVisible = vi.fn()
    const el = element()
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 100,
      top: 10,
      bottom: 110,
      left: 0,
      right: 100,
      x: 0,
      y: 10,
      toJSON: () => ({}),
    })

    observeOnce(el, onVisible)

    expect(onVisible).toHaveBeenCalledOnce()
    expect(StubObserver.last).toBeNull()
  })

  it('does not resolve immediately when the laid-out element is far outside the viewport', () => {
    withObserver()
    const onVisible = vi.fn()
    const el = element()
    const far = window.innerHeight * 3
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 100,
      top: far,
      bottom: far + 100,
      left: 0,
      right: 100,
      x: 0,
      y: far,
      toJSON: () => ({}),
    })

    observeOnce(el, onVisible)

    expect(onVisible).not.toHaveBeenCalled()
    expect(StubObserver.last!.observed).toHaveLength(1)
  })
})
