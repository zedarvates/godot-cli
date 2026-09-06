import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, digest } from './helpers/template-validation-fixture.mjs';

test('catalog fingerprint identifies exact source bytes, independently of readiness', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'templates/catalog.json');
  const original = await fs.readFile(file);
  const first = await inspectTemplateRegistry({ root: f.root });
  assert.equal(first.catalog.sha256, digest(original));
  assert.equal(first.catalog.bytes, original.length);
  assert.equal(first.consumerReady, false);

  const reformatted = JSON.stringify(JSON.parse(original), null, 2) + '\n';
  await fs.writeFile(file, reformatted);
  const second = await inspectTemplateRegistry({ root: f.root });
  assert.equal(second.catalog.sha256, digest(reformatted));
  assert.notEqual(second.catalog.sha256, first.catalog.sha256);
  assert.equal(second.catalog.bytes, Buffer.byteLength(reformatted));
  assert.deepEqual(second.profiles, first.profiles);
  assert.deepEqual(second.readBudget, first.readBudget);

  const incomplete = await inspectTemplateRegistry({ root: f.root, maxReadBytes: 1 });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.catalog.sha256, second.catalog.sha256);
  assert.equal(incomplete.catalog.bytes, second.catalog.bytes);
});
