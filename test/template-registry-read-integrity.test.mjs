import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectTemplateRegistry } from '../dist/template-registry-inspection.js';
import { fixture, COMMON, digest } from './helpers/template-validation-fixture.mjs';

test('registry never hashes replacement bytes to certify a different parsed document', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, COMMON);
  const replacement = JSON.stringify({ ...f.common, type: 'number' });
  f.catalog.entries[0].sha256 = digest(replacement);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const originalReadFile = fs.readFile;
  const originalOpen = fs.open;
  let changed = false;
  const replace = async source => {
    if (!changed && path.resolve(String(source)) === path.resolve(file)) {
      changed = true;
      await fs.writeFile(file, replacement);
    }
  };
  // Exercise both the old readFile path and a bounded file-handle implementation.
  fs.readFile = async (...args) => {
    const bytes = await originalReadFile(...args);
    await replace(args[0]);
    return bytes;
  };
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      await replace(args[0]);
      return result;
    };
    return handle;
  };
  let report;
  try { report = await inspectTemplateRegistry({ root: f.root }); }
  finally { fs.readFile = originalReadFile; fs.open = originalOpen; }
  assert.equal(changed, true, 'The test must modify the resource during its read');
  assert.equal(report.integrityReady, false);
  assert.equal(report.contract.ready, false);
  assert.equal(report.consumerReady, false);
});

test('registry rejects invalid UTF-8 rather than silently replacing bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(f.common).replace('"type":"object"', '"title":"MARKER","type":"object"'));
  const index = bytes.indexOf('MARKER');
  bytes[index] = 0xff;
  await fs.writeFile(path.join(f.root, COMMON), bytes);
  f.catalog.entries[0].sha256 = digest(bytes);
  await fs.writeFile(path.join(f.root, 'templates/catalog.json'), JSON.stringify(f.catalog));
  const report = await inspectTemplateRegistry({ root: f.root });
  assert.equal(report.integrityReady, false);
  assert.equal(report.consumerReady, false);
});

test('short reads preserve UTF-8 and hash the complete bounded snapshot', async t => {
  const f = await fixture(t);
  f.common.title = 'Schéma 🧩';
  await f.save();
  const file = path.join(f.root, COMMON);
  const originalOpen = fs.open;
  let reads = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(file)) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => {
        reads++;
        return originalRead(buffer, offset, Math.min(length, 7), position);
      };
    }
    return handle;
  };
  let report;
  try { report = await inspectTemplateRegistry({ root: f.root }); }
  finally { fs.open = originalOpen; }
  assert.ok(reads > 1);
  assert.equal(report.integrityReady, true);
});

test('growth during a read stops at the initial size plus one byte', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, COMMON);
  const size = (await fs.stat(file)).size;
  const originalOpen = fs.open;
  let consumed = 0;
  let grew = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(file)) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        consumed += result.bytesRead;
        if (!grew) {
          grew = true;
          await fs.appendFile(file, Buffer.alloc(5 * 1024 * 1024, 32));
        }
        return result;
      };
    }
    return handle;
  };
  let report;
  try { report = await inspectTemplateRegistry({ root: f.root }); }
  finally { fs.open = originalOpen; }
  assert.equal(grew, true);
  assert.ok(consumed <= size + 1);
  assert.equal(report.integrityReady, false);
  assert.equal(report.consumerReady, false);
});
