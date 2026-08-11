import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packReleasePackage,
  packedArtifactFailures,
  packageStaticFailures,
  readManifest,
  releasePackageDefinitions,
} from './verify-packages.mjs';
import { releaseReadinessFailures } from './verify-release.mjs';
import { validateReleaseEvidenceDossier } from './assemble-release-evidence.mjs';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function installedDependencyVersion(packagePath, dependency) {
  const require = createRequire(resolve(workspaceRoot, packagePath));
  let current;
  try {
    const manifest = require(`${dependency}/package.json`);
    if (manifest.name === dependency && typeof manifest.version === 'string') {
      return manifest.version;
    }
  } catch {
    try {
      current = dirname(require.resolve(dependency));
    } catch (error) {
      throw new Error(
        `Could not resolve installed ${dependency} from ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  while (current !== undefined && current !== dirname(current)) {
    const manifestPath = resolve(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === dependency && typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    current = dirname(current);
  }
  throw new Error(`Could not find installed metadata for ${dependency} from ${packagePath}.`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
}

export function writeConsumerSources(
  consumerDirectory,
  executablePath,
  packageVersion,
  expectedDependencyVersions,
) {
  writeFileSync(
    join(consumerDirectory, 'smoke.ts'),
    [
      "import { BrowserIRRuntime } from '@browserir/core';",
      "import { createPlaywrightBrowserDriver } from '@browserir/playwright';",
      "import { BROWSERIR_PROTOCOL_VERSION, type BrowserIrService } from '@browserir/mcp';",
      '',
      'const runtime: BrowserIRRuntime = new BrowserIRRuntime(createPlaywrightBrowserDriver());',
      'const service: BrowserIrService | undefined = undefined;',
      'void runtime;',
      'void service;',
      'void BROWSERIR_PROTOCOL_VERSION;',
      '',
    ].join('\n'),
  );

  const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Packed BrowserIR smoke</title></head>
  <body>
    <main>
      <label for="customer-name">Customer name</label>
      <input id="customer-name" autocomplete="off">
      <button id="save-customer" type="button">Save customer</button>
      <p id="status" role="status">Ready</p>
    </main>
    <script>
      document.querySelector('#save-customer').addEventListener('click', () => {
        document.querySelector('#status').textContent =
          'Save customer succeeded for ' + document.querySelector('#customer-name').value;
      });
    </script>
  </body>
</html>`;

  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync, readFileSync } from 'node:fs';",
      "import { access } from 'node:fs/promises';",
      "import { constants } from 'node:fs';",
      "import { createServer } from 'node:http';",
      "import { createRequire } from 'node:module';",
      "import { dirname, resolve } from 'node:path';",
      "import { BrowserIRRuntime } from '@browserir/core';",
      "import { createPlaywrightBrowserDriver } from '@browserir/playwright';",
      "import { BROWSERIR_PROTOCOL_VERSION, SAFE_BROWSER_TOOL_NAMES } from '@browserir/mcp';",
      "import { Client } from '@modelcontextprotocol/client';",
      "import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';",
      '',
      `const executable = ${JSON.stringify(executablePath)};`,
      `const packageVersion = ${JSON.stringify(packageVersion)};`,
      `const expectedDependencyVersions = ${JSON.stringify(expectedDependencyVersions)};`,
      `const fixtureHtml = ${JSON.stringify(fixtureHtml)};`,
      'await access(executable, constants.X_OK);',
      "assert.equal(typeof BrowserIRRuntime, 'function');",
      "assert.equal(typeof createPlaywrightBrowserDriver, 'function');",
      "assert.equal(BROWSERIR_PROTOCOL_VERSION, '2026-07-28');",
      '',
      'const require = createRequire(import.meta.url);',
      'function installedVersion(dependency) {',
      '  try {',
      '    return require(`${dependency}/package.json`).version;',
      '  } catch {}',
      '  let current = dirname(require.resolve(dependency));',
      '  while (current !== dirname(current)) {',
      "    const manifestPath = resolve(current, 'package.json');",
      '    if (existsSync(manifestPath)) {',
      "      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));",
      '      if (manifest.name === dependency) return manifest.version;',
      '    }',
      '    current = dirname(current);',
      '  }',
      '  throw new Error(`Could not find installed version for ${dependency}.`);',
      '}',
      'for (const [dependency, expectedVersion] of Object.entries(expectedDependencyVersions)) {',
      '  assert.equal(installedVersion(dependency), expectedVersion);',
      '}',
      '',
      "const help = spawnSync(executable, ['--help'], { encoding: 'utf8' });",
      'assert.equal(help.status, 0);',
      "assert.equal(help.stderr, '');",
      "assert.match(help.stdout, /^Usage: browserir-mcp \[--headless \| --headful\]/);",
      "assert.match(help.stdout, /--headful/);",
      "const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });",
      'assert.equal(version.status, 0);',
      "assert.equal(version.stderr, '');",
      'assert.equal(version.stdout, `${packageVersion}\\n`);',
      '',
      'const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;',
      "assert.equal(typeof browserPath, 'string');",
      'const childEnvironment = {',
      '  ...getDefaultEnvironment(),',
      '  PLAYWRIGHT_BROWSERS_PATH: browserPath,',
      '};',
      'const transport = new StdioClientTransport({',
      '  command: executable,',
      '  cwd: process.cwd(),',
      '  env: childEnvironment,',
      "  stderr: 'pipe',",
      '});',
      "let stderr = '';",
      "transport.stderr?.setEncoding('utf8');",
      "transport.stderr?.on('data', (chunk) => { stderr += chunk; });",
      'const client = new Client(',
      "  { name: 'browserir-packed-consumer-smoke', version: packageVersion },",
      '  { versionNegotiation: { mode: { pin: BROWSERIR_PROTOCOL_VERSION } } },',
      ');',
      '',
      'function textOf(result) {',
      "  const item = result.content.find((candidate) => candidate.type === 'text');",
      "  assert.ok(item && item.type === 'text', 'missing BrowserIR model text');",
      '  return item.text;',
      '}',
      'function observationOf(result) {',
      '  assert.notEqual(result.isError, true);',
      "  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');",
      '  const data = result.structuredContent;',
      "  assert.equal(typeof data.browser_id, 'string');",
      "  assert.equal(typeof data.page_id, 'string');",
      '  const revision = data.revision ?? data.post_revision;',
      "  assert.equal(typeof revision, 'number');",
      '  return {',
      '    browserId: data.browser_id,',
      '    pageId: data.page_id,',
      '    revision,',
      '    text: textOf(result),',
      '  };',
      '}',
      'function entityNamed(observation, name, role) {',
      '  const encodedName = `name=${JSON.stringify(name)}`;',
      '  const encodedRole = `role=${JSON.stringify(role)}`;',
      '  const matches = observation.text.split("\\n").filter((line) =>',
      '    line.includes(encodedName) && line.includes(encodedRole),',
      '  );',
      '  assert.equal(matches.length, 1, `expected one ${role} named ${name}`);',
      '  const match = matches[0].match(/^\\[([^@\\]]+)@r(\\d+)\\]/);',
      '  assert.ok(match, `missing entity reference for ${name}`);',
      '  return {',
      '    page_id: observation.pageId,',
      '    entity_id: match[1],',
      '    revision: Number(match[2]),',
      '  };',
      '}',
      '',
      'const fixtureServer = createServer((request, response) => {',
      "  if (request.url !== '/') {",
      '    response.writeHead(404).end();',
      '    return;',
      '  }',
      "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
      '  response.end(fixtureHtml);',
      '});',
      'await new Promise((resolveListen, rejectListen) => {',
      "  fixtureServer.once('error', rejectListen);",
      "  fixtureServer.listen(0, '127.0.0.1', resolveListen);",
      '});',
      'const fixtureAddress = fixtureServer.address();',
      "assert.ok(fixtureAddress && typeof fixtureAddress === 'object');",
      'const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;',
      'let browserId;',
      '',
      'try {',
      '  await client.connect(transport);',
      '  assert.equal(client.getNegotiatedProtocolVersion(), BROWSERIR_PROTOCOL_VERSION);',
      '  const tools = await client.listTools();',
      '  assert.deepEqual(tools.tools.map((tool) => tool.name), [...SAFE_BROWSER_TOOL_NAMES]);',
      "  assert.ok(!tools.tools.some((tool) => tool.name === 'browser_evaluate_unsafe'));",
      "  const created = await client.callTool({ name: 'browser_create', arguments: {} });",
      '  assert.notEqual(created.isError, true);',
      '  const createdData = created.structuredContent;',
      "  assert.equal(typeof createdData?.browser_id, 'string');",
      "  assert.equal(typeof createdData?.page_id, 'string');",
      "  assert.equal(typeof createdData?.revision, 'number');",
      '  browserId = createdData.browser_id;',
      '',
      '  const navigated = await client.callTool({',
      "    name: 'browser_navigate',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: createdData.page_id,',
      '      url: fixtureUrl,',
      '      expected_revision: createdData.revision,',
      '    },',
      '  });',
      '  let current = observationOf(navigated);',
      "  assert.match(current.text, /Customer name/);",
      "  assert.match(current.text, /Save customer/);",
      '',
      '  const observed = await client.callTool({',
      "    name: 'browser_observe',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      expected_revision: current.revision,',
      '    },',
      '  });',
      '  current = observationOf(observed);',
      "  const nameField = entityNamed(current, 'Customer name', 'textbox');",
      "  const saveButton = entityNamed(current, 'Save customer', 'button');",
      '',
      '  const inspected = await client.callTool({',
      "    name: 'browser_inspect',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      entity_ids: [nameField.entity_id, saveButton.entity_id],',
      '      expected_revision: current.revision,',
      '      include_evidence: true,',
      '    },',
      '  });',
      '  assert.notEqual(inspected.isError, true);',
      "  assert.match(textOf(inspected), /Customer name/);",
      "  assert.match(textOf(inspected), /Save customer/);",
      '',
      '  const filled = await client.callTool({',
      "    name: 'browser_act',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      expected_revision: current.revision,',
      "      action: { kind: 'fill', target: nameField, value: 'Ada Lovelace' },",
      '    },',
      '  });',
      "  assert.equal(filled.structuredContent?.status, 'verified');",
      '  current = observationOf(filled);',
      '',
      "  const refreshedSaveButton = entityNamed(current, 'Save customer', 'button');",
      '  const clicked = await client.callTool({',
      "    name: 'browser_act',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      expected_revision: current.revision,',
      "      action: { kind: 'click', target: refreshedSaveButton },",
      '    },',
      '  });',
      "  assert.equal(clicked.structuredContent?.status, 'verified');",
      '  current = observationOf(clicked);',
      "  assert.match(current.text, /Save customer succeeded for Ada Lovelace/);",
      '',
      '  const waited = await client.callTool({',
      "    name: 'browser_wait',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      expected_revision: current.revision,',
      "      condition: { kind: 'settled' },",
      '      timeout_ms: 5000,',
      '    },',
      '  });',
      '  current = observationOf(waited);',
      "  assert.match(current.text, /Save customer succeeded for Ada Lovelace/);",
      '',
      '  const pages = await client.callTool({',
      "    name: 'browser_pages',",
      '    arguments: { browser_id: browserId },',
      '  });',
      '  assert.notEqual(pages.isError, true);',
      '  assert.ok(Array.isArray(pages.structuredContent?.pages));',
      '  assert.ok(pages.structuredContent.pages.some((page) => page.page_id === current.pageId));',
      '',
      '  const captured = await client.callTool({',
      "    name: 'browser_capture',",
      '    arguments: {',
      '      browser_id: browserId,',
      '      page_id: current.pageId,',
      '      expected_revision: current.revision,',
      "      kind: 'viewport',",
      "      format: 'png',",
      '    },',
      '  });',
      '  assert.notEqual(captured.isError, true);',
      "  assert.ok(captured.content.some((item) => item.type === 'image' && item.mimeType === 'image/png'));",
      '  assert.equal(captured.structuredContent?.revision, current.revision);',
      '',
      "  const closed = await client.callTool({ name: 'browser_close', arguments: { browser_id: browserId, expected_revision: current.revision } });",
      '  assert.notEqual(closed.isError, true);',
      '  browserId = undefined;',
      '',
      '  const eofOwned = await client.callTool({ name: \'browser_create\', arguments: {} });',
      '  assert.notEqual(eofOwned.isError, true);',
      "  assert.equal(typeof eofOwned.structuredContent?.browser_id, 'string');",
      '  browserId = eofOwned.structuredContent.browser_id;',
      '} finally {',
      '  await client.close().catch(() => {});',
      '  await new Promise((resolveClose) => fixtureServer.close(resolveClose));',
      '}',
      "assert.equal(typeof browserId, 'string');",
      "assert.equal(stderr, '');",
      '',
    ].join('\n'),
  );
}

function artifactRecords(archives) {
  const expectedPackages = releasePackageDefinitions.map((definition) => definition.name).sort();
  const actualPackages = [...archives.keys()].sort();
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      `Release candidate requires exactly these packages: ${expectedPackages.join(', ')}.`,
    );
  }
  const records = [...archives.values()]
    .map((archive) => ({
      file: archive,
      name: basename(archive),
      bytes: statSync(archive).size,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(records.map((record) => record.name)).size !== records.length) {
    throw new Error('Release package archives must have unique file names.');
  }
  return records;
}

export function validateArtifactDirectory(artifactDirectory) {
  if (typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory)) {
    throw new Error('The release artifact directory must be an absolute path.');
  }
  if (existsSync(artifactDirectory)) {
    throw new Error('The release artifact directory must not already exist.');
  }
}

export function validateReleaseEvidenceForWorkspace({
  releaseEvidenceDirectory,
  workspaceDirectory = workspaceRoot,
}) {
  const validated = validateReleaseEvidenceDossier(releaseEvidenceDirectory);
  const workspace = resolve(workspaceDirectory);
  let revision;
  let tree;
  let status;
  try {
    revision = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: workspace }).trim();
    tree = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: workspace }).trim();
    status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: workspace,
    }).trim();
  } catch (error) {
    throw new Error(
      `Could not bind release evidence to the current Git source: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (status !== '') {
    throw new Error('Persistent release artifacts require a clean Git worktree.');
  }
  const source = validated.report.source;
  if (source === null || typeof source !== 'object') {
    throw new Error('Release evidence dossier has no source binding.');
  }
  if (source.revision !== revision) {
    throw new Error('Release evidence commit revision does not match the current Git HEAD.');
  }
  if (source.tree !== tree) {
    throw new Error('Release evidence tree does not match the current Git tree.');
  }
  const lockfilePath = join(workspace, 'pnpm-lock.yaml');
  if (!existsSync(lockfilePath)) {
    throw new Error(`Release source lockfile does not exist: ${lockfilePath}`);
  }
  const lockfileSha256 = createHash('sha256')
    .update(readFileSync(lockfilePath))
    .digest('hex');
  if (source.lockfileSha256 !== lockfileSha256) {
    throw new Error('Release evidence lockfile does not match the current pnpm-lock.yaml.');
  }
  return validated;
}

export function finalizeReleaseArtifacts({
  artifactDirectory,
  archives,
  releaseEvidenceDirectory,
  workspaceDirectory = workspaceRoot,
}) {
  validateArtifactDirectory(artifactDirectory);
  const releaseEvidence = validateReleaseEvidenceForWorkspace({
    releaseEvidenceDirectory,
    workspaceDirectory,
  });
  const records = artifactRecords(archives);
  const integrityRecords = [
    ...records.map(({ file: _file, ...record }) => record),
    ...[...releaseEvidence.files.entries()].map(([name, content]) => ({
      name: `release-evidence/${name}`,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    })),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const parentDirectory = dirname(artifactDirectory);
  mkdirSync(parentDirectory, { recursive: true });
  const stagingDirectory = mkdtempSync(join(parentDirectory, '.browserir-candidate-'));
  try {
    for (const record of records) {
      copyFileSync(record.file, join(stagingDirectory, record.name));
      const retained = readFileSync(join(stagingDirectory, record.name));
      if (
        retained.byteLength !== record.bytes ||
        createHash('sha256').update(retained).digest('hex') !== record.sha256
      ) {
        throw new Error(`Release archive changed while it was being retained: ${record.name}`);
      }
    }
    for (const [name, content] of releaseEvidence.files) {
      const target = join(stagingDirectory, 'release-evidence', ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: 'wx' });
    }
    writeFileSync(
      join(stagingDirectory, 'SHA256SUMS'),
      `${integrityRecords.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`,
      { flag: 'wx' },
    );
    validateReleaseEvidenceForWorkspace({
      releaseEvidenceDirectory,
      workspaceDirectory,
    });
    renameSync(stagingDirectory, artifactDirectory);
    return records;
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function parsePackedConsumerArguments(arguments_) {
  const parsed = {};
  const filtered = arguments_.filter((argument) => argument !== '--');
  for (let index = 0; index < filtered.length; index += 1) {
    const argument = filtered[index];
    if (
      argument !== '--artifact-directory' &&
      argument !== '--release-evidence' &&
      argument !== '--report'
    ) {
      throw new Error(`Unknown packed-consumer argument ${JSON.stringify(argument)}.`);
    }
    const key =
      argument === '--artifact-directory'
        ? 'artifactDirectory'
        : argument === '--release-evidence'
          ? 'releaseEvidenceDirectory'
          : 'reportPath';
    if (parsed[key] !== undefined) throw new Error(`${argument} may be provided only once.`);
    const value = filtered[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
    parsed[key] = value;
  }
  if (parsed.artifactDirectory !== undefined && parsed.releaseEvidenceDirectory === undefined) {
    throw new Error('--artifact-directory requires --release-evidence.');
  }
  if (parsed.releaseEvidenceDirectory !== undefined && parsed.artifactDirectory === undefined) {
    throw new Error('--release-evidence requires --artifact-directory.');
  }
  return parsed;
}

export function writePackedConsumerReport(reportPath, report) {
  if (typeof reportPath !== 'string' || reportPath.trim() === '') {
    throw new Error('Packed-consumer report path is required.');
  }
  const target = resolve(reportPath);
  if (existsSync(target)) throw new Error(`Packed-consumer report already exists: ${target}`);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(target)}-`));
  try {
    const temporaryReport = join(staging, 'report.json');
    writeFileSync(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    linkSync(temporaryReport, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function runPackedConsumerSmoke({ artifactDirectory, releaseEvidenceDirectory, phase }) {
  process.stderr.write('Building release packages for packed-consumer smoke...\n');
  phase('build', () =>
    run('pnpm', ['build'], { cwd: workspaceRoot, stdio: 'inherit', timeout: 120_000 }),
  );
  phase('static-package-contract', () => {
    const staticFailures = packageStaticFailures();
    if (staticFailures.length > 0) {
      throw new Error(`Package layout is invalid:\n- ${staticFailures.join('\n- ')}`);
    }
  });

  const persistentArtifactDirectory =
    artifactDirectory === undefined ? undefined : resolve(artifactDirectory);
  if (persistentArtifactDirectory !== undefined) {
    phase('persistent-artifact-authorization', () => {
      validateArtifactDirectory(artifactDirectory);
      validateReleaseEvidenceForWorkspace({ releaseEvidenceDirectory });
      const releaseFailures = releaseReadinessFailures({ inspectPackedArtifacts: false });
      if (releaseFailures.length > 0) {
        throw new Error(
          `Persistent release artifacts require a green public-release gate:\n- ${releaseFailures.join('\n- ')}`,
        );
      }
    });
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browserir-consumer-'));
  const archiveDirectory = join(temporaryRoot, 'archives');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  const storeDirectory = join(temporaryRoot, 'pnpm-store');
  const browserDirectory = join(temporaryRoot, 'playwright-browsers');
  const consumerEnvironment = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
  };
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  try {
    const archives = new Map();
    phase('pack-public-packages', () => {
      for (const definition of releasePackageDefinitions) {
        archives.set(
          definition.name,
          packReleasePackage(definition.directory, archiveDirectory, workspaceRoot),
        );
      }
    });
    const coreArchive = archives.get('@browserir/core');
    const playwrightArchive = archives.get('@browserir/playwright');
    const mcpArchive = archives.get('@browserir/mcp');
    if (
      !existsSync(coreArchive ?? '') ||
      !existsSync(playwrightArchive ?? '') ||
      !existsSync(mcpArchive ?? '')
    ) {
      throw new Error('One or more release package archives were not created.');
    }
    phase('verify-packed-artifacts', () => {
      const packedFailures = packedArtifactFailures({ archives });
      if (packedFailures.length > 0) {
        throw new Error(`Packed artifacts are invalid:\n- ${packedFailures.join('\n- ')}`);
      }
    });

    const coreManifest = readManifest('packages/browser-ir');
    const mcpManifest = readManifest('packages/mcp-server');
    const expectedDependencyVersions = {
      '@modelcontextprotocol/client': installedDependencyVersion(
        'packages/mcp-server/package.json',
        '@modelcontextprotocol/client',
      ),
      '@modelcontextprotocol/server': installedDependencyVersion(
        'packages/mcp-server/package.json',
        '@modelcontextprotocol/server',
      ),
      '@types/node': installedDependencyVersion('package.json', '@types/node'),
      playwright: installedDependencyVersion(
        'packages/playwright-driver/package.json',
        'playwright',
      ),
      typescript: installedDependencyVersion('package.json', 'typescript'),
      zod: installedDependencyVersion('packages/mcp-server/package.json', 'zod'),
    };
    const consumerManifest = {
      name: 'browserir-packed-consumer-smoke',
      version: '0.0.0',
      private: true,
      type: 'module',
      engines: { node: coreManifest.engines.node },
      dependencies: {
        '@browserir/core': `file:${coreArchive}`,
        '@browserir/playwright': `file:${playwrightArchive}`,
        '@browserir/mcp': `file:${mcpArchive}`,
      },
      devDependencies: {
        ...expectedDependencyVersions,
      },
      pnpm: {
        overrides: {
          '@browserir/core': `file:${coreArchive}`,
          '@browserir/playwright': `file:${playwrightArchive}`,
          '@modelcontextprotocol/client': expectedDependencyVersions['@modelcontextprotocol/client'],
          '@modelcontextprotocol/server': expectedDependencyVersions['@modelcontextprotocol/server'],
          '@types/node': expectedDependencyVersions['@types/node'],
          playwright: expectedDependencyVersions.playwright,
          typescript: expectedDependencyVersions.typescript,
          zod: expectedDependencyVersions.zod,
        },
      },
    };
    writeFileSync(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify(consumerManifest, null, 2)}\n`,
    );

    process.stderr.write('Installing release tarballs into a clean temporary consumer...\n');
    phase('install-clean-consumer', () =>
      run(
        'pnpm',
        [
          'install',
          '--no-frozen-lockfile',
          '--ignore-scripts',
          '--strict-peer-dependencies',
          '--store-dir',
          storeDirectory,
        ],
        {
          cwd: consumerDirectory,
          env: consumerEnvironment,
          stdio: 'inherit',
          timeout: 180_000,
        },
      ),
    );

    process.stderr.write('Installing the Chromium build selected by the packed dependency graph...\n');
    phase('install-qualified-chromium', () =>
      run('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
        cwd: consumerDirectory,
        env: consumerEnvironment,
        stdio: 'inherit',
        timeout: 180_000,
      }),
    );

    const executablePath = resolve(
      consumerDirectory,
      'node_modules/.bin/browserir-mcp',
    );
    accessSync(executablePath, constants.X_OK);
    writeConsumerSources(
      consumerDirectory,
      executablePath,
      mcpManifest.version,
      expectedDependencyVersions,
    );

    process.stderr.write('Type-checking and importing the installed package boundaries...\n');
    phase('typecheck-installed-boundaries', () =>
      run(
        process.execPath,
        [
          resolve(consumerDirectory, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--types',
          'node',
          'smoke.ts',
        ],
        { cwd: consumerDirectory, env: consumerEnvironment, timeout: 120_000 },
      ),
    );

    process.stderr.write('Driving the installed browserir-mcp executable over stdio...\n');
    phase('drive-installed-stdio-mcp', () =>
      run(process.execPath, ['smoke.mjs'], {
        cwd: consumerDirectory,
        env: consumerEnvironment,
        timeout: 90_000,
      }),
    );
    if (persistentArtifactDirectory !== undefined) {
      const records = phase('retain-authorized-release-artifacts', () =>
        finalizeReleaseArtifacts({
          artifactDirectory: persistentArtifactDirectory,
          archives,
          releaseEvidenceDirectory,
        }),
      );
      for (const record of records) {
        process.stdout.write(
          `Release artifact ${record.name}: ${record.bytes} bytes, sha256 ${record.sha256}\n`,
        );
      }
      process.stdout.write(
        `Release artifacts, evidence dossier, and SHA-256 integrity manifest retained in ${persistentArtifactDirectory}.\n`,
      );
    }
    process.stdout.write('Packed consumer smoke passed.\n');
    return {
      archives: artifactRecords(archives).map(({ file: _file, ...record }) => record),
      expectedDependencyVersions,
      packageVersion: mcpManifest.version,
      persistentArtifactsRetained: persistentArtifactDirectory !== undefined,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function smokePackedConsumer({ artifactDirectory, releaseEvidenceDirectory, reportPath } = {}) {
  if (artifactDirectory !== undefined && releaseEvidenceDirectory === undefined) {
    throw new Error('Persistent release artifacts require a release-evidence dossier.');
  }
  if (releaseEvidenceDirectory !== undefined && artifactDirectory === undefined) {
    throw new Error('A release-evidence dossier may only be used with persistent release artifacts.');
  }
  if (reportPath !== undefined && existsSync(resolve(reportPath))) {
    throw new Error(`Packed-consumer report already exists: ${resolve(reportPath)}`);
  }
  const startedAt = Date.now();
  const report = {
    schemaVersion: '1.0.0',
    outcome: 'failed',
    startedAtUtc: new Date(startedAt).toISOString(),
    completedAtUtc: undefined,
    durationMs: undefined,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    phases: [],
    archives: [],
  };
  const phase = (name, operation) => {
    const phaseStarted = Date.now();
    try {
      const value = operation();
      report.phases.push({ name, outcome: 'passed', durationMs: Date.now() - phaseStarted });
      return value;
    } catch (error) {
      report.phases.push({
        name,
        outcome: 'failed',
        durationMs: Date.now() - phaseStarted,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  let failure;
  try {
    const result = runPackedConsumerSmoke({ artifactDirectory, releaseEvidenceDirectory, phase });
    report.outcome = 'passed';
    report.archives = result.archives;
    report.expectedDependencyVersions = result.expectedDependencyVersions;
    report.packageVersion = result.packageVersion;
    report.persistentArtifactsRetained = result.persistentArtifactsRetained;
  } catch (error) {
    failure = error;
    report.error = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const completedAt = Date.now();
  report.completedAtUtc = new Date(completedAt).toISOString();
  report.durationMs = completedAt - startedAt;
  if (reportPath !== undefined) writePackedConsumerReport(reportPath, report);
  if (failure !== undefined) throw failure;
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    smokePackedConsumer(parsePackedConsumerArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `Packed consumer smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
