import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fx, Range, Report } from '../types'
import { addTranscript, newTally, reportOf } from './parse'
import { PARTS, firstDayOf, groupBy, isPriced, totalOf } from './pricing'
import type { Group } from './pricing'

const PANE = 'token-spend'
const FX_KEY = 'fx-usd-gbp'
const FX_MAX_AGE_MS = 12 * 3_600_000
// Used only when the live rate cannot be fetched and none is cached.
const FALLBACK_RATE = 0.76
const RESCAN_GAP_MS = 60_000
const SESSIONS_SHOWN = 30

const report = atom({ plugin: 'token-spend', key: 'report' } as const, null)
const range = atom({ plugin: 'token-spend', key: 'range' } as const, '30d')
const isLoading = atom({ plugin: 'token-spend', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'token-spend', key: 'error' } as const, null)
const fx = atom({ plugin: 'token-spend', key: 'fx' } as const, null)
const sessionId = atom({ plugin: 'token-spend', key: 'sessionId' } as const, null)

const RANGES: { id: Range; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
]

const gbp = (usd: number, rate: number) => {
  const pounds = usd * rate

  return pounds >= 1000
    ? `£${Math.round(pounds).toLocaleString('en-GB')}`
    : `£${pounds.toFixed(2)}`
}

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
    : String(n)

const percent = (part: number, whole: number) =>
  `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`

const pad = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)

const bar = (share: number, width: number) => {
  const full = Math.round(Math.max(0, Math.min(1, share)) * width)

  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** The project's folder name. */
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? path

/** A transcript's prompt text, unescaped as far as it was cut cleanly. */
const unescape = (text: string) => {
  try {
    return JSON.parse(`"${text.replace(/\\$/, '')}"`) as string
  } catch {
    return text
  }
}

const oneLine = (text: string) => unescape(text).replace(/\s+/g, ' ').trim()

const loadFx = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const cached = (await $.store.get(FX_KEY)) as (Fx & { fetchedAt: number }) | undefined
  if (cached && now - cached.fetchedAt < FX_MAX_AGE_MS) {
    await update($, fx, () => ({ rate: cached.rate, asOf: cached.asOf, isLive: cached.isLive }))
    return
  }
  try {
    const res = await $.http.fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP')
    const body = JSON.parse(res.text) as { date?: string; rates?: { GBP?: number } }
    const rate = body.rates?.GBP
    if (!res.ok || typeof rate !== 'number') throw new Error(`status ${res.status}`)
    const next: Fx = { rate, asOf: body.date ?? new Date(now).toISOString().slice(0, 10), isLive: true }
    await $.store.set(FX_KEY, { ...next, fetchedAt: now })
    await update($, fx, () => next)
  } catch {
    const fallback: Fx = cached
      ? { rate: cached.rate, asOf: cached.asOf, isLive: cached.isLive }
      : { rate: FALLBACK_RATE, asOf: 'fixed estimate', isLive: false }
    await update($, fx, () => fallback)
  }
}

let lastScanAt = 0
let isScanning = false

async function showStatus($: EngineInterface) {
  const data = await read($, report)
  if (data === null) return
  const rate = (await read($, fx))?.rate ?? FALLBACK_RATE
  const current = await read($, sessionId)
  const today = firstDayOf('today', await $.clock.now())
  const day = totalOf(data.rows.filter(row => row.d >= today))
  const session = totalOf(data.rows.filter(row => row.s === current))
  $.ui.status(
    `Session ${gbp(session.usd, rate)} (${compact(session.tokens)}) · Today ${gbp(day.usd, rate)} (${compact(day.tokens)})`,
  )
  await exportToCloud($, data, rate, current)
}

const lastWritten = new Map<string, string>()

/** Writes session and day totals as JSON into a OneDrive folder, so they sync to the cloud. */
async function exportToCloud($: EngineInterface, data: Report, rate: number, current: string | null) {
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const sep = isWindows ? '\\' : '/'
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const custom = await $.env.get('TOKEN_SPEND_CLOUD_DIR')
    // Off Windows (a cloud session) there is no OneDrive folder; export only where one is named.
    if (!isWindows && custom === undefined) return
    const base = custom ?? `${home}${sep}OneDrive${sep}Claude Token Usage`
    const machine = (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? 'pc'
    const dir = `${base}${sep}${machine}`
    const now = await $.clock.now()
    const summary = (g: Group) => ({
      gbp: Math.round(g.usd * rate * 100) / 100,
      usd: Math.round(g.usd * 100) / 100,
      tokens: g.tokens,
      apiCalls: g.calls,
    })
    const infoOf = new Map(data.sessions.map(s => [s.id, s]))
    const dayFile = (day: string) => {
      const rows = data.rows.filter(row => row.d === day)

      return {
        day,
        note: 'UTC day; GBP at API list prices',
        total: summary(totalOf(rows)),
        sessions: groupBy(rows, row => row.s).map(s => ({
          id: s.name,
          title: oneLine(infoOf.get(s.name)?.title ?? ''),
          project: projectName(infoOf.get(s.name)?.project ?? ''),
          ...summary(s),
        })),
      }
    }
    const today = firstDayOf('today', now)
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10)
    const latest = {
      updatedAt: new Date(now).toISOString(),
      machine,
      fxUsdGbp: rate,
      currentSessionId: current,
      session: summary(totalOf(data.rows.filter(row => row.s === current))),
      today: summary(totalOf(data.rows.filter(row => row.d === today))),
    }
    const files: [string, string][] = [
      [`${dir}${sep}daily${sep}${today}.json`, JSON.stringify(dayFile(today), null, 2)],
      [`${dir}${sep}daily${sep}${yesterday}.json`, JSON.stringify(dayFile(yesterday), null, 2)],
      [`${dir}${sep}latest.json`, JSON.stringify(latest, null, 2)],
    ]
    for (const [path, text] of files) {
      // latest.json always carries a fresh timestamp; skip the rest when nothing changed.
      const key = path.endsWith('latest.json') ? text.replace(/"updatedAt".*\n/, '') : text
      if (lastWritten.get(path) === key) continue
      await $.fs.write(path, text)
      lastWritten.set(path, key)
    }
  } catch (err) {
    await update($, error, () => `cloud export failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
}

/** Windows: the bundled PowerShell scanner, which reads transcripts of any size. */
async function scanWithPowerShell($: EngineInterface, projects: string): Promise<Report> {
  const result = await $.process.run(
    [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${$.plugin.root}\\scripts\\scan.ps1`, '-Root', projects,
    ],
    { timeoutMs: 120_000 },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `scanner exited ${result.exitCode}`)
  const parsed = JSON.parse(result.stdout) as Report
  // PowerShell writes a one-item list as the item alone.
  const listOf = <T,>(value: T[] | T | undefined | null): T[] =>
    Array.isArray(value) ? value : value ? [value] : []

  return { ...parsed, rows: listOf(parsed.rows), sessions: listOf(parsed.sessions) }
}

/** Elsewhere (a cloud session runs on Linux): reads the transcripts here, up to 4 MiB each. */
async function scanInPlace($: EngineInterface, projects: string): Promise<Report> {
  const tally = newTally()
  const found: { path: string; session: string; fallback: string; isSubagent: boolean; mtime: number; size: number }[] = []
  for (const project of (await $.fs.list(projects)).filter(e => e.kind === 'dir')) {
    const projectDir = `${projects}/${project.name}`
    for (const entry of await $.fs.list(projectDir)) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        const session = entry.name.slice(0, -'.jsonl'.length)
        found.push({ path: `${projectDir}/${entry.name}`, session, fallback: project.name, isSubagent: false, mtime: entry.mtimeMs, size: entry.size })
      }
      if (entry.kind === 'dir' && (await $.fs.exists(`${projectDir}/${entry.name}/subagents`))) {
        for (const sub of await $.fs.list(`${projectDir}/${entry.name}/subagents`)) {
          if (sub.kind !== 'file' || !sub.name.endsWith('.jsonl')) continue
          found.push({ path: `${projectDir}/${entry.name}/subagents/${sub.name}`, session: entry.name, fallback: project.name, isSubagent: true, mtime: sub.mtimeMs, size: sub.size })
        }
      }
    }
  }
  for (const file of found.sort((a, b) => a.mtime - b.mtime)) {
    if (file.size > 4 * 1024 * 1024) {
      tally.skipped.push(file.path)
      continue
    }
    addTranscript(tally, await $.fs.read(file.path), file.session, file.fallback, file.isSubagent)
  }

  return reportOf(tally, new Date(await $.clock.now()).toISOString())
}

/** Totals every transcript under ~/.claude/projects. */
async function scan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  lastScanAt = await $.clock.now()
  await update($, isLoading, () => true)
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const sep = isWindows ? '\\' : '/'
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}${sep}.claude`
    const projects = `${configDir}${sep}projects`
    const scanned = isWindows ? await scanWithPowerShell($, projects) : await scanInPlace($, projects)
    await update($, report, () => scanned)
    await update($, error, () => null)
    await showStatus($)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)).slice(0, 300))
  } finally {
    isScanning = false
    await update($, isLoading, () => false)
  }
}

async function start($: EngineInterface) {
  const id = await $.session.id()
  await update($, sessionId, () => id)
  await loadFx($)
  await scan($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-spend',
      description: 'Open the token spend dashboard: tokens and GBP cost per project and session',
    })
    void start($)

    return next(e)
  })

  on('command.run', { command: 'token-spend' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token spend (GBP)' })
    void start($)

    return { text: 'Token spend dashboard opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((await $.clock.now()) - lastScanAt > RESCAN_GAP_MS) void scan($)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, report)
    const chosen = await read($, range)
    const loading = await read($, isLoading)
    const failure = await read($, error)
    const fxNow = await read($, fx)
    const current = await read($, sessionId)
    const rate = fxNow?.rate ?? FALLBACK_RATE
    const columns = Math.max(48, e.props.bodyColumns ?? e.viewport?.columns ?? 80)

    const controls = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {RANGES.map(({ id, label }) => (
          <Button
            key={`range-${id}`}
            label={label}
            variant={id === chosen ? 'primary' : 'secondary'}
            onPress={() => update($, range, () => id)}
          />
        ))}
        <Button key="refresh" label={loading ? 'Scanning…' : 'Refresh'} onPress={() => scan($)} />
      </Box>
    )

    if (data === null) {
      return (
        <Box flexDirection="column" gap={1}>
          {controls}
          <Text dimColor>{failure ? `Scan failed: ${failure}` : 'Reading your session transcripts…'}</Text>
        </Box>
      )
    }

    const nameWidth = Math.max(14, Math.min(30, columns - 44))
    const barWidth = Math.max(6, Math.min(16, columns - nameWidth - 32))
    const now = await $.clock.now()
    const firstDay = firstDayOf(chosen, now)
    const rows = data.rows.filter(row => row.d >= firstDay)
    const total = totalOf(rows)
    const thisSession = totalOf(data.rows.filter(row => row.s === current))
    const today = totalOf(data.rows.filter(row => row.d >= firstDayOf('today', now)))
    const projects = groupBy(rows, row => projectName(row.p))
    const sessions = groupBy(rows, row => row.s)
    const models = groupBy(rows, row => row.m)
    const unpriced = models.filter(m => !isPriced(m.name)).map(m => m.name)
    const infoOf = new Map(data.sessions.map(s => [s.id, s]))
    const rangeLabel = RANGES.find(r => r.id === chosen)?.label ?? ''

    const sessionLabel = (id: string) => {
      const info = infoOf.get(id)
      const title = info?.title ? oneLine(info.title) : `session ${id.slice(0, 8)}`
      const note = info?.deleted ? ' (deleted)' : info?.archived ? ' (archived)' : ''

      return `${id === current ? '● ' : ''}${title}${note}`
    }

    const costLine = (key: string, name: string, group: Group, top: number, color: string) => (
      <Text key={key}>
        {pad(name, nameWidth)} <Text color={color}>{bar(group.usd / (top || 1), barWidth)}</Text>{' '}
        {gbp(group.usd, rate).padStart(9)} <Text dimColor>{compact(group.tokens).padStart(7)} tok</Text>
      </Text>
    )

    const summary = (label: string, group: Group) => (
      <Text>
        <Text bold>{pad(label, 13)}</Text>
        {gbp(group.usd, rate).padStart(9)}
        <Text dimColor>
          {'  '}{compact(group.tokens)} tokens · {group.calls} API calls
        </Text>
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {controls}

        <Box flexDirection="column">
          {summary('This session', thisSession)}
          {current !== null && infoOf.get(current)?.title && (
            <Text dimColor>{'             '}{oneLine(infoOf.get(current)?.title ?? '')}</Text>
          )}
          {summary('Today', today)}
          {summary(rangeLabel, total)}
          <Text dimColor>
            API list prices · 1 USD = {rate.toFixed(4)} GBP
            {fxNow?.isLive ? ` (ECB, ${fxNow.asOf})` : ' (estimated rate)'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold color="claude">Where the tokens go · {rangeLabel}</Text>
          <Text dimColor>
            {pad('', nameWidth)} {'tokens'.padStart(8)} {'% tok'.padStart(6)} {'cost'.padStart(9)} {'% cost'.padStart(6)}
          </Text>
          {PARTS.map(({ key, side, label }) => {
            const part = total.parts[key]
            const isNewSide = key === 'read' || key === 'thinking'
            return (
              <Box key={`part-${key}`} flexDirection="column">
                {isNewSide && (
                  <Text dimColor>
                    {side === 'Input' ? 'Read by Claude (input)' : 'Written by Claude (output)'}
                    {' · '}
                    {percent(
                      side === 'Input'
                        ? total.parts.read.tokens + total.parts.write.tokens + total.parts.input.tokens
                        : total.parts.thinking.tokens + total.parts.text.tokens + total.parts.tools.tokens,
                      total.tokens,
                    )}{' '}
                    of tokens
                  </Text>
                )}
                <Text>
                  {pad(`  ${label}`, nameWidth)} {compact(part.tokens).padStart(8)}{' '}
                  <Text color="suggestion">{percent(part.tokens, total.tokens).padStart(6)}</Text>{' '}
                  {gbp(part.usd, rate).padStart(9)}{' '}
                  <Text color="claude">{percent(part.usd, total.usd).padStart(6)}</Text>
                </Text>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold color="claude">By project</Text>
          {projects.length === 0 && <Text dimColor>No usage in this range.</Text>}
          {projects.map(p => costLine(`p-${p.name}`, p.name, p, projects[0]?.usd ?? 0, 'claude'))}
        </Box>

        {sessions.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="claude">
              By session{sessions.length > SESSIONS_SHOWN ? ` (top ${SESSIONS_SHOWN} of ${sessions.length})` : ''}
            </Text>
            {sessions
              .slice(0, SESSIONS_SHOWN)
              .map(s => costLine(`s-${s.name}`, sessionLabel(s.name), s, sessions[0]?.usd ?? 0, 'suggestion'))}
          </Box>
        )}

        {models.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="claude">By model</Text>
            {models.map(m => (
              <Text key={`m-${m.name}`}>
                {pad(m.name, nameWidth)} {gbp(m.usd, rate).padStart(9)}{' '}
                <Text dimColor>{compact(m.tokens).padStart(7)} tok · {m.calls} calls</Text>
              </Text>
            ))}
          </Box>
        )}

        <Text dimColor>
          ● is this session · {data.files} transcripts scanned {new Date(data.scannedAt).toLocaleTimeString('en-GB')}
          {unpriced.length > 0 ? ` · no price for ${unpriced.join(', ')}` : ''}
          {failure ? ` · last refresh failed: ${failure}` : ''}
        </Text>
      </Box>
    )
  })
}

