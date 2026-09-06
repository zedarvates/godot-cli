import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, FAMILY, COMMON, digest, specDigest } from './helpers/template-validation-fixture.mjs';

const run = f => validateTemplate({ root: f.root, template: TEMPLATE });

test('validates actual common and family constraints without promoting Godot readiness', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, TEMPLATE));
  const r = await run(f);
  assert.equal(r.valid, true, JSON.stringify(r));
  assert.equal(r.complete, true);
  assert.equal(r.consumerReady, false);
  assert.equal(r.godotValidation, 'not_run');
  assert.equal(r.integrity.unchanged, true);
  assert.equal(r.integrity.files.length, 4);
  assert.deepEqual(await fs.readFile(path.join(f.root, TEMPLATE)), before);
  f.doc.spec.display_name = '';
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  const invalid = await run(f);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.complete, true);
  assert.equal(invalid.findings[0].code, 'TEMPLATE_SCHEMA_INVALID');
  assert.equal(invalid.findings[0].location, '/spec/display_name');
});

test('rejects unsupported schemas, unresolved refs, wrong family declarations and spec digests', async t => {
  for (const change of [
    f => { f.family.unknownConstraint = true; },
    f => { f.family.allOf.push({ $ref: 'https://example.invalid/schema' }); },
    f => { f.family.allOf.push({ $ref: '#/$defs/missing' }); },
    f => { f.family.$async = true; },
    f => { f.family.$vocabulary = { 'https://example.invalid/custom-vocabulary': true }; },
    f => { f.family.contentEncoding = 'base64'; },
    f => { f.doc.$schema = '../../../schemas/other/v1.0.0/schema.json'; },
    f => { f.doc.spec_checksum = 'sha256:' + '0'.repeat(64); },
    f => { f.doc.dependencies = ['items:missing@1.0.0']; },
    f => { f.doc.contract_version = '2.0.0'; },
  ]) {
    const f = await fixture(t);
    change(f); await f.save();
    assert.equal((await run(f)).valid, false);
  }
});

test('enforces date-time and rejects unknown formats instead of ignoring them', async t => {
  const f = await fixture(t);
  f.doc.compatibility = [{ consumer: 'zig-server-v2', version: '1.0.0', verified_at: '2026-99-01T00:00:00Z', evidence: 'test:proof' }];
  await f.save();
  assert.equal((await run(f)).findings[0].code, 'TEMPLATE_SCHEMA_INVALID');
  f.common.properties.compatibility.items.properties.verified_at.format = 'unsupported-format';
  await f.save();
  assert.equal((await run(f)).complete, false);
});

test('relative schema references resolve only to local catalogued schemas', async t => {
  const f = await fixture(t);
  f.family.type = 'object';
  f.family.allOf[0].$ref = '../../template-contract/v1.0.0/schema.json';
  await f.save();
  assert.equal((await run(f)).valid, true);
  f.family.allOf[0].$ref = '../../../../outside.json';
  await f.save();
  assert.equal((await run(f)).valid, false);
});

test('checks file hashes and rejects duplicate JSON keys even with updated file hash', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.root, TEMPLATE), '\n');
  assert.equal((await run(f)).valid, false);
  await f.save();
  const raw = (await fs.readFile(path.join(f.root, TEMPLATE), 'utf8')).replace('"display_name":"Test token"', '"display_name":"Other","display_name":"Test token"');
  await fs.writeFile(path.join(f.root, TEMPLATE), raw);
  f.catalog.entries[2].sha256 = digest(raw);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await run(f);
  assert.equal(r.valid, false);
  assert.match(r.findings[0].message, /Duplicate JSON key/);
});

test('rejects non-strict selection, traversal, symlinks and oversized template files', async t => {
  const f = await fixture(t);
  for (const template of [COMMON, FAMILY, '../outside.json', '/tmp/template.json', TEMPLATE.replace('/items/', '/items/../items/'), 'https://example.invalid/template.json']) {
    assert.equal((await validateTemplate({ root: f.root, template })).valid, false);
  }
  await fs.unlink(path.join(f.root, TEMPLATE));
  await fs.symlink(path.join(f.root, COMMON), path.join(f.root, TEMPLATE));
  assert.equal((await run(f)).valid, false);
  await fs.unlink(path.join(f.root, TEMPLATE));
  f.doc.spec.display_name = 'x'.repeat(270_000);
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  assert.equal((await run(f)).valid, false);
});

test('CLI returns JSON and nonzero status for invalid strict content', async t => {
  const f = await fixture(t);
  const command = () => spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE, '--registry', f.root], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  const valid = command();
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.equal(JSON.parse(valid.stdout).godotValidation, 'not_run');
  f.doc.spec.display_name = '';
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  const invalid = command();
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).valid, false);
});

test('worker budget and invalid limits fail closed with no ready claim', async t => {
  const f = await fixture(t);
  const timed = await validateTemplate({ root: f.root, template: TEMPLATE, timeoutMs: 1 });
  assert.equal(timed.findings[0].code, 'TEMPLATE_TIMEOUT');
  assert.equal(timed.complete, false);
  assert.equal(timed.consumerReady, false);
  for (const timeoutMs of [0, -1, 120001, NaN, Infinity, 1.5]) {
    const r = await validateTemplate({ root: f.root, template: TEMPLATE, timeoutMs });
    assert.equal(r.findings[0].code, 'TEMPLATE_LIMIT_INVALID');
  }
});

test('spec canonicalization preserves UTF-8 and rejects unproven numeric serialization', async t => {
  const f = await fixture(t);
  f.doc.spec.display_name = 'Épée 🗡️';
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  assert.equal((await run(f)).valid, true);
  f.doc.spec.display_name = 1.5;
  f.doc.spec_checksum = specDigest(f.doc.spec);
  await f.save();
  const r = await run(f);
  assert.equal(r.valid, false);
  assert.match(r.findings[0].message, /Numeric spec/);
});
