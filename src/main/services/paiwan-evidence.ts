import type { Contact, Message } from '../../shared/types'
import type { DailyEvidence, PaiwanState } from '../../shared/paiwan'
import type { VoiceMessageReference, VoiceRecognitionResult } from '../../shared/voice-recognition'

export function conversationAllowed(state: PaiwanState, id: string): boolean {
  return !state.excludedConversationIds.includes(id)
}

/** Filters before any message/audio read. Both sent and received voices take the same path. */
export async function collectPaiwanEvidence(input: {
  state: () => PaiwanState
  contacts: Contact[]
  start: number
  end: number
  read: (contact: Contact, start: number, end: number) => Promise<Message[]>
  transcribe: (reference: VoiceMessageReference) => Promise<VoiceRecognitionResult>
}): Promise<{ evidence: DailyEvidence[]; warnings: string[] }> {
  const evidence: DailyEvidence[] = [], warnings: string[] = []
  for (const contact of input.contacts) {
    const id = contact.m_nsUsrName
    if (contact.isOfficialAccount || !conversationAllowed(input.state(), id)) continue
    const messages = await input.read(contact, input.start - 48 * 3600, input.end)
    for (const message of messages) {
      // Recheck while collecting: a newly excluded conversation never starts another ASR task.
      if (!conversationAllowed(input.state(), id)) break
      let text = message.content
      if (message.type === 'voice' || message.type === '34') {
        if (!message.voiceTranscript) {
          if (!message.localId || !message.createTime) {
            warnings.push(`${id}/${message.id}: 语音缺少读取标识，未转写`)
            continue
          }
          const result = await input.transcribe({ sessionId: message.sessionId || id, localId: message.localId, createTime: message.createTime, svrId: message.serverId })
          if (!result.success || !result.transcript) {
            warnings.push(`${id}/${message.id}: ${result.error || '语音转写失败'}`)
            continue
          }
          text = result.transcript
        } else text = message.voiceTranscript
      }
      if (!conversationAllowed(input.state(), id)) break
      const at = message.createTime ? message.createTime * 1000 : Date.parse(message.datetime)
      if (!Number.isFinite(at)) { warnings.push(`${id}/${message.id}: 时间不可确认`); continue }
      evidence.push({ id: `${id}:${message.id}`, customerId: id, at: new Date(at).toISOString(), text: `${message.isSender ? '本人' : '对方'}：${text}`, context: at < input.start * 1000 })
    }
  }
  // If a scope changes during collection, also remove text read before the change.
  return { evidence: evidence.filter(e => conversationAllowed(input.state(), e.customerId)), warnings }
}
