/**
 * Session import — Host half.
 *
 * Scans the transcript directories of the supported clients (Codex, Claude Code /
 * Claude Desktop, WorkBuddy) and materializes selected conversations as ordinary
 * DSH Session logs, so they open in the Harness conversation view like any other
 * session.
 *
 * The browser half talks to this file through JSON endpoints the Web carrier
 * serves below `/session-import`; the panel page is the only intended caller.
 *
 * @module dsh-session-import
 */

import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { buildEvents } from './build.js'
import { GRANULARITY } from './build.js'
import { SOURCES, sessionIdFor, sourceById } from './sources.js'

/**
 * Services this plugin cannot work without.
 *
 * `connection` is the Host's browser-trust fence. It is listed here so the routes
 * mount only after it exists: `requestRejection` is the one implementation of the
 * loopback / DNS-rebinding / cross-site rules DSH itself uses, and a second private
 * copy of those rules would be a second thing to keep in step with the core.
 */
export const inject = ['webServer', 'sessionPersistence', 'connection']

/**
 * The row's config, as the settings form reads and writes it.
 *
 * Every field this plugin reads is declared here. DSH 0.1.7+ builds its form from
 * this schema and writes `simplify(config)` back, so a field the plugin honours but
 * the schema omits would be deleted by the first save from that form. Each entry
 * keeps the default `cordis.patch.yml` ships, so an older composition that writes
 * only some of them still boots with the documented values.
 */
export const Config = z.object({
  codexHome: z.string().default('').description('Codex transcript root; empty uses CODEX_HOME, then ~/.codex.'),
  claudeHome: z.string().default('').description('Claude transcript root; empty uses CLAUDE_CONFIG_DIR, then ~/.claude.'),
  workbuddyHome: z.string().default('').description('WorkBuddy transcript root; empty uses WORKBUDDY_HOME, then ~/.workbuddy.'),
  toolOutputLimit: z.natural().default(4000).description('Characters kept per tool output below the full granularity; 0 or less falls back to 4000.'),
  createWorkspace: z.boolean().default(true).description('Create a Workspace when no existing one owns the imported session\'s directory.'),
  publishSessions: z.boolean().default(true).description('Open each imported session live so it appears in the sidebar without a restart.'),
})

/** Prefix every endpoint lives below. */
const ROUTE_PREFIX = '/session-import'
/** Largest JSON request body the import page may send. */
const MAX_BODY_BYTES = 1 << 20
/** Session-log format this build writes. */
const SESSION_FORMAT_VERSION = 4
/** Sessions accepted in one import request. */
const MAX_IMPORT_BATCH = 40
/** Events written per `SessionHandle.append` call. */
const APPEND_BATCH = 400

/**
 * Resolve the working directory a Session should record.
 *
 * `ApiSessionList.list` only returns a cold Session when its header carries a cwd,
 * so the recorded directory is always kept even after the folder disappears; an
 * existing directory is canonicalized so it matches a Workspace record exactly.
 * @param path - the directory recorded by the source client.
 * @returns the path to store, or undefined when nothing usable was recorded.
 */
async function resolveSessionCwd(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return undefined
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : undefined
  } catch {
    // The project may be gone; the transcript is still worth keeping.
    return path
  }
}

/**
 * Put one Session under the Workspace that owns its directory.
 *
 * The visible session list groups by `Workspace.sessionIds`, and DSH only adds a
 * session there when the creator attaches it — the same call the Session
 * Controller makes right after creating a session in a Workspace.
 * @param ctx - the plugin context.
 * @param sessionId - the imported Session.
 * @param cwd - the Session's stored working directory.
 * @param createWorkspace - whether a missing Workspace may be created.
 * @returns the attachment outcome reported by the panel.
 */
async function attachToWorkspace(ctx, sessionId, cwd, createWorkspace) {
  if (cwd === undefined)
    return { attached: false, reason: '会话没有可归属的工作目录 / The session has no working directory to group under.' }
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined)
    return { attached: false, reason: '当前 profile 没有工作区注册表 / This profile has no workspace registry.' }

  let workspace
  try {
    workspace = await registry.resolveByPath(cwd)
  } catch (error) {
    return { attached: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (workspace === undefined) {
    if (createWorkspace !== true)
      return { attached: false, reason: '没有匹配的工作区 / No workspace matches this directory.' }
    try {
      workspace = await registry.create(cwd)
    } catch (error) {
      return { attached: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    return { attached: false, reason: error instanceof Error ? error.message : String(error) }
  }
  return { attached: true, workspaceId: workspace.id ?? '', title: workspace.title ?? '' }
}

/**
 * Publish one imported Session as a live Session.
 *
 * A persisted-only log is invisible until the next Host start: the client list is
 * fed by `api-session/added`, which the Session Controller emits from
 * `session/created` — and only a live Session is ever created. Resuming through
 * the Session Controller is exactly what opening the Session does, so the row,
 * its title projection, and later continuation all come from the real path.
 * @param ctx - the plugin context.
 * @param sessionId - the imported Session.
 * @returns the publication outcome reported by the panel.
 */
async function publishSession(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller === undefined)
    return { published: false, reason: '当前 profile 没有会话控制器 / This profile has no session controller.' }
  try {
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved !== null && typeof resolved === 'object' && resolved.error !== undefined) {
      return { published: false, reason: resolved.error.message ?? String(resolved.error) }
    }
    return { published: true }
  } catch (error) {
    return { published: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Find a free session id beside one that is already taken.
 * @param persistence - the session persistence service.
 * @param base - the occupied session id.
 * @returns the first free suffixed id.
 */
async function nextFreeSessionId(persistence, base) {
  for (let copy = 2; copy <= 20; copy += 1) {
    const candidate = `${base}-${copy}`
    if ((await persistence.stat(candidate)) === undefined) return candidate
  }
  throw new Error('同名会话过多，无法创建副本 / Too many copies already share this name.')
}

/**
 * Read the on-disk location of a stored Session.
 *
 * `stat` and the shape it returns are the persistence service's business, not this
 * plugin's: the location is only used to tell a reader where a rejected log sits, so
 * anything unexpected — a throw, a missing `location`, a non-string `path` — degrades
 * to "unknown" instead of replacing the real validation error with a TypeScript-shaped
 * one about a property this plugin guessed at.
 * @param persistence - the session persistence service.
 * @param sessionId - the Session whose log location is wanted.
 * @returns the log path, or '' when it cannot be established.
 */
async function storedLocation(persistence, sessionId) {
  try {
    const stored = await persistence.stat(sessionId)
    const path = stored?.location?.path
    return typeof path === 'string' ? path : ''
  } catch {
    return ''
  }
}

/**
 * Read the working directory recorded in a stored Session's header.
 *
 * The header is written by `importEntry` and read back through the persistence
 * service, which may hand back a record without a header (a log it refused to open)
 * or one whose cwd is not a string. Grouping a session under a Workspace is a
 * convenience, so an unreadable header reports "no directory" and skips grouping
 * rather than failing the whole import that already succeeded.
 * @param persistence - the session persistence service.
 * @param sessionId - the imported Session.
 * @returns the recorded cwd, or undefined when it cannot be established.
 */
async function storedCwd(persistence, sessionId) {
  try {
    const stored = await persistence.stat(sessionId)
    const cwd = stored?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Import one scanned conversation as a new DSH Session.
 * @param ctx - the plugin context.
 * @param source - the adapter that owns the transcript.
 * @param entry - the scan entry to import.
 * @param options - import depth and limits.
 * @returns the per-session report row.
 */
async function importEntry(ctx, source, entry, options) {
  const persistence = ctx.sessionPersistence
  let sessionId = sessionIdFor(entry.source, entry.id)
  let existing = await persistence.stat(sessionId)
  if (existing !== undefined) {
    const reader = await persistence.open(sessionId, 'read')
    let present
    try {
      present = (await reader.read()).events
    } finally {
      await reader.close()
    }
    if (present.length > 0) {
      // An earlier import already holds this conversation: refuse by default, or
      // write a copy beside it when the caller asked for another granularity.
      if (options.allowDuplicate !== true)
        return { id: entry.id, source: entry.source, client: entry.client, sessionId, title: entry.title, skipped: true, events: 0 }
      sessionId = await nextFreeSessionId(persistence, sessionId)
      existing = undefined
    }
    // An earlier attempt that failed before writing content leaves an empty log;
    // fill it instead of reporting the conversation as already imported.
  }

  // The entry, not the path: Codex folds a conversation's continuation slices into
  // it, and only the adapter knows whether the remaining sources have just one file.
  const records = await source.read(entry)
  const { items, model } = source.toItems(records, entry)
  const { events, counters } = buildEvents(items, options, {
    model,
    provider: entry.source,
    createdAt: entry.createdAt,
    title: entry.title,
  })
  if (events.length === 0) return { id: entry.id, source: entry.source, client: entry.client, sessionId: '', title: entry.title, error: '没有可导入的对话内容 / This conversation has no content to import.' }

  const header = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: entry.createdAt,
    isSeeded: false,
  }
  const cwd = await resolveSessionCwd(entry.cwd)
  if (cwd !== undefined) header.cwd = cwd

  const handle = existing === undefined ? await persistence.create(header) : await persistence.open(sessionId, 'write')
  try {
    for (let index = 0; index < events.length; index += APPEND_BATCH) {
      await handle.append(events.slice(index, index + APPEND_BATCH))
    }
    await handle.flush()
  } finally {
    await handle.close()
  }

  // The write path accepts what it is given; only the read path proves the log is
  // a log DSH can reopen, so check it here instead of leaving a broken session.
  const location = await storedLocation(persistence, sessionId)
  try {
    const reader = await persistence.open(sessionId, 'read')
    try {
      await reader.read()
    } finally {
      await reader.close()
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      id: entry.id,
      source: entry.source,
      client: entry.client,
      sessionId,
      title: entry.title,
      error: `写入的日志未通过 DSH 校验：${detail}${location === '' ? '' : `（日志位置 ${location}）`} / DSH rejected the written log: ${detail}${location === '' ? '' : ` (log at ${location})`}`,
    }
  }

  return { id: entry.id, source: entry.source, client: entry.client, sessionId, title: entry.title, events: events.length, model, counters, cwd: header.cwd }
}

/**
 * Answer one request with JSON.
 * @param response - the server response.
 * @param status - HTTP status code.
 * @param payload - JSON payload.
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param request - the incoming request.
 * @returns the parsed body.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求内容过大 / The request body is too large.')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Ask the Host's browser-trust fence whether this request may proceed.
 *
 * The fence is the same `ctx.connection.requestRejection` the Host itself consults
 * below `/api`, so the loopback, DNS-rebinding and cross-site rules live in one
 * place instead of a second private copy that could drift from the core.
 *
 * It is deliberately stricter than comparing `Origin` against `Host`: `Host` is the
 * one header a rebinding attack cannot forge, so a request whose `Host` names a
 * foreign domain is refused even when `Origin` agrees with it, a bare `Origin:`
 * value is refused rather than read as "no Origin", and a request that carries no
 * DSH credentials is refused instead of served.
 * @param ctx - the plugin context.
 * @param request - the incoming request.
 * @returns the status to refuse with, or undefined when the request may proceed.
 */
function rejectionOf(ctx, request) {
  const connection = Reflect.get(ctx, 'connection')
  if (connection === undefined) return 403
  try {
    const rejection = connection.requestRejection(request)
    return typeof rejection === 'number' ? rejection : undefined
  } catch {
    // A fence that throws is a Host bug; failing open here would turn it into
    // exactly the exposure this exists to close.
    return 403
  }
}

/**
 * Answer a request the fence refused, in the reader's language.
 * @param response - the server response.
 * @param rejection - the status the fence returned.
 */
function sendRejection(response, rejection) {
  if (rejection === 401)
    return sendJson(response, 401, {
      ok: false,
      error:
        '需要先登录 DSH：请重新打开 dsh web 启动时打印的那个网址。 / DSH login required: reopen the URL dsh web printed at startup.',
    })
  return sendJson(response, 403, {
    ok: false,
    error: '这个请求来自不受信任的地址，已拒绝。 / This request came from an untrusted origin and was refused.',
  })
}

/**
 * Normalize the browser half's request into the numbers the builder expects.
 * @param body - request body.
 * @param config - the row's config.
 * @returns import options.
 */
function readImportOptions(body, config) {
  const granularity = Number.isInteger(body.granularity) ? body.granularity : GRANULARITY.TALK
  const maxMessages = Number.isInteger(body.maxMessages) && body.maxMessages > 0 ? body.maxMessages : 0
  const limit = Number.isInteger(config?.toolOutputLimit) && config.toolOutputLimit > 0 ? config.toolOutputLimit : 4000
  return {
    granularity: Math.min(GRANULARITY.FULL, Math.max(GRANULARITY.SUMMARY, granularity)),
    maxMessages,
    allowDuplicate: body.allowDuplicate === true,
    toolOutputLimit: granularity >= GRANULARITY.FULL ? 0 : limit,
    createWorkspace: config?.createWorkspace !== false,
    publishSessions: config?.publishSessions !== false,
  }
}

/**
 * Filter a scan result down to the scope the panel asked for.
 * @param sessions - scan entries.
 * @param body - request body.
 * @returns the entries inside the requested scope.
 */
function applyScope(sessions, body) {
  const sinceDays = Number.isInteger(body.sinceDays) && body.sinceDays > 0 ? body.sinceDays : 0
  const projects = Array.isArray(body.projects) ? body.projects.filter((value) => typeof value === 'string') : []
  const includeArchived = body.includeArchived === true
  const cutoff = sinceDays === 0 ? 0 : Date.now() - sinceDays * 24 * 60 * 60 * 1000
  return sessions.filter((session) => {
    if (!includeArchived && session.archived) return false
    if (cutoff !== 0 && session.updatedAt < cutoff) return false
    if (projects.length > 0 && !projects.includes(session.cwd)) return false
    return true
  })
}

/**
 * Merge the per-source scans into one panel payload.
 *
 * A source may be missing entirely (the client was never installed), which is a
 * normal state rather than an error: the panel greys that source out and the other
 * sources still import.
 * @param results - per-source results (or `{ id, error }` for a failed scan).
 * @param body - request body, used for the scope filter.
 * @returns the merged payload.
 */
function mergeScan(results, body) {
  const sessions = []
  const sources = []
  const warnings = []
  const skipped = { total: 0, empty: 0, unreadable: 0, foreign: 0, missing: 0 }
  let files = 0

  for (const result of results) {
    if (result.error !== undefined) {
      sources.push({ id: result.id, label: sourceById(result.id)?.label ?? result.id, available: false, error: result.error, sessions: 0 })
      continue
    }
    const inScope = applyScope(result.sessions, body)
    sessions.push(...inScope)
    files += result.stats.files
    for (const key of Object.keys(skipped)) skipped[key] += result.skipped[key] ?? 0
    warnings.push(...result.warnings.slice(0, 20))
    sources.push({
      id: result.id,
      label: result.label,
      root: result.root,
      available: true,
      sessions: result.sessions.length,
      inScope: inScope.length,
      bytes: result.stats.bytes,
      skipped: result.skipped,
    })
  }

  sessions.sort((left, right) => right.updatedAt - left.updatedAt)

  const projects = new Map()
  for (const session of sessions) {
    if (session.cwd === '') continue
    const project = projects.get(session.cwd) ?? { cwd: session.cwd, count: 0, lastAt: 0 }
    project.count += 1
    project.lastAt = Math.max(project.lastAt, session.updatedAt)
    projects.set(session.cwd, project)
  }

  skipped.total = skipped.empty + skipped.unreadable + skipped.foreign + skipped.missing
  return {
    ok: true,
    sessions,
    sources,
    projects: [...projects.values()].sort((left, right) => right.lastAt - left.lastAt),
    warnings,
    skipped,
    stats: { files, sessions: sessions.length, bytes: sessions.reduce((sum, session) => sum + session.bytes, 0) },
    inScope: sessions.length,
  }
}

/**
 * Mount the panel's Host side.
 * @param ctx - the plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  /** Most recent scan per source, keyed by conversation id, so import never trusts a client path. */
  let scanned = new Map()

  const runScan = async () => {
    const startedAt = Date.now()
    const results = await Promise.all(
      SOURCES.map(async (source) => {
        try {
          return await source.scan(source.resolveRoot(config))
        } catch (error) {
          return { id: source.id, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
    const merged = mergeScan(results, {})
    scanned = new Map()
    for (const session of merged.sessions) scanned.set(`${session.source}:${session.id}`, session)
    return { ...merged, durationMs: Date.now() - startedAt, scannedAt: Date.now() }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          try {
            const rejection = rejectionOf(ctx, request)
            if (rejection !== undefined) return sendRejection(response, rejection)
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const action = url.pathname.slice(ROUTE_PREFIX.length)

            if (action === '/ping') {
              const roots = SOURCES.map((source) => ({ id: source.id, root: source.resolveRoot(config) }))
              return sendJson(response, 200, { ok: true, roots })
            }

            if (action === '/scan') {
              if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: '请使用 POST / Use POST.' })
              const body = await readJsonBody(request)
              const startedAt = Date.now()
              const results = await Promise.all(
                SOURCES.map(async (source) => {
                  try {
                    return await source.scan(source.resolveRoot(config))
                  } catch (error) {
                    return { id: source.id, error: error instanceof Error ? error.message : String(error) }
                  }
                }),
              )
              const merged = mergeScan(results, body)
              scanned = new Map()
              for (const session of merged.sessions) scanned.set(`${session.source}:${session.id}`, session)
              const imported = await Promise.all(
                merged.sessions.map(async (session) => (await ctx.sessionPersistence.stat(sessionIdFor(session.source, session.id))) !== undefined),
              )
              const sessions = merged.sessions.map((session, index) => ({
                ...session,
                importedSessionId: imported[index] ? sessionIdFor(session.source, session.id) : null,
              }))
              return sendJson(response, 200, { ...merged, sessions, durationMs: Date.now() - startedAt, scannedAt: Date.now() })
            }

            if (action === '/import') {
              if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: '请使用 POST / Use POST.' })
              const body = await readJsonBody(request)
              // The panel identifies a conversation by source plus its own id, so an
              // imported path can only ever be one that this Host scanned itself.
              const chosen = Array.isArray(body.sessions) ? body.sessions.filter((entry) => typeof entry?.id === 'string' && typeof entry?.source === 'string') : []
              if (chosen.length === 0) return sendJson(response, 400, { ok: false, error: '没有选择会话 / No session was selected.' })

              if (scanned.size === 0) await runScan()
              const options = readImportOptions(body, config)
              const results = []
              let imported = 0
              for (const request_ of chosen.slice(0, MAX_IMPORT_BATCH)) {
                const source = sourceById(request_.source)
                const entry = scanned.get(`${request_.source}:${request_.id}`)
                if (source === undefined || entry === undefined) {
                  results.push({ id: request_.id, source: request_.source, error: '会话不在本次扫描结果中，请刷新后重试 / That session is not in this scan; refresh and retry.' })
                  continue
                }
                try {
                  const report = await importEntry(ctx, source, entry, options)
                  if (report.sessionId !== '' && report.skipped !== true) imported += 1
                  // Group and publish even for an already imported conversation, so
                  // repeating an import also repairs an earlier ungrouped copy.
                  if (report.sessionId !== '' && report.error === undefined) {
                    report.workspace = await attachToWorkspace(
                      ctx,
                      report.sessionId,
                      await storedCwd(ctx.sessionPersistence, report.sessionId),
                      options.createWorkspace,
                    )
                    report.publish = options.publishSessions
                      ? await publishSession(ctx, report.sessionId)
                      : { published: false, reason: '配置已关闭发布 / Publishing is disabled in the config.' }
                  }
                  results.push(report)
                } catch (error) {
                  results.push({ id: request_.id, source: request_.source, title: entry.title, error: error instanceof Error ? error.message : String(error) })
                }
              }
              const dropped = chosen.length > MAX_IMPORT_BATCH ? chosen.length - MAX_IMPORT_BATCH : 0
              return sendJson(response, 200, {
                ok: true,
                imported,
                results,
                dropped,
                granularity: options.granularity,
                maxMessages: options.maxMessages,
              })
            }

            return sendJson(response, 404, { ok: false, error: '未知操作 / Unknown endpoint.' })
          } catch (error) {
            return sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'session-import: routes',
  )
}
