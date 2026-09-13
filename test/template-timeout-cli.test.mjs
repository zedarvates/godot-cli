import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fixture, TEMPLATE } from './helpers/template-validation-fixture.mjs';

function invoke(root, args = []) {
  const result = spawnSync(process.execPath,
    ['dist/cli.js', 'template', 'validate', TEMPLATE, '--registry', root, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test('CLI accepts a lower validation deadline and preserves default behavior', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--timeout-ms', '15000'], ['--timeout-ms', '120000', '--with-dependencies']]) {
    const { status, report } = invoke(f.root, args);
    assert.equal(status, 0, JSON.stringify(report));
    assert.equal(report.valid, true);
    assert.equal(report.complete, true);
    assert.equal(report.consumerReady, false);
    assert.equal(report.godotValidation, 'not_run');
    assert.equal(report.dependencyClosureChecked, args.includes('--with-dependencies'));
  }
});

test('CLI rejects invalid deadlines before inspecting the registry', () => {
  for (const value of ['0', '-1', '120001', '1.5', 'NaN', 'Infinity', 'invalid']) {
    const { status, report } = invoke('missing-registry', [`--timeout-ms=${value}`]);
    assert.equal(status, 1);
    assert.equal(report.findings[0].code, 'TEMPLATE_LIMIT_INVALID');
    assert.equal(report.complete, false);
    assert.equal(report.consumerReady, false);
    assert.equal(report.registryReadBudget, null);
  }
});

test('CLI deadline terminates validation without a partial readiness claim', async t => {
  const f = await fixture(t);
  for (const args of [[], ['--with-dependencies']]) {
    const { status, report } = invoke(f.root, ['--timeout-ms', '1', ...args]);
    assert.equal(status, 1);
    assert.equal(report.findings[0].code, 'TEMPLATE_TIMEOUT');
    assert.equal(report.valid, false);
    assert.equal(report.complete, false);
    assert.equal(report.consumerReady, false);
    assert.equal(report.godotValidation, 'not_run');
    assert.equal(report.dependencyClosureChecked, false);
    assert.deepEqual(report.templateChecks, []);
    assert.equal(report.integrity.unchanged, false);
  }
});
