/** Public renderer contract. OAuth tokens never cross this boundary. */
export interface MicrosoftAccount { id: string; displayName: string; address: string }
export interface MicrosoftTarget { id: string; name: string }
export interface MicrosoftSelection {
  accountId: string
  list: MicrosoftTarget
  calendar: MicrosoftTarget
  revision: string
}
export type MicrosoftDraft =
  | { kind: 'task'; operation: 'create' | 'update'; objectId?: string; title: string; dueDate?: string | null; status?: 'notStarted' | 'completed' }
  | { kind: 'event'; operation: 'create' | 'update'; objectId?: string; title: string; start: string; end: string; allDay: boolean }
export interface MicrosoftProposal {
  id: string
  account: MicrosoftAccount
  selection: MicrosoftSelection
  draft?: MicrosoftDraft
  before?: Record<string, unknown>
  status: 'preview' | 'cancelled' | 'writing' | 'unknown' | 'verified' | 'stale'
  createdAt: number
  externalId?: string
  verifiedAt?: number
}
export interface MicrosoftAgenda {
  date: string
  timeZone: 'Asia/Shanghai'
  account: MicrosoftAccount
  selection: MicrosoftSelection
  tasks: Record<string, unknown>[]
  events: Record<string, unknown>[]
  readAt: number
}
export interface MicrosoftStatus {
  account?: MicrosoftAccount
  selection?: MicrosoftSelection
  loggedIn: boolean
  proposals: MicrosoftProposal[]
}
export interface MicrosoftDeviceLogin { userCode: string; verificationUri: string; expiresAt: number; pollAfterMs: number }
