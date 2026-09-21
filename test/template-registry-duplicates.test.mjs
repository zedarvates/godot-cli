import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, COMMON, digest } from './helpers/template-validation-fixture.mjs';

test('registry rejects duplicate catalogue keys rather than accepting the last value', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'templates/catalog.json');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('"registry_version":"2.0.0"', '"registry_version":"bad","registry_version":"2.0.0"'));
  await assert.rejects(inspectTemplateRegistry({ root: f.root }), /Duplicate JSON key/);
});

test('registry rejects nested and escaped duplicate keys even with a matching checksum', async t => {
  for (const properties of ['"type":"number","type":"object"', '"type":"number","ty\\u0070e":"object"']) {
    const f = await fixture(t);
    const text = JSON.stringify(f.common).replace('"type":"object"', properties);
    await fs.writeFile(path.join(f.root, COMMON), text);
    f.catalog.entries[0].sha256 = digest(text);
    await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
    const report = await inspectTemplateRegistry({ root: f.root });
    assert.equal(report.integrityReady, false);
    assert.equal(report.consumerReady, false);
    assert.ok(report.findings.some(f => /Duplicate JSON key/.test(f.message)));
  }
});

test('same key in separate objects and punctuation inside strings remain valid', async t => {
  const f = await fixture(t);
  f.common.examples = [{ text: '}, "x": 1, "x": 2 {' }, { text: '[]: and \\" quotes' }];
  await f.save();
  const report = await inspectTemplateRegistry({ root: f.root });
  assert.equal(report.integrityReady, true, JSON.stringify(report));
});

test('duplicates nested in annotation arrays are rejected', async t => {
  const f = await fixture(t);
  f.common.examples = [{ sample: 1 }];
  const bytes = JSON.stringify(f.common).replace('"sample":1', '"sample":1,"sample":2');
  await fs.writeFile(path.join(f.root, COMMON), bytes);
  f.catalog.entries[0].sha256 = digest(bytes);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const report = await inspectTemplateRegistry({ root: f.root });
  assert.equal(report.integrityReady, false);
  assert.ok(report.findings.some(f => /Duplicate JSON key/.test(f.message)));
});
