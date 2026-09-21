import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateTemplate } from '../dist/template-validation.js';
import { fixture, TEMPLATE, digest } from './helpers/template-validation-fixture.mjs';

const vectors = [
  ['{"value":0}', '{"value":0}'],
  ['{"value":-0}', '{"value":0}'],
  ['{"value":42}', '{"value":42}'],
  ['{"value":-42}', '{"value":-42}'],
  ['{"value":9007199254740991}', '{"value":9007199254740991}'],
  ['{"value":-9007199254740991}', '{"value":-9007199254740991}'],
  ['{"value":[2,-3,{"z":0,"a":4}]}', '{"value":[2,-3,{"a":4,"z":0}]}'],
  ['{"value":{"10":10,"2":2,"1":1}}', '{"value":{"1":1,"10":10,"2":2}}'],
  ['{"value":"1.0 1e400 -0.0"}', '{"value":"1.0 1e400 -0.0"}'],
];

async function writeSpec(f, raw, canonical) {
  f.doc.spec = JSON.parse(raw);
  f.doc.spec_checksum = 'sha256:' + digest(canonical);
  f.family.allOf[1].properties.spec = {
    type: 'object', required: ['value'], properties: { value: {} }, additionalProperties: false,
  };
  await f.save();
  // Preserve source numeric syntax: JSON.stringify would turn 1.0 into 1.
  const bytes = JSON.stringify({ ...f.doc, spec: 'RAW_SPEC' }).replace('"RAW_SPEC"', raw);
  await fs.writeFile(path.join(f.root, TEMPLATE), bytes);
  f.catalog.entries[2].sha256 = digest(bytes);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  return bytes;
}

test('exact integer checksum vectors validate and preserve original bytes', async t => {
  const f = await fixture(t);
  for (const [raw, canonical] of vectors) {
    const bytes = await writeSpec(f, raw, canonical);
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, true, `${raw}: ${JSON.stringify(r)}`);
    assert.equal(r.integrity.unchanged, true);
    assert.equal(r.consumerReady, false);
    assert.equal(r.godotValidation, 'not_run');
    assert.equal(await fs.readFile(path.join(f.root, TEMPLATE), 'utf8'), bytes);
  }
});

test('rounded integers and float syntax cannot masquerade as canonical integers', async t => {
  const f = await fixture(t);
  for (const token of ['9007199254740992', '9007199254740993', '-9007199254740993',
    '1.0', '1e0', '1E+0', '-0.0', '0.1', '1e-400']) {
    // Deliberately use the post-parse JS digest: an unsafe implementation would
    // accept it after erasing the original numeric syntax or precision.
    const raw = `{"value":${token}}`;
    await writeSpec(f, raw, JSON.stringify(JSON.parse(raw)));
    const r = await validateTemplate({ root: f.root, template: TEMPLATE });
    assert.equal(r.valid, false, token);
    assert.equal(r.complete, false, token);
    assert.match(r.findings[0].message, /safe integer tokens/, token);
  }
});

test('integer support still enforces schema limits and checksum integrity', async t => {
  const f = await fixture(t);
  await writeSpec(f, '{"value":42}', '{"value":42}');
  f.family.allOf[1].properties.spec.properties.value = { type: 'integer', maximum: 41 };
  await f.save();
  const invalid = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.equal(invalid.findings[0].code, 'TEMPLATE_SCHEMA_INVALID');
  await writeSpec(f, '{"value":42}', '{"value":43}');
  const checksum = await validateTemplate({ root: f.root, template: TEMPLATE });
  assert.match(checksum.findings[0].message, /Spec checksum mismatch/);
});

test('integer vectors match Python canonical JSON and optional registry serializer', t => {
  const probe = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') { t.skip('Python is not installed; fixed vectors still run'); return; }
  assert.equal(probe.status, 0);
  const script = `import sys,json,hashlib
root=sys.argv[1]
if root:
    sys.path.insert(0,root)
    from scripts.template_contract import canonical_json_bytes,decode_json_bytes
else:
    def decode_json_bytes(b): return json.loads(b.decode('utf-8'))
    def canonical_json_bytes(v): return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
print(json.dumps([{'text':canonical_json_bytes(decode_json_bytes(s.encode('utf-8'))).decode('utf-8'),'sha256':hashlib.sha256(canonical_json_bytes(decode_json_bytes(s.encode('utf-8')))).hexdigest()} for s in json.load(sys.stdin)],ensure_ascii=False))`;
  const result = spawnSync('python', ['-c', script, process.env.UO_TEMPLATE_REGISTRY_ROOT ?? ''], {
    input: JSON.stringify(vectors.map(([raw]) => raw)), encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), vectors.map(([, canonical]) => ({ text: canonical, sha256: digest(canonical) })));
});
