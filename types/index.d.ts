export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// the status line's figures, from session.measure or $.session.usage()
export type Usage = {
  model: string | null
  ctxPercent: number | null
  ctxTokens: number | null
  // the compaction window when known, as the app's Context panel measures
  ctxWindow: number
  modelWindow: number
  usd: number | null
  limits: Limit[]
}

// the last main-thread API request, from its turn.step result
export type Cache = {
  at: number
  model: string
  hitPct: number
  ttlMs: number
  isTtlKnown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band-plus': {
      usage: Usage | null
      cache: Cache | null
      now: number
      lastTurnUsd: number | null
      handoffArmedUntil: number
      isHandoffBusy: boolean
      dismissedCacheAt: number | null
      isCompacting: boolean
    }
  }
}
