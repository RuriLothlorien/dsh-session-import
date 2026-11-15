/**
 * Session import — browser half.
 *
 * Registers a global panel (sidebar icon plus a root-scoped `main` page) that lists
 * the conversations the Host half found in Codex, Claude Code / Claude Desktop and
 * WorkBuddy, lets the user choose source, scope, granularity and size, and reports
 * what each import produced.
 *
 * @module dsh-session-import/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-import',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-import'
    const PANEL_ID = 'session-import'
    const API = '/session-import'

    /** Import depth levels, mirroring the Host half; labels live in the dictionaries. */
    const LEVELS = [
      { level: 1, labelKey: 'level1Label', detailKey: 'level1Detail' },
      { level: 2, labelKey: 'level2Label', detailKey: 'level2Detail' },
      { level: 3, labelKey: 'level3Label', detailKey: 'level3Detail' },
      { level: 4, labelKey: 'level4Label', detailKey: 'level4Detail' },
    ]

    /** Per-client accent colour, keyed by the id the Host reports. */
    const CLIENT_COLOR = {
      codex: 'var(--dsw-alias-brand-primary)',
      claude: 'var(--dsw-alias-state-warn-primary)',
      workbuddy: 'var(--dsw-alias-state-success-primary)',
    }

    const EN = {
      panel: 'Session import',
      title: 'Import sessions',
      subtitle: 'Reads conversation transcripts from Codex, Claude and WorkBuddy, and writes them as DSH sessions.',
      refresh: 'Rescan',
      scanning: 'Scanning…',
      sourceTitle: 'Sources',
      sourceAll: 'All sources',
      sourceMissing: 'not found',
      scopeTitle: 'Scope',
      sinceLabel: 'Time range',
      sinceAll: 'All time',
      since7: 'Last 7 days',
      since30: 'Last 30 days',
      since90: 'Last 90 days',
      archivedLabel: 'Include archived sessions',
      projectsLabel: 'Projects',
      projectsAll: 'All projects',
      depthTitle: 'Granularity',
      depthHint: 'Each level contains everything in the level above it.',
      level1Label: 'summary',
      level1Detail: 'User and assistant prose only — the lightest import to browse or search.',
      level2Label: 'talk',
      level2Detail: 'Plus the developer and system notes the client injected once the conversation had started.',
      level3Label: 'tools',
      level3Detail: 'Plus tool calls and their outputs, with outputs truncated past the limit.',
      level4Label: 'full',
      level4Detail: 'Plus reasoning and complete tool outputs — the largest, closest to the original record.',
      maxMessagesLabel: 'Messages per session',
      maxMessagesAll: 'All',
      maxMessagesUnit: 'most recent',
      sessionsTitle: 'Sessions',
      search: 'Filter by title or path',
      selectAll: 'Select all',
      clear: 'Clear',
      selected: 'selected',
      empty: 'No sessions match this scope.',
      loading: 'Reading transcripts…',
      failed: 'The import service did not answer',
      imported: 'imported',
      open: 'Open',
      summary: 'messages',
      tools: 'tool calls',
      estimate: 'This import writes about',
      events: 'events',
      start: 'Import',
      importing: 'Importing…',
      done: 'Import finished',
      succeeded: 'imported',
      skipped: 'already imported',
      failedCount: 'failed',
      ungroupedHint: 'Imported sessions join the workspace of their original directory; a new one is created when none matches.',
      note: 'One import per conversation: a second import is skipped.',
      groupedAs: 'workspace',
      notLive: 'appears after a restart',
      repair: 'Repair grouping',
      filesScanned: 'transcript files scanned',
      skippedFiles: 'could not be parsed (encrypted or in use)',
      userShort: 'user',
      assistantShort: 'assistant',
      toolShort: 'tool',
      duplicateLabel: 'Write a copy of an already imported session',
      variantsHint: 'logs folded into one conversation',
    }

    const ZH = {
      panel: '会话导入',
      title: '导入会话',
      subtitle: '从 Codex、Claude 与 WorkBuddy 的会话记录中读取对话，按所选范围与颗粒度写入 DSH 会话。',
      refresh: '重新扫描',
      scanning: '正在扫描…',
      sourceTitle: '来源',
      sourceAll: '全部来源',
      sourceMissing: '未找到目录',
      scopeTitle: '范围',
      sinceLabel: '时间范围',
      sinceAll: '全部',
      since7: '最近 7 天',
      since30: '最近 30 天',
      since90: '最近 90 天',
      archivedLabel: '包含已归档的会话',
      projectsLabel: '项目',
      projectsAll: '全部项目',
      depthTitle: '颗粒度',
      depthHint: '每一级都包含上一级的内容。',
      level1Label: '摘要',
      level1Detail: '只保留用户与助手的正文，适合快速浏览或检索。',
      level2Label: '对话',
      level2Detail: '在正文之外加入客户端注入的开发者/系统说明。',
      level3Label: '工具',
      level3Detail: '再加入工具调用与工具输出，输出超过上限会截断。',
      level4Label: '完整',
      level4Detail: '再加入推理内容与完整工具输出，体积最大、最接近原始记录。',
      maxMessagesLabel: '每个会话的消息条数',
      maxMessagesAll: '全部',
      maxMessagesUnit: '最近',
      sessionsTitle: '会话',
      search: '按标题或路径筛选',
      selectAll: '全选',
      clear: '清空',
      selected: '已选',
      empty: '当前范围内没有可导入的会话。',
      loading: '正在读取会话记录…',
      failed: '导入服务没有响应',
      imported: '已导入',
      open: '打开',
      summary: '条消息',
      tools: '次工具调用',
      estimate: '本次将写入约',
      events: '个事件',
      start: '开始导入',
      importing: '正在导入…',
      done: '导入完成',
      succeeded: '成功',
      skipped: '已存在',
      failedCount: '失败',
      ungroupedHint: '导入的会话会归入其原始目录对应的工作区；没有匹配时会新建一个。',
      note: '每个会话只导入一次：重复导入会被跳过。',
      groupedAs: '工作区',
      notLive: '需重启后可见',
      repair: '修复分组',
      filesScanned: '个会话记录文件，其中',
      skippedFiles: '个无法解析（已加密或被占用）',
      userShort: '用户',
      assistantShort: '助手',
      toolShort: '工具',
      duplicateLabel: '已导入的会话再写一份副本',
      variantsHint: '份日志已合并',
    }

    /** Inline style helpers keep every surface on host theme tokens. */
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 14,
        lineHeight: 1.5,
      },
      header: {
        flex: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        padding: '20px 28px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      headerText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      title: { margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '.01em' },
      subtitle: { margin: 0, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      body: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '18px 28px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      cardHint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 },
      fieldLabel: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
      select: {
        appearance: 'none',
        height: 30,
        padding: '0 26px 0 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        font: 'inherit',
        cursor: 'pointer',
      },
      input: {
        height: 30,
        padding: '0 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        font: 'inherit',
        minWidth: 220,
      },
      button: {
        height: 30,
        padding: '0 12px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        font: 'inherit',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      },
      buttonDisabled: { opacity: 0.45, cursor: 'default' },
      primary: {
        height: 32,
        padding: '0 18px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        fontWeight: 600,
        font: 'inherit',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
      },
      segmentRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      list: { display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 'var(--dsw-radius-sm)', overflow: 'hidden' },
      sessionRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '9px 12px',
        cursor: 'pointer',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
      },
      sessionMain: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
      sessionTitle: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sessionMeta: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      badge: {
        flex: 'none',
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      badgeDone: {
        flex: 'none',
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      footer: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 28px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      estimate: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5 },
      empty: { padding: '22px 12px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12.5 },
      reportRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
    }

    /** The icon the sidebar paints for this panel. */
    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        { viewBox: '0 0 20 20', width: size, height: size, fill: 'none', 'aria-hidden': true },
        // Two stacked sheets: imports land beside the sessions you already have.
        h('rect', { x: 3.2, y: 5.4, width: 9.2, height: 10.4, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M7.2 3.2h8c.9 0 1.6.7 1.6 1.6v8.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M7.8 10.6h3m-1.5-1.5v3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    /**
     * Format a timestamp for a dense list row.
     * @param value - epoch milliseconds.
     * @returns `MM-DD HH:mm`.
     */
    function formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (number) => String(number).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Format a byte count for a list row.
     * @param bytes - size in bytes.
     * @returns a short human-readable size.
     */
    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Show the tail of a long path, which is the part that identifies a project.
     * @param path - directory path.
     * @returns the last two segments.
     */
    function tailPath(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]/).filter((part) => part !== '')
      return parts.slice(-2).join('/')
    }

    /**
     * Ask the Host half for one operation.
     * @param action - endpoint below the plugin prefix.
     * @param body - JSON request body.
     * @param signal - caller cancellation.
     * @returns the decoded payload.
     */
    async function callHost(action, body, signal) {
      const response = await fetch(`${API}${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const reason = payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return payload
    }

    /**
     * The panel page.
     * @param props - slot props; only the workspace navigation service is used.
     */
    function SessionImportPage(props) {
      const t = props.t
      const uiWorkspace = props.uiWorkspace
      const [phase, setPhase] = React.useState('idle')
      const [error, setError] = React.useState('')
      const [scan, setScan] = React.useState(null)
      const [source, setSource] = React.useState('')
      const [sinceDays, setSinceDays] = React.useState(0)
      const [includeArchived, setIncludeArchived] = React.useState(false)
      const [project, setProject] = React.useState('')
      const [level, setLevel] = React.useState(3)
      const [maxMessages, setMaxMessages] = React.useState(100)
      const [allowDuplicate, setAllowDuplicate] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [selected, setSelected] = React.useState(() => new Set())
      const [report, setReport] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const runScan = React.useCallback(
        async (signal) => {
          setPhase('scanning')
          setError('')
          try {
            const payload = await callHost(
              '/scan',
              {
                sinceDays,
                includeArchived,
                projects: project === '' ? [] : [project],
              },
              signal,
            )
            if (!alive.current) return
            setScan(payload)
            setSelected((current) => {
              const available = new Set(
                payload.sessions.filter((session) => session.importedSessionId === null).map((session) => `${session.source}:${session.id}`),
              )
              const next = new Set()
              for (const key of current) if (available.has(key)) next.add(key)
              return next
            })
            setPhase('ready')
          } catch (reason) {
            if (!alive.current || (reason instanceof DOMException && reason.name === 'AbortError')) return
            setError(reason instanceof Error ? reason.message : String(reason))
            setPhase('error')
          }
        },
        [sinceDays, includeArchived, project],
      )

      React.useEffect(() => {
        const controller = new AbortController()
        runScan(controller.signal)
        return () => controller.abort()
      }, [runScan])

      const keyOf = (session) => `${session.source}:${session.id}`

      const sources = scan !== null && Array.isArray(scan.sources) ? scan.sources : []
      const allSessions = scan !== null && Array.isArray(scan.sessions) ? scan.sessions : []
      const projects = scan !== null && Array.isArray(scan.projects) ? scan.projects : []

      // The source chips narrow the list locally: the scan already covered every
      // source, so switching chips does not need another pass over the disk.
      const sessions = source === '' ? allSessions : allSessions.filter((session) => session.source === source)
      const visible = sessions.filter((session) => {
        if (query.trim() === '') return true
        const needle = query.trim().toLowerCase()
        return (
          session.title.toLowerCase().includes(needle) ||
          session.fileName.toLowerCase().includes(needle) ||
          session.cwd.toLowerCase().includes(needle)
        )
      })
      const importable = visible.filter((session) => allowDuplicate || session.importedSessionId === null)
      const chosen = visible.filter((session) => selected.has(keyOf(session)))
      const cap = maxMessages > 0 ? maxMessages : Number.POSITIVE_INFINITY
      const messageTotal = chosen.reduce((sum, session) => sum + Math.min(session.userMessages + session.assistantMessages, cap), 0)
      const toolTotal = level >= 3 ? chosen.reduce((sum, session) => sum + session.toolCalls, 0) : 0
      const reasoningTotal = level >= 4 ? chosen.reduce((sum, session) => sum + session.reasoning, 0) : 0
      const eventEstimate = chosen.length === 0 ? 0 : messageTotal * 3 + toolTotal * 3 + reasoningTotal + chosen.length * 2

      const toggle = (key) => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      /**
       * Run one import request.
       *
       * The panel always sends `{source, id}` pairs: the Host half only imports a
       * conversation it scanned itself, so no path ever crosses the wire.
       * @param targets - scan entries to import.
       * @param options - `{granularity, maxMessages, duplicate}` overrides.
       */
      const runImport = async (targets, options) => {
        if (targets.length === 0) return
        setPhase('importing')
        setError('')
        setReport(null)
        try {
          const payload = await callHost('/import', {
            sessions: targets.map((session) => ({ source: session.source, id: session.id })),
            granularity: options.granularity,
            maxMessages: options.maxMessages,
            allowDuplicate: options.duplicate === true,
          })
          if (!alive.current) return
          setReport(payload)
          setPhase('done')
          const controller = new AbortController()
          await runScan(controller.signal)
        } catch (reason) {
          if (!alive.current) return
          setError(reason instanceof Error ? reason.message : String(reason))
          setPhase('error')
        }
      }

      const startImport = () => runImport(chosen, { granularity: level, maxMessages, duplicate: allowDuplicate })

      // Re-sending an already imported conversation is a no-op for the log but
      // still groups and publishes it, which repairs an import made by an older
      // build or by a run whose Workspace did not exist yet.
      const repairGrouping = () => {
        const imported = allSessions.filter((session) => session.importedSessionId !== null)
        return runImport(imported, { granularity: level, maxMessages: 0 })
      }

      const levelInfo = LEVELS[level - 1]

      const renderSourceCard = () =>
        h(
          'section',
          { style: styles.card },
          h(
            'div',
            { style: styles.cardHead },
            h('span', { style: styles.cardTitle }, t('sourceTitle')),
            h(
              'span',
              { style: styles.cardHint },
              sources
                .filter((entry) => entry.available === true)
                .map((entry) => `${entry.label} ${entry.sessions}`)
                .join(' · ') || '—',
            ),
          ),
          h(
            'div',
            { style: styles.segmentRow },
            h(
              'button',
              {
                type: 'button',
                'aria-pressed': source === '',
                style: {
                  ...styles.button,
                  ...(source === '' ? { background: 'var(--dsw-alias-interactive-bg-active)', fontWeight: 600 } : {}),
                },
                onClick: () => {
                  setSource('')
                  setSelected(new Set())
                },
              },
              `${t('sourceAll')} ${allSessions.length}`,
            ),
            sources.map((entry) =>
              h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  'aria-pressed': source === entry.id,
                  disabled: entry.available !== true,
                  style: {
                    ...styles.button,
                    ...(source === entry.id ? { background: 'var(--dsw-alias-interactive-bg-active)', fontWeight: 600 } : {}),
                    ...(entry.available === true ? {} : styles.buttonDisabled),
                  },
                  title: entry.available === true ? entry.root : `${entry.root} · ${t('sourceMissing')}`,
                  onClick: () => {
                    setSource(entry.id)
                    setSelected(new Set())
                  },
                },
                entry.available === true
                  ? `${entry.label} ${entry.sessions}`
                  : `${entry.label} · ${t('sourceMissing')}`,
              ),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            sources.map((entry) =>
              h(
                'div',
                { key: `${entry.id}-root`, style: styles.cardHint, title: entry.root },
                `${entry.label}: ${entry.available === true ? entry.root : `${entry.root} (${t('sourceMissing')})`}`,
              ),
            ),
          ),
        )

      const renderScopeCard = () =>
        h(
          'section',
          { style: styles.card },
          h('div', { style: styles.cardHead }, h('span', { style: styles.cardTitle }, t('scopeTitle'))),
          h(
            'div',
            { style: styles.row },
            h(
              'label',
              { style: styles.field },
              h('span', { style: styles.fieldLabel }, t('sinceLabel')),
              h(
                'select',
                { style: styles.select, value: String(sinceDays), onChange: (event) => setSinceDays(Number(event.target.value)) },
                h('option', { value: '0' }, t('sinceAll')),
                h('option', { value: '7' }, t('since7')),
                h('option', { value: '30' }, t('since30')),
                h('option', { value: '90' }, t('since90')),
              ),
            ),
            h(
              'label',
              { style: styles.field },
              h('span', { style: styles.fieldLabel }, t('projectsLabel')),
              h(
                'select',
                { style: styles.select, value: project, onChange: (event) => setProject(event.target.value) },
                h('option', { value: '' }, t('projectsAll')),
                projects.map((entry) => h('option', { key: entry.cwd, value: entry.cwd }, `${tailPath(entry.cwd)} · ${entry.count}`)),
              ),
            ),
            h(
              'label',
              { style: { ...styles.field, minWidth: 120 } },
              h('span', { style: styles.fieldLabel }, t('maxMessagesLabel')),
              h(
                'select',
                { style: styles.select, value: String(maxMessages), onChange: (event) => setMaxMessages(Number(event.target.value)) },
                h('option', { value: '0' }, t('maxMessagesAll')),
                h('option', { value: '200' }, `${t('maxMessagesUnit')} 200`),
                h('option', { value: '100' }, `${t('maxMessagesUnit')} 100`),
                h('option', { value: '50' }, `${t('maxMessagesUnit')} 50`),
                h('option', { value: '20' }, `${t('maxMessagesUnit')} 20`),
              ),
            ),
          ),
          h(
            'label',
            { style: { ...styles.row, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: includeArchived, onChange: (event) => setIncludeArchived(event.target.checked) }),
            h('span', { style: { fontSize: 12.5 } }, t('archivedLabel')),
          ),
        )

      const renderDepthCard = () =>
        h(
          'section',
          { style: styles.card },
          h('div', { style: styles.cardHead }, h('span', { style: styles.cardTitle }, t('depthTitle')), h('span', { style: styles.cardHint }, t('depthHint'))),
          h(
            'div',
            { style: styles.segmentRow },
            LEVELS.map((entry) =>
              h(
                'button',
                {
                  key: entry.level,
                  type: 'button',
                  'aria-pressed': level === entry.level,
                  style: {
                    ...styles.button,
                    height: 32,
                    padding: '0 16px',
                    ...(level === entry.level
                      ? { background: 'var(--dsw-alias-interactive-bg-active)', borderColor: 'var(--dsw-alias-border-l2)', fontWeight: 600 }
                      : {}),
                  },
                  onClick: () => setLevel(entry.level),
                },
                `L${entry.level} ${t(entry.labelKey)}`,
              ),
            ),
          ),
          h('div', { style: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' } }, t(levelInfo.detailKey)),
        )

      const renderSessionList = () => {
        const rows = []
        for (const session of visible) {
          const key = keyOf(session)
          const done = session.importedSessionId !== null
          const blocked = done && !allowDuplicate
          const checked = selected.has(key)
          rows.push(
            h(
              'label',
              {
                key,
                style: {
                  ...styles.sessionRow,
                  ...(rows.length === 0 ? { borderTop: 'none' } : {}),
                  ...(checked ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}),
                  ...(blocked ? { opacity: 0.55, cursor: 'default' } : {}),
                },
              },
              h('input', {
                type: 'checkbox',
                checked,
                disabled: blocked,
                onChange: () => toggle(key),
                style: { marginTop: 3 },
              }),
              h(
                'div',
                { style: styles.sessionMain },
                h('div', { style: styles.sessionTitle, title: session.title }, session.title),
                h(
                  'div',
                  { style: styles.sessionMeta, title: session.fileName },
                  `${formatTime(session.updatedAt)} · ${tailPath(session.cwd) || '—'} · ${session.userMessages} ${t('userShort')} / ${session.assistantMessages} ${t('assistantShort')} / ${session.toolCalls} ${t('toolShort')} · ${formatBytes(session.bytes)}`,
                ),
              ),
              h(
                'span',
                { style: { ...styles.badge, borderColor: CLIENT_COLOR[session.source] ?? 'var(--dsw-alias-border-l2)', color: CLIENT_COLOR[session.source] ?? 'var(--dsw-alias-label-secondary)' } },
                session.client,
              ),
              // A continuation log is a second file for one conversation; saying so
              // explains why the row covers more than the file the user remembers.
              typeof session.variants === 'number' && session.variants > 1
                ? h('span', { style: styles.cardHint, title: t('variantsHint') }, `×${session.variants}`)
                : null,
              done ? h('span', { style: styles.badgeDone }, t('imported')) : null,
            ),
          )
        }
        if (visible.length === 0)
          rows.push(h('div', { key: 'empty', style: styles.empty }, phase === 'scanning' ? t('loading') : t('empty')))
        return h('div', { style: styles.list }, rows)
      }

      const renderReport = () => {
        if (report === null) return null
        const results = Array.isArray(report.results) ? report.results : []
        const rows = results.map((result) => {
          const failed = typeof result.error === 'string'
          const skipped = result.skipped === true
          return h(
            'div',
            { key: `${result.source ?? ''}:${result.id}`, style: styles.reportRow },
            h(
              'span',
              {
                style: {
                  color: failed
                    ? 'var(--dsw-alias-state-error-primary)'
                    : skipped
                      ? 'var(--dsw-alias-label-tertiary)'
                      : 'var(--dsw-alias-state-success-primary)',
                },
              },
              failed ? '✕' : skipped ? '•' : '✓',
            ),
            h(
              'span',
              { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              result.title ?? result.id,
            ),
            !failed && result.workspace !== undefined && result.workspace.attached === true && result.workspace.title !== ''
              ? h('span', { style: styles.cardHint }, `${t('groupedAs')}: ${result.workspace.title}`)
              : null,
            !failed && result.publish !== undefined && result.publish.published === false
              ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, t('notLive'))
              : null,
            failed ? h('span', { style: styles.error }, result.error) : null,
            !failed && typeof result.sessionId === 'string' && result.sessionId !== '' && result.skipped !== true
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: { ...styles.button, height: 24, padding: '0 8px' },
                    onClick: () => {
                      try {
                        if (uiWorkspace !== undefined) uiWorkspace.openSession(result.sessionId)
                      } catch {
                        // Navigation is best-effort; the session is already durable.
                      }
                    },
                  },
                  t('open'),
                )
              : null,
          )
        })
        const skippedCount = results.filter((item) => item.skipped === true).length
        const failedCount = results.filter((item) => typeof item.error === 'string').length
        return h(
          'section',
          { style: styles.card },
          h(
            'div',
            { style: styles.cardHead },
            h('span', { style: styles.cardTitle }, t('done')),
            h('span', { style: styles.cardHint }, `${report.imported} ${t('succeeded')} · ${skippedCount} ${t('skipped')} · ${failedCount} ${t('failedCount')}`),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' } }, rows),
          h('div', { style: styles.cardHint }, t('ungroupedHint')),
        )
      }

      const busy = phase === 'scanning' || phase === 'importing'
      const importedSessions = allSessions.filter((session) => session.importedSessionId !== null)

      const headerAction = h(
        'button',
        {
          type: 'button',
          style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) },
          disabled: busy,
          onClick: () => runScan(),
        },
        phase === 'scanning' ? t('scanning') : t('refresh'),
      )

      return h(
        'div',
        { style: styles.root },
        h(
          'header',
          { style: styles.header },
          h(
            'div',
            { style: styles.headerText },
            h('h1', { style: styles.title }, t('title')),
            h('p', { style: styles.subtitle }, t('subtitle')),
          ),
          headerAction,
        ),
        h(
          'div',
          { style: styles.body },
          renderSourceCard(),
          renderScopeCard(),
          renderDepthCard(),
          renderReport(),
          h(
            'section',
            { style: styles.card },
            h(
              'div',
              { style: styles.cardHead },
              h('span', { style: styles.cardTitle }, `${t('sessionsTitle')} · ${visible.length}`),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('input', { style: styles.input, placeholder: t('search'), value: query, onChange: (event) => setQuery(event.target.value) }),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...styles.button, ...(importedSessions.length === 0 || busy ? styles.buttonDisabled : {}) },
                    disabled: importedSessions.length === 0 || busy,
                    onClick: repairGrouping,
                  },
                  t('repair'),
                ),
                h(
                  'button',
                  { type: 'button', style: styles.button, onClick: () => setSelected(new Set(importable.map(keyOf))) },
                  t('selectAll'),
                ),
                h('button', { type: 'button', style: styles.button, onClick: () => setSelected(new Set()) }, t('clear')),
              ),
            ),
            renderSessionList(),
            scan !== null && scan.skipped !== undefined && scan.skipped.total > 0
              ? h('div', { style: styles.cardHint }, `${scan.stats.files} ${t('filesScanned')} ${scan.skipped.total} ${t('skippedFiles')}`)
              : null,
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
              h('span', { style: styles.cardHint }, t('note')),
              h(
                'label',
                { style: { ...styles.row, gap: 6, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: allowDuplicate,
                  onChange: (event) => {
                    setAllowDuplicate(event.target.checked)
                    setSelected(new Set())
                  },
                }),
                h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('duplicateLabel')),
              ),
            ),
            error !== '' ? h('div', { style: styles.error }, `${t('failed')}: ${error}`) : null,
          ),
        ),
        h(
          'footer',
          { style: styles.footer },
          h(
            'div',
            { style: styles.estimate },
            `${t('selected')} ${chosen.length} · ${messageTotal} ${t('summary')} · ${toolTotal} ${t('tools')}`,
            chosen.length > 0 ? ` · ${t('estimate')} ${eventEstimate} ${t('events')}` : '',
          ),
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.primary, ...(chosen.length === 0 || busy ? styles.buttonDisabled : {}) },
              disabled: chosen.length === 0 || busy,
              onClick: startImport,
            },
            phase === 'importing' ? t('importing') : t('start'),
          ),
        ),
      )
    }

    /**
     * Mount the panel: one sidebar icon and the page it selects.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh: ZH,
            en: EN,
          }),
        'session-import: dictionaries',
      )
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('panel'),
            locale: NS,
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t, uiWorkspace: ctx.get('uiWorkspace') }),
          },
          SessionImportPage,
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply,
    }
  },
})
