export interface Customer {
  id: string
  name: string
  company: string
  role: string
  summary: string
  rating: '' | 'A' | 'B' | 'C' | 'D'
}
export interface FollowupNote {
  id: string
  customerId: string
  occurredAt: string
  facts: string
  source: 'phone' | 'meeting'
  status: 'draft' | 'confirmed' | 'void'
  replaces?: string
  createdAt: string
}
export interface DailyEvidence { id: string; customerId: string; at: string; text: string; context?: boolean }
export interface DailyItem { text: string; evidenceIds: string[]; customerId?: string }
export interface DailyReport {
  date: string
  generatedAt: string
  highlights: DailyItem[]
  suggestions: DailyItem[]
  maintenance: DailyItem[]
  coverage: string
}
export interface PaiwanState {
  version: 1
  customers: Customer[]
  notes: FollowupNote[]
  excludedConversationIds: string[]
  maintenanceDays: Partial<Record<'A' | 'B' | 'C' | 'D', number>>
  dailyTime: string
  dailyEnabled: boolean
  inputBudgetKiB: number
  owner?: { accountId: string; userId: string }
  daily?: DailyReport
}
export interface PaiwanAPI {
  call: (action: string, input?: unknown) => Promise<unknown>
}
