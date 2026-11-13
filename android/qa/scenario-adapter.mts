import type { AgentAdapter, AgentId, AdapterEvent, ApprovalDecision, CreateOpts, UserInput } from '../../WebDCC/packages/protocol/src/adapter.ts';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type Runtime = { generation: number; approval?: (d: ApprovalDecision) => void; question?: (a: unknown) => void };
/** Deterministic test Agent. This is excluded from the APK and never calls external models. */
export class ScenarioAdapter implements AgentAdapter {
  readonly kind = 'fake' as const;
  private listeners: ((sessionId: string, event: AdapterEvent) => void)[] = [];
  private sessions = new Map<string, Runtime>();
  constructor(readonly id: AgentId, private workspace: string, private root: string) {}
  onEvent(cb: (sessionId: string, event: AdapterEvent) => void) { this.listeners.push(cb); }
  private emit(id: string, e: AdapterEvent) { this.listeners.forEach(f => f(id, e)); }
  async probe() { return { installed: true, version: 'qa-fixture', pinnedVersion: 'qa-fixture', auth: 'ok' as const, notes: ['仅用于原生交互验收'] }; }
  async listModels() { return [{ id: 'qa-model', label: 'UI 验收模型' }, { id: 'qa-model-fast', label: 'UI 验收模型 · 快速', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]; }
  accessModes() { return this.id === 'codex' ? [{id:'read-only',label:'只读'},{id:'workspace',label:'工作区可写'},{id:'danger-full-access',label:'完全访问'}] : this.id === 'claude-code' ? [{id:'default',label:'默认权限'},{id:'plan',label:'规划模式'}] : [{id:'read-only',label:'只读'},{id:'workspace-write',label:'编辑项目'}]; }
  buildLaunchSpec() { return { command:'ui-qa-fixture',env:{} }; }
  async create(opts: CreateOpts) { this.sessions.set(opts.sessionId,{generation:0}); return { nativeId: 'qa-'+randomUUID() }; }
  async resume(opts: CreateOpts) { this.sessions.set(opts.sessionId,{generation:0}); }
  async send(id: string, input: UserInput) { const runtime = this.sessions.get(id)!; runtime.generation++; void this.run(id,input,runtime,runtime.generation); }
  async interrupt(id: string) { const s=this.sessions.get(id); if(!s)return; s.generation++; s.approval?.({approvalId:'',optionId:'cancelled'});s.question?.({cancelled:true});this.emit(id,{type:'turn.end',status:'interrupted'}); }
  async respond(id: string, decision: ApprovalDecision) { this.sessions.get(id)?.approval?.(decision); }
  async answer(id: string, q: string, answer: unknown) { await writeFile(resolve(this.root,'last-answer.json'),JSON.stringify({sessionId:id,questionId:q,answer}));this.sessions.get(id)?.question?.(answer); }
  async dispose(id: string) { const s=this.sessions.get(id);if(s)s.generation++;this.sessions.delete(id); }
  async setModel() {};async setReasoningEffort(id: string, effort: string) { await appendFile(resolve(this.root,'effort-updates.jsonl'),JSON.stringify({agent:this.id,sessionId:id,effort})+'\n'); };async setAccessMode(_id: string, mode: string) { return mode; }
  private async run(id: string, input: UserInput, runtime: Runtime, generation: number) {
    const turn = randomUUID(); const wait = (ms:number) => new Promise(r=>setTimeout(r,ms));
    const emit = (e: AdapterEvent) => {if(runtime.generation===generation)this.emit(id,e);};
    const complete = (key:string,kind:any,data:any) => emit({type:'item.complete',itemKey:key,kind,data,turnId:turn});
    emit({type:'turn.start',nativeTurnId:turn});
    const plan = [{text:'检查项目主题',status:'in_progress'},{text:'修改强调色',status:'pending'},{text:'汇总改动供审阅',status:'pending'}];
    complete('plan-'+turn,'plan',{items:plan});
    const slow = input.text.toLowerCase().includes('slow');
    const delay = slow ? 800 : 220;
    const interim='我会先检查主题配置，再修改强调色。';
    emit({type:'item.start',itemKey:'intro-'+turn,kind:'assistant.message',data:{text:''},turnId:turn});
    for (const part of interim.match(/.{1,4}/gu) ?? []) {await wait(delay);emit({type:'item.delta',itemKey:'intro-'+turn,field:'text',append:part});if(runtime.generation!==generation)return;}
    complete('intro-'+turn,'assistant.message',{text:interim,nativePhase:'commentary'});
    if(this.id==='claude-code') {
      const approvalId='approve-'+turn;
      complete('approval-'+turn,'approval.request',{approvalId,title:'运行项目检查',detail:'cat src/theme.ts',reason:'读取主题配置，确认修改位置。',options:[{id:'allow',label:'允许一次'},{id:'deny',label:'拒绝'}]});
      const decision=await new Promise<ApprovalDecision>(r=>{runtime.approval=r});runtime.approval=undefined;if(runtime.generation!==generation)return;
      if(decision.optionId==='deny'){complete('denied-'+turn,'notice',{level:'info',text:'你已拒绝运行检查。'});emit({type:'turn.end',nativeTurnId:turn,status:'completed'});return;}
      const questionId='question-'+turn;
      complete('question-'+turn,'question',{questionId,header:'选择修改方式',prompt:'本次主题调整，你希望采用哪种风格？',options:[{id:'minimal',label:'简洁风格',description:'保持结构，只调整颜色和间距。'},{id:'detailed',label:'更丰富的层次',description:'同时增加边框与背景层次。'}],multiSelect:false,allowsFreeText:true,status:'pending'});
      await new Promise(r=>{runtime.question=r});runtime.question=undefined;if(runtime.generation!==generation)return;
    }
    emit({type:'item.start',itemKey:'cmd-'+turn,kind:'command',data:{command:'cat src/theme.ts',label:'读取主题配置',status:'running'},turnId:turn});
    await wait(slow?6000:700);if(runtime.generation!==generation)return;
    const source=await readFile(resolve(this.workspace,'src/theme.ts'),'utf8');
    complete('cmd-'+turn,'command',{command:'cat src/theme.ts',label:'读取主题配置',status:'completed',exitCode:0,outputTail:source});
    await writeFile(resolve(this.workspace,'src/theme.ts'),source.replace('#657185','#3562D6'));
    const diff=execFileSync('git',['diff','--','src/theme.ts'],{cwd:this.workspace,encoding:'utf8'});
    complete('change-'+turn,'file.change',{changes:[{path:'src/theme.ts',kind:'modify',added:1,removed:1,diff}],status:'completed'});
    complete('diff-'+turn,'turn.diff',{changes:[{path:'src/theme.ts',kind:'modify',added:1,removed:1,diff}],status:'completed'});
    complete('plan-done-'+turn,'plan',{items:plan.map(p=>({...p,status:'completed'}))});
    const answer='已更新项目主题。\n\n### 这次改了什么\n\n- 将强调色改为 `#3562D6`，提高按钮辨识度。\n- 保留背景色与现有组件结构。\n\n```ts\nexport const palette = {\n  accent: "#3562D6",\n  surface: "#FCFCFD",\n};\n```\n\n点下方的**改动审阅**，可以查看逐行差异并继续提出修改意见。';
    emit({type:'item.start',itemKey:'answer-'+turn,kind:'assistant.message',data:{text:''},turnId:turn});
    for(const part of answer.match(/.{1,12}|\n/gu)??[]) {await wait(delay);emit({type:'item.delta',itemKey:'answer-'+turn,field:'text',append:part});if(runtime.generation!==generation)return;}
    complete('answer-'+turn,'assistant.message',{text:answer,nativePhase:'final_answer'});
    emit({type:'turn.end',nativeTurnId:turn,status:'completed'});
  }
}
