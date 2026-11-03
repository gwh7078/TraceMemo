import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Customer, FollowupNote, PaiwanState } from '../../shared/paiwan'

export function atomicWrite(file: string, content: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  writeFileSync(temporary, content, { mode: 0o600 })
  renameSync(temporary, file)
}

export class PaiwanStore {
  private state: PaiwanState
  constructor(private file: string) {
    try {
      this.state = JSON.parse(readFileSync(file, 'utf8'))
      if (this.state.version !== 1 || !Array.isArray(this.state.customers) || !Array.isArray(this.state.notes)) throw new Error('档案格式无效；已停止写入，请恢复备份')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { version: 1, customers: [], notes: [], excludedConversationIds: [], maintenanceDays: {}, dailyTime: '09:00', dailyEnabled: false, inputBudgetKiB: 48 }
    }
  }
  get(): PaiwanState { return structuredClone(this.state) }
  save(next: PaiwanState): void {
    atomicWrite(this.file, JSON.stringify(next, null, 2))
    this.state = structuredClone(next)
  }
  customer(input: Customer): Customer {
    if (!input.id || !input.name.trim() || !['', 'A', 'B', 'C', 'D'].includes(input.rating)) throw new Error('请明确客户身份、姓名和人工评级')
    const next = this.get()
    const index = next.customers.findIndex(c => c.id === input.id)
    if (index < 0) next.customers.push(input); else next.customers[index] = input
    this.save(next)
    return input
  }
  draftNote(input: Omit<FollowupNote, 'id' | 'status' | 'createdAt'>): FollowupNote {
    if (!this.state.customers.some(c => c.id === input.customerId)) throw new Error('请先选择已建档客户；同名需明确微信身份')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error('请明确实际发生时间和时区，不按录入时间推断')
    if (!input.facts.trim() || !['phone', 'meeting'].includes(input.source)) throw new Error('请填写电话或面聊事实')
    if (input.replaces && !this.state.notes.some(n => n.id === input.replaces && n.customerId === input.customerId && n.status === 'confirmed')) throw new Error('更正依据无效')
    const note: FollowupNote = { ...input, id: randomUUID(), status: 'draft', createdAt: new Date().toISOString() }
    const next = this.get(); next.notes.push(note); this.save(next); return note
  }
  confirmNote(id: string): FollowupNote {
    const next = this.get(), note = next.notes.find(n => n.id === id)
    if (!note || note.status !== 'draft') throw new Error('草案不存在或已处理')
    note.status = 'confirmed'
    if (note.replaces) {
      const old = next.notes.find(n => n.id === note.replaces)
      if (!old || old.status !== 'confirmed') throw new Error('原记录已变化，请重新核对')
      old.status = 'void'
    }
    this.save(next); return note
  }
  voidNote(id: string): void {
    const next = this.get(), note = next.notes.find(n => n.id === id)
    if (!note) throw new Error('记录不存在')
    note.status = 'void'; this.save(next)
  }
}
