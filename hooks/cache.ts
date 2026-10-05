/**
 * cache.ts: the pure half of cache-countdown. No `$`, no engine, no timers.
 *
 * Model (Anthropic prompt-caching docs):
 *   - entries live 5 minutes by default, 1 hour when asked for; a read refreshes
 *     the entry for free; the lifetime counts from the START of the request
 *   - prompt = input_tokens (uncached) + cache_read + cache_creation
 *   - a prefix change (model, effort, tools, system prompt) writes instead of reads
 *
 * Logic ported from davila7/claude-code-templates mods/observability/prompt-cache-control (MIT).
 */
import type { Sample, Ttl } from '../types'

export type { Sample, Ttl }

export type CacheEnv = {
  enable1h?: string
  force5m?: string
  /** CLAUDE_CODE_PROMPT_CACHE_TTL */
  ttlVar?: string
  disableAll?: string
  disableHaiku?: string
  disableSonnet?: string
  disableOpus?: string
}

export type AdviceKind = 'off' | 'cold' | 'uncached' | 'warm' | 'soon' | 'expired' | 'miss'
export type Advice = { kind: AdviceKind; text: string }
export type Policy = { ttl: Ttl; warnMs: number; compactAtTokens: number; /** the model's context window, when known: the advice then says how much is left */ windowTokens?: number }

/** Used when the session has not reported its window yet. */
export const DEFAULT_WINDOW = 200_000

/** Tokens of context at which only `remainingPct` of the window is left. 100 → 0 (always). */
export const usedAt = (windowTokens: number, remainingPct: number) => Math.round(windowTokens * (1 - Math.min(100, Math.max(0, remainingPct)) / 100))

/** Share of the window left after `tokens`, as a whole percentage. */
export const remainingPct = (tokens: number, windowTokens: number) => Math.max(0, Math.min(100, Math.round(100 - (tokens / windowTokens) * 100)))

/** A remaining-percentage option: 1–100, else the fallback. */
export const pctOption = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback)
export type Account = 'subscription' | 'credits' | 'other'
export type TtlChoice = { ttl: Ttl; source: string; /** the answer depends on the account, so re-check it after requests */ byAccount: boolean }

export const isOn = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'
const asTtl = (v: unknown): Ttl | undefined => (v === '5m' || v === '1h' ? v : undefined)

/**
 * The TTL Claude Code asks for on the main conversation, first match wins:
 * the mod's ttl option, FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL,
 * the promptCacheTtl setting, ENABLE_PROMPT_CACHING_1H, then the account
 * (1h on a Claude subscription within plan usage, 5m otherwise).
 */
export function decideTtl(option: unknown, env: CacheEnv, setting?: unknown, account?: Account): TtlChoice {
  const pinned = asTtl(option)
  if (pinned) return { ttl: pinned, source: 'ttl option', byAccount: false }
  if (isOn(env.force5m)) return { ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M', byAccount: false }
  const fromVar = asTtl(env.ttlVar)
  if (fromVar) return { ttl: fromVar, source: 'CLAUDE_CODE_PROMPT_CACHE_TTL', byAccount: false }
  const fromSetting = asTtl(setting)
  if (fromSetting) return { ttl: fromSetting, source: 'promptCacheTtl setting', byAccount: false }
  if (isOn(env.enable1h)) return { ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H', byAccount: false }
  if (account === 'subscription') return { ttl: '1h', source: 'Claude subscription default', byAccount: true }
  if (account === 'credits') return { ttl: '5m', source: 'usage credits default', byAccount: true }
  return { ttl: '5m', source: 'default', byAccount: true }
}

/** From the rate-limit windows: a plan window means a subscription; a full one means usage credits. */
export function accountOf(windows: readonly { kind: string; percentUsed: number }[]): Account {
  const plan = windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  if (plan.length === 0) return 'other'
  return plan.some(w => w.percentUsed >= 100) ? 'credits' : 'subscription'
}

export const ttlMs = (ttl: Ttl) => (ttl === '1h' ? 3_600_000 : 300_000)

export function isCachingDisabled(model: string, env: CacheEnv): boolean {
  if (isOn(env.disableAll)) return true
  const name = model.toLowerCase()
  if (name.includes('haiku')) return isOn(env.disableHaiku)
  if (name.includes('sonnet')) return isOn(env.disableSonnet)
  if (name.includes('opus')) return isOn(env.disableOpus)
  return false
}

export const promptTokens = (s: { read: number; write: number; fresh: number }) => s.read + s.write + s.fresh

export function hitRatio(s: { read: number; write: number; fresh: number }): number {
  const total = promptTokens(s)
  return total === 0 ? 0 : s.read / total
}

/** 0 for a request that touched no cache entry: nothing to count down. */
export function remainingMs(s: Sample, ttl: Ttl, now: number): number {
  if (s.read + s.write === 0) return 0
  return Math.max(0, s.startedAt + ttlMs(ttl) - now)
}

/** Why a request that should have read the cache wrote it instead; undefined when it did not miss. */
export function missReason(prev: Sample | undefined, cur: Sample, ttl: Ttl): string | undefined {
  if (!prev) return undefined
  const before = promptTokens(prev)
  // a prompt that shrank is /compact or /clear, not a miss
  if (before === 0 || promptTokens(cur) < before * 0.7) return undefined
  if (cur.read >= before * 0.5 || cur.write === 0) return undefined
  if (cur.model !== prev.model) return `model changed (${prev.model} → ${cur.model})`
  if (cur.startedAt - prev.startedAt > ttlMs(ttl)) return `the ${ttl} cache had lapsed`
  return 'prompt prefix changed (effort, tools, system prompt or CLAUDE.md)'
}

export function advise(last: Sample | undefined, prev: Sample | undefined, policy: Policy, now: number, disabled: boolean): Advice {
  if (disabled) return { kind: 'off', text: 'prompt caching is off for this model (DISABLE_PROMPT_CACHING*)' }
  if (!last) return { kind: 'cold', text: 'no request yet: the first one writes the cache' }
  if (last.read + last.write === 0) return { kind: 'uncached', text: 'not cached (prompt under the model minimum, or caching off)' }
  const left = remainingMs(last, policy.ttl, now)
  const size = promptTokens(last)
  if (left <= 0) {
    const left = policy.windowTokens ? ` (${remainingPct(size, policy.windowTokens)}% of window remaining)` : ''
    return size >= policy.compactAtTokens
      ? { kind: 'expired', text: `expired: next message rewrites ${fmtTokens(size)} tokens${left}. /compact first, or /clear if done` }
      : { kind: 'expired', text: `expired: ${fmtTokens(size)} tokens to rebuild${left}, keep going` }
  }
  if (left <= policy.warnMs) return { kind: 'soon', text: 'expires soon: any message refreshes it for free' }
  const miss = missReason(prev, last, policy.ttl)
  if (miss) return { kind: 'miss', text: `cache missed: ${miss}` }
  return { kind: 'warm', text: 'warm: keep going' }
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** m:ss, or h:mm:ss from an hour up. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function bar(ratio: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export type TurnRow = { turnId: string; steps: number; read: number; write: number; fresh: number; output: number }

/** Samples grouped by turn, oldest first, each turn's requests summed. */
export function byTurn(samples: readonly Sample[]): TurnRow[] {
  const rows: TurnRow[] = []
  for (const s of samples) {
    let row = rows[rows.length - 1]
    if (!row || row.turnId !== s.turnId) {
      row = { turnId: s.turnId, steps: 0, read: 0, write: 0, fresh: 0, output: 0 }
      rows.push(row)
    }
    row.steps += 1
    row.read += s.read
    row.write += s.write
    row.fresh += s.fresh
    row.output += s.output
  }
  return rows
}

/** Session totals across every kept request. */
export function totals(samples: readonly Sample[]): TurnRow {
  const t: TurnRow = { turnId: 'all', steps: 0, read: 0, write: 0, fresh: 0, output: 0 }
  for (const s of samples) {
    t.steps += 1
    t.read += s.read
    t.write += s.write
    t.fresh += s.fresh
    t.output += s.output
  }
  return t
}

export const fit = (text: string, width: number) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)

export const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)

export const lifeRatio = (leftMs: number, ttl: Ttl) => Math.min(1, Math.max(0, leftMs / ttlMs(ttl)))

/** Read / wrote / new segment widths over `width` cells: proportional, non-empty parts ≥ 1 cell, summing to width. */
export function segments(read: number, write: number, fresh: number, width: number): [number, number, number] {
  const total = read + write + fresh
  if (total === 0 || width <= 0) return [0, 0, 0]
  const parts: [number, number, number] = [read, write, fresh]
  const cells = parts.map(p => (p > 0 ? Math.max(1, Math.round((p / total) * width)) : 0)) as [number, number, number]
  let over = cells[0] + cells[1] + cells[2] - width
  while (over !== 0) {
    const i = (over > 0 ? cells.indexOf(Math.max(...cells)) : parts.indexOf(Math.max(...parts))) as 0 | 1 | 2
    cells[i] += over > 0 ? -1 : 1
    over += over > 0 ? -1 : 1
  }
  return cells
}

/** Default toast marks, seconds left, at least 4 s apart: Claude Code drops a toast within 2 s of the previous one. */
export const DEFAULT_TOAST_AT = [60, 10, 5, 1]
/** From here down a toast says "send a message now". */
export const URGENT_SECS = 10

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 }

/**
 * One time-left mark in seconds: "30m", "10s", "1h", "1.5m", or a bare number
 * meaning seconds ("90"). Undefined for anything else.
 */
export function parseSpan(token: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)?$/i.exec(token.trim())
  if (!m) return undefined
  const unit = (m[2] ?? 's')[0]!.toLowerCase()
  const secs = Math.round(Number(m[1]) * (UNIT_SECONDS[unit] ?? 1))
  return secs > 0 ? secs : undefined
}

/** "30m, 15m, 5m, 1m" → [1800, 900, 300, 60]: seconds, unique, largest first; nothing valid → fallback. */
export function parseMarks(v: unknown, fallback: readonly number[] = DEFAULT_TOAST_AT): number[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,;]+/) : []
  const marks = [...new Set(raw.map(parseSpan).filter((n): n is number => n !== undefined))]
  return marks.length ? marks.sort((a, b) => b - a) : [...fallback]
}

/** Time left in words for a toast: "30 min", "1 hr", "1:30", "10s". */
export function fmtSpan(secs: number): string {
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} hr`
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60} min`
  if (secs >= 60) return fmtClock(secs * 1000)
  return `${secs}s`
}

/** The toast mark due now, or undefined. `level` is the last mark fired for this entry (Infinity before any); a late tick skips to the newest mark. */
export function nextToastMark(secsLeft: number, marks: readonly number[], level: number): number | undefined {
  const due = marks.filter(m => secsLeft <= m && m < level)
  return due.length ? Math.min(...due) : undefined
}

export type Pace = { tickMs: number; finalTickMs: number; warnMs: number }

/** The countdown step in force: `tickMs` while more than `warnMs` is left, `finalTickMs` inside it. */
export const periodFor = (leftMs: number, pace: Pace) => (leftMs > pace.warnMs ? pace.tickMs : pace.finalTickMs)

/** Countdown text at the step in force: "59m" for steps of a minute or more, else m:ss rounded up to the step. */
export function fmtCountdown(leftMs: number, pace: Pace): string {
  if (leftMs <= 0) return '0:00'
  const period = periodFor(leftMs, pace)
  if (period >= 60_000) return `${Math.ceil(leftMs / 60_000)}m`
  return fmtClock(Math.ceil(leftMs / period) * period)
}

/**
 * ms until the timer next has something to do: the countdown text changes, the
 * fast window starts, or a toast mark comes due. Never a fixed period, so a 1h
 * cache on the default pace wakes about 60 times in its last minute and once a
 * minute before that.
 */
export function nextDelay(leftMs: number, pace: Pace, marks: readonly number[]): number {
  if (leftMs <= 0) return 0
  const period = periodFor(leftMs, pace)
  let d = ((leftMs - 1) % period) + 1
  if (leftMs > pace.warnMs) d = Math.min(d, leftMs - pace.warnMs)
  for (const m of marks) {
    const at = m * 1000
    if (at < leftMs) d = Math.min(d, leftMs - at)
  }
  return Math.max(d, 20)
}

export type LifeColor = 'green' | 'yellow' | 'red'

/** Green while plenty, yellow below 40% of the lifetime, red from the warning threshold. */
export function lifeColor(leftMs: number, ttl: Ttl, warnMs: number): LifeColor {
  if (leftMs <= warnMs) return 'red'
  return leftMs / ttlMs(ttl) <= 0.4 ? 'yellow' : 'green'
}

// requests are timed from their start; slack keeps a hit just inside 5m from "proving" 1h
const SLACK_MS = 10_000

/**
 * What the traffic says about the lifetime:
 *   - a hit more than 5 minutes after the previous request proves 1h, and sticks
 *   - a miss 5–60 minutes later, same model, prompt not shrunk, says 5m (a later hit overrules)
 */
export function observeTtl(prev: Sample | undefined, cur: Sample, known: Ttl | undefined): Ttl | undefined {
  if (!prev || prev.read + prev.write === 0 || cur.model !== prev.model) return known
  const gap = cur.startedAt - prev.startedAt
  const before = promptTokens(prev)
  if (gap <= ttlMs('5m') + SLACK_MS) return known
  if (cur.read >= before * 0.5) return '1h'
  if (known === '1h') return known
  const lapsed = cur.write > 0 && promptTokens(cur) >= before * 0.7 && gap < ttlMs('1h') + SLACK_MS
  return lapsed ? '5m' : known
}
