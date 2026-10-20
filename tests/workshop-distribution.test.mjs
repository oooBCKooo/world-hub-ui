import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('community UI offers the three independent resource kinds without retired pack selectors', async () => {
  const source = await readFile(new URL('../tools/workshop/public/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /!\['module',\s*'configuration',\s*'data'\]\.includes\(artifact\.kind\)/);
  assert.match(source, /configuration\.json/);
  assert.doesNotMatch(source, /\['pack',t\('pack'\)\]|\['template',t\('template'\)\]/);
});
