import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { NativePeerSupervisor } from '../src/native-peer.js';

/** A scripted CLI and RPC server with a real PTY; no native/model claim. */
export async function createPeerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-peer-fixture-'));
  const sock = join(root, 'socket');
  const server = createServer(); const native = new WebSocketServer({ server });
  const pending: (() => void)[] = [];
  let deferIdentity = false; let wrongIdentity = false; let recording = true; let epoch = 1;
  const requests: Record<string, unknown>[] = [];
  native.on('connection', socket => socket.on('message', raw => {
    const value = JSON.parse(String(raw)) as { id: number; method: string; params: { threadId: string; text?: string } };
    requests.push(value);
    const reply = () => socket.send(JSON.stringify({ id: value.id, result: value.method === 'thread/resume'
      ? { thread: { id: wrongIdentity ? 'wrong-native' : value.params.threadId } } : { text: value.params.text } }));
    if (deferIdentity && value.method === 'thread/resume') pending.push(reply); else reply();
  }));
  server.listen(sock); await once(server, 'listening');
  const fixture = join(root, 'cli.cjs'); const ws = createRequire(import.meta.url).resolve('ws');
  await writeFile(fixture, `#!${process.execPath}
const WS=require(${JSON.stringify(ws)});
const remote=process.argv[process.argv.indexOf('--remote')+1];
const socket=new WS(remote,{headers:{Authorization:'Bearer '+process.env.WEB_DCC_NATIVE_PEER_TOKEN}});
let id=1,ready=false,input='';
socket.on('open',()=>socket.send(JSON.stringify({id:id++,method:'thread/resume',params:{threadId:'parent-native'}})));
socket.on('message',raw=>{const frame=JSON.parse(String(raw));ready=true;process.stdout.write(frame.result.thread?'fixture-ready\\r\\n':'RESULT '+frame.result.text+'\\r\\n');});
socket.on('close',()=>process.exit());socket.on('error',()=>process.exit(1));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdin.on('data',data=>{
 input+=data;
 while(input.includes('\\r')){const end=input.indexOf('\\r'),text=input.slice(0,end);input=input.slice(end+1);
  if(text==='child'||text==='parent')socket.send(JSON.stringify({id:id++,method:'thread/resume',params:{threadId:text+'-native'}}));
  else if(ready)socket.send(JSON.stringify({id:id++,method:'fixture/command',params:{text}}));
 }
});
`, { mode: 0o700 });
  let held = 0; let releases = 0;
  const parent = { nativeId: 'parent-native', ownerId: 'original-owner' };
  const frames: { direction: string; channel: string; frame: Record<string, unknown> }[] = [];
  const supervisor = new NativePeerSupervisor(async () => ({ nativeId: parent.nativeId, nativeVersion: 'fixture', socketPath: sock, executable: fixture, cwd: root,
    env: { PATH: process.env['PATH']!, HOME: root }, identity: { generation: 1, ownerId: parent.ownerId, hostId: 'host' },
    assert: () => { if (epoch !== 1) throw new Error('stale owner'); },
    hold: () => { held++; return () => { held--; releases++; }; },
    record: (direction, channel, frame) => { frames.push({ direction, channel, frame }); return recording; },
  }), join(root, 'logs'));
  return { root, parent, frames, requests, supervisor,
    metrics: () => ({ held, releases }),
    deferIdentity(value: boolean) { deferIdentity = value; },
    acknowledge() { for (const reply of pending.splice(0)) reply(); },
    wrongIdentity() { wrongIdentity = true; },
    rejectRecording() { recording = false; },
    replaceOwner() { epoch++; },
    async close() {
      await supervisor.dispose(); for (const socket of native.clients) socket.terminate();
      native.close(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true });
    },
  };
}
