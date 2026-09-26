import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { test } from 'node:test';
const root = new URL('../../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
test('CLI removes exporter package and bootstrap integration', async () => {
  await assert.rejects(access(new URL('apps/acode-cli/packages/telemetry/package.json', root)));
  const manifest = JSON.parse(await read('apps/acode-cli/packages/bootstrap/package.json'));
  assert.equal(manifest.dependencies['@acode/telemetry'], undefined);
  for (const file of ['app/create-app.ts', 'index.ts', 'acode-protocol-entrypoint.ts', 'acode-protocol/runtime-cleanup.ts']) {
    assert.doesNotMatch(await read(`apps/acode-cli/packages/bootstrap/src/${file}`), /@acode\/telemetry|prepareACodeTelemetryEnv|shutdownACodeTelemetry|createModelTelemetry/);
  }
});
test('Host no longer supplies telemetry identity or OTLP environment', async () => {
  assert.doesNotMatch(await read('packages/services/src/node.ts'), /buildAgentTelemetrySpawnEnv|getCapturedACodeAgentTelemetryEnv|createTelemetryCore|createTelemetryAuthorizationLoader/);
});
test('legacy telemetry credentials are discarded without retaining a capture API', async () => {
  const runtimeEnv = await import('../../../packages/shared/src/runtimeEnv.ts');
  const source = {
    PATH: '/test/bin',
    ACODE_HTTP_PROXY: 'http://localhost:8080',
    OTEL_EXPORTER_OTLP_HEADERS: 'synthetic-secret',
    ACODE_TELEMETRY_DEVICE_MID: 'synthetic-device',
  };
  const cleaned = runtimeEnv.sanitizeACodeRuntimeEnv(source);
  assert.equal(cleaned.PATH, source.PATH);
  assert.equal(cleaned.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(cleaned.ACODE_TELEMETRY_DEVICE_MID, undefined);
  assert.equal(runtimeEnv.getCapturedACodeAgentTelemetryEnv, undefined);
  runtimeEnv.sanitizeACodeRuntimeEnvInPlace(source);
  assert.equal(source.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(source.PATH, '/test/bin');
});
test('TTFT recorder and standalone protocol notification are removed', async () => {
  await assert.rejects(access(new URL('apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/local-ttft.ts', root)));
  assert.doesNotMatch(await read('packages/shared/src/acode-protocol-v4/transport.ts'), /v4\/telemetry\/local-ttft/);
  assert.doesNotMatch(await read('apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/v4-gateway.ts'), /LocalTtftRecorder|emitLocalTtftFacts/);
});
