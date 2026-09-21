import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, COMMON, digest } from './helpers/template-validation-fixture.mjs';

test('template validation forwards an exact registry read budget and reports exhaustion', async t => {
  const f = await fixture(t);
  let bytes = 0;
  for (const e of f.catalog.entries) bytes += (await fs.stat(path.join(f.root, e.file))).size;
  const pin = digest(await fs.readFile(path.join(f.root, 'templates/catalog.json')));
  const exact = await validateTemplate({ root: f.root, template: TEMPLATE, registryMaxReadBytes: bytes, expectedCatalogSha256: pin });
  assert.equal(exact.valid, true, JSON.stringify(exact));
  assert.equal(exact.catalogPinVerified, true);
  assert.deepEqual(exact.registryReadBudget, { limitBytes: bytes, consumedBytes: bytes, exhausted: false });
  const short = await validateTemplate({ root: f.root, template: TEMPLATE, registryMaxReadBytes: bytes - 1 });
  assert.equal(short.valid, false);
  assert.equal(short.complete, false);
  assert.equal(short.registryReadBudget.exhausted, true);
  assert.ok(short.registryReadBudget.consumedBytes <= bytes - 1);
  assert.equal(short.consumerReady, false);
});

test('rejected resources consume the forwarded budget and invalid limits fail before worker startup', async t => {
  const f = await fixture(t);
  const bytes = (await fs.stat(path.join(f.root, COMMON))).size;
  f.catalog.entries[0].sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const bad = await validateTemplate({ root: f.root, template: TEMPLATE, registryMaxReadBytes: bytes });
  assert.equal(bad.registryReadBudget.consumedBytes, bytes);
  assert.equal(bad.registryReadBudget.exhausted, true);
  for (const registryMaxReadBytes of [0, -1, 0.5, NaN, Infinity, 536870913]) {
    const r = await validateTemplate({ root: 'missing', template: TEMPLATE, registryMaxReadBytes });
    assert.equal(r.findings[0].code, 'TEMPLATE_LIMIT_INVALID');
    assert.match(r.findings[0].message, /registryMaxReadBytes/);
    assert.equal(r.registryReadBudget, null);
  }
});

test('CLI reports a registry budget failure with a nonzero exit status', async t => {
  const f = await fixture(t);
  const r = spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE, '--registry', f.root,
    '--registry-max-read-bytes', '1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.registryReadBudget.exhausted, true);
  assert.equal(report.registryReadBudget.consumedBytes, 0);
});
