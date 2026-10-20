// Execute the production canvas renderer and filter against an SVG/DOM model.
// This verifies identity/layout decisions; it is not a browser screenshot test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../src/management/canvas-modes.mjs', import.meta.url), 'utf8');
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this._text = '';
    this.classes = new Set(); this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll() { return []; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.replaceChildren(); if (value.includes('value="all"')) { const option = new Element('option'); option.value = 'all'; this.append(option); } }
  get options() { return this.children; }
}
const flatten = element => [element, ...element.children.flatMap(flatten)];
function scene(groups, programs = ['a', 'b', 'c']) {
  const container = new Element('g'), filter = new Element('select'); filter.value = 'all';
  const elements = new Map([['group-containers-g', container], ['hud-group-filter', filter]]);
  const requests = [];
  const context = vm.createContext({ console, structuredClone, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    fetch: async (path, options) => { requests.push({ path, input: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
    window: {}, localStorage: { getItem: () => null } });
  vm.runInContext(source.slice(0, source.indexOf('// 自动初始化并挂载')).replace('export class CanvasModesController', 'class CanvasModesController') + '\nglobalThis.controller = new CanvasModesController();', context);
  const view = context.controller;
  view.data = { groups: structuredClone(groups), programs: programs.map(programId => ({ programId })) }; view.mode = 'static'; view.groupFilter = 'all';
  view.nodePositions = new Map(programs.map((id, index) => [id, { x: index * 400, y: 0 }]));
  const rendered = () => { view.renderGroupContainers(); return container.children; };
  return { view, container, filter, rendered, requests };
}
const group = (id, memberProgramIds, title = id, extra = {}) => ({ id, title, memberProgramIds, ...extra });
const headers = container => flatten(container).filter(node => node.attributes.class === 'cmn-group-header-bar');

test('identical complete membership renders one labeled group and one filter option without mutating server identities', () => {
  const groups = [group('text-desk', ['a', 'b', 'c'], 'Text desk'), group('configuration-94fda0da0000000000000000', ['c', 'a', 'b'], 'Evening recipe')];
  const { view, container, filter, rendered } = scene(groups);
  assert.equal(rendered().length, 1); assert.equal(headers(container).length, 1);
  assert.match(container.textContent, /Text desk/); assert.match(container.textContent, /Evening recipe/);
  view.updateGroupFilterOptions(); assert.equal(filter.children.length, 2);
  assert.doesNotMatch(filter.textContent, /94fda0da/);
  assert.equal(JSON.stringify(view.data.groups), JSON.stringify(groups));
  filter.value = 'text-desk'; view.updateGroupFilterOptions();
  assert.equal(view.filteredPrograms().length, 3); assert.notEqual(view.groupFilter, 'all');
});

test('active profile metadata labels the single original business group', () => {
  const { container, filter, view, rendered } = scene([group('desk', ['a'], 'Text desk', { activeProfiles: [{ title: 'Quiet setup', profileId: 'p1', ownsGroup: false }] })]);
  rendered(); view.updateGroupFilterOptions();
  assert.match(container.textContent, /Text desk · ⚡ Quiet setup/);
  assert.match(filter.textContent, /Text desk · ⚡ Quiet setup/);
});

test('derived profile metadata never becomes writable group input when saving plans or membership', async () => {
  const recipe = [{ title: 'Quiet setup', profileId: 'p1', ownsGroup: false }];
  const { view, requests } = scene([group('desk', ['a'], 'Text desk', { revision: 'r1', activeProfiles: recipe }), group('other', ['b'], 'Other desk', { revision: 'r2', activeProfiles: [] })]);
  view.fetchModulesData = async () => ({ refreshed: true });
  assert.equal(await view.saveActivePlan({ members: [{ programId: 'a', enabled: false, after: [] }] }, true, 'desk'), true);
  await view.assignModuleGroup('b', 'desk');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(row => !Object.hasOwn(row.input.group, 'activeProfiles')));
  assert.equal(JSON.stringify(view.data.groups[0].activeProfiles), JSON.stringify(recipe));
});

test('disjoint parallel instances preserve independent containers, filters and actions', () => {
  const { container, view, filter, rendered } = scene([group('one', ['a'], 'Desk one'), group('two', ['b'], 'Desk two')]);
  assert.equal(rendered().length, 2); view.updateGroupFilterOptions(); assert.equal(filter.children.length, 3);
  let selected; view.selectGroup = id => { selected = id; };
  headers(container)[1].listeners.click({ stopPropagation() {} }); assert.equal(selected, 'two');
});

test('partly overlapping distinct memberships retain both groups and get nonintersecting headers', () => {
  const { view, container, rendered } = scene([group('one', ['a', 'b']), group('two', ['a', 'c'])]);
  view.nodePositions.set('c', { x: 400, y: 0 });
  assert.equal(rendered().length, 2);
  const rectangles = headers(container).map(header => header.children.find(node => node.tagName === 'rect').attributes);
  assert.equal(rectangles[0].x, rectangles[1].x);
  const [first, second] = rectangles.map(rect => ({ y: Number(rect.y), height: Number(rect.height) }));
  assert.ok(second.y + second.height < first.y || first.y + first.height < second.y);
  assert.deepEqual(view.nodePositions.get('c'), { x: 400, y: 0 }, 'layout does not move cards to hide the defect');
});

test('a search projection that hides distinct members does not merge unrelated full groups', () => {
  const { view, rendered } = scene([group('one', ['a', 'b']), group('two', ['a', 'c'])]);
  view.filteredPrograms = () => [{ programId: 'a' }];
  assert.equal(rendered().length, 2);
});

test('automatic layout does not allocate a duplicate cluster or place shared members twice', () => {
  const original = group('desk', ['a', 'b'], 'Desk');
  const first = scene([original]), duplicate = scene([original, group('legacy', ['b', 'a'])]);
  first.view.layoutClustered(); duplicate.view.layoutClustered();
  assert.equal(JSON.stringify([...first.view.nodePositions]), JSON.stringify([...duplicate.view.nodePositions]));
  const withShared = scene([original, group('overlap', ['a', 'c'])]);
  withShared.view.layoutClustered();
  assert.equal(JSON.stringify(withShared.view.nodePositions.get('a')), JSON.stringify(first.view.nodePositions.get('a')));
  assert.equal(new Set([...withShared.view.nodePositions.values()].map(point => JSON.stringify(point))).size, 3);
});

test('merged aliases keep an explicitly selected identity available to management', () => {
  const { view, container, rendered } = scene([group('alpha', ['a']), group('beta', ['a'])]);
  view.selectedGroupId = 'beta'; rendered();
  assert.match(container.children[0].attributes.class, /selected/);
  let selected; view.selectGroup = id => { selected = id; };
  headers(container)[0].listeners.click({ stopPropagation() {} }); assert.equal(selected, 'beta');
});

test('long group names have a bounded title region and a complete tooltip, empty/orbit views stay empty', () => {
  const title = 'Very long user supplied title '.repeat(50);
  const { container, view, rendered } = scene([group('one', ['a'], title), group('configuration-user-name', [], 'Empty')]);
  rendered();
  const all = flatten(container), clip = all.find(node => node.tagName === 'clipPath');
  assert.ok(Number(clip.children[0].attributes.width) > 0);
  assert.ok(all.some(node => node.tagName === 'title' && node.textContent.includes(title)));
  assert.ok(all.some(node => node.tagName === 'text' && node.attributes['clip-path']));
  view.mode = 'runtime'; view.runtimePerspective = 'orbits'; assert.equal(rendered().length, 0);
});
