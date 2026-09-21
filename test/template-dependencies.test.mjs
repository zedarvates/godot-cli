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

test('caller can lower the unique-template closure budget without counting shared or cyclic references twice', async t => {
  const f = await fixture(t);
  await add(f, 'alpha', ['items:shared@1.0.0']);
  await add(f, 'beta', ['items:shared@1.0.0']);
  await add(f, 'shared', ['items:alpha@1.0.0']);
  f.doc.dependencies = ['items:alpha@1.0.0', 'items:beta@1.0.0'];
  await f.save();
  for (const maxTemplates of [1, 3, 4, 128]) {
    const r = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true, maxTemplates });
    assert.equal(r.complete, maxTemplates >= 4, JSON.stringify(r));
    assert.equal(r.valid, maxTemplates >= 4);
    assert.equal(r.consumerReady, false);
    if (maxTemplates < 4) {
      assert.equal(r.findings[0].code, 'TEMPLATE_CLOSURE_LIMIT');
      assert.equal(r.dependencyClosureChecked, false);
      assert.deepEqual(r.templateChecks, []);
    } else assert.equal(r.templateChecks.length, 4);
  }
  for (const maxTemplates of [3, 4]) {
    const cli = spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE,
      '--registry', f.root, '--with-dependencies', '--max-templates', String(maxTemplates)],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(cli.status, maxTemplates === 4 ? 0 : 1, cli.stdout + cli.stderr);
    assert.equal(JSON.parse(cli.stdout).complete, maxTemplates === 4);
  }
});

test('closure budget accepts a root-only closure and rejects invalid or inactive limits before reads', async t => {
  const f = await fixture(t);
  const rootOnly = await validateTemplate({ root: f.root, template: TEMPLATE, withDependencies: true, maxTemplates: 1 });
  assert.equal(rootOnly.valid, true);
  assert.equal(rootOnly.templateChecks.length, 1);
  for (const maxTemplates of [0, -1, 129, 1.5, NaN, Infinity, '2', null]) {
    const r = await validateTemplate({ root: 'missing-registry', template: TEMPLATE, withDependencies: true, maxTemplates });
    assert.equal(r.findings[0].code, 'TEMPLATE_LIMIT_INVALID');
    assert.equal(r.registryReadBudget, null);
  }
  for (const withDependencies of [undefined, false]) {
    const r = await validateTemplate({ root: 'missing-registry', template: TEMPLATE, withDependencies, maxTemplates: 1 });
    assert.equal(r.findings[0].code, 'TEMPLATE_OPTION_INVALID');
  }
  for (const args of [['--max-templates', '2'], ['--with-dependencies', '--max-templates', '129']]) {
    const cli = spawnSync(process.execPath, ['dist/cli.js', 'template', 'validate', TEMPLATE, '--registry', 'missing-registry', ...args],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(cli.status, 1);
    assert.match(JSON.parse(cli.stdout).findings[0].code, /^TEMPLATE_(OPTION|LIMIT)_INVALID$/);
  }
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
