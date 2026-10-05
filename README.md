# cache-countdown

A prompt-cache meter for Claude Code, written as a mod (function hooks).

```
● cache ██████████ 86% read 317k wrote 52.3k new 2 ⏱ 59m 1h · warm: keep going
```

- **Meter row above the input box**: hit %, read / wrote / new tokens, the time left on the cache, and advice: `warm`, `soon`, `expired` (suggests `/compact` on big contexts), `miss` (names the cause: model changed, cache lapsed, prefix changed), `off`.
- **`/cache`**: a pane with the countdown bar, the last request as a stacked read/wrote/new bar, and a per-turn table with a totals row. `/cache stop`, Esc or `[ close ]` closes it.
- **`/cache setup`**: a settings wizard with presets (Recommended, Quiet, Live) and one picker per setting. Save writes your Claude Code settings the same way `/config` does, and the mod reloads with them.
- **Toasts** before the cache expires (default at 1 min, 10 s, 5 s and 1 s left; set any times you like, e.g. `30m, 15m, 5m, 1m`), only for prompts big enough to matter.
- **Footer line** (optional): `cache 86% · 59m` on its own line under the input box, beside your statusline.

## Install

Requires Claude Code 2.1.287 or later (mods).

**From the marketplace** (loads in every session):

```
/plugin marketplace add jmac122/cache-countdown
/plugin install cache-countdown@cache-countdown
```

**For one session only**: clone it and point `--plugin-dir` at the folder:

```
git clone https://github.com/jmac122/cache-countdown
claude --plugin-dir ./cache-countdown
```

It writes nothing to your settings until you press Save in `/cache setup`. On first load it shows one toast pointing at `/cache setup`, once ever.

## How often it wakes

There is no fixed interval. One timer sleeps until the next moment something changes on screen:

| Time left | Countdown shows | Wakes |
| --- | --- | --- |
| more than `warnSeconds` | `59m` | every `tickSeconds` (default 60) |
| the last `warnSeconds` (default 60) | `0:42` | every `finalTickSeconds` (default 1) |
| a toast mark | | once, at the mark |
| expired, nothing cached, caching off | `0:00` | never, until your next request |

On a 1-hour cache with the defaults that's about 120 wakes per hour instead of 3,600. Each wake redraws only the band and the pane, which takes about 1–5 ms per redraw (measured in a live session).

## Options

Use `/cache setup`, the `/config` menu, or `~/.claude/settings.json` under `pluginConfigs["cache-countdown@cache-countdown"].options` (marketplace install) or `pluginConfigs["cache-countdown"].options` (`--plugin-dir`):

| Option | Default | |
| --- | --- | --- |
| `ttl` | `auto` | `auto` \| `5m` \| `1h`; the last two pin it |
| `tickSeconds` | 60 | countdown step outside the final stretch; 60 shows `59m`, below 60 shows `m:ss` |
| `warnSeconds` | 60 | the final stretch: the band turns red and the countdown uses `finalTickSeconds` |
| `finalTickSeconds` | 1 | countdown step inside the final stretch |
| `toast` | true | expiry toasts on/off |
| `toastAt` | `1m,10s,5s,1s` | times left at which a toast fires, once each per cache entry, with units: `30m, 15m, 5m, 1m`, `5m, 2m, 1m`, `90s`, `1h` (a bare number is seconds). Keep marks at least 3 s apart: Claude Code drops a toast that comes within 2 s of the previous one |
| `toastMinTokens` | 20000 | smaller prompts never toast (0 = always) |
| `compactAtTokens` | 100000 | above this, an expired cache suggests `/compact` |
| `band` | true | the meter row above the input box |
| `status` | false | a short footer line beside your statusline |

## Which cache lifetime (`ttl: auto`)

The first match wins:

1. `FORCE_PROMPT_CACHING_5M=1` → 5m
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` → `5m` / `1h`
3. the `promptCacheTtl` setting, read merged over user, project, local, `--settings` and managed settings
4. `ENABLE_PROMPT_CACHING_1H=1` → 1h
5. the account: a Claude subscription within plan usage → 1h; usage credits, an API key or a cloud provider → 5m

Request timing then corrects it. A cache hit more than 5 minutes after the previous request proves the 1h lifetime. A miss 5–60 minutes later, with the same model and a prompt that didn't shrink, says 5m. The `/cache` pane names the source in use. `DISABLE_PROMPT_CACHING` (and its `_HAIKU`, `_SONNET` and `_OPUS` forms) shows `off`.

## What it hooks

`session.start`, `session.end` (`/clear` resets the meter), `turn.step` (main loop only; subagents have their own prefixes), `command.run` (`/cache`), `ui.close`, and `ui.render` (`AbovePrompt` and two `Pane`s). Request history lives in `$.state`, so a hot reload keeps it.

## Develop

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`hooks/cache.ts` and `hooks/setup.ts` are pure logic with no engine calls. `hooks/cache-countdown.tsx` is the wiring.

## Credits

The TTL rules, advice and observed-TTL logic are adapted from [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) `mods/observability/prompt-cache-control` (MIT). See `LICENSE`.
