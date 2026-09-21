import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, FAMILY, digest, specDigest } from './helpers/template-validation-fixture.mjs';

test('schema numeric tokens must not silently round before validation', async t => {
  for (const token of ['0.99999999999999999', '1e-400', '9007199254740993', '1.0', '1e0']) {
    const f = await fixture(t);
    f.doc.spec.display_name = token === '0.99999999999999999' ? 1 : 0;
    f.doc.spec_checksum = specDigest(f.doc.spec);
    f.family.allOf[1].properties.spec.properties.display_name = { type: 'integer', maximum: 'RAW_LIMIT' };
    await f.save();
    const raw = JSON.stringify(f.family).replace('"RAW_LIMIT"', token);
    await fs.writeFile(path.join(f.root, FAMILY), raw);
    f.catalog.entries.find(e => e.file === FAMILY).sha256 = digest(raw);
    await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, false, `${token}: ${JSON.stringify(r)}`);
    assert.equal(r.complete, false);
    assert.match(r.findings[0].message, /Schema numbers require safe integer tokens/);
  }
});

test('exact schema integer bounds still accept and reject at their boundary', async t => {
  const f = await fixture(t);
  f.doc.spec.display_name = 42;
  f.doc.spec_checksum = specDigest(f.doc.spec);
  f.family.allOf[1].properties.spec.properties.display_name = { type: 'integer', minimum: 42, maximum: 42 };
  await f.save();
  assert.equal((await validateTemplate({ root: f.root, template: TEMPLATE })).valid, true);
  f.family.allOf[1].properties.spec.properties.display_name.maximum = 41;
  await f.save();
  const r = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(r.valid, false);
  assert.equal(r.complete, true);
  assert.equal(r.findings[0].code, 'TEMPLATE_SCHEMA_INVALID');
});
