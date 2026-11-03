import { randomUUID } from 'node:crypto'
import type { MicrosoftAccount, MicrosoftAgenda, MicrosoftDeviceLogin, MicrosoftDraft, MicrosoftProposal, MicrosoftSelection, MicrosoftStatus, MicrosoftTarget } from '../../shared/paiwan-microsoft'

const GRAPH = 'https://graph.microsoft.com/v1.0'
const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPE = 'offline_access User.Read Tasks.ReadWrite Calendars.ReadWrite'
const ZONE = 'China Standard Time'
type Row = Record<string, unknown>
interface Tokens { access: string; refresh: string; expiresAt: number }
export interface MicrosoftPrivateState {
  version: 1
  clientId?: string
  tokens?: Tokens
  account?: MicrosoftAccount
  selection?: MicrosoftSelection
  proposals: MicrosoftProposal[]
}
export interface MicrosoftDependencies {
  /** Must throw on unreadable/corrupt storage. Never silently return empty on read errors. */
  load: () => MicrosoftPrivateState | undefined
  /** Must atomically encrypt/write or throw, preserving the old stored state on failure. */
  save: (state: MicrosoftPrivateState) => void
  fetch?: typeof fetch
  now?: () => number
}
const copy = <T>(value: T): T => structuredClone(value)
const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}缺失`)
  return value
}
const id = (value: string): string => encodeURIComponent(required(value, 'ID'))
const date = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('日期必须是有效 YYYY-MM-DD')
  return value
}
const dateTime = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('时间必须为北京时间 YYYY-MM-DDTHH:mm，不接受含糊时间')
  date(value.slice(0, 10))
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19) || '0') > 59) throw new Error('时间无效')
  return value.length === 16 ? `${value}:00` : value
}
const etag = (row: Row): string => typeof row['@odata.etag'] === 'string' ? row['@odata.etag'] : ''

/** One-user Graph boundary. Call only after the trusted owner has authorized the UI action. */
export class PaiwanMicrosoftService {
  private state: MicrosoftPrivateState
  private fetcher: typeof fetch
  private now: () => number
  private login?: { clientId: string; deviceCode: string; expiresAt: number; interval: number; nextPoll: number }
  private refreshing?: Promise<void>
  private busy = new Set<string>()
  private loginAttempt = 0
  constructor(private deps: MicrosoftDependencies) {
    this.fetcher = deps.fetch || fetch
    this.now = deps.now || Date.now
    const loaded = deps.load()
    if (loaded && (loaded.version !== 1 || !Array.isArray(loaded.proposals))) throw new Error('微软配置无法读取；已保护原配置，请恢复备份')
    this.state = copy(loaded || { version: 1, proposals: [] })
    // A process may have exited after the server accepted a write. Never replay it.
    if (this.state.proposals.some(p => p.status === 'writing')) {
      this.commit(s => { s.proposals.forEach(p => { if (p.status === 'writing') p.status = 'unknown' }) })
    }
  }
  private commit(change: (state: MicrosoftPrivateState) => void): void {
    const next = copy(this.state)
    change(next)
    this.deps.save(next)
    this.state = next
  }
  status(): MicrosoftStatus {
    return copy({ account: this.state.account, selection: this.state.selection, loggedIn: Boolean(this.state.tokens), proposals: this.state.proposals })
  }
  async startLogin(clientId: string): Promise<MicrosoftDeviceLogin> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) throw new Error('请输入自有 Microsoft 应用的 Client ID')
    const attempt = ++this.loginAttempt
    this.login = undefined
    const response = await this.fetcher(`${AUTH}/devicecode`, { method: 'POST', body: new URLSearchParams({ client_id: clientId, scope: SCOPE }), redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Microsoft 登录初始化失败 (${response.status})`)
    const data = await response.json() as Row
    if (attempt !== this.loginAttempt) throw new Error('登录已取消或被新请求替代')
    const duration = Number(data.expires_in)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('登录有效期无效')
    const interval = Math.max(5, Number(data.interval) || 5) * 1000
    const expiresAt = this.now() + duration * 1000
    const verificationUri = required(data.verification_uri, '登录地址')
    const url = new URL(verificationUri)
    if (url.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com'].includes(url.hostname)) throw new Error('Microsoft 登录地址不受信任')
    this.login = { clientId, deviceCode: required(data.device_code, '设备代码'), expiresAt, interval, nextPoll: this.now() + interval }
    return { userCode: required(data.user_code, '用户代码'), verificationUri, expiresAt, pollAfterMs: interval }
  }
  cancelLogin(): void { this.loginAttempt++; this.login = undefined }
  async pollLogin(): Promise<{ pending: boolean; pollAfterMs?: number; account?: MicrosoftAccount }> {
    const session = this.login
    if (!session || this.now() >= session.expiresAt) { this.login = undefined; throw new Error('登录已取消或到期，请重新主动登录') }
    if (this.now() < session.nextPoll) return { pending: true, pollAfterMs: session.nextPoll - this.now() }
    session.nextPoll = this.now() + session.interval
    const response = await this.fetcher(`${AUTH}/token`, { method: 'POST', body: new URLSearchParams({ client_id: session.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: session.deviceCode }), redirect: 'error', signal: AbortSignal.timeout(30000) })
    const data = await response.json() as Row
    if (this.login !== session) throw new Error('登录已取消')
    if (!response.ok) {
      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        if (data.error === 'slow_down') session.interval += 5000
        session.nextPoll = this.now() + session.interval
        return { pending: true, pollAfterMs: session.interval }
      }
      this.login = undefined
      throw new Error('Microsoft 登录失败或被拒绝，请重新主动登录')
    }
    const tokens = this.tokens(data, '')
    const meResponse = await this.fetcher(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, { headers: { Authorization: `Bearer ${tokens.access}` }, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!meResponse.ok) throw new Error('无法核验登录账户')
    const me = await meResponse.json() as Row
    const account = { id: required(me.id, '账户 ID'), displayName: String(me.displayName || ''), address: required(me.mail || me.userPrincipalName, '账户地址') }
    if (this.login !== session) throw new Error('登录已取消')
    this.commit(s => { s.tokens = tokens; s.clientId = session.clientId; s.account = account; s.selection = undefined; s.proposals.forEach(p => { if (p.status === 'preview') p.status = 'stale' }) })
    this.login = undefined
    return { pending: false, account }
  }
  disconnect(): void {
    this.cancelLogin()
    this.commit(s => { delete s.tokens; delete s.account; delete s.selection; s.proposals.forEach(p => { if (p.status === 'preview') p.status = 'stale' }) })
  }
  private tokens(data: Row, previousRefresh: string): Tokens {
    const duration = Number(data.expires_in)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('令牌有效期无效')
    return { access: required(data.access_token, '访问令牌'), refresh: String(data.refresh_token || previousRefresh), expiresAt: this.now() + duration * 1000 }
  }
  private async access(): Promise<string> {
    if (!this.state.tokens || !this.state.clientId) throw new Error('请先登录 Microsoft 账户')
    if (this.state.tokens.expiresAt <= this.now() + 60000) {
      if (!this.refreshing) {
        const previous = this.state.tokens
        const clientId = this.state.clientId
        this.refreshing = (async () => {
          const response = await this.fetcher(`${AUTH}/token`, { method: 'POST', body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: required(previous.refresh, '刷新令牌'), scope: SCOPE }), redirect: 'error', signal: AbortSignal.timeout(30000) })
          if (!response.ok) throw new Error('Microsoft 登录已失效，请重新主动登录')
          const tokens = this.tokens(await response.json() as Row, previous.refresh)
          if (this.state.tokens?.access !== previous.access || this.state.tokens?.refresh !== previous.refresh || this.state.clientId !== clientId) throw new Error('登录账户已变化，请重新操作')
          this.commit(s => { s.tokens = tokens })
        })().finally(() => { this.refreshing = undefined })
      }
      await this.refreshing
    }
    return required(this.state.tokens?.access, '访问令牌')
  }
  private async graph(path: string, method = 'GET', body?: Row, match?: string, revision?: string): Promise<Row> {
    const url = path.startsWith('https:') ? new URL(path) : new URL(`${GRAPH}${path}`)
    if (url.origin !== 'https://graph.microsoft.com' || !(url.pathname === '/v1.0/me' || url.pathname.startsWith('/v1.0/me/'))) throw new Error('仅允许 Microsoft 全球服务本人资源')
    const accountId = this.account().id
    const token = await this.access()
    if (this.account().id !== accountId || (revision && this.selection().revision !== revision)) throw new Error('账户或目标已变化，操作未发送')
    const response = await this.fetcher(url.toString(), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: `outlook.timezone="${ZONE}"`, ...(match ? { 'If-Match': match } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Microsoft ${method}失败 (${response.status})`)
    return response.status === 204 ? {} : await response.json() as Row
  }
  private async all(path: string): Promise<Row[]> {
    const rows: Row[] = []
    const seen = new Set<string>()
    while (path) {
      if (seen.has(path)) throw new Error('Microsoft 分页异常；没有返回不完整结果')
      seen.add(path)
      const page = await this.graph(path)
      if (!Array.isArray(page.value)) throw new Error('Microsoft 响应格式异常')
      rows.push(...page.value)
      path = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : ''
    }
    return rows
  }
  private account(): MicrosoftAccount {
    if (!this.state.account) throw new Error('请先核验 Microsoft 账户')
    return this.state.account
  }
  private ownCalendar(row: Row): boolean {
    const owner = row.owner as Row | undefined
    return row.canEdit === true && String(owner?.address || '').toLowerCase() === this.account().address.toLowerCase()
  }
  async listTargets(): Promise<{ account: MicrosoftAccount; lists: MicrosoftTarget[]; calendars: MicrosoftTarget[] }> {
    const accountId = this.account().id
    const [lists, calendars] = await Promise.all([this.all('/me/todo/lists'), this.all('/me/calendars')])
    if (this.account().id !== accountId) throw new Error('账户已变化，请重新读取')
    const target = (r: Row): MicrosoftTarget => ({ id: required(r.id, '目标 ID'), name: String(r.displayName || r.name || '') })
    return { account: copy(this.account()), lists: lists.filter(r => r.isOwner === true && r.isShared === false && r.wellknownListName !== 'flaggedEmails').map(target), calendars: calendars.filter(r => this.ownCalendar(r)).map(target) }
  }
  async selectTargets(listId: string, calendarId: string): Promise<MicrosoftSelection> {
    const accountId = this.account().id
    const targets = await this.listTargets()
    const list = targets.lists.find(x => x.id === listId)
    const calendar = targets.calendars.find(x => x.id === calendarId)
    if (!list || !calendar || this.account().id !== accountId) throw new Error('请选择当前账户核验过的自有清单与日历')
    const selection = { accountId, list, calendar, revision: randomUUID() }
    // Actually read both collections before recording successful selection.
    await Promise.all([this.graph(`/me/todo/lists/${id(list.id)}/tasks?$top=1`), this.graph(`/me/calendars/${id(calendar.id)}/events?$top=1`)])
    if (this.account().id !== accountId) throw new Error('账户已变化')
    this.commit(s => { s.selection = selection; s.proposals.forEach(p => { if (p.status === 'preview') p.status = 'stale' }) })
    return copy(selection)
  }
  private selection(): MicrosoftSelection {
    const value = this.state.selection
    if (!value || value.accountId !== this.account().id) throw new Error('请先选择并只读核验自有目标')
    return value
  }
  private async verifySelection(selection: MicrosoftSelection): Promise<void> {
    const targets = await this.listTargets()
    if (this.selection().revision !== selection.revision || targets.account.id !== selection.accountId || !targets.lists.some(x => x.id === selection.list.id) || !targets.calendars.some(x => x.id === selection.calendar.id)) throw new Error('账户、目标或权限已变化，请重新核验与预览')
  }
  async readAgenda(day: string): Promise<MicrosoftAgenda> {
    date(day)
    const selection = copy(this.selection())
    await this.verifySelection(selection)
    const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    const params = new URLSearchParams({ startDateTime: `${day}T00:00:00+08:00`, endDateTime: `${tomorrow}T00:00:00+08:00` })
    const [tasks, events] = await Promise.all([this.all(`/me/todo/lists/${id(selection.list.id)}/tasks`), this.all(`/me/calendars/${id(selection.calendar.id)}/calendarView?${params}`)])
    if (this.selection().revision !== selection.revision) throw new Error('读取期间目标变化，请重新读取')
    return { date: day, timeZone: 'Asia/Shanghai', account: copy(this.account()), selection, tasks, events, readAt: this.now() }
  }
  private body(draft: MicrosoftDraft): Row {
    const title = required(draft.title, '标题').trim()
    if (title.length > 500) throw new Error('标题过长')
    if (!['create', 'update'].includes(draft.operation)) throw new Error('不支持的操作')
    if (draft.operation === 'update') required(draft.objectId, '现有对象 ID')
    if (draft.kind === 'task') {
      if (draft.status && !['notStarted', 'completed'].includes(draft.status)) throw new Error('待办状态无效')
      return { title, ...(draft.dueDate !== undefined ? { dueDateTime: draft.dueDate === null ? null : { dateTime: `${date(draft.dueDate)}T00:00:00`, timeZone: ZONE } } : {}), ...(draft.status ? { status: draft.status } : {}) }
    }
    if (draft.kind !== 'event' || typeof draft.allDay !== 'boolean') throw new Error('日程类型无效')
    const start = draft.allDay ? `${date(draft.start)}T00:00:00` : dateTime(draft.start)
    const end = draft.allDay ? `${date(draft.end)}T00:00:00` : dateTime(draft.end)
    if (end <= start) throw new Error('结束必须晚于开始；全天结束日期为不包含的次日')
    return { subject: title, start: { dateTime: start, timeZone: ZONE }, end: { dateTime: end, timeZone: ZONE }, isAllDay: draft.allDay }
  }
  private collection(selection: MicrosoftSelection, kind: MicrosoftDraft['kind']): string {
    return kind === 'task' ? `/me/todo/lists/${id(selection.list.id)}/tasks` : `/me/calendars/${id(selection.calendar.id)}/events`
  }
  async preview(draft: MicrosoftDraft): Promise<MicrosoftProposal> {
    this.body(draft)
    const selection = copy(this.selection())
    await this.verifySelection(selection)
    const path = this.collection(selection, draft.kind)
    const before = draft.operation === 'update' ? await this.graph(`${path}/${id(draft.objectId!)}`) : undefined
    if (before && !etag(before)) throw new Error('无法获得外部版本，不能安全修改')
    if (draft.kind === 'event' && before && (!Array.isArray(before.attendees) || before.attendees.length || before.isOrganizer !== true || before.type !== 'singleInstance')) throw new Error('仅可修改本人无参会人的独立日程，不修改会议或重复日程')
    if (this.selection().revision !== selection.revision) throw new Error('目标已变化')
    const proposal: MicrosoftProposal = { id: randomUUID(), account: copy(this.account()), selection, draft: copy(draft), before, status: 'preview', createdAt: this.now() }
    this.commit(s => { s.proposals.push(proposal) })
    return copy(proposal)
  }
  cancel(proposalId: string): MicrosoftProposal {
    const proposal = this.proposal(proposalId)
    if (proposal.status !== 'preview' || this.busy.has(proposalId)) throw new Error('只可取消尚未提交的预览')
    this.commit(s => { const p = s.proposals.find(x => x.id === proposalId)!; p.status = 'cancelled'; delete p.draft; delete p.before })
    return copy(this.proposal(proposalId))
  }
  private proposal(proposalId: string): MicrosoftProposal {
    const result = this.state.proposals.find(x => x.id === proposalId)
    if (!result) throw new Error('预览不存在')
    return result
  }
  async confirm(proposalId: string, explicitConfirmation: boolean): Promise<MicrosoftProposal> {
    if (explicitConfirmation !== true) throw new Error('必须由本人明确确认此预览')
    const proposal = this.proposal(proposalId)
    if (proposal.status !== 'preview' || this.busy.has(proposalId)) throw new Error('此预览已处理；结果未知时请先回读，不可重试写入')
    this.busy.add(proposalId)
    try {
      await this.verifySelection(proposal.selection)
      if (!proposal.draft) throw new Error('预览内容缺失')
      const draft = proposal.draft
      const path = this.collection(proposal.selection, draft.kind)
      if (draft.operation === 'update') {
        const latest = await this.graph(`${path}/${id(draft.objectId!)}`)
        if (!etag(latest) || etag(latest) !== etag(proposal.before || {})) { this.commit(s => { s.proposals.find(x => x.id === proposalId)!.status = 'stale' }); throw new Error('外部对象已变化，请重新预览确认') }
      }
      if (this.selection().revision !== proposal.selection.revision || this.proposal(proposalId).status !== 'preview') throw new Error('预览已失效')
      const body = this.body(draft)
      if (draft.kind === 'event' && draft.operation === 'create') body.transactionId = proposalId
      // Durable intent BEFORE write: crash/timeout never becomes an automatic replay.
      this.commit(s => { const p = s.proposals.find(x => x.id === proposalId)!; p.status = 'writing'; if (draft.objectId) p.externalId = draft.objectId })
      try {
        const result = await this.graph(draft.operation === 'create' ? path : `${path}/${id(draft.objectId!)}`, draft.operation === 'create' ? 'POST' : 'PATCH', body, draft.operation === 'update' ? etag(proposal.before || {}) : undefined, proposal.selection.revision)
        const externalId = draft.objectId || required(result.id, '写入回执 ID')
        this.commit(s => { s.proposals.find(x => x.id === proposalId)!.externalId = externalId })
        return await this.readBack(proposalId)
      } catch (error) {
        this.commit(s => { const p = s.proposals.find(x => x.id === proposalId)!; if (p.status !== 'verified') p.status = 'unknown' })
        throw new Error(`写入结果未知，请先回读核对，禁止重复提交。${error instanceof Error ? error.message : ''}`)
      }
    } finally { this.busy.delete(proposalId) }
  }
  async reconcile(proposalId: string): Promise<MicrosoftProposal> {
    if (this.busy.has(proposalId)) throw new Error('操作正在执行，请稍后只读核验')
    return this.readBack(proposalId)
  }
  private async readBack(proposalId: string): Promise<MicrosoftProposal> {
    const proposal = this.proposal(proposalId)
    if (!['unknown', 'writing'].includes(proposal.status)) return copy(proposal)
    await this.verifySelection(proposal.selection)
    if (!proposal.draft) throw new Error('原预览不可用，请到 Microsoft 核对')
    const path = this.collection(proposal.selection, proposal.draft.kind)
    if (!proposal.externalId) {
      // To Do create has no proven idempotency key; matching titles are not proof of success.
      await this.graph(`${path}?$top=1`)
      throw new Error('已只读核验连接，但写入回执 ID 未取得；结果仍未知。请到 Microsoft 核对，不能自动重建')
    }
    const actual = await this.graph(`${path}/${id(proposal.externalId)}`)
    if (this.selection().revision !== proposal.selection.revision) throw new Error('回读期间目标已变化')
    const expected = this.body(proposal.draft)
    const same = Object.entries(expected).every(([key, value]) => {
      if (key === 'start' || key === 'end' || key === 'dueDateTime') {
        if (value === null) return actual[key] == null
        const got = actual[key] as Row | undefined
        const want = value as Row
        return got && String(got.dateTime).slice(0, 19) === String(want.dateTime).slice(0, 19) && [ZONE, 'Asia/Shanghai'].includes(String(got.timeZone))
      }
      return actual[key] === value
    })
    if (!same) throw new Error('外部回读与确认内容不一致，结果仍待核对')
    this.commit(s => { const p = s.proposals.find(x => x.id === proposalId)!; p.status = 'verified'; p.verifiedAt = this.now(); delete p.before; delete p.draft })
    return copy(this.proposal(proposalId))
  }
}
