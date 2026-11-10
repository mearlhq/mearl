import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
if (process.platform === 'win32') throw new Error('This verification requires POSIX HOME and socket isolation');
const home = await mkdtemp(join(tmpdir(), 'mearl-coordination-'));
const children = [];
const entry = fileURLToPath(new URL('../packages/native-host/dist/index.js', import.meta.url));
function host(browserId) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, HOME: home, TMPDIR: home, MEARL_CAPABILITY_DIR: join(home, 'capabilities') }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let buffer = Buffer.alloc(0), error = '';
  const messages = [], waiters = new Set();
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);
      messages.push(JSON.parse(buffer.subarray(4, size + 4).toString()));
      buffer = buffer.subarray(size + 4);
    }
    for (const waiter of waiters) waiter();
  });
  const send = message => {
    const data = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    child.stdin.write(Buffer.concat([header, data]));
  };
  const receive = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Native handshake timed out: ' + error)); }, 10000);
    function check() { const index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0]); }
    waiters.add(check); check();
  });
  let request = 0;
  return {
    send,
    async action(action, data) {
      return new Promise((resolve, reject) => {
        const socket = createConnection(join(home, `mearl-agent-${child.pid}.sock`));
        let response = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Socket action timed out')); }, 5000);
        socket.on('connect', () => socket.write(JSON.stringify({ id: 'disabled-file-action', action, data, transport: 'extension', protocolVersion: 3, deadline: Date.now() + 4000 }) + '\n'));
        socket.on('error', error => { clearTimeout(timer); reject(error); });
        socket.on('data', chunk => {
          response += chunk;
          if (!response.includes('\n')) return;
          clearTimeout(timer); socket.destroy(); resolve(JSON.parse(response.split('\n')[0]));
        });
      });
    },
    async connect() { send({ type: 'ping', browserId, browserName: 'Fixture', version: '3.0.0', rpcVersion: 1, checkForUpdates: false, agentAccessProtocol: 1 }); return receive(m => m.type === 'pong'); },
    async barrier() { const id = 'barrier-' + ++request; send({ id, rpcVersion: 1, action: 'node_capabilities_status', data: {} }); assert.equal((await receive(m => m.id === id)).success, true); },
  };
}
async function registered() {
  const dir = join(home, '.mearl/browsers');
  const files = await readdir(dir).catch(() => []);
  return (await Promise.all(files.filter(f => f.endsWith('.json')).map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))))).map(r => r.browserId).sort();
}
try {
  const a = host('coordination-a'), b = host('coordination-b');
  const [pa, pb] = await Promise.all([a.connect(), b.connect()]);
  assert.deepEqual(await registered(), []);
  a.send({ type: 'agent_access', revision: pa.agentPolicy.revision + 1, enabled: true }); await a.barrier();
  assert.deepEqual(await registered(), []);
  a.send({ type: 'agent_access', revision: pa.agentPolicy.revision, enabled: true }); await a.barrier();
  b.send({ type: 'agent_access', revision: pb.agentPolicy.revision, enabled: true }); await b.barrier();
  assert.deepEqual(await registered(), ['coordination-a', 'coordination-b']);
  a.send({ type: 'agent_access', revision: pa.agentPolicy.revision, enabled: false });
  a.send({ type: 'browser_focus' }); await a.barrier();
  assert.deepEqual(await registered(), ['coordination-b']);
  const upload = { url: 'https://example.test/upload', method: 'POST', bodyFile: { base64: 'YWJj' } };
  for (const [action, data] of [
    ['send_request', upload],
    ['run_actions', { tabId: 1, actions: [{ action: 'send_request', data: upload }, { action: 'page_eval', data: { tabId: 1, expression: '1' } }] }],
  ]) {
    const response = await a.action(action, data);
    assert.equal(response.success, false);
    assert.match(response.error, /Extension Agent access is disabled/);
  }
  console.log('PASS: real Native Messaging handshake, stale revision rejection, profile isolation, and no focus-event resurrection');
} finally {
  await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); })));
  await rm(home, { recursive: true, force: true });
}
