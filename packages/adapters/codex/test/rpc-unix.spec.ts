import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { JsonRpcStdio } from '../src/rpc.js';

it('official Unix WebSocket framing preserves client and server request IDs and confirms process exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-rpc-unix-')); const socketPath = join(root, 'socket');
  const ws = createRequire(import.meta.url).resolve('ws');
  const program = `const http=require('node:http');const{WebSocketServer}=require(${JSON.stringify(ws)});const server=http.createServer();const sockets=new WebSocketServer({server});sockets.on('connection',socket=>socket.on('message',raw=>{const frame=JSON.parse(String(raw));if(frame.method==='reverse'){socket.send(JSON.stringify({id:'native/request:42',method:'permission',params:{original:true}}));socket.send(JSON.stringify({id:frame.id,result:frame.params}));}else if(frame.id==='native/request:42')socket.send(JSON.stringify({method:'reverse-reply',params:frame}));else socket.send(JSON.stringify({id:frame.id,result:frame.params}));}));server.listen(${JSON.stringify(socketPath)});`;
  const frames: unknown[] = [];
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', program], unixSocketPath: socketPath, onFrame: (direction, frame) => { frames.push({ direction, frame }); } });
  try {
    rpc.onServerRequest(() => ({ originalAnswer: 'yes' }));
    const reply = rpc.waitForNotification(frame => frame['method'] === 'reverse-reply', 5000);
    expect(await rpc.request('reverse', { exact: '原样' }, 5000)).toEqual({ exact: '原样' });
    expect((await reply)['params']).toEqual({ id: 'native/request:42', result: { originalAnswer: 'yes' } });
    expect(frames).toContainEqual({ direction: 'out', frame: { id: 'native/request:42', result: { originalAnswer: 'yes' } } });
    expect(rpc.resourceCounts.pending).toBe(0);
  } finally { await rpc.kill(); await rm(root, { recursive: true, force: true }); }
  expect(rpc.child.signalCode).toBe('SIGKILL'); expect(rpc.isClosed).toBe(true);
});

it('rejects pending requests when an established Unix connection closes and does not silently reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-rpc-disconnect-')); const socketPath = join(root, 'socket');
  const ws = createRequire(import.meta.url).resolve('ws');
  const program = `const http=require('node:http');const{WebSocketServer}=require(${JSON.stringify(ws)});const server=http.createServer();const sockets=new WebSocketServer({server});sockets.on('connection',socket=>socket.on('message',()=>socket.close()));server.listen(${JSON.stringify(socketPath)});`;
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', program], unixSocketPath: socketPath });
  try {
    await expect(rpc.request('must-fail', { original: true }, 5000)).rejects.toThrow('connection closed');
    expect(rpc.isClosed).toBe(true); expect(rpc.resourceCounts.pending).toBe(0);
    await vi.waitFor(() => expect(rpc.child.signalCode).toBe('SIGTERM'));
    await expect(rpc.request('cannot-replay', {}, 100)).rejects.toThrow('transport is closed');
  } finally { await rpc.kill(); await rm(root, { recursive: true, force: true }); }
});

it('confirms process exit and clears queued work when killed before the Unix listener exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-rpc-startup-'));
  const rpc = JsonRpcStdio.start({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], unixSocketPath: join(root, 'missing') });
  try {
    const request = expect(rpc.request('not-connected', {}, 5000)).rejects.toThrow('子进程退出');
    await rpc.kill(); await request;
    expect(rpc.resourceCounts).toEqual({ pending: 0, listeners: 0, waiters: 0, frames: 0 });
    expect(rpc.isClosed).toBe(true); expect(rpc.child.signalCode).toBe('SIGKILL');
  } finally { await rpc.kill(); await rm(root, { recursive: true, force: true }); }
});
