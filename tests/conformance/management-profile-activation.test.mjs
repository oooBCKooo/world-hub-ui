import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
const response = (body, ok = true) => ({ ok, json: async () => structuredClone(body) });
function scene(fetch) {
  const events = [], toasts = [];
  const controls = [{ disabled: false }, { disabled: false }];
  const popover = { querySelectorAll: () => controls, setAttribute() {} };
  const context = vm.createContext({ console, AbortSignal, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { hubCanvas: { state: { data: { csrfToken: 'csrf-private' } }, toast: (...args) => toasts.push(args) }, dispatchEvent: event => events.push(event.type) },
    document: { getElementById: id => id === 'hud-profile-popover' ? popover : null }, localStorage: { getItem: () => null }, fetch });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.view = new CanvasModesController();', context);
  const view = context.view; let refreshes = 0;
  view.updateProfileSwitcher = async () => { refreshes++; };
  return { view, controls, events, toasts, context, get refreshes() { return refreshes; } };
}
const profiles = [
  { profileId: 'global-old', id: 'global', scope: 'global', active: true, title: 'Old global' },
  { profileId: 'global-new', id: 'global', scope: 'global', active: false, title: 'New global' },
  { profileId: 'local-a', id: 'a', scope: 'local', active: true, title: 'Existing local' },
  { profileId: 'local-b', id: 'b', scope: 'local', active: false, title: 'New local' },
];
const state = { revision: 'observed-revision', profiles, activeProfileIds: ['global-old', 'local-a'] };

test('checking a local recipe explicitly preserves other global and local profiles', async () => {
  const requests = [];
  const s = scene(async (path, options) => {
    requests.push({ path, ...(options?.body ? { input: JSON.parse(options.body) } : {}) });
    assert.ok(options.signal, 'all profile requests have a deadline');
    if (path === '/manage/api/resources') return response(state);
    if (path.endsWith('/preview')) return response({ reviewId: 'actual-review', review: { blocked: false } });
    return response({});
  });
  assert.equal(await s.view.switchProfile('local-b'), true);
  assert.deepEqual(requests[1].input, { profileId: 'local-b', replaceProfileIds: [], expectedRevision: state.revision });
  assert.deepEqual(requests[2].input, { reviewId: 'actual-review', accepted: true });
  assert.equal(s.refreshes, 1); assert.deepEqual(s.events, ['world-hub:resources-changed']);
  assert.ok(s.controls.every(control => !control.disabled));
});

test('global radio selection replaces only observed global profiles and uses the current revision', async () => {
  let preview;
  const s = scene(async (path, options) => {
    if (path === '/manage/api/resources') return response(state);
    if (path.endsWith('/preview')) { preview = JSON.parse(options.body); return response({ reviewId: 'actual', review: {} }); }
    return response({});
  });
  assert.equal(await s.view.switchProfile('global-new'), true);
  assert.deepEqual(preview.replaceProfileIds, ['global-old']);
  assert.equal(preview.expectedRevision, state.revision);
});

test('blocked or stopped-instance previews open the real review without applying or leaving optimistic checks', async () => {
  const writes = []; let shown;
  const s = scene(async (path, options) => {
    if (path === '/manage/api/resources') return response(state);
    writes.push(path); return response({ reviewId: 'review', review: { conflicts: [{ code: 'ACTIVE_CONFIGURATION_CONFLICT' }] } });
  });
  s.context.window.resourceConsole = { selectTab() {}, showReview: (...args) => { shown = args; } };
  assert.equal(await s.view.switchProfile('local-b'), false);
  assert.deepEqual(writes, ['/manage/api/resources/profiles/preview']);
  assert.equal(shown[0], 'configuration'); assert.equal(shown[1].reviewId, 'review'); assert.equal(s.refreshes, 1);
});

test('profile changes serialize pending operations and timeout does not resend a mutation', async () => {
  let release; let posts = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const s = scene(async path => {
    if (path === '/manage/api/resources') { await pending; return response(state); }
    posts++; throw new Error('Request timed out; current state must be checked');
  });
  const first = s.view.switchProfile('local-b');
  assert.ok(s.controls.every(control => control.disabled));
  assert.equal(await s.view.deactivateProfile('local-a'), false);
  release(); assert.equal(await first, false); assert.equal(posts, 1);
  assert.equal(s.view.profileOperationPending, false); assert.equal(s.refreshes, 1);
});

test('deactivation affects only selected active references and includes revision without changing runtime state', async () => {
  let input;
  const s = scene(async (path, options) => {
    if (path === '/manage/api/resources') return response(state);
    input = JSON.parse(options.body); return response({ changesRunningState: false });
  });
  assert.equal(await s.view.deactivateProfile('local-a'), true);
  assert.deepEqual(input, { profileIds: ['local-a'], accepted: true, expectedRevision: state.revision });
  assert.equal(s.refreshes, 1);
});

test('popover exposes dialog semantics and all new module/group descriptors use translation bindings', async () => {
  const html = await readFile(new URL('../../src/management/console.html', import.meta.url), 'utf8');
  assert.match(html, /id="hud-profile-switcher" aria-haspopup="dialog"[^>]*aria-controls="hud-profile-popover"/u);
  assert.match(source, /profileTrigger\.focus\(\)/u);
  const raised = /#detached-hud-group:has\(#hud-profile-switcher\[aria-expanded="true"\]\)\s*\{\s*z-index:\s*80;/u;
  assert.match(source, raised); assert.match(html, raised);
  assert.doesNotMatch(source, /descRow\.textContent = `[^`]*模块/u);
  assert.doesNotMatch(source, /Handle legacy select element/u);
});
