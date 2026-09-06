import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const COMMON = 'templates/schemas/template-contract/v1.0.0/schema.json';
export const FAMILY = 'templates/schemas/items/v1.0.0/schema.json';
export const TEMPLATE = 'templates/items/test-token/v1.0.0/template.json';
export const commonId = 'https://ultimateodycer.com/schemas/template-contract/1.0.0';
export const digest = v => createHash('sha256').update(v).digest('hex');
export const specDigest = spec => 'sha256:' + digest(JSON.stringify(spec, Object.keys(spec).sort()));

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uo-template-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const doc = { $schema: '../../../schemas/items/v1.0.0/schema.json', contract_version: '1.0.0',
    id: 'items:test-token', slug: 'test-token', family: 'items', version: '1.0.0',
    authority: 'declarative', intended_consumers: ['zig-server-v2'], compatibility: [], dependencies: [],
    spec_checksum: specDigest({ display_name: 'Test token' }), spec: { display_name: 'Test token' } };
  const common = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: commonId,
    type: 'object', required: Object.keys(doc), properties: Object.fromEntries(Object.keys(doc).map(k => [k, {}])),
    additionalProperties: false };
  common.properties.authority = { const: 'declarative' };
  common.properties.compatibility = { type: 'array', items: { type: 'object', properties: {
    verified_at: { type: 'string', format: 'date-time' } } } };
  const family = { $schema: common.$schema, $id: 'https://ultimateodycer.com/schemas/items/1.0.0',
    allOf: [{ $ref: commonId }, { properties: { spec: { type: 'object', required: ['display_name'],
      properties: { display_name: { type: 'string', minLength: 1 } }, additionalProperties: false } } }] };
  const catalog = { registry_version: '2.0.0', generated_at: '2026-09-06', source_set: 'fixture', entries: [], aliases: [] };
  for (const [file, name] of [[COMMON, 'template-contract'], [FAMILY, 'items']]) catalog.entries.push({
    name, kind: 'json-schema', version: '1.0.0', status: 'experimental', file,
    sha256: '', compatibility: [], validation_profile: 'strict-schema-v1', contract_version: '1.0.0' });
  catalog.entries.push({ name: doc.slug, kind: 'item-template', version: '1.0.0', status: 'experimental',
    file: TEMPLATE, sha256: '', compatibility: [], validation_profile: 'strict-v1', contract_version: '1.0.0',
    id: doc.id, slug: doc.slug, family: doc.family, schema_file: FAMILY, spec_checksum: doc.spec_checksum,
    intended_consumers: doc.intended_consumers, supersedes: [] });
  const values = new Map([[COMMON, common], [FAMILY, family], [TEMPLATE, doc]]);
  async function save() {
    catalog.entries[2].spec_checksum = doc.spec_checksum;
    catalog.entries[2].compatibility = doc.compatibility;
    for (const [resource, value] of values) {
      const bytes = JSON.stringify(value);
      await fs.mkdir(path.dirname(path.join(root, resource)), { recursive: true });
      await fs.writeFile(path.join(root, resource), bytes);
      catalog.entries.find(e => e.file === resource).sha256 = digest(bytes);
    }
    await fs.writeFile(path.join(root, 'templates/catalog.json'), JSON.stringify(catalog));
  }
  await save();
  return { root, doc, common, family, catalog, save };
}
