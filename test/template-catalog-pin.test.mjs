import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, digest } from './helpers/template-validation-fixture.mjs';

test('catalog pin accepts both hex cases and does not promote readiness', async t => {
  const f = await fixture(t);
  const expected = digest(await fs.readFile(path.join(f.root, 'templates/catalog.json')));
  for (const pin of [expected, expected.toUpperCase()]) {
    const r = await inspectTemplateRegistry({ root: f.root, expectedCatalogSha256: pin });
    assert.equal(r.catalog.pinVerified, true);
    assert.equal(r.consumerReady, false);
  }
  const unpinned = await inspectTemplateRegistry({ root: f.root });
  assert.equal(unpinned.catalog.pinVerified, false);
  const limited = await inspectTemplateRegistry({ root: f.root, expectedCatalogSha256: expected, maxReadBytes: 1 });
  assert.equal(limited.catalog.pinVerified, true);
  assert.equal(limited.complete, false);
});

test('catalog pin mismatch stops before any referenced file is opened', async t => {
  const f = await fixture(t);
  const original = fs.open;
  const opened = [];
  fs.open = async (...args) => { opened.push(path.resolve(String(args[0]))); return original(...args); };
  try {
    await assert.rejects(inspectTemplateRegistry({ root: f.root, expectedCatalogSha256: '0'.repeat(64) }), /does not match expected digest/);
  } finally { fs.open = original; }
  assert.deepEqual(opened, [path.resolve(f.root, 'templates/catalog.json')]);
});

test('invalid pins fail before filesystem access and CLI rejects catalog drift', async t => {
  for (const pin of ['', '0'.repeat(63), 'g'.repeat(64), '0'.repeat(65), ' ' + '0'.repeat(64)]) {
    await assert.rejects(inspectTemplateRegistry({ root: 'missing', expectedCatalogSha256: pin }), /expectedCatalogSha256/);
  }
  const f = await fixture(t);
  const file = path.join(f.root, 'templates/catalog.json');
  const expected = digest(await fs.readFile(file));
  const command = () => spawnSync(process.execPath, ['dist/cli.js', 'template', 'registry', 'inspect', f.root,
    '--expected-catalog-sha256', expected], { encoding: 'utf8', windowsHide: true });
  const good = command();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).catalog.pinVerified, true);
  await fs.appendFile(file, '\n');
  const changed = command();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /does not match expected digest/);
});
