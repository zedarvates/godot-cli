import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE } from './helpers/template-validation-fixture.mjs';

test('unused schema definitions cannot hide unsupported keywords or formats', async t => {
  for (const unused of [
    { unsupportedConstraint: true },
    { toString: true },
    { type: 'string', format: 'unsupported-format' },
    { properties: { title: { unknownValidation: true } } },
    { dependencies: { field: { unknownValidation: true } } },
  ]) {
    const f = await fixture(t);
    f.family.$defs = { unused };
    await f.save();
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, false, JSON.stringify(unused));
    assert.equal(r.complete, false);
    assert.match(r.findings[0].message, /Unsupported schema (keyword|format)/);
  }
});

test('annotation and const data are not interpreted as schema keywords', async t => {
  const f = await fixture(t);
  f.family.examples = [{ unsupportedConstraint: true, format: 'unsupported-format' }];
  f.family.default = { unsupportedConstraint: true, format: 'unsupported-format' };
  f.family.$defs = { unused: { const: { unsupportedConstraint: true, format: 'unsupported-format' } } };
  await f.save();
  const r = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('boolean schemas count toward the traversal budget', async t => {
  const f = await fixture(t);
  f.family.$defs = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`definition${i}`, true]));
  await f.save();
  const r = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(r.valid, false);
  assert.equal(r.complete, false);
  assert.match(r.findings[0].message, /Schema node limit exceeded/);
});
