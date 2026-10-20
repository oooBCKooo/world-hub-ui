import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createUIServer } from '../../src/server.mjs';
import { ManualBridge } from '../../src/management/manual-bridge.mjs';

// Supply an installed or source Hub CLI explicitly; the UI neither imports its
// internals nor assumes a sibling checkout. This test owns only its temp Hub.
test('public Hub CLI contract: separate UI, CSRF writes, browser bridge, raw payload and independent shutdown', { skip: !process.env.WORLD_HUB_ENTRY }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'world-hub-ui-contract-'));
  await mkdir(join(root, 'data'));
  const configPath = join(root, 'hub.json');
  await writeFile(configPath, JSON.stringify({ version: '0.1', hub: { id: 'ui-contract' },
    transport: { host: '127.0.0.1', port: 0, path: '/contract-bridge' },
    log: { enabled: true, dir: join(root,'data','log') }, blobs: { dir: join(root,'data','blobs') },
    management: { stateFile: join(root,'data','management.json') },
    acl: { defaultDeny: true, allowUnlistedBridges: false, credentials: {
      'ui-owner': { token: 'test-only-bridge-credential', maxConnections: 4, allow: { publish: ['#'], subscribe: ['#'] } },
    } },
  }));
  const child = spawn(process.execPath, [resolve(process.env.WORLD_HUB_ENTRY),'--config',configPath,'--port','0'], { cwd: root, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true });
  let stderr = '', output = '';
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  let ui, browser;
  async function stopHub() {
    if (child.exitCode !== null) return;
    const exited = once(child,'exit');
    if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM');
    await exited;
  }
  t.after(async () => { browser?.close(); await ui?.close(); await stopHub(); });
  const ready = await new Promise((resolveReady,reject) => {
    const timer = setTimeout(() => reject(new Error('Hub CLI ready deadline: ' + stderr)),10000);
    child.once('error',reject); child.once('exit',code => { clearTimeout(timer); reject(new Error(`Hub CLI exited ${code}: ${stderr}`)); });
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      for (const line of output.split('\n')) {
        try { const event = JSON.parse(line); if (event.event === 'ready') { clearTimeout(timer); resolveReady(event); return; } } catch {}
      }
    });
  });
  const hubOrigin = `http://127.0.0.1:${ready.port}`;
  assert.match((await fetch(hubOrigin)).headers.get('content-type'), /application\/json/);
  assert.equal((await fetch(hubOrigin + '/manage/')).status,404);
  ui = await createUIServer({ hub: hubOrigin });
  assert.equal(ui.bridgePath,'/contract-bridge');
  const management = await (await fetch(ui.origin + '/manage/api/state')).json();
  assert.equal(management.transport.path,'/contract-bridge'); assert.ok(management.csrfToken);
  const bad = await fetch(ui.origin + '/manage/api/annotation',{ method:'POST', headers:{ 'content-type':'application/json', origin:ui.origin }, body:JSON.stringify({key:'ui-owner',bridgeName:'Test',programs:[]}) });
  assert.equal(bad.status,403);
  const saved = await fetch(ui.origin + '/manage/api/annotation',{ method:'POST', headers:{ 'content-type':'application/json', origin:ui.origin, 'x-management-token':management.csrfToken }, body:JSON.stringify({key:'ui-owner',bridgeName:'Independent UI',programs:[]}) });
  assert.equal(saved.status,200);
  const deliveries = [];
  browser = new ManualBridge({ timeoutMs:3000, onFrame: (raw,frame) => { if(frame.type === 'delivery') deliveries.push(frame); } });
  await browser.connect({ url:ui.origin.replace('http:','ws:') + ui.bridgePath, bridge:'ui-browser',credential:'ui-owner',token:'test-only-bridge-credential' });
  await browser.command('register',{channels:[{name:'ui/contract',publish:true,subscribe:true}]});
  const subscription = await browser.subscribe({filters:['ui/contract'],from:'now'});
  const bodyRaw = '{"large":9007199254740993,"opaque":"原始内容"}';
  const receipt = await browser.command('publish',{topic:'ui/contract'},{bodyRaw});
  assert.equal(receipt.type,'published');
  const deadline = Date.now() + 3000;
  while (!deliveries.length && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait,10));
  assert.equal(deliveries.length,1); assert.equal(deliveries[0].bodyRaw,bodyRaw);
  browser.ack(subscription.subscription,[deliveries[0].seq]); browser.close();
  await ui.close(); ui = null;
  assert.equal((await fetch(hubOrigin + '/manage/api/state')).status,200,'closing UI must leave Hub running');
  await stopHub();
  assert.equal(child.exitCode,0);
});
