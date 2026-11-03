import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PaiwanStore } from '../../src/main/services/paiwan-store'
import { collectPaiwanEvidence } from '../../src/main/services/paiwan-evidence'
import { generatePaiwanDaily } from '../../src/main/services/paiwan-daily'

// Controlled business-flow fixture. Does not prove native WeChat/audio/provider integration.
describe('Paiwan cloud business flow (mock dependencies)', () => {
  it('saves a customer, excludes before reads/ASR, transcribes both sides, summarizes with citations, reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paiwan-fixture-'))
    try {
      const store = new PaiwanStore(join(dir, 'state.json'))
      store.customer({id:'fixture-person', name:'合成客户', company:'', role:'', summary:'', rating:'A'})
      store.save({...store.get(), excludedConversationIds:['fixture-blocked']})
      const reads: string[] = [], voices: number[] = []
      const collected = await collectPaiwanEvidence({state:()=>store.get(),start:200000,end:290000,
        contacts:['fixture-person','fixture-blocked'].map(id=>({m_nsUsrName:id,m_nsNickName:id,md5:id,type:'user'})),
        read: async c => {reads.push(c.m_nsUsrName);return [false,true].map((sent,i)=>({id:String(i),from:'fixture',type:'voice',datetime:'',content:'',isSender:sent,localId:i+1,createTime:210000+i}))},
        transcribe:async ref=>{voices.push(ref.localId);return {success:true,transcript:'合成转写内容'}}})
      expect(reads).toEqual(['fixture-person']);expect(voices).toEqual([1,2])
      const report=await generatePaiwanDaily({date:'1970-01-03',state:store.get(),evidence:collected.evidence,external:[],coverage:'fixture完整读取'},async messages=>{
        expect(messages).toHaveLength(2)
        return {success:true,data:JSON.stringify({highlights:[{text:'合成要点',evidenceIds:['fixture-person:0']}],suggestions:[],maintenance:[]})}
      })
      store.save({...store.get(),daily:report})
      expect(new PaiwanStore(join(dir,'state.json')).get().daily?.highlights[0].text).toBe('合成要点')
      expect(store.get().customers[0].rating).toBe('A')
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('requires explicit note confirmation, keeps correction evidence, cancels without active follow-up',()=>{
    const dir=mkdtempSync(join(tmpdir(),'paiwan-fixture-'))
    try {
      const store=new PaiwanStore(join(dir,'state.json'))
      store.customer({id:'fixture-person',name:'合成客户',company:'',role:'',summary:'',rating:'B'})
      const note=store.draftNote({customerId:'fixture-person',occurredAt:'2026-11-02T15:00:00+08:00',facts:'合成电话',source:'phone'})
      expect(store.get().notes.filter(n=>n.status==='confirmed')).toHaveLength(0)
      store.confirmNote(note.id)
      const correction=store.draftNote({...note,replaces:note.id,facts:'更正合成事实'})
      store.confirmNote(correction.id)
      expect(store.get().notes.map(n=>n.status)).toEqual(['void','confirmed'])
      const cancel=store.draftNote({...note,facts:'取消合成草案'})
      store.voidNote(cancel.id)
      expect(store.get().notes.filter(n=>n.status==='confirmed')).toHaveLength(1)
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('fails honestly for model failure, bad citations and excess input; corrupt file is not overwritten',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'paiwan-fixture-'))
    try {
      const file=join(dir,'state.json'), store=new PaiwanStore(file)
      const input={date:'2026-11-02',state:store.get(),evidence:[],external:[],coverage:'fixture'}
      await expect(generatePaiwanDaily(input,async()=>({success:false,error:'fixture failure'}))).rejects.toThrow('fixture failure')
      await expect(generatePaiwanDaily(input,async()=>({success:true,data:JSON.stringify({highlights:[{text:'bad',evidenceIds:['missing']}],suggestions:[],maintenance:[]})}))).rejects.toThrow('引用')
      await expect(generatePaiwanDaily({...input,external:'x'.repeat(50000)},async()=>{throw Error('must not call model')})).rejects.toThrow('超出')
      writeFileSync(file,'broken');expect(()=>new PaiwanStore(file)).toThrow();expect(readFileSync(file,'utf8')).toBe('broken')
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
})
