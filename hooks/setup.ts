/**
 * setup.ts: the /cache setup walkthrough's pure half. One step per setting,
 * each with what it is for, its choices and their hints; presets; the diff
 * between the picks and what settings hold. No `$`.
 */
import type { SetupChange, SetupDraft } from '../types'
import { parsePercents, parseSpan } from './cache'

export type { SetupChange, SetupDraft }

type Value = string | number | boolean
export type Choice = { value: Value; label: string; /** one line on why you would pick it */ hint?: string }
export type Field = {
  key: string
  /** the step's heading */
  title: string
  /** the review page's row label */
  label: string
  /** what the setting is for, in plain words */
  help: string[]
  choices: Choice[]
  /** a free-text choice: what to show in the empty field and how to clean what was typed (undefined: not valid) */
  custom?: { placeholder: string; normalize: (raw: string) => string | undefined }
}

/** The value of the "custom…" choice. */
export const CUSTOM = '__custom'

const normalizeMarks = (raw: string) => {
  const marks = raw.split(/[,;]+/).map(t => t.trim()).filter(t => parseSpan(t) !== undefined)
  return marks.length ? marks.join(',') : undefined
}
const normalizePercents = (raw: string) => {
  if (raw.trim().toLowerCase() === 'off') return 'off'
  const marks = parsePercents(raw, [])
  return marks.length ? marks.join(',') : undefined
}

export const FIELDS: Field[] = [
  {
    key: 'ttl',
    title: 'Cache lifetime',
    label: 'Cache lifetime',
    help: [
      'Claude caches the start of your conversation so each message re-sends it cheaply. The cache expires after this long without a message; the next message then pays to rebuild it.',
      'auto follows Claude Code: 1 hour on a Claude subscription, 5 minutes on an API key or cloud provider, and corrects itself from request timing.',
    ],
    choices: [
      { value: 'auto', label: 'auto', hint: 'default · recommended' },
      { value: '1h', label: '1 hour', hint: 'pin it if auto guesses wrong' },
      { value: '5m', label: '5 minutes', hint: 'pin it if auto guesses wrong' },
    ],
  },
  {
    key: 'tickSeconds',
    title: 'Countdown step',
    label: 'Countdown step',
    help: ['How often the countdown above the input box updates while plenty of time is left.'],
    choices: [
      { value: 60, label: 'every minute', hint: 'default · shows "59m", near-zero cost' },
      { value: 10, label: 'every 10 seconds', hint: 'shows "59:40"' },
      { value: 1, label: 'every second', hint: 'shows "59:42", redraws every second' },
    ],
  },
  {
    key: 'warnSeconds',
    title: 'Final stretch',
    label: 'Final stretch',
    help: ['The last stretch before the cache expires: the meter turns red and the countdown switches to the final-stretch step.'],
    choices: [
      { value: 30, label: 'last 30 seconds' },
      { value: 60, label: 'last 60 seconds', hint: 'default' },
      { value: 120, label: 'last 2 minutes' },
      { value: 300, label: 'last 5 minutes' },
    ],
  },
  {
    key: 'finalTickSeconds',
    title: 'Final stretch step',
    label: 'Final stretch step',
    help: ['How often the countdown updates inside the final stretch.'],
    choices: [
      { value: 1, label: 'every second', hint: 'default' },
      { value: 5, label: 'every 5 seconds' },
      { value: 10, label: 'every 10 seconds' },
    ],
  },
  {
    key: 'toasts',
    title: 'Cache expiry toasts',
    label: 'Cache expiry toasts',
    help: [
      "Small pop-ups in Claude Code's top-right corner (not your OS notification tray) warning that the cache is about to expire.",
      'Send any message before the countdown hits zero and the cache stays warm for free.',
    ],
    choices: [
      { value: '1m,10s,5s,1s', label: '1m, 10s, 5s, 1s', hint: 'default' },
      { value: '30m,15m,5m,1m', label: '30m, 15m, 5m, 1m', hint: 'early warnings on a 1-hour cache' },
      { value: '5m,2m,1m', label: '5m, 2m, 1m' },
      { value: '1m', label: '1m only' },
      { value: 'off', label: 'off', hint: 'no expiry toasts' },
    ],
    custom: { placeholder: 'e.g. 45m, 20m, 2m (h, m, s)', normalize: normalizeMarks },
  },
  {
    key: 'contextAlertsAt',
    title: 'Context window alerts',
    label: 'Context alerts',
    help: [
      "A pop-up each time your conversation crosses a fill level of the model's context window, e.g. \"25% of window remaining\".",
      "Handy if your status line doesn't show context usage. Separate from the cache toasts.",
    ],
    choices: [
      { value: '50,25,10', label: '50%, 25%, 10% remaining', hint: 'default' },
      { value: '75,50,25,10,5', label: '75, 50, 25, 10, 5% remaining', hint: 'more warnings' },
      { value: '25,10', label: '25%, 10% remaining', hint: 'only when it is getting tight' },
      { value: 'off', label: 'off' },
    ],
    custom: { placeholder: 'e.g. 75,50,25,10,5 (% of window remaining)', normalize: normalizePercents },
  },
  {
    key: 'compactWhenRemainingPct',
    title: '/compact suggestion',
    label: '/compact suggestion',
    help: [
      'After the cache expires, the meter says "keep going", or suggests /compact (shrink the conversation) once this little of the context window is left.',
      'Rebuilding a huge context is the expensive moment.',
    ],
    choices: [
      { value: 75, label: 'at 75% remaining', hint: 'suggest early' },
      { value: 60, label: 'at 60% remaining', hint: 'default' },
      { value: 40, label: 'at 40% remaining' },
      { value: 20, label: 'at 20% remaining', hint: 'only when nearly full' },
    ],
  },
  {
    key: 'band',
    title: 'Meter above the input box',
    label: 'Meter above input box',
    help: ['The one-line meter above the box you type in: cache hit %, tokens, countdown and advice.'],
    choices: [
      { value: true, label: 'on', hint: 'default' },
      { value: false, label: 'off', hint: 'keep /cache and the toasts only' },
    ],
  },
  {
    key: 'status',
    title: 'Footer line',
    label: 'Footer line',
    help: ['A short copy of the meter ("cache 86% · 59m") on its own line in the footer, beside your status line.'],
    choices: [
      { value: false, label: 'off', hint: 'default' },
      { value: true, label: 'on' },
    ],
  },
]

/** The manifest defaults, as the walkthrough's rows hold them. */
export const DEFAULTS: SetupDraft = {
  ttl: 'auto',
  tickSeconds: 60,
  warnSeconds: 60,
  finalTickSeconds: 1,
  toasts: '1m,10s,5s,1s',
  contextAlertsAt: '50,25,10',
  compactWhenRemainingPct: 60,
  band: true,
  status: false,
}

export type PresetName = 'recommended' | 'quiet' | 'live'

export const PRESETS: { key: PresetName; label: string; about: string; draft: SetupDraft }[] = [
  { key: 'recommended', label: 'Recommended', about: 'minute steps, 4 cache toasts, context alerts at 50/25/10%', draft: DEFAULTS },
  {
    key: 'quiet',
    label: 'Quiet',
    about: 'the meter only: no toasts, no alerts',
    draft: { ...DEFAULTS, finalTickSeconds: 10, toasts: 'off', contextAlertsAt: 'off' },
  },
  {
    key: 'live',
    label: 'Live',
    about: 'per-second countdown, footer line, more toasts and alerts',
    draft: { ...DEFAULTS, tickSeconds: 1, toasts: '5m,2m,1m', contextAlertsAt: '75,50,25,10,5', status: true },
  },
]

/** Steps: the preset, one per setting, then the review. */
export const STEP_COUNT = FIELDS.length + 2
export const REVIEW_STEP = STEP_COUNT - 1

/** The value a choice carries as text. */
export const encode = (v: Value) => String(v)

/** A choice's text back to the field's type, from that field's choices. */
export function decode(field: Field, raw: string): Value {
  const hit = field.choices.find(c => encode(c.value) === raw)
  if (hit) return hit.value
  if (typeof field.choices[0]?.value === 'number') return Number(raw)
  if (typeof field.choices[0]?.value === 'boolean') return raw === 'true'
  return raw
}

/** Whether the field's value is one of its listed choices. */
export const isListed = (field: Field, value: Value | undefined) => value !== undefined && field.choices.some(c => encode(c.value) === encode(value))

/** What the review page shows for a value: the choice's label, or the custom text. */
export function display(field: Field, value: Value | undefined): string {
  const hit = field.choices.find(c => value !== undefined && encode(c.value) === encode(value))
  return hit ? hit.label : value === undefined ? '' : `custom: ${encode(value)}`
}

/** Merge the toast pair into the walkthrough's one "toasts" row. */
export function toastsRow(toast: unknown, toastAt: unknown): string {
  if (toast === false) return 'off'
  return typeof toastAt === 'string' && toastAt.trim() ? toastAt.replace(/\s+/g, '') : '1m,10s,5s,1s'
}

/** The walkthrough's "toasts" row back into the two settings it stands for. */
export function splitToasts(row: Value): { toast: boolean; toastAt?: string } {
  return row === 'off' ? { toast: false } : { toast: true, toastAt: String(row) }
}

/** The draft the walkthrough opens with: what settings hold now, as its rows. */
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
