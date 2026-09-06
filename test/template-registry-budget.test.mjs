import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, COMMON } from './helpers/template-validation-fixture.mjs';

test('rejected file bytes consume the inspection read budget', async t => {
  const f = await fixture(t);
  const bytes = (await fs.stat(path.join(f.root, COMMON))).size;
  f.catalog.entries[0].sha256 = '0'.repeat(64);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await inspectTemplateRegistry({ root: f.root, maxReadBytes: bytes });
  assert.ok(r.findings.some(f => f.code === 'REGISTRY_LIMIT_EXCEEDED'));
  assert.equal(r.catalog.verifiedFiles, 0);
  assert.equal(r.readBudget.consumedBytes, bytes);
  assert.equal(r.readBudget.exhausted, true);
  assert.equal(r.consumerReady, false);
});

test('exact budget succeeds while an insufficient budget fails before the next read', async t => {
  const f = await fixture(t);
  let bytes = 0;
  for (const entry of f.catalog.entries) bytes += (await fs.stat(path.join(f.root, entry.file))).size;
  const exact = await inspectTemplateRegistry({ root: f.root, maxReadBytes: bytes });
  assert.equal(exact.complete, true);
  assert.equal(exact.readBudget.consumedBytes, bytes);
  assert.equal(exact.readBudget.exhausted, false);
  const short = await inspectTemplateRegistry({ root: f.root, maxReadBytes: bytes - 1 });
  assert.equal(short.complete, false);
  assert.ok(short.readBudget.consumedBytes <= bytes - 1);
});

test('malformed JSON also consumes bytes before being rejected', async t => {
  const f = await fixture(t);
  const bytes = (await fs.stat(path.join(f.root, COMMON))).size;
  await fs.writeFile(path.join(f.root, COMMON), '{' + ' '.repeat(bytes - 1));
  const r = await inspectTemplateRegistry({ root: f.root, maxReadBytes: bytes });
  assert.equal(r.readBudget.consumedBytes, bytes);
  assert.equal(r.readBudget.exhausted, true);
  assert.equal(r.catalog.verifiedFiles, 0);
});

test('invalid budget limits fail before accessing a registry and CLI preserves failure status', async t => {
  for (const maxReadBytes of [0, -1, 1.5, Infinity, NaN, 512 * 1024 * 1024 + 1]) {
    await assert.rejects(inspectTemplateRegistry({ root: 'missing', maxReadBytes }), /maxReadBytes/);
  }
  const f = await fixture(t);
  const r = spawnSync(process.execPath, ['dist/cli.js', 'template', 'registry', 'inspect', f.root, '--max-read-bytes', '1'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).readBudget.exhausted, true);
});
