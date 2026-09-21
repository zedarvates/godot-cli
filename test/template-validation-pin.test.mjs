import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, COMMON, digest, specDigest } from './helpers/template-validation-fixture.mjs';

test('pinned validation accepts both hex cases while preserving readiness boundaries', async t => {
  const f = await fixture(t);
  const pin = digest(await fs.readFile(path.join(f.root, 'templates/catalog.json')));
  for (const expectedCatalogSha256 of [pin, pin.toUpperCase()]) {
    const r = await validateTemplate({ root: f.root, template: TEMPLATE, expectedCatalogSha256 });
    assert.equal(r.valid, true, JSON.stringify(r));
    assert.equal(r.catalogPinVerified, true);
    assert.equal(r.consumerReady, false);
    assert.equal(r.godotValidation, 'not_run');
    assert.equal(r.integrity.files.find(f => f.resource === 'templates/catalog.json').sha256, pin);
  }
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).catalogPinVerified, false);
});

test('wrong pin wins before referenced-file inspection and invalid pins need no filesystem', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, COMMON));
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, expectedCatalogSha256: '0'.repeat(64) });
  assert.equal(r.findings[0].code, 'TEMPLATE_CATALOG_MISMATCH');
  assert.equal(r.catalogPinVerified, false);
  assert.equal(r.complete, false);
  for (const expectedCatalogSha256 of ['', 'g'.repeat(64), '0'.repeat(63)]) {
    const invalid = await validateTemplate({ root: 'missing', template: TEMPLATE, expectedCatalogSha256 });
    assert.equal(invalid.findings[0].code, 'TEMPLATE_CATALOG_PIN_INVALID');
  }
});

test('matching catalog pin cannot override a schema rejection', async t => {
  const f = await fixture(t);
  f.doc.spec.display_name = '';
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  const pin = digest(await fs.readFile(path.join(f.root, 'templates/catalog.json')));
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, expectedCatalogSha256: pin });
  assert.equal(r.catalogPinVerified, true);
  assert.equal(r.valid, false);
  assert.equal(r.complete, true);
  assert.equal(r.consumerReady, false);
});

test('CLI forwards the pin and refuses formatting drift', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'templates/catalog.json');
  const pin = digest(await fs.readFile(file));
  const command = () => spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE,
    '--registry', f.root, '--expected-catalog-sha256', pin], { encoding: 'utf8', windowsHide: true });
  const good = command();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).catalogPinVerified, true);
  await fs.appendFile(file, '\n');
  const changed = command();
  assert.equal(changed.status, 1);
  assert.equal(JSON.parse(changed.stdout).findings[0].code, 'TEMPLATE_CATALOG_MISMATCH');
});
