/**
 * setup.ts: the /cache setup wizard's pure half. Fields, choices, presets and
 * the diff between the picks and what settings hold. No `$`.
 */
import type { SetupChange, SetupDraft } from '../types'

export type { SetupChange, SetupDraft }

type Value = string | number | boolean
export type Choice = { value: Value; label: string }
export type Field = { key: string; label: string; choices: Choice[] }

/**
 * The wizard's rows. `toast` and `toastAt` share one row ("toasts") so a
 * newcomer picks one thing; `toastsRow` / `splitToasts` map between them.
 */
export const FIELDS: Field[] = [
  {
    key: 'ttl',
    label: 'Cache lifetime',
    choices: [
      { value: 'auto', label: 'auto · default' },
      { value: '1h', label: '1h (pinned)' },
      { value: '5m', label: '5m (pinned)' },
    ],
  },
  {
    key: 'tickSeconds',
    label: 'Countdown step',
    choices: [
      { value: 60, label: 'every minute, "59m" · default' },
      { value: 10, label: 'every 10 s' },
      { value: 1, label: 'every second, "59:42"' },
    ],
  },
  {
    key: 'warnSeconds',
    label: 'Final stretch',
    choices: [
      { value: 30, label: 'last 30 s' },
      { value: 60, label: 'last 60 s · default' },
      { value: 120, label: 'last 2 min' },
      { value: 300, label: 'last 5 min' },
    ],
  },
  {
    key: 'finalTickSeconds',
    label: 'Final stretch step',
    choices: [
      { value: 1, label: 'every second · default' },
      { value: 5, label: 'every 5 s' },
      { value: 10, label: 'every 10 s' },
    ],
  },
  {
    key: 'toasts',
    label: 'Toasts at',
    choices: [
      { value: '1m,10s,5s,1s', label: '1m, 10s, 5s, 1s · default' },
      { value: '30m,15m,5m,1m', label: '30m, 15m, 5m, 1m' },
      { value: '5m,2m,1m', label: '5m, 2m, 1m' },
      { value: '1m', label: '1m only' },
      { value: 'off', label: 'off' },
    ],
  },
  {
    key: 'toastWhenRemainingPct',
    label: 'Toast when window remaining ≤',
    choices: [
      { value: 100, label: 'always · default' },
      { value: 90, label: '90% remaining' },
      { value: 75, label: '75% remaining' },
      { value: 50, label: '50% remaining' },
    ],
  },
  {
    key: 'compactWhenRemainingPct',
    label: 'Suggest /compact when remaining ≤',
    choices: [
      { value: 75, label: '75% remaining' },
      { value: 60, label: '60% remaining · default' },
      { value: 40, label: '40% remaining' },
      { value: 20, label: '20% remaining' },
    ],
  },
  {
    key: 'band',
    label: 'Meter above input box',
    choices: [
      { value: true, label: 'on · default' },
      { value: false, label: 'off' },
    ],
  },
  {
    key: 'status',
    label: 'Footer line',
    choices: [
      { value: false, label: 'off · default' },
      { value: true, label: 'on' },
    ],
  },
]

/** The manifest defaults, as the wizard's rows hold them. */
export const DEFAULTS: SetupDraft = {
  ttl: 'auto',
  tickSeconds: 60,
  warnSeconds: 60,
  finalTickSeconds: 1,
  toasts: '1m,10s,5s,1s',
  toastWhenRemainingPct: 100,
  compactWhenRemainingPct: 60,
  band: true,
  status: false,
}

export type PresetKey = 'recommended' | 'quiet' | 'live'

export const PRESETS: { key: PresetKey; label: string; about: string; draft: SetupDraft }[] = [
  { key: 'recommended', label: 'Recommended', about: 'minute steps, seconds in the last minute, 4 toasts', draft: DEFAULTS },
  {
    key: 'quiet',
    label: 'Quiet',
    about: 'meter only, minute steps, no toasts',
    draft: { ...DEFAULTS, finalTickSeconds: 10, toasts: 'off' },
  },
  {
    key: 'live',
    label: 'Live',
    about: 'per-second countdown, footer line, toasts at 5m, 2m, 1m',
    draft: { ...DEFAULTS, tickSeconds: 1, toasts: '5m,2m,1m', status: true },
  },
]

/** The value a Select carries: Select options are strings. */
export const encode = (v: Value) => String(v)

/** A Select's string back to the field's type, from that field's choices. */
export function decode(field: Field, raw: string): Value {
  const hit = field.choices.find(c => encode(c.value) === raw)
  if (hit) return hit.value
  if (typeof field.choices[0]?.value === 'number') return Number(raw)
  if (typeof field.choices[0]?.value === 'boolean') return raw === 'true'
  return raw
}

/** A field's choices, with the current value added as "current: …" when settings hold one the list lacks. */
export function choicesFor(field: Field, current: Value | undefined): Choice[] {
  if (current === undefined || field.choices.some(c => encode(c.value) === encode(current))) return field.choices
  return [...field.choices, { value: current, label: `current: ${encode(current)}` }]
}

/** Merge the toast pair into the wizard's one "toasts" row. */
export function toastsRow(toast: unknown, toastAt: unknown): string {
  if (toast === false) return 'off'
  return typeof toastAt === 'string' && toastAt.trim() ? toastAt.replace(/\s+/g, '') : '1m,10s,5s,1s'
}

/** The wizard's "toasts" row back into the two settings it stands for. */
export function splitToasts(row: Value): { toast: boolean; toastAt?: string } {
  return row === 'off' ? { toast: false } : { toast: true, toastAt: String(row) }
}

/** The draft the wizard opens with: what settings hold now, as its rows. */
export function draftFromOptions(values: Readonly<Record<string, unknown>>): SetupDraft {
  const draft: SetupDraft = { ...DEFAULTS }
  for (const f of FIELDS) {
    if (f.key === 'toasts') continue
    const v = values[f.key]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') draft[f.key] = v
  }
  draft.toasts = toastsRow(values.toast, values.toastAt)
  return draft
}

/** The settings to write: each userConfig field whose value the draft changes. */
export function changes(draft: SetupDraft, values: Readonly<Record<string, unknown>>): SetupChange[] {
  const out: SetupChange[] = []
  for (const f of FIELDS) {
    const v = draft[f.key]
    if (v === undefined) continue
    if (f.key === 'toasts') {
      const { toast, toastAt } = splitToasts(v)
      if (values.toast !== toast) out.push({ key: 'toast', value: toast })
      if (toastAt !== undefined && values.toastAt !== toastAt) out.push({ key: 'toastAt', value: toastAt })
      continue
    }
    if (values[f.key] !== v) out.push({ key: f.key, value: v })
  }
  return out
}
