/**
 * cache-countdown's $.state contract: the values it keeps for the session
 * (they survive a hot reload of the module, and nothing else).
 */

/** The /cache setup walkthrough's picks, one entry per row (plus `<row>:custom` / `<row>:text` helpers). */
export type SetupDraft = Record<string, string | number | boolean>

/** One setting the walkthrough will write. */
export type SetupChange = { key: string; value: string | number | boolean }

/** One main-loop model request, as turn.step reported it. */
export type CacheSample = {
  /** when the request started (clock ms): the cache lifetime counts from here */
  at: number
  turnId: string
  /** 1, 2, 3... in the order turns arrived this session */
  turnNo: number
  model: string
  /** prompt read from the cache */
  read: number
  /** prompt written to the cache */
  write: number
  /** prompt neither read nor written (uncached input) */
  fresh: number
  output: number
}

/** What request timing has shown about the cache lifetime. */
export type CacheObserved = {
  /** seconds: 300 or 3600 */
  ttl: number
  /** true once a late hit proved 1h; a later miss does not undo it */
  proven: boolean
}

/** One row of the per-turn table (or the totals row). */
export type CacheTurnRow = {
  label: string
  steps: number
  read: number
  write: number
  fresh: number
  /** whole percent of the prompt served from the cache */
  hit: number
}

/** The last request, summed up once when it arrived. */
export type CacheLast = {
  /** start of the request (clock ms) */
  at: number
  model: string
  read: number
  write: number
  fresh: number
  output: number
  /** read + write + fresh */
  prompt: number
  /** whole percent */
  hit: number
  /** read 0 and wrote 0 */
  uncached: boolean
  /** why it missed, or null when it did not */
  cause: string | null
}

/** Everything the band, the pane and the timer draw from, rebuilt once per request (never per tick). */
export type CacheView = {
  /** cache lifetime in seconds */
  ttl: number
  /** `5m` or `1h` */
  ttlLabel: string
  /** where the lifetime comes from */
  source: string
  /** set when prompt caching is off: the variable that turned it off */
  off: string | null
  /** the model's context window, 0 when unknown */
  window: number
  /** % of the window left after the last request, null when the window is unknown */
  windowLeft: number | null
  last: CacheLast | null
  /** per turn, oldest first */
  rows: CacheTurnRow[]
  /** every kept request together, labelled `all` */
  total: CacheTurnRow
}

declare module 'claude-code' {
  interface PluginState {
    'cache-countdown': {
      /** the last 200 main-loop requests */
      samples: CacheSample[]
      view: CacheView | null
      /** ms left on the cache at the last wake; the only value a wake writes for the band and pane */
      tick: number
      observed: CacheObserved | null
      /** context-window levels (% remaining) already announced */
      alerts: number[]
      paneOpen: boolean
      draft: SetupDraft | null
      setupNote: string
      pending: SetupChange[]
      setupStep: number
    }
  }
}
