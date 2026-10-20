import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createUIServer, validateHubURL } from '../../src/server.mjs';
import { parseArguments } from '../../bin/world-hub-ui.mjs';
import { workshopAssetsRoot } from '../../src/workshop-assets.mjs';

async function fixture(t, { bridgePath = '/transport/custom', handler } = {}) {
  const calls = [], upgrades = [];
  const hub = createServer((req, res) => {
    calls.push({ path: req.url, method: req.method, headers: req.headers });
    if (handler?.(req, res)) return;
    if (req.url === '/manage/api/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ transport: { path: bridgePath }, csrfToken: 'retained-management-token' })); }
    else if (req.url === '/manage/api/redirect') { res.writeHead(302, { location: 'http://example.com/' }); res.end(); }
    else {
      const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, method: req.method, token: req.headers['x-management-token'], origin: req.headers.origin, host: req.headers.host, body: Buffer.concat(chunks).toString('utf8') })); });
    }
  });
  const owned = new Set();
  hub.on('connection', socket => { owned.add(socket); socket.once('close', () => owned.delete(socket)); });
  hub.on('upgrade', (req, socket, head) => {
    upgrades.push({ path: req.url, headers: req.headers, head });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', bytes => socket.write(bytes));
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const hubOrigin = `http://127.0.0.1:${hub.address().port}`;
  const ui = await createUIServer({ hub: hubOrigin });
  t.after(async () => { await ui.close(); for (const socket of owned) socket.destroy(); await new Promise(resolve => hub.close(resolve)); });
  return { hub, hubOrigin, ui, calls, upgrades };
}

function raw(origin, path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin), req = httpRequest({ hostname: url.hostname, port: url.port, path, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }); req.on('error', reject); req.end(body);
  });
}

test('static UI runs independently, discovers transport, and exposes external Workshop assets', async t => {
  const { ui } = await fixture(t);
  assert.equal(ui.bridgePath, '/transport/custom');
  for (const [path, type] of [['/manage/', 'text/html'], ['/manage/resource-console.mjs', 'javascript'], ['/manage/canvas-i18n.mjs', 'javascript'], ['/ui/language.mjs', 'javascript'], ['/debug', 'text/html']]) {
    const response = await fetch(ui.origin + path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), new RegExp(type));
  }
  const response = await fetch(ui.origin + '/manage/');
  assert.ok(response.headers.get('content-security-policy').includes(ui.origin.replace('http:', 'ws:')));
  assert.match(await response.text(), /resource-console\.mjs/);
  assert.match(await readFile(workshopAssetsRoot + '/index.html', 'utf8'), /\/workshop\/app\.mjs/);
});

test('fixed-target management proxy preserves body and operation token while translating validated origin', async t => {
  const { ui, hubOrigin } = await fixture(t);
  const body = JSON.stringify({ accepted: true, profileId: 'my-profile' });
  const response = await raw(ui.origin, '/manage/api/resources/profiles/apply', { method: 'POST', headers: { origin: ui.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-management-token': 'original-csrf' }, body });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { path: '/manage/api/resources/profiles/apply', method: 'POST', token: 'original-csrf', origin: hubOrigin, host: new URL(hubOrigin).host, body });
  const status = await raw(ui.origin, '/status'); assert.equal(status.status, 200);
  assert.equal((await raw(ui.origin, '/log?limit=60')).status, 200);
});

test('host, origin, same-site and cross-site requests fail before reaching privileged Hub APIs', async t => {
  const { ui, calls } = await fixture(t), baseline = calls.length;
  for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { origin: 'http://127.0.0.1:1' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await raw(ui.origin, '/manage/api/state', { headers }); assert.equal(response.status, 403);
  }
  assert.equal(calls.length, baseline);
  const entry = await raw(ui.origin, '/manage/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }); assert.equal(entry.status, 200);
});

test('allowlist refuses arbitrary upstream paths, traversal, non-read diagnostics and API redirects', async t => {
  const { ui, calls } = await fixture(t), baseline = calls.length;
  for (const path of ['/secret', '/http://example.com', '//example.com/manage/api/state', '/manage/api/../secret', '/manage/api/%2e%2e/secret', '/manage/api/foo%2fsecret', '/manage/api/foo\\secret', '/src/server.mjs', '/workshop/api/me']) {
    const response = await raw(ui.origin, path); assert.ok([400,404].includes(response.status), `${path}: ${response.status}`);
  }
  assert.equal((await raw(ui.origin, '/status', { method: 'POST' })).status, 405);
  assert.equal(calls.length, baseline);
  const response = await raw(ui.origin, '/manage/api/redirect'); assert.equal(response.status, 502); assert.match(response.text, /UPSTREAM_REDIRECT_REJECTED/);
});

test('WebSocket upgrade and bytes use the configured path and fixed target', async t => {
  const { ui, hubOrigin, upgrades } = await fixture(t);
  const socket = connect(new URL(ui.origin).port, '127.0.0.1'); t.after(() => socket.destroy());
  const payload = Buffer.from([0x81, 0x02, 0x68, 0x69]);
  const result = await new Promise((resolve, reject) => {
    let received = Buffer.alloc(0), sent = false;
    socket.on('error', reject); socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const at = received.indexOf('\r\n\r\n');
      if (at !== -1 && !sent) { sent = true; socket.write(payload); }
      if (at !== -1 && received.length >= at + 4 + payload.length) resolve({ header: received.subarray(0, at).toString('utf8'), bytes: received.subarray(at + 4) });
    });
    socket.once('connect', () => socket.write(`GET /transport/custom HTTP/1.1\r\nHost: ${new URL(ui.origin).host}\r\nOrigin: ${ui.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MTIzNDU2Nzg5MDEyMzQ1Ng==\r\n\r\n`));
  });
  assert.match(result.header, /^HTTP\/1.1 101/); assert.deepEqual(result.bytes, payload);
  assert.equal(upgrades.length, 1); assert.equal(upgrades[0].path, '/transport/custom'); assert.equal(upgrades[0].headers.origin, hubOrigin); assert.equal(upgrades[0].headers.host, new URL(hubOrigin).host);
});

test('remote Hub addresses and malformed CLI flags are refused; default CLI does not start a Hub', () => {
  for (const address of ['https://127.0.0.1:8790', 'http://192.168.1.3:8790', 'http://example.com', 'http://127.0.0.1:8790/manage', 'http://user:password@127.0.0.1', 'http://127.0.0.1/?target=evil']) assert.throws(() => validateHubURL(address));
  assert.equal(validateHubURL('http://localhost:8790').hostname, '127.0.0.1');
  assert.deepEqual(parseArguments([]), { hub: 'http://127.0.0.1:8790', port: 0, open: false });
  for (const args of [['--port','65536'], ['--port','1.5'], ['--hub'], ['--token','secret'], ['--open','--open']]) assert.throws(() => parseArguments(args));
});

test('foreign WebSocket origin and undeclared transport paths cannot reach the Hub', async t => {
  const { ui, upgrades } = await fixture(t);
  async function upgrade(path, origin) {
    const socket = connect(new URL(ui.origin).port,'127.0.0.1');
    t.after(() => socket.destroy());
    return new Promise((resolve,reject) => {
      socket.on('error',reject); socket.once('data', bytes => resolve(bytes.toString('utf8')));
      socket.once('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${new URL(ui.origin).host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MTIzNDU2Nzg5MDEyMzQ1Ng==\r\n\r\n`));
    });
  }
  assert.match(await upgrade('/transport/custom','https://attacker.example'), /^HTTP\/1.1 403/);
  assert.match(await upgrade('/transport/other',ui.origin), /^HTTP\/1.1 404/);
  assert.match(await upgrade('/transport/custom?target=http://evil.example',ui.origin), /^HTTP\/1.1 404/);
  assert.equal(upgrades.length,0);
});

test('UI remains independently available when its configured Hub is stopped', async t => {
  const stopped = createServer();
  await new Promise(resolve => stopped.listen(0,'127.0.0.1',resolve));
  const hub = `http://127.0.0.1:${stopped.address().port}`;
  await new Promise(resolve => stopped.close(resolve));
  const ui = await createUIServer({ hub, bridgePath:'/explicit-bridge' }); t.after(() => ui.close());
  assert.equal((await fetch(ui.url)).status,200);
  assert.equal((await fetch(ui.origin + '/health')).status,200);
  const response = await fetch(ui.origin + '/manage/api/state');
  assert.equal(response.status,502); assert.match(await response.text(), /HUB_UNAVAILABLE/);
  assert.equal(ui.bridgePath,'/explicit-bridge');
});
