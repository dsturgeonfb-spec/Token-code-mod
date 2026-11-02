export type UsageRow = {
  /** project folder (the session's working directory) */
  p: string
  /** model id */
  m: string
  /** UTC day, YYYY-MM-DD */
  d: string
  /** session id */
  s: string
  /** fast mode */
  f: boolean
  i: number
  o: number
  w5: number
  w1: number
  r: number
  /** API calls */
  n: number
  /** output spent thinking */
  ot: number
  /** output written as reply text (estimated) */
  ox: number
  /** output written as tool calls (estimated) */
  oc: number
}

export type SessionInfo = {
  /** transcript id */
  id: string
  /** the sidebar name, else the first prompt */
  title: string
  project: string
  start: string
  /** the desktop app's id for it (local_...), when the app made it */
  app?: string
  archived?: boolean
  deleted?: boolean
}

export type Report = { scannedAt: string; files: number; rows: UsageRow[]; sessions: SessionInfo[] }

export type Fx = { rate: number; asOf: string; isLive: boolean }

export type Range = 'today' | '7d' | '30d' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'token-spend': {
      report: Report | null
      range: Range
      isLoading: boolean
      error: string | null
      fx: Fx | null
      sessionId: string | null
    }
  }
}
