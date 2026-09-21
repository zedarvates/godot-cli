import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, digest } from './helpers/template-validation-fixture.mjs';

test('diagnostic overflow is explicit, bounded and never reports readiness', async t => {
  const f = await fixture(t);
  f.catalog.entries.unshift(...Array.from({ length: 300 }, (_, i) => ({ name: `invalid-${i}` })));
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await inspectTemplateRegistry({ root: f.root });
  assert.equal(r.findings.length, 256);
  assert.equal(r.findings.filter(f => f.code === 'REGISTRY_FINDINGS_TRUNCATED').length, 1);
  assert.equal(r.findingCount, 300);
  assert.equal(r.findingsTruncated, true);
  assert.equal(r.complete, false);
  assert.equal(r.consumerReady, false);
});

test('long diagnostics are clipped and flagged instead of expanding the report', async t => {
  const f = await fixture(t);
  // Rejected before any filesystem access: this key is echoed by catalog validation.
  f.catalog.entries[2]['unknown-' + 'x'.repeat(8000)] = true;
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await inspectTemplateRegistry({ root: f.root });
  assert.ok(r.findings.every(f => f.message.length <= 1024 && f.location.length <= 512),
    `Longest message: ${Math.max(...r.findings.map(f => f.message.length))} characters`);
  assert.equal(r.findingsTruncated, true);
  assert.ok(r.findings.some(f => f.code === 'REGISTRY_FINDINGS_TRUNCATED'));
  assert.equal(r.complete, false);
});

test('small and exact-cap diagnostics retain their full count without a marker', async t => {
  const f = await fixture(t);
  for (const count of [0, 1, 256]) {
    const catalog = { ...f.catalog, entries: [...Array.from({ length: count }, () => ({})), ...f.catalog.entries] };
    await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(catalog));
    const r = await inspectTemplateRegistry({ root: f.root });
    assert.equal(r.findingCount, count);
    assert.equal(r.findingsTruncated, false);
    assert.equal(r.findings.length, count);
    assert.equal(r.complete, count === 0);
  }
});

test('long referenced resource locations are bounded as well as messages', async t => {
  const f = await fixture(t);
  const resource = 'templates/schemas/' + ('segment'.repeat(12) + '/').repeat(7) + 'schema.json';
  const bytes = '{}';
  await fs.mkdir(path.dirname(path.join(f.root, resource)), { recursive: true });
  await fs.writeFile(path.join(f.root, resource), bytes);
  f.catalog.entries.push({ name: 'invalid-schema-path', kind: 'json-schema', version: '1.0.0',
    status: 'experimental', file: resource, sha256: digest(bytes), compatibility: [],
    validation_profile: 'strict-schema-v1', contract_version: '1.0.0' });
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await inspectTemplateRegistry({ root: f.root });
  assert.equal(r.findingsTruncated, true);
  assert.equal(r.findings.find(f => f.code === 'REGISTRY_SCHEMA_INVALID').location.length, 512);
  assert.ok(r.findings.every(f => f.location.length <= 512));
});

test('omitted checksum diagnostics still inform subsequent contract checks', async t => {
  const f = await fixture(t);
  f.catalog.entries[0].sha256 = '0'.repeat(64);
  f.catalog.entries.unshift(...Array.from({ length: 300 }, () => ({})));
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const r = await inspectTemplateRegistry({ root: f.root });
  assert.equal(r.findingCount, 301);
  assert.equal(r.findingsTruncated, true);
  assert.equal(r.contract.ready, false);
});
