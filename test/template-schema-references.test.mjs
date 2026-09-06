import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE } from './helpers/template-validation-fixture.mjs';

test('unused definitions reject missing and non-schema reference targets', async t => {
  for (const ref of ['#/$defs/missing', '#/title', '#/$defs/malformed~2pointer', '#/%ZZ', '#/examples/0', '#/default']) {
    const f = await fixture(t);
    f.family.title = 'Not a schema';
    f.family.examples = [{ type: 'object' }];
    f.family.default = { type: 'object' };
    f.family.$defs = { 'malformed~2pointer': true, unused: { $ref: ref } };
    await f.save();
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, false, ref);
    assert.equal(r.complete, false);
  }
});

test('unused local refs resolve escaped and encoded pointers to real schemas', async t => {
  for (const ref of ['#/$defs/a~1b', '#/$defs/a%7E1b', '#/$defs/disabled']) {
    const f = await fixture(t);
    f.family.$defs = { 'a/b': { type: 'string' }, disabled: false, unused: { $ref: ref } };
    await f.save();
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, true, `${ref}: ${JSON.stringify(r)}`);
    assert.equal(r.godotValidation, 'not_run');
  }
});

test('unused cross-file refs must resolve a fragment in the catalogued target', async t => {
  const f = await fixture(t);
  f.family.$defs = { unused: { $ref: '../../template-contract/v1.0.0/schema.json#/$defs/missing' } };
  await f.save();
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).valid, false);
  f.common.$defs = { missing: { type: 'string' } };
  await f.save();
  const r = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(r.valid, true, JSON.stringify(r));
});
