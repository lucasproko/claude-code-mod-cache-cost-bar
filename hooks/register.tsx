import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionUsage, Timer } from 'claude-code'

import type { Cache, Usage } from '../types'

const usageAtom = atom({ plugin: 'usage-band-plus', key: 'usage' } as const, null)
const cacheAtom = atom({ plugin: 'usage-band-plus', key: 'cache' } as const, null)
const nowAtom = atom({ plugin: 'usage-band-plus', key: 'now' } as const, 0)
const lastTurnUsdAtom = atom({ plugin: 'usage-band-plus', key: 'lastTurnUsd' } as const, null)
const handoffArmedUntilAtom = atom({ plugin: 'usage-band-plus', key: 'handoffArmedUntil' } as const, 0)
const isHandoffBusyAtom = atom({ plugin: 'usage-band-plus', key: 'isHandoffBusy' } as const, false)
const dismissedCacheAtAtom = atom({ plugin: 'usage-band-plus', key: 'dismissedCacheAt' } as const, null)
const isCompactingAtom = atom({ plugin: 'usage-band-plus', key: 'isCompacting' } as const, false)

type $ = EngineInterface

const TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 }
const USAGE_REFRESH_MS = 30_000
const SECONDS_COUNTDOWN_MS = 10 * 60 * 1000
const HANDOFF_CONFIRM_MS = 5000
// rebuilding a small context is cheap, so the expiry warning skips it
const NUDGE_MIN_CONTEXT_TOKENS = 20_000
type Settings = {
  placement: 'footer' | 'band'
  contextWarnPercent: number
  contextCritPercent: number
  showCache: boolean
  showCost: boolean
  cacheTtl: 'auto' | '1h' | '5m'
  cacheNudgeMinutes: number
  handoffMode: 'fork' | 'haiku'
  handoffAtPercent: number
  confirmHandoff: boolean
}

const readSettings = (options: PluginOptions): Settings => {
  const num = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const bool = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback
  return {
    placement: options.placement === 'band' ? 'band' : 'footer',
    contextWarnPercent: num('contextWarnPercent', 50),
    contextCritPercent: num('contextCritPercent', 80),
    showCache: bool('showCache', true),
    showCost: bool('showCost', true),
    cacheTtl: options.cacheTtl === '1h' || options.cacheTtl === '5m' ? options.cacheTtl : 'auto',
    cacheNudgeMinutes: num('cacheNudgeMinutes', 5),
    handoffMode: options.handoffMode === 'haiku' ? 'haiku' : 'fork',
    handoffAtPercent: num('handoffAtPercent', 80),
    confirmHandoff: bool('confirmHandoff', true),
  }
}

// One id per cache: drops a [1m] suffix, a date and a provider prefix. An alias
// such as "opus" gives null, because it cannot be compared with an API id.
const cacheModelKey = (id: string) =>
  id.toLowerCase().match(/claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d{1,2}(?!\d))?/)?.[0] ?? null

type Tone = 'normal' | 'warning' | 'error' | 'muted'

// theme keys, so the readout follows the app's light or dark theme
const TONE_COLOR: Record<Tone, string> = {
  normal: 'inactive',
  warning: 'warning',
  error: 'error',
  muted: 'subtle',
}

const tok = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const dur = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  // whole minutes up to the 1-hour TTL, so a fresh cache reads 60m, not 1h 0m
  if (s * 1000 >= SECONDS_COUNTDOWN_MS) return s <= 3600 ? `${Math.floor(s / 60)}m` : dur(s)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const usd = (amount: number) => `$${amount.toFixed(2)}`

const toUsage = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, model: string | null): Usage => {
  const window = compactWindowTokens ?? u.context.window
  const tokens = u.context.tokens ?? null
  return {
    model,
    ctxPercent: tokens !== null && window ? Math.min(100, (tokens / window) * 100) : (u.context.percent ?? null),
    ctxTokens: tokens,
    ctxWindow: window,
    modelWindow: u.context.window,
    usd: u.cost?.usd ?? null,
    limits: u.rateLimits.map(l => ({ ...l })),
  }
}

async function markNow($: $) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

async function readModel($: $) {
  try {
    return await $.session.model()
  } catch {
    return null
  }
}

// The plugin API does not report the cache TTL, but each API response in the
// transcript does. A pure cache hit writes nothing, so the latest response that
// wrote decides. POSIX only: on Windows this rejects and the default stands.
async function readTtlFromTranscript($: $): Promise<number | null> {
  const id = await $.session.id()
  if (!/^[0-9a-f-]{36}$/.test(id)) return null
  const r = await $.process.run([
    'sh',
    '-c',
    `tail -n 400 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl 2>/dev/null | grep '"cache_creation"' | tail -n 30`,
  ])
  for (const line of r.stdout.split('\n').reverse()) {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const written = entry?.message?.usage?.cache_creation
    if (entry.type !== 'assistant' || entry.isSidechain || !written) continue
    if (written.ephemeral_1h_input_tokens > 0) return TTL_MS['1h']
    if (written.ephemeral_5m_input_tokens > 0) return TTL_MS['5m']
  }
  return null
}

type Item = { key: string; value: string; tone: Tone; detail: string }

const ttlLabel = (ttlMs: number) => (ttlMs === TTL_MS['5m'] ? '5-minute' : '1-hour')

const clockTime = (ms: number) => {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

// The footer shows three bare numbers; each `detail` says what one means, for
// /usage-band (the desktop footer draws text only, so it has no tooltips).
function buildItems(usage: Usage, cache: Cache | null, now: number, lastTurnUsd: number | null): Item[] {
  const items: Item[] = []

  if (usage.ctxPercent !== null) {
    const pct = usage.ctxPercent
    const tone: Tone = pct >= settings.contextCritPercent ? 'error' : pct >= settings.contextWarnPercent ? 'warning' : 'normal'
    items.push({
      key: 'context',
      value: `${Math.round(pct)}%`,
      tone,
      detail: [
        `Context: ${tok(usage.ctxTokens ?? 0)} of ${tok(usage.ctxWindow)} tokens (${Math.round(pct)}%)`,
        ...(usage.ctxWindow < usage.modelWindow
          ? [`Measured against the auto-compact window; the model allows ${tok(usage.modelWindow)}.`]
          : []),
        settings.handoffAtPercent > 0
          ? `At ${settings.handoffAtPercent}% a Handoff prompt appears. /handoff works at any time.`
          : '/handoff starts a fresh session with a handoff note.',
      ].join('\n'),
    })
  }

  if (settings.showCost && usage.usd !== null) {
    const isEstimate = usage.limits.length > 0
    items.push({
      key: 'cost',
      value: `${isEstimate ? '~' : ''}${usd(usage.usd)}`,
      tone: 'normal',
      detail: [
        `Session cost at API prices: ${usd(usage.usd)}`,
        ...(lastTurnUsd !== null && lastTurnUsd > 0 ? [`Last turn: +${usd(lastTurnUsd)}`] : []),
        ...(isEstimate ? ['On a subscription this is an estimate, not a charge.'] : []),
      ].join('\n'),
    })
  }

  if (settings.showCache && cache) {
    // `now` can lag the request that wrote the cache, so cap at the TTL
    const leftSec = Math.min(cache.ttlMs, cache.at + cache.ttlMs - now) / 1000
    const sessionKey = usage.model ? cacheModelKey(usage.model) : null
    const cacheKey = cacheModelKey(cache.model)
    const isSwitched = sessionKey !== null && cacheKey !== null && sessionKey !== cacheKey
    const hitLine = `The last request read ${Math.round(cache.hitPct)}% of its input from cache.`
    const ttlLine = cache.isTtlKnown
      ? `${ttlLabel(cache.ttlMs)} cache; each request restarts it.`
      : `${ttlLabel(cache.ttlMs)} cache assumed until this turn ends; each request restarts it.`
    if (isSwitched) {
      items.push({
        key: 'cache',
        value: 'cold',
        tone: 'warning',
        detail: 'Prompt cache: cold\nYou switched models. Each model has its own cache, so the next message rebuilds it at full input price.',
      })
    } else if (leftSec > 0) {
      items.push({
        key: 'cache',
        value: `${cache.isTtlKnown ? '' : '≈'}${clock(leftSec)}`,
        tone: leftSec * 1000 <= settings.cacheNudgeMinutes * 60 * 1000 ? 'warning' : 'normal',
        detail: [`Prompt cache: warm until ${clockTime(cache.at + cache.ttlMs)}`, ttlLine, hitLine].join('\n'),
      })
    } else {
      items.push({
        key: 'cache',
        value: 'cold',
        tone: 'muted',
        detail: `Prompt cache: expired at ${clockTime(cache.at + cache.ttlMs)}\nThe next message rebuilds it at full input price.\n${hitLine}`,
      })
    }
  }

  return items
}

const DOT = '\u2002·\u2002'

const HANDOFF_PROMPT =
  'Write a hand-off note so a fresh coding session can continue this work. Cover the goal, what was done (files changed, decisions and why), the current state, open issues, and the next steps. Be specific and brief. Reply with the note only.'

async function writeHandoff($: $, settings: Settings): Promise<string | null | 'empty'> {
  if (settings.handoffMode === 'fork') {
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (r.isAnswered) return r.text
    if (r.reason === 'nothing-to-fork') return 'empty'
    // a near-full context is when the fork is most likely to fail
    if (r.reason !== 'api-error') return null
  }
  return writeHandoffWithHaiku($)
}

async function writeHandoffWithHaiku($: $): Promise<string | null | 'empty'> {
  const messages = await $.session.messages()
  const transcript = messages
    .map(m => {
      const tools = m.toolUses
        .map(t => {
          const target = t.input.file_path ?? t.input.path ?? t.input.command
          return typeof target === 'string' ? `${t.tool}(${target.slice(0, 200)})` : t.tool
        })
        .join(', ')
      const speaker = m.role === 'user' ? 'User' : 'Assistant'
      return `${speaker}: ${m.text}${tools ? `\n[tools: ${tools}]` : ''}`
    })
    .filter(line => line.length > 12)
    .join('\n\n')
    .slice(-60000)
  if (!transcript) return 'empty'
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 1500,
    timeoutMs: 90000,
    system: 'You write concise hand-off notes so a fresh coding session can continue seamlessly.',
    prompt: `${HANDOFF_PROMPT}\n\n${transcript}`,
  })
  return r.isAnswered ? r.text : null
}

async function runHandoff($: $, settings: Settings) {
  if (await read($, isHandoffBusyAtom)) return
  await update($, isHandoffBusyAtom, () => true)
  try {
    $.ui.toast('Writing handoff…')
    const note = await writeHandoff($, settings)
    if (note === 'empty') {
      $.ui.toast('Nothing to hand off yet')
      return
    }
    if (!note) {
      $.ui.toast('Handoff failed; session kept')
      return
    }
    // /clear empties the prompt box, so keep what the person had typed
    const draft = (await $.prompt.read()).text.trim()
    await $.command.run({ command: 'clear' })
    await resetConversationState($)
    await $.prompt.fill({
      text: `Handoff from my previous session:\n\n${note}\n\nContinue from here.${draft ? `\n\n${draft}` : ''}`,
    })
    $.ui.toast('New session started. The handoff is in the prompt box; press Enter to send.')
  } catch {
    $.ui.toast('Handoff failed; session kept')
  } finally {
    await update($, isHandoffBusyAtom, () => false)
  }
}

async function pressHandoff($: $, settings: Settings) {
  if (!settings.confirmHandoff) return runHandoff($, settings)
  const now = await $.clock.now()
  if ((await read($, handoffArmedUntilAtom)) > now) {
    await update($, handoffArmedUntilAtom, () => 0)
    return runHandoff($, settings)
  }
  await update($, handoffArmedUntilAtom, () => now + HANDOFF_CONFIRM_MS)
  await markNow($)
}

// module state: a reload runs this file again, so it starts over
let settings: Settings = readSettings({})
let fixedTtlMs: number | null = null
let refreshTimer: Timer | undefined
let tickTimer: Timer | undefined
let isTurnRunning = false
let turnStartUsd: number | null = null
let nudgedCacheAt: number | null = null
let hasSuggestedHandoff = false
let compactWindowTokens: number | null = null


// /clear starts a new conversation, but $.state and module state outlive it
async function resetConversationState($: $) {
  turnStartUsd = null
  nudgedCacheAt = null
  hasSuggestedHandoff = false
  await update($, cacheAtom, () => null)
  await update($, lastTurnUsdAtom, () => null)
}

async function storeUsage($: $, usage: Usage) {
  await update($, usageAtom, () => usage)
  const isPastHandoff =
    settings.handoffAtPercent > 0 && (usage.ctxPercent ?? 0) >= settings.handoffAtPercent
  if (isPastHandoff && !hasSuggestedHandoff) {
    hasSuggestedHandoff = true
    $.ui.toast(`Context is ${Math.round(usage.ctxPercent ?? 0)}% full. Handoff is ready above the prompt, or type /handoff.`, {
      timeoutMs: 8000,
    })
  }
}

async function refreshUsage($: $) {
  try {
    // "summary" estimates locally and sends nothing; only its window is used
    const u = await $.session.usage({ breakdown: 'summary' })
    compactWindowTokens = u.context.breakdown?.rawMaxTokens ?? null
    await storeUsage($, toUsage(u, await readModel($)))
    await markNow($)
  } catch {
    // session not bound yet; the next refresh tries again
  }
}

const appleScriptString = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// The desktop app's deep link accepts only its own local_ session id, not the CLI's.
async function readHostSessionId($: $) {
  try {
    const hostSessionId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    if (hostSessionId && /^local_[A-Za-z0-9-]{1,64}$/.test(hostSessionId)) return hostSessionId
  } catch {}
  return null
}

// The desktop app has no notification channel for plugins ($.ui.notify answers
// no-surface there). terminal-notifier can open this session on click; an
// osascript notification belongs to Script Editor, so a click opens that instead.
// terminal-notifier is started through LaunchServices: run as a child of the
// Claude process, macOS refuses its notification permission.
async function sendNotification($: $, title: string, text: string) {
  try {
    const sent = await $.ui.notify(text, { title })
    if (sent.isSent) return
  } catch {}
  const hostSessionId = await readHostSessionId($)
  const clickArgs = hostSessionId
    ? ['-open', `claude://code/continue?session=${hostSessionId}`, '-group', `usage-band-plus-${hostSessionId}`]
    : ['-activate', 'com.anthropic.claudefordesktop']
  try {
    const r = await $.process.run([
      'open', '-n', '-g', '-b', 'fr.julienxx.oss.terminal-notifier',
      '--args', '-title', title, '-message', text, ...clickArgs,
    ])
    if (r.exitCode === 0) return
  } catch {}
  try {
    await $.process.run([
      'osascript',
      '-e',
      `display notification ${appleScriptString(text)} with title ${appleScriptString(title)}`,
    ])
  } catch {}
}

const isCacheNudgeWindow = (leftMs: number, usage: Usage) => {
  const nudgeMs = settings.cacheNudgeMinutes * 60 * 1000
  return nudgeMs > 0 && leftMs > 0 && leftMs <= nudgeMs && (usage.ctxTokens ?? 0) >= NUDGE_MIN_CONTEXT_TOKENS
}

async function compactForCache($: $) {
  if (await read($, isCompactingAtom)) return
  await update($, isCompactingAtom, () => true)
  try {
    const cacheAt = (await read($, cacheAtom))?.at ?? null
    let result: Awaited<ReturnType<typeof $.session.compact>>
    try {
      result = await $.session.compact()
    } catch {
      // An SDK-hosted session (the desktop app) rejects $.session.compact:
      // there, compaction runs only as a /compact prompt.
      void $.prompt
        .submit({ text: '/compact', asUser: true })
        .catch(err => $.ui.toast(`Compact failed; the session is unchanged: ${String(err)}`))
      await update($, dismissedCacheAtAtom, () => cacheAt)
      return
    }
    if ('skip' in result) $.ui.toast(`Compact skipped: ${result.skip}`)
    else await update($, dismissedCacheAtAtom, () => cacheAt)
  } catch (err) {
    $.ui.toast(`Compact failed; the session is unchanged: ${String(err)}`)
  } finally {
    await update($, isCompactingAtom, () => false)
  }
}

async function tick($: $) {
  try {
    const now = await $.clock.now()
    const cache = await read($, cacheAtom)
    const usage = await read($, usageAtom)
    const armedUntil = await read($, handoffArmedUntilAtom)
    const leftMs = cache ? cache.at + cache.ttlMs - now : -Infinity
    const isCountingSeconds = leftMs > -1000 && leftMs < SECONDS_COUNTDOWN_MS
    if (armedUntil && armedUntil <= now) await update($, handoffArmedUntilAtom, () => 0)
    if (isCountingSeconds || armedUntil) await update($, nowAtom, () => now)

    const isNudgeDue =
      cache !== null &&
      usage !== null &&
      !isTurnRunning &&
      isCacheNudgeWindow(leftMs, usage) &&
      nudgedCacheAt !== cache.at
    if (isNudgeDue) {
      nudgedCacheAt = cache.at
      const minutes = Math.max(1, Math.round(leftMs / 60000))
      const text = `Prompt cache expires in about ${minutes} min. Compact from the prompt, or let it expire.`
      // macOS often hides a system notification while the app is in front, so toast too
      $.ui.toast(text, { timeoutMs: 10000 })
      void sendNotification($, 'Prompt cache', text)
    }
  } catch {}
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  fixedTtlMs = settings.cacheTtl === 'auto' ? null : TTL_MS[settings.cacheTtl]

  on('session.start', async ($, e, next) => {
    refreshTimer?.cancel()
    tickTimer?.cancel()
    hasSuggestedHandoff = false
    nudgedCacheAt = null
    // session.measure pushes usage changes; this slow timer moves the reset
    // countdowns and picks up a /model switch, which measures nothing
    refreshTimer = $.clock.every(USAGE_REFRESH_MS, () => refreshUsage($))
    tickTimer = $.clock.every(1000, () => tick($))
    try {
      await $.command.register({
        name: 'handoff',
        description: 'Write a handoff note, clear the session, and put the note in the prompt box',
      })
      await $.command.register({
        name: 'usage-band',
        description: 'Explain the footer numbers: context, cost and prompt cache, with current values',
      })
    } catch {}
    await markNow($)
    await refreshUsage($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await resetConversationState($)
      } catch {}
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      await storeUsage($, toUsage(e, await readModel($)))
      // measure may land after turn.complete, with the turn's final request counted
      if (e.cost && turnStartUsd !== null) {
        const turnUsd = e.cost.usd - turnStartUsd
        await update($, lastTurnUsdAtom, () => turnUsd)
      }
      await markNow($)
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      try {
        turnStartUsd = (await $.session.usage()).cost?.usd ?? null
      } catch {
        turnStartUsd = null
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || !result.usage) return result
    const u = result.usage
    const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    const at = await $.clock.now()
    await update($, cacheAtom, (prev: Cache | null) => ({
      at,
      model: u.model,
      hitPct: total ? (u.cache_read_input_tokens / total) * 100 : 0,
      ttlMs: fixedTtlMs ?? prev?.ttlMs ?? TTL_MS['1h'],
      isTtlKnown: fixedTtlMs !== null || (prev?.isTtlKnown ?? false),
    }))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false
    try {
      const endUsd = (await $.session.usage()).cost?.usd ?? null
      if (endUsd !== null && turnStartUsd !== null) {
        const turnUsd = endUsd - turnStartUsd
        await update($, lastTurnUsdAtom, () => turnUsd)
      }
    } catch {}
    if (fixedTtlMs === null) {
      try {
        const ttlMs = await readTtlFromTranscript($)
        if (ttlMs !== null) {
          await update($, cacheAtom, (cur: Cache | null) => (cur ? { ...cur, ttlMs, isTtlKnown: true } : cur))
        }
      } catch {}
    }
    return result
  })

  on('command.run', { command: 'usage-band' }, async $ => {
    const usage = await read($, usageAtom)
    if (usage === null) return { text: 'No usage yet: the footer fills in after the first response.' }
    const now = await $.clock.now()
    const items = buildItems(usage, await read($, cacheAtom), now, await read($, lastTurnUsdAtom))
    const footer = items.map(item => item.value).join(' · ')
    return { text: [`Footer: ${footer}`, ...items.map(item => item.detail)].join('\n\n') }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void runHandoff($, settings)
    return { text: 'Writing a handoff note…' }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (settings.placement !== 'footer') return next(e)
    const usage = await read($, usageAtom)
    if (usage === null) return next(e)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const items = buildItems(usage, await read($, cacheAtom), now, await read($, lastTurnUsdAtom))
    if (!items.length) return next(e)

    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        {items.flatMap((item, index) => {
          const drawn = (
            <Text key={`ubp-${item.key}`} color={TONE_COLOR[item.tone]}>
              {item.value}
            </Text>
          )
          return index
            ? [
                <Text key={`ubp-dot-${item.key}`} color="subtle">
                  {DOT}
                </Text>,
                drawn,
              ]
            : [drawn]
        })}
        {e.props.modes.length ? <Text dimColor>{`${DOT}${e.props.modes.join(' & ')}`}</Text> : null}
      </Text>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const usage = await read($, usageAtom)
    if (e.props.hasSurvey || usage === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const cache = await read($, cacheAtom)

    const leftMs = cache ? cache.at + cache.ttlMs - now : -Infinity
    const isExpiring =
      cache !== null &&
      !e.props.isWorking &&
      isCacheNudgeWindow(leftMs, usage) &&
      (await read($, dismissedCacheAtAtom)) !== cache.at
    if (isExpiring && cache) {
      const isCompacting = await read($, isCompactingAtom)
      return (
        <Box justifyContent="space-between" alignItems="center">
          <Text dimColor wrap="truncate-end">
            <Text color="warning">{`Prompt cache expires in ${clock(leftMs / 1000)}. `}</Text>
            Compact so the next message rebuilds a smaller cache, or let it expire.
          </Text>
          <Box columnGap={1}>
            <Button
              key="compact"
              label={isCompacting ? 'Compacting…' : 'Compact'}
              variant="primary"
              onPress={() => compactForCache($)}
            />
            <Button
              key="let-expire"
              label="Let it expire"
              variant="secondary"
              dimColor
              onPress={() => update($, dismissedCacheAtAtom, () => cache.at)}
            />
          </Box>
        </Box>
      )
    }

    const isArmed = (await read($, handoffArmedUntilAtom)) > now
    const isBusy = await read($, isHandoffBusyAtom)
    const isSuggested =
      settings.handoffAtPercent > 0 && (usage.ctxPercent ?? 0) >= settings.handoffAtPercent
    const items =
      settings.placement === 'band' ? buildItems(usage, cache, now, await read($, lastTurnUsdAtom)) : []
    if (!items.length && !isSuggested && !isArmed && !isBusy) return next(e)

    const isProminent = isSuggested || isArmed
    const label = isBusy ? 'Writing…' : isArmed ? 'Confirm handoff' : 'Handoff'
    const message = isArmed
      ? 'Press again to clear this session and start fresh with a handoff note.'
      : `Context is ${Math.round(usage.ctxPercent ?? 0)}% full. A handoff note carries this work into a fresh session.`

    return (
      <Box justifyContent="space-between" alignItems="center">
        {items.length ? (
          <Text>
            {items.flatMap((item, index) => {
              const drawn = <Text color={TONE_COLOR[item.tone]}>{item.value}</Text>
              return index ? [<Text color="subtle">{DOT}</Text>, drawn] : [drawn]
            })}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {message}
          </Text>
        )}
        <Button
          key="handoff"
          label={label}
          variant={isProminent ? 'primary' : 'secondary'}
          dimColor={!isProminent}
          onPress={() => pressHandoff($, settings)}
        />
      </Box>
    )
  })
}
