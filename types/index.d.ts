export type Ttl = '5m' | '1h'

/** One main-loop request, as the API reported it. */
export type Sample = {
  turnId: string
  index: number
  model: string
  /** ms when the request started: the cache lifetime counts from here */
  startedAt: number
  read: number
  write: number
  fresh: number
  output: number
}

/** The setup wizard's picks, keyed by userConfig field. */
export type SetupDraft = Record<string, string | number | boolean>

/** One setting the wizard writes. */
export type SetupChange = { key: string; value: string | number | boolean }

declare module 'claude-code' {
  interface PluginState {
    'cache-countdown': {
      /** last 200 main-loop requests, oldest first */
      samples: Sample[]
      /** TTL proven by request timing; null until the traffic says something */
      observed: Ttl | null
      /** whole seconds; written only while a countdown is live, so the band and pane redraw and nothing else does */
      tick: number
      /** the /cache pane is open: the band steps aside */
      paneOpen: boolean
      /** the setup wizard's unsaved picks, keyed by userConfig field; null while it is closed */
      draft: SetupDraft | null
      /** one line the wizard shows after Save (what was written, or why not) */
      setupNote: string
      /** settings the wizard still has to write: one is written per load, since each write reloads the mod */
      pending: SetupChange[]
    }
  }
}
