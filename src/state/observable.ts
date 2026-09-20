/**
 * The minimal subscribable box both module-level stores are built on.
 *
 * It lives in its own module rather than in `store.ts` because `state/notes.ts` needs
 * it too, and `store.ts` already imports from `notes.ts` to compose the run's context.
 * Importing the class the other way would close that cycle, and since `store.ts`
 * instantiates at module-evaluation time the class would still be in its temporal dead
 * zone -- a crash at startup, depending only on module evaluation order.
 */

import { useEffect, useState } from 'preact/hooks'

export class Store<T extends object> {
  private listeners = new Set<() => void>()

  constructor(private state: T) {}

  get(): T {
    return this.state
  }

  set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** Subscribe a component to a store, re-rendering whenever it changes. */
export function useStoreValue<T extends object>(store: Store<T>): T {
  const [state, setState] = useState(store.get())
  useEffect(() => {
    // Re-read before subscribing. An update that lands between the first render and
    // this effect would otherwise be missed forever, which is exactly what happens on
    // a reload: `initNotes` resolves in that window and the view sticks on "Loading".
    setState(store.get())
    return store.subscribe(() => setState(store.get()))
  }, [store])
  return state
}
