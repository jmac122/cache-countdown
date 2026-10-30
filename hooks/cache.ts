/**
 * cache.ts: cache-countdown's pure half. Parsing the options, choosing the
 * cache lifetime, reading request timing, the advice, the countdown text and
 * when the timer next has to wake, the per-request view, and the number
 * formats. No `$`, no engine, no timers: everything here is a function of its
 * arguments, so the tests call it directly.
 */
import type { CacheLast, CacheObserved, CacheSample, CacheTurnRow, CacheView } from '../types'

// ---------------------------------------------------------------- options

export const DEFAULT_MARKS = [60, 10, 5, 1]
export const DEFAULT_LEVELS = [50, 25, 10]

export type Config = {
  /** 'auto', '5m' or '1h' */
  ttl: string
  warnSeconds: number
  tickSeconds: number
  finalTickSeconds: number
  compactWhenRemainingPct: number
  band: boolean
  status: boolean
  toast: boolean
  /** seconds left at which a toast fires, descending */
  marks: number[]
  /** % of the context window remaining at which an alert fires, descending */
  levels: number[]
}

const positive = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const flag = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false') return false
  }
  return fallback
}

const listText = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(String).join(',')
  return undefined
}

/** The options as `register` receives them, checked and filled in. */
export function readConfig(o: Readonly<Record<string, unknown>>): Config {
  const ttl = typeof o.ttl === 'string' ? o.ttl.trim().toLowerCase() : ''
  return {
    ttl: ttl === '5m' || ttl === '1h' ? ttl : 'auto',
    warnSeconds: positive(o.warnSeconds, 60),
    tickSeconds: positive(o.tickSeconds, 60),
    finalTickSeconds: positive(o.finalTickSeconds, 1),
    compactWhenRemainingPct: Math.min(100, positive(o.compactWhenRemainingPct, 60)),
    band: flag(o.band, true),
    status: flag(o.status, false),
    toast: flag(o.toast, true),
    marks: parseMarks(o.toastAt),
    levels: parsePercents(o.contextAlertsAt),
  }
}

const SPAN = /^(\d+(?:\.\d+)?|\.\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?$/

/** One span ("1h", "1.5 min", "90s", or a bare number of seconds) in seconds; undefined when it is not one. */
export function parseSpan(v: unknown): number | undefined {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().toLowerCase() : ''
  const m = SPAN.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  const seconds = unit.startsWith('h') ? n * 3600 : unit.startsWith('m') ? n * 60 : n
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.round(seconds * 1000) / 1000
}

/** The toast marks: a comma list of spans, deduplicated, longest first; nothing valid gives the default. */
export function parseMarks(v: unknown): number[] {
  const text = listText(v) ?? ''
  const marks = [...new Set(text.split(/[,;]+/).map(parseSpan).filter((s): s is number => s !== undefined))]
  return marks.length ? marks.sort((a, b) => b - a) : [...DEFAULT_MARKS]
}

/** A comma list of whole percents 1..99, deduplicated, highest first; off/none/empty is none; nothing valid gives `fallback`. */
export function parsePercents(v: unknown, fallback: number[] = DEFAULT_LEVELS): number[] {
  const text = listText(v)
  if (text === undefined) return [...fallback]
  const t = text.trim().toLowerCase()
  if (t === '' || t === 'off' || t === 'none') return []
  const found = new Set<number>()
  for (const part of t.split(/[,;\s]+/)) {
    const m = /^(\d+)%?$/.exec(part)
    if (!m) continue
    const n = Number(m[1])
    if (n >= 1 && n <= 99) found.add(n)
  }
  return found.size ? [...found].sort((a, b) => b - a) : [...fallback]
}

// ---------------------------------------------------------------- lifetime

export type Account = 'subscription' | 'credits' | 'other'

/** What the session's rate-limit windows say about the account. */
export function accountKind(limits: readonly { kind: string; percentUsed: number }[]): Account {
  const plan = limits.filter(l => /^(five_hour|seven_day)/.test(l.kind))
  if (plan.length === 0) return 'other'
  return plan.some(l => l.percentUsed >= 100) ? 'credits' : 'subscription'
}

/** What the lifetime is decided from, as read at session start. */
export type LifetimeInputs = {
  /** the ttl option: 'auto', '5m' or '1h' */
  option: string
  force5m?: string
  envTtl?: string
  settingTtl?: unknown
  enable1h?: string
  account: Account
}

export type Lifetime = { ttl: number; source: string; pinned: boolean }

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
export const isTruthy = (v: string | undefined) => v !== undefined && TRUTHY.has(v.trim().toLowerCase())

const ttlValue = (v: unknown): number | undefined => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === '5m' ? 300 : s === '1h' ? 3600 : undefined
}

/** The cache lifetime before request timing has a say, first match wins. */
export function baseLifetime(i: LifetimeInputs): Lifetime {
  const option = ttlValue(i.option)
  if (option) return { ttl: option, source: 'ttl option', pinned: true }
  if (isTruthy(i.force5m)) return { ttl: 300, source: 'FORCE_PROMPT_CACHING_5M', pinned: false }
  const env = ttlValue(i.envTtl)
  if (env) return { ttl: env, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL', pinned: false }
  const setting = ttlValue(i.settingTtl)
  if (setting) return { ttl: setting, source: 'promptCacheTtl setting', pinned: false }
  if (isTruthy(i.enable1h)) return { ttl: 3600, source: 'ENABLE_PROMPT_CACHING_1H', pinned: false }
  if (i.account === 'subscription') return { ttl: 3600, source: 'Claude subscription default', pinned: false }
  if (i.account === 'credits') return { ttl: 300, source: 'usage credits (plan limit reached)', pinned: false }
  return { ttl: 300, source: 'API key or cloud provider', pinned: false }
}

export const ttlLabel = (ttl: number) => (ttl >= 3600 && ttl % 3600 === 0 ? `${ttl / 3600}h` : `${Math.round(ttl / 60)}m`)

/** The lifetime in force: the base one, corrected by what traffic showed unless the option pins it. */
export function effectiveLifetime(base: Lifetime, observed: CacheObserved | null): Lifetime {
  if (base.pinned || !observed) return base
  if (observed.ttl === base.ttl) return { ...base, source: `${base.source}, confirmed by traffic` }
  return { ttl: observed.ttl, source: `observed from request timing (${base.source} said ${ttlLabel(base.ttl)})`, pinned: false }
}

/** The variable that turns caching off for this model, or null. */
export function cachingOff(env: { all?: string; haiku?: string; sonnet?: string; opus?: string }, model: string | undefined): string | null {
  if (isTruthy(env.all)) return 'DISABLE_PROMPT_CACHING'
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku') && isTruthy(env.haiku)) return 'DISABLE_PROMPT_CACHING_HAIKU'
  if (m.includes('sonnet') && isTruthy(env.sonnet)) return 'DISABLE_PROMPT_CACHING_SONNET'
  if (m.includes('opus') && isTruthy(env.opus)) return 'DISABLE_PROMPT_CACHING_OPUS'
  return null
}

// ---------------------------------------------------------------- reading traffic

/*
 * Thresholds, in one place:
 * - a request READ MOST of what was cached when it read at least HALF of the
 *   previous request's prompt (the prefix it shares with this one); less, with
 *   something written, is a miss.
 * - a prompt SHRANK when it is under HALF of the previous prompt: that is
 *   /compact or /clear rebuilding a smaller conversation, not a miss.
 * - SLACK covers clock jitter and the time a request takes to reach the cache:
 *   a hit has to come more than 5 minutes + 20 s after the previous request to
 *   prove that a 5-minute entry would not have survived.
 */
export const MOST = 0.5
export const SHRANK = 0.5
export const SLACK_MS = 20_000
const FIVE_MIN_MS = 300_000
const HOUR_MS = 3_600_000

export const promptSize = (s: { read: number; write: number; fresh: number }) => s.read + s.write + s.fresh

const shrank = (prev: CacheSample, cur: CacheSample) => promptSize(cur) < promptSize(prev) * SHRANK
const readMost = (prev: CacheSample, cur: CacheSample) => cur.read >= promptSize(prev) * MOST

/** What a request says about the lifetime, given the one before it: the updated observation (unchanged when it proves nothing). */
export function observe(observed: CacheObserved | null, prev: CacheSample | undefined, cur: CacheSample): CacheObserved | null {
  if (!prev || prev.model !== cur.model) return observed
  const gap = cur.at - prev.at
  if (gap <= FIVE_MIN_MS + SLACK_MS) return observed
  if (cur.read > 0 && readMost(prev, cur)) return { ttl: 3600, proven: true }
  const missed = cur.write > 0 && !readMost(prev, cur) && !shrank(prev, cur)
  if (missed && gap < HOUR_MS && !observed?.proven) return { ttl: 300, proven: false }
  return observed
}

/** Why a request wrote the cache instead of reading it, or null when it did not miss. */
export function missCause(prev: CacheSample | undefined, cur: CacheSample, ttl: number): string | null {
  if (!prev) return null
  if (cur.read === 0 && cur.write === 0) return null
  if (shrank(prev, cur)) return null
  if (cur.write === 0 || readMost(prev, cur)) return null
  if (prev.model !== cur.model) return `model changed (${prev.model} → ${cur.model})`
  if (cur.at - prev.at > ttl * 1000) return `the ${ttlLabel(ttl)} cache had lapsed`
  return 'prompt prefix changed (effort, tools, system prompt or CLAUDE.md)'
}

// ---------------------------------------------------------------- the view

export const hitPercent = (s: { read: number; write: number; fresh: number }) => {
  const size = promptSize(s)
  return size > 0 ? Math.round((s.read / size) * 100) : 0
}

/** % of the window left after a prompt of `size`, clamped 0..100. */
export const windowLeftPct = (window: number, size: number) => Math.max(0, Math.min(100, Math.round((100 * (window - size)) / window)))

export type ViewInputs = {
  samples: readonly CacheSample[]
  lifetime: Lifetime
  off: string | null
  window: number
}

function row(label: string, list: readonly CacheSample[]): CacheTurnRow {
  const sum = { read: 0, write: 0, fresh: 0 }
  for (const s of list) {
    sum.read += s.read
    sum.write += s.write
    sum.fresh += s.fresh
  }
  return { label, steps: list.length, ...sum, hit: hitPercent(sum) }
}

/** Everything the band and pane draw, computed once when a request arrives. */
export function buildView(i: ViewInputs): CacheView {
  const n = i.samples.length
  const cur = i.samples[n - 1]
  const prev = i.samples[n - 2]
  let last: CacheLast | null = null
  if (cur) {
    const prompt = promptSize(cur)
    last = {
      at: cur.at,
      model: cur.model,
      read: cur.read,
      write: cur.write,
      fresh: cur.fresh,
      output: cur.output,
      prompt,
      hit: hitPercent(cur),
      uncached: cur.read === 0 && cur.write === 0,
      cause: missCause(prev, cur, i.lifetime.ttl),
    }
  }
  const turns: CacheSample[][] = []
  for (const s of i.samples) {
    const group = turns[turns.length - 1]
    if (group && group[0]?.turnId === s.turnId) group.push(s)
    else turns.push([s])
  }
  return {
    ttl: i.lifetime.ttl,
    ttlLabel: ttlLabel(i.lifetime.ttl),
    source: i.lifetime.source,
    off: i.off,
    window: i.window,
    windowLeft: i.window > 0 && last ? windowLeftPct(i.window, last.prompt) : null,
    last,
    rows: turns.map(t => row(String(t[0]?.turnNo ?? ''), t)),
    total: row('all', i.samples),
  }
}

/** Remaining cache life in ms: counted from the start of the last request, never below 0. */
export const remainingMs = (start: number, ttl: number, now: number) => Math.max(0, start + ttl * 1000 - now)

// ---------------------------------------------------------------- advice

export type AdviceState = 'off' | 'cold' | 'uncached' | 'expired' | 'soon' | 'miss' | 'warm'
export type Advice = { state: AdviceState; text: string }

/** The window used for the /compact decision when the real one is not known. */
export const ASSUMED_WINDOW = 200_000

/** One line of advice for the view at `left` ms of cache life. */
export function advise(view: CacheView, left: number, s: Pick<Config, 'warnSeconds' | 'compactWhenRemainingPct'>): Advice {
  if (view.off) return { state: 'off', text: `off: prompt caching is off (${view.off})` }
  const last = view.last
  if (!last) return { state: 'cold', text: 'cold: no request yet' }
  if (last.uncached) return { state: 'uncached', text: 'not cached: the prompt is under the model minimum, or caching is off' }
  if (left <= 0) {
    const pct = windowLeftPct(view.window > 0 ? view.window : ASSUMED_WINDOW, last.prompt)
    const shown = view.window > 0 ? ` (${pct}% of window remaining)` : ''
    const tail = pct <= s.compactWhenRemainingPct ? '. /compact first, or /clear if done' : ', keep going'
    return { state: 'expired', text: `expired: the next message rebuilds ${formatCount(last.prompt)}${shown}${tail}` }
  }
  if (left <= s.warnSeconds * 1000) return { state: 'soon', text: 'expires soon: any message refreshes it' }
  if (last.cause) return { state: 'miss', text: `miss: ${last.cause}` }
  return { state: 'warm', text: 'warm: keep going' }
}

// ---------------------------------------------------------------- countdown and timer

export type Steps = Pick<Config, 'warnSeconds' | 'tickSeconds' | 'finalTickSeconds'>

/** The countdown step (ms) for `left` ms: tickSeconds outside the final stretch, finalTickSeconds inside it. */
export const stepMs = (left: number, s: Steps) => (left > s.warnSeconds * 1000 ? s.tickSeconds : s.finalTickSeconds) * 1000

/** The countdown: whole minutes rounded up while the step is a minute or more, else m:ss with the seconds rounded up. */
export function countdownText(left: number, s: Steps): string {
  if (stepMs(left, s) >= 60_000) return `${Math.ceil(left / 60_000)}m`
  const total = Math.ceil(left / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * How long the timer sleeps from `left` ms: until the next step boundary (the
 * countdown's next value), the start of the final stretch, or the next toast
 * mark not yet shown, whichever comes first; null once nothing is left.
 * `marks` are seconds, descending; `shown` how many of them are used up.
 */
export function nextDelay(left: number, s: Steps, marks: readonly number[] = [], shown = 0): number | null {
  if (left <= 0) return null
  const step = stepMs(left, s)
  const warn = s.warnSeconds * 1000
  let target = Math.floor((left - 1) / step) * step
  if (left > warn) target = Math.max(target, warn)
  const mark = marks.slice(shown).find(m => m * 1000 < left)
  if (mark !== undefined) target = Math.max(target, mark * 1000)
  return Math.max(1, left - Math.max(0, target))
}

/**
 * The toast marks at `left` ms: every mark at or above it is passed; of the
 * passed ones not shown yet, only the smallest (the newest) fires.
 */
export function takeMarks(marks: readonly number[], shown: number, left: number): { fire: number | undefined; shown: number } {
  let passed = shown
  while (passed < marks.length && (marks[passed] ?? 0) * 1000 >= left) passed++
  const fire = passed > shown && left > 0 ? marks[passed - 1] : undefined
  return { fire, shown: passed }
}

/** How many marks are already behind a countdown starting at `left` ms (they never fire). */
export const marksBehind = (marks: readonly number[], left: number) => marks.filter(m => m * 1000 >= left).length

/** A span as a toast says it: `1 hr`, `30 min`, `1:30`, `10s`. */
export function spanWords(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hr`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`
  if (seconds > 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
  return `${seconds}s`
}

export function expiryToast(mark: number, prompt: number): string {
  const action = mark > 10 ? `send a message to keep ${formatCount(prompt)} warm` : 'send a message now'
  return `cache expires in ${spanWords(mark)}: ${action}`
}

/** The footer line, or undefined while there is nothing to say. */
export function statusText(view: CacheView | null, left: number, s: Steps): string | undefined {
  if (!view) return undefined
  if (view.off) return 'cache: off'
  if (!view.last) return undefined
  if (view.last.uncached) return 'cache: not cached'
  return `cache ${view.last.hit}% · ${left > 0 ? countdownText(left, s) : 'expired'}`
}

// ---------------------------------------------------------------- context window alerts

/**
 * The levels crossed at `pct` % remaining, and the one to announce: the lowest
 * level newly crossed. A level stays announced only while the window is still
 * at or below it, so climbing back above it (after /compact) re-arms it.
 */
export function crossLevels(levels: readonly number[], announced: readonly number[], pct: number): { announce: number | undefined; announced: number[] } {
  const crossed = levels.filter(l => pct <= l)
  const fresh = crossed.filter(l => !announced.includes(l))
  return { announce: fresh.length ? Math.min(...fresh) : undefined, announced: crossed }
}

export function contextToast(pct: number, used: number, window: number, compactPct: number): string {
  const hint = pct <= compactPct ? ' · /compact or /clear frees room' : ''
  return `context: ${pct}% of window remaining (${formatCount(used)} of ${formatCount(window)} used)${hint}`
}

// ---------------------------------------------------------------- formats

/** 300, 84.2k, 1.2M. */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.round(n))
  const short = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  if (v < 1000) return String(v)
  if (v < 999_950) return `${short(v / 1000)}k`
  return `${short(v / 1_000_000)}M`
}

/** 3:20, or 1:00:00 from an hour up; seconds rounded up. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Whole cells for each part, adding up to `cells`; a part above zero gets at least one cell when there is room. */
export function splitCells(parts: readonly number[], cells: number): number[] {
  const sum = parts.reduce((a, b) => a + Math.max(0, b), 0)
  if (sum <= 0 || cells <= 0) return parts.map(() => 0)
  const exact = parts.map(p => (Math.max(0, p) / sum) * cells)
  const out = exact.map(Math.floor)
  let left = cells - out.reduce((a, b) => a + b, 0)
  const byFraction = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f)
  for (const { i } of byFraction) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left--
  }
  // a part above zero shows: take a cell from the widest part for each one left at zero
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] ?? 0) <= 0 || (out[i] ?? 0) > 0) continue
    let widest = -1
    for (let j = 0; j < out.length; j++) if ((out[j] ?? 0) > 1 && (widest < 0 || (out[j] ?? 0) > (out[widest] ?? 0))) widest = j
    if (widest < 0) break
    out[widest] = (out[widest] ?? 0) - 1
    out[i] = 1
  }
  return out
}

/** A bar of `cells` characters, `filled` of them solid. */
export const textBar = (fraction: number, cells: number) => {
  const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}
