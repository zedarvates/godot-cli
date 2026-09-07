import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, digest, specDigest } from './helpers/template-validation-fixture.mjs';

async function add(f, slug, dependencies = [], displayName = slug) {
  const resource = `templates/items/${slug}/v1.0.0/template.json`;
  const spec = { display_name: displayName };
  const doc = { ...f.doc, id: `items:${slug}`, slug, dependencies, spec, spec_checksum: specDigest(spec) };
  const bytes = JSON.stringify(doc);
  await fs.mkdir(path.dirname(path.join(f.root, resource)), { recursive: true });
  await fs.writeFile(path.join(f.root, resource), bytes);
  f.catalog.entries.push({ ...f.catalog.entries[2], id: doc.id, slug, name: slug,
    file: resource, spec_checksum: doc.spec_checksum, sha256: digest(bytes) });
  return resource;
}

test('dependency schema rejection is opt-in and cannot promote readiness', async t => {
  const f = await fixture(t);
  const dependency = await add(f, 'broken', [], '');
  f.doc.dependencies = ['items:broken@1.0.0'];
  await f.save();
  const before = await fs.readFile(path.join(f.root, dependency));
  const single = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(single.valid, true);
  const closure = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
  assert.equal(closure.valid, false);
  assert.equal(closure.complete, true);
  assert.equal(closure.dependencyClosureChecked, true);
  assert.deepEqual(closure.templateChecks, [{ resource: TEMPLATE, valid: true }, { resource: dependency, valid: false }]);
  assert.equal(closure.findings[0].resource, dependency);
  assert.equal(closure.consumerReady, false);
  assert.equal(closure.godotValidation, 'not_run');
  assert.deepEqual(await fs.readFile(path.join(f.root, dependency)), before);
});

test('transitive, shared and cyclic dependencies are checked exactly once', async t => {
  const f = await fixture(t);
  const a = await add(f, 'alpha', ['items:shared@1.0.0']);
  const b = await add(f, 'beta', ['items:shared@1.0.0']);
  const c = await add(f, 'shared', ['items:alpha@1.0.0']);
  f.doc.dependencies = ['items:alpha@1.0.0', 'items:beta@1.0.0'];
  await f.save();
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
  assert.equal(r.valid, true, JSON.stringify(r));
  assert.equal(r.dependencyClosureChecked, true);
  assert.deepEqual(r.templateChecks.map(t => t.resource), [TEMPLATE, a, b, c]);
  assert.equal(new Set(r.integrity.files.map(f => f.resource)).size, r.integrity.files.length);
  const cli = spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE, '--registry', f.root, '--with-dependencies'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).templateChecks.length, 4);
});

test('dependency traversal fails closed at 128 templates including the root', async t => {
  for (const count of [127, 128]) {
    const f = await fixture(t);
    for (let i = 0; i < count; i++) await add(f, `node-${i}`, i < count - 1 ? [`items:node-${i + 1}@1.0.0`] : []);
    f.doc.dependencies = ['items:node-0@1.0.0'];
    await f.save();
    const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
    assert.equal(r.valid, count === 127, JSON.stringify(r));
    assert.equal(r.complete, count === 127);
    assert.equal(r.dependencyClosureChecked, count === 127);
    if (count === 128) assert.match(r.findings[0].message, /128.*template|template.*128/i);
    else assert.equal(r.templateChecks.length, 128);
  }
});

test('root compatibility cannot promote an incompatible dependency closure', async t => {
  const f = await fixture(t);
  await add(f, 'dependency');
  f.doc.dependencies = ['items:dependency@1.0.0'];
  f.doc.compatibility = [{ consumer: 'godot-vr', version: '4.7', verified_at: '2026-09-07T00:00:00Z', evidence: 'fixture:root' }];
  await f.save();
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).consumerReady, true);
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
  assert.equal(r.valid, true);
  assert.equal(r.consumerReady, false);
  assert.equal(r.godotValidation, 'not_run');
});

test('dependency mode rejects invalid option types and unsupported numeric dependency specs', async t => {
  const invalidOption = await validateTemplate({ root: 'missing', template: TEMPLATE, withDependencies: 'yes' });
  assert.equal(invalidOption.findings[0].code, 'TEMPLATE_OPTION_INVALID');
  const f = await fixture(t);
  await add(f, 'float-spec', [], 1.5);
  f.doc.dependencies = ['items:float-spec@1.0.0'];
  await f.save();
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).valid, true);
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
  assert.equal(r.complete, false);
  assert.match(r.findings[0].message, /safe integer tokens/);
});

test('each dependency spec checksum is recomputed independently of its file hash', async t => {
  const f = await fixture(t);
  const resource = await add(f, 'bad-digest');
  const doc = JSON.parse(await fs.readFile(path.join(f.root, resource), 'utf8'));
  doc.spec_checksum = 'sha256:' + '0'.repeat(64);
  const bytes = JSON.stringify(doc);
  await fs.writeFile(path.join(f.root, resource), bytes);
  const entry = f.catalog.entries.find(e => e.file === resource);
  entry.spec_checksum = doc.spec_checksum;
  entry.sha256 = digest(bytes);
  f.doc.dependencies = ['items:bad-digest@1.0.0'];
  await f.save();
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).valid, true);
  const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true });
  assert.equal(r.valid, false);
  assert.equal(r.complete, false);
  assert.match(r.findings[0].message, /Spec checksum mismatch/);
});
