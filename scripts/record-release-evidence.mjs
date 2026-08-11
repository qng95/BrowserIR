import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
export const releaseEvidenceSchemaVersion = '1.1.0';
const declaredGates = new Set([
  'workspace-verification',
  'capability-qualification',
  'task-qualification',
  'representation-qualification',
  'performance-characterization',
  'packed-consumer',
  'production-audit',
]);
const reportGateArtifacts = new Map([
  ['task-qualification', ['qualification-report.json', 'qualification-report.md']],
  [
    'representation-qualification',
    [
      'model-payload.ndjson',
      'representation-report.json',
      'representation-report.junit.xml',
      'representation-report.md',
      'representation-report.ndjson',
    ],
  ],
  [
    'performance-characterization',
    ['environment.json', 'samples.ndjson', 'summary.json', 'summary.md'],
  ],
]);
const workspaceTestPackages = [
  { name: '@browserir/core', directory: 'packages/browser-ir' },
  { name: '@think-dom/fixture-app', directory: 'packages/fixture-app' },
  { name: '@browserir/playwright', directory: 'packages/playwright-driver' },
  { name: '@browserir/benchmark', directory: 'packages/benchmark' },
  { name: '@browserir/mcp', directory: 'packages/mcp-server' },
];
export const releaseEvidenceSourceFilePaths = Object.freeze([
  'package.json',
  'packages/benchmark/package.json',
  'packages/browser-ir/package.json',
  'packages/fixture-app/package.json',
  'packages/mcp-server/package.json',
  'packages/playwright-driver/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]);

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

function usage() {
  return [
    'Usage: pnpm release:evidence <gate> --output <new-directory> --run-id <id> [--skip-build]',
    '',
    'Gates:',
    '  workspace-verification',
    '  capability-qualification',
    '  task-qualification',
    '  representation-qualification',
    '  performance-characterization',
    '  packed-consumer',
    '  production-audit',
    '',
    '--skip-build is accepted only for workspace-verification.',
  ].join('\n');
}

export function parseReleaseEvidenceArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    throw new Error(usage());
  }
  const [gate, ...rest] = arguments_;
  if (!declaredGates.has(gate)) {
    throw new Error(`Unknown release evidence gate ${JSON.stringify(gate)}.\n${usage()}`);
  }

  let outputDirectory;
  let runId;
  let skipBuild = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--output') {
      if (outputDirectory !== undefined) throw new Error('--output may be provided only once.');
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error('--output requires a directory.');
      outputDirectory = value;
      continue;
    }
    if (argument === '--run-id') {
      if (runId !== undefined) throw new Error('--run-id may be provided only once.');
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error('--run-id requires a value.');
      runId = value;
      continue;
    }
    if (argument === '--skip-build') {
      if (skipBuild) throw new Error('--skip-build may be provided only once.');
      skipBuild = true;
      continue;
    }
    throw new Error(`Unknown release evidence argument ${JSON.stringify(argument)}.`);
  }

  if (outputDirectory === undefined) throw new Error('--output is required.');
  if (runId === undefined) throw new Error('--run-id is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error('--run-id must contain only letters, digits, dot, underscore, or hyphen.');
  }
  if (skipBuild && gate !== 'workspace-verification') {
    throw new Error('--skip-build is valid only for workspace-verification.');
  }

  return { gate, outputDirectory, runId, skipBuild };
}

export function vitestEvidenceArguments({ targets = [], jsonPath, junitPath }) {
  if (!Array.isArray(targets) || targets.some((target) => typeof target !== 'string')) {
    throw new Error('Vitest evidence targets must be strings.');
  }
  if (typeof jsonPath !== 'string' || jsonPath === '') {
    throw new Error('Vitest JSON evidence path is required.');
  }
  if (typeof junitPath !== 'string' || junitPath === '') {
    throw new Error('Vitest JUnit evidence path is required.');
  }
  return [
    'exec',
    'vitest',
    'run',
    ...targets,
    '--reporter=default',
    '--reporter=json',
    '--reporter=junit',
    `--outputFile.json=${jsonPath}`,
    `--outputFile.junit=${junitPath}`,
  ];
}

export function reportArtifactsForGate(gate) {
  const artifacts = reportGateArtifacts.get(gate);
  if (artifacts === undefined) {
    throw new Error(`${JSON.stringify(gate)} is not a report gate.`);
  }
  return [...artifacts];
}

function parseNonnegativeNumber(value, name, integer) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`JUnit ${name} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`JUnit ${name} must be a nonnegative ${integer ? 'integer' : 'number'}.`);
  }
  return parsed;
}

export function parseJunitSummary(xml) {
  if (typeof xml !== 'string') throw new Error('JUnit report must be text.');
  const roots = [...xml.matchAll(/<testsuites(?:\s[^>]*)?>/g)];
  if (roots.length !== 1) {
    throw new Error(`JUnit evidence must contain exactly one testsuites root; found ${roots.length}.`);
  }
  const attributes = new Map();
  for (const match of roots[0][0].matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    attributes.set(match[1], match[2]);
  }
  let skipped;
  if (attributes.has('skipped')) {
    skipped = parseNonnegativeNumber(attributes.get('skipped'), 'skipped', true);
  } else {
    const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)];
    if (suites.length === 0) throw new Error('JUnit skipped is required.');
    skipped = suites.reduce((total, suite) => {
      const skippedMatch = suite[0].match(/\bskipped="([^"]*)"/);
      return (
        total +
        parseNonnegativeNumber(skippedMatch?.[1], 'child testsuite skipped', true)
      );
    }, 0);
  }
  return {
    tests: parseNonnegativeNumber(attributes.get('tests'), 'tests', true),
    failures: parseNonnegativeNumber(attributes.get('failures'), 'failures', true),
    errors: parseNonnegativeNumber(attributes.get('errors'), 'errors', true),
    skipped,
    timeSeconds: parseNonnegativeNumber(attributes.get('time'), 'time', false),
  };
}

function nonnegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative integer.`);
  }
  return value;
}

export function normalizePnpmAuditReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('pnpm audit output must be an object.');
  }
  const metadata = report.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('pnpm audit metadata is required.');
  }
  const vulnerabilitySource = metadata.vulnerabilities;
  if (
    vulnerabilitySource === null ||
    typeof vulnerabilitySource !== 'object' ||
    Array.isArray(vulnerabilitySource)
  ) {
    throw new Error('pnpm audit vulnerability counts are required.');
  }
  const vulnerabilities = {
    info: nonnegativeInteger(vulnerabilitySource.info, 'metadata.vulnerabilities.info'),
    low: nonnegativeInteger(vulnerabilitySource.low, 'metadata.vulnerabilities.low'),
    moderate: nonnegativeInteger(
      vulnerabilitySource.moderate,
      'metadata.vulnerabilities.moderate',
    ),
    high: nonnegativeInteger(vulnerabilitySource.high, 'metadata.vulnerabilities.high'),
    critical: nonnegativeInteger(
      vulnerabilitySource.critical,
      'metadata.vulnerabilities.critical',
    ),
  };
  const dependencies = {
    production: nonnegativeInteger(metadata.dependencies, 'metadata.dependencies'),
    development: nonnegativeInteger(metadata.devDependencies, 'metadata.devDependencies'),
    optional: nonnegativeInteger(metadata.optionalDependencies, 'metadata.optionalDependencies'),
    total: nonnegativeInteger(metadata.totalDependencies, 'metadata.totalDependencies'),
  };
  return {
    vulnerabilities,
    totalVulnerabilities: Object.values(vulnerabilities).reduce((total, count) => total + count, 0),
    dependencies,
  };
}

export function classifyPnpmAuditOutcome({ exitCode, normalized, muted }) {
  if (
    normalized !== undefined &&
    (normalized.totalVulnerabilities > 0 || (Number.isInteger(muted) && muted > 0))
  ) {
    return 'vulnerabilities_found';
  }
  if (exitCode === 0 && normalized !== undefined && muted === 0) return 'passed';
  return 'audit_unavailable';
}

function validateArtifactName(name) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name) || name.includes('\\')) {
    throw new Error(`Invalid evidence artifact path ${JSON.stringify(name)}.`);
  }
  const segments = name.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    name === 'SHA256SUMS'
  ) {
    throw new Error(`Invalid evidence artifact path ${JSON.stringify(name)}.`);
  }
}

export function finalizeEvidenceDirectory({ targetDirectory, artifacts }) {
  if (typeof targetDirectory !== 'string' || targetDirectory.trim() === '') {
    throw new Error('Evidence target directory is required.');
  }
  if (!(artifacts instanceof Map) || artifacts.size === 0) {
    throw new Error('At least one evidence artifact is required.');
  }
  const target = resolve(targetDirectory);
  if (existsSync(target)) throw new Error(`Evidence target already exists: ${target}`);
  for (const name of artifacts.keys()) validateArtifactName(name);

  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.browserir-evidence-${basename(target)}-`));
  try {
    const records = [];
    for (const [name, value] of [...artifacts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const content = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      const destination = join(staging, ...name.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: 'wx' });
      records.push({ name, bytes: content.byteLength, sha256: sha256(content) });
    }
    writeFileSync(
      join(staging, 'SHA256SUMS'),
      `${records.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`,
      { flag: 'wx' },
    );
    renameSync(staging, target);
    return records;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function runSyncText(command, arguments_, cwd = workspaceRoot) {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function classifySourceBinding({ revision, tree, objectFormat, dirty, githubSha }) {
  const reasons = [];
  const hashLength = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : undefined;
  const validHash = (value) =>
    hashLength !== undefined &&
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${hashLength}}$`).test(value);
  if (!validHash(revision)) reasons.push('revision_unavailable');
  if (!validHash(tree)) reasons.push('tree_unavailable');
  if (hashLength === undefined) reasons.push('unsupported_object_format');
  if (dirty) reasons.push('dirty_worktree');
  if (githubSha !== undefined && githubSha !== revision) reasons.push('github_sha_mismatch');
  return { status: reasons.length === 0 ? 'bound' : 'unbound', reasons };
}

const sourceStabilityFields = [
  'revision',
  'tree',
  'objectFormat',
  'dirty',
  'binding',
  'githubSha',
  'githubShaMatchesHead',
  'lockfileSha256',
  'files',
];

export function verifyStableEvidenceSource({ gateOutcome, sourceBefore, sourceAfter }) {
  if (gateOutcome !== 'passed' && gateOutcome !== 'failed') {
    throw new Error('Release evidence gate outcome must be passed or failed.');
  }
  if (
    sourceBefore === null ||
    typeof sourceBefore !== 'object' ||
    sourceAfter === null ||
    typeof sourceAfter !== 'object'
  ) {
    throw new Error('Release evidence source snapshots must be objects.');
  }
  const changedFields = sourceStabilityFields.filter(
    (field) => !isDeepStrictEqual(sourceBefore[field], sourceAfter[field]),
  );
  const changed = changedFields.length > 0;
  const source = changed
    ? {
        ...sourceAfter,
        binding: {
          status: 'unbound',
          reasons: [
            ...new Set([
              ...(Array.isArray(sourceAfter.binding?.reasons)
                ? sourceAfter.binding.reasons
                : []),
              'source_changed_during_gate',
            ]),
          ],
        },
      }
    : sourceAfter;
  return {
    outcome: gateOutcome === 'passed' && !changed ? 'passed' : 'failed',
    source,
    verification: {
      status: changed ? 'changed' : 'stable',
      changedFields,
      before: sourceBefore,
      after: sourceAfter,
    },
  };
}

function hashedSourceFiles() {
  return releaseEvidenceSourceFilePaths.map((path) => {
    const content = readFileSync(join(workspaceRoot, path));
    return { path, bytes: content.byteLength, sha256: sha256(content) };
  });
}

function sourceMetadata() {
  const revision = runSyncText('git', ['rev-parse', '--verify', 'HEAD']);
  const tree = runSyncText('git', ['rev-parse', '--verify', 'HEAD^{tree}']);
  const objectFormat = runSyncText('git', ['rev-parse', '--show-object-format']) ?? 'unknown';
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const lockfile = readFileSync(join(workspaceRoot, 'pnpm-lock.yaml'));
  const source = {
    revision: revision ?? 'unavailable',
    tree: tree ?? 'unavailable',
    objectFormat,
    dirty: status.status !== 0 || status.stdout.trim() !== '',
    githubSha: process.env.GITHUB_SHA,
  };
  return {
    revision: source.revision,
    tree: source.tree,
    objectFormat: source.objectFormat,
    dirty: source.dirty,
    binding: classifySourceBinding(source),
    ...(source.githubSha === undefined
      ? {}
      : { githubSha: source.githubSha, githubShaMatchesHead: source.githubSha === source.revision }),
    lockfileSha256: sha256(lockfile),
    files: hashedSourceFiles(),
  };
}

function runtimeMetadata() {
  const github = process.env.GITHUB_ACTIONS === 'true';
  const rootManifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'));
  const playwrightManifest = JSON.parse(
    readFileSync(join(workspaceRoot, 'packages/playwright-driver/package.json'), 'utf8'),
  );
  const mcpManifest = JSON.parse(
    readFileSync(join(workspaceRoot, 'packages/mcp-server/package.json'), 'utf8'),
  );
  return {
    node: process.version,
    pnpm: runSyncText(pnpmExecutable, ['--version']) ?? 'unavailable',
    platform: platform(),
    platformRelease: release(),
    architecture: arch(),
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    declaredToolchain: {
      packageManager: rootManifest.packageManager ?? 'unavailable',
      playwright: playwrightManifest.dependencies?.playwright ?? 'unavailable',
      mcpServer: mcpManifest.dependencies?.['@modelcontextprotocol/server'] ?? 'unavailable',
      zod: mcpManifest.dependencies?.zod ?? 'unavailable',
      typescript: rootManifest.devDependencies?.typescript ?? 'unavailable',
      vitest: rootManifest.devDependencies?.vitest ?? 'unavailable',
    },
    ci: github
      ? {
          provider: 'github-actions',
          runId: process.env.GITHUB_RUN_ID ?? 'unavailable',
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? 'unavailable',
          job: process.env.GITHUB_JOB ?? 'unavailable',
          eventName: process.env.GITHUB_EVENT_NAME ?? 'unavailable',
          ref: process.env.GITHUB_REF ?? 'unavailable',
          runnerOs: process.env.RUNNER_OS ?? 'unavailable',
          runnerArchitecture: process.env.RUNNER_ARCH ?? 'unavailable',
          imageOs: process.env.ImageOS ?? 'unavailable',
          imageVersion: process.env.ImageVersion ?? 'unavailable',
        }
      : { provider: 'local' },
  };
}

async function runRecordedCommand({ name, command, arguments_, cwd = workspaceRoot, env = {} }) {
  const startedAt = Date.now();
  const startedAtUtc = new Date(startedAt).toISOString();
  process.stdout.write(`\n[release-evidence] ${name}\n`);
  process.stdout.write(`$ ${[command, ...arguments_].join(' ')}\n`);
  return await new Promise((resolveCommand) => {
    const stdout = [];
    const stderr = [];
    let spawnError;
    const child = spawn(command, arguments_, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      stdout.push(Buffer.from(chunk));
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      const completedAt = Date.now();
      resolveCommand({
        name,
        command: [command, ...arguments_],
        cwd: relative(workspaceRoot, cwd) || '.',
        startedAtUtc,
        completedAtUtc: new Date(completedAt).toISOString(),
        durationMs: completedAt - startedAt,
        exitCode,
        signal,
        spawnError: spawnError?.message,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function commandSummary(result) {
  return {
    name: result.name,
    command: result.command,
    cwd: result.cwd,
    startedAtUtc: result.startedAtUtc,
    completedAtUtc: result.completedAtUtc,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.spawnError === undefined ? {} : { spawnError: result.spawnError }),
    outcome: result.exitCode === 0 && result.spawnError === undefined ? 'passed' : 'failed',
  };
}

function addCommandLogs(artifacts, prefix, result) {
  artifacts.set(`${prefix}.stdout.log`, result.stdout);
  artifacts.set(`${prefix}.stderr.log`, result.stderr);
}

function artifactDescriptions(artifacts) {
  return [...artifacts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const content = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      return { name, bytes: content.byteLength, sha256: sha256(content) };
    });
}

function safePackageArtifactName(name) {
  return name.replace(/^@/, '').replaceAll('/', '-');
}

async function workspaceVerification(options, temporaryDirectory, artifacts) {
  const preparations = [];
  if (!options.skipBuild) {
    preparations.push(
      await runRecordedCommand({
        name: 'build',
        command: pnpmExecutable,
        arguments_: ['build'],
      }),
    );
  }
  preparations.push(
    await runRecordedCommand({
      name: 'typecheck',
      command: pnpmExecutable,
      arguments_: ['typecheck'],
    }),
  );
  preparations.push(
    await runRecordedCommand({
      name: 'verify-packages',
      command: process.execPath,
      arguments_: [join(workspaceRoot, 'scripts/verify-packages.mjs')],
    }),
  );
  for (const result of preparations) addCommandLogs(artifacts, `logs/${result.name}`, result);

  const packages = [];
  for (const definition of workspaceTestPackages) {
    const artifactName = safePackageArtifactName(definition.name);
    const jsonPath = join(temporaryDirectory, `${artifactName}.vitest.json`);
    const junitPath = join(temporaryDirectory, `${artifactName}.junit.xml`);
    const command = await runRecordedCommand({
      name: `tests ${definition.name}`,
      command: pnpmExecutable,
      arguments_: vitestEvidenceArguments({ jsonPath, junitPath }),
      cwd: join(workspaceRoot, definition.directory),
    });
    addCommandLogs(artifacts, `logs/${artifactName}`, command);
    let jsonError;
    if (existsSync(jsonPath)) {
      const json = readFileSync(jsonPath, 'utf8');
      try {
        const parsed = JSON.parse(json);
        if (parsed === null || typeof parsed !== 'object') {
          throw new Error('Vitest JSON report must contain an object.');
        }
        artifacts.set(`vitest/${artifactName}.json`, json);
      } catch (error) {
        jsonError = error instanceof Error ? error.message : String(error);
      }
    } else {
      jsonError = 'Vitest did not create a JSON report.';
    }
    let junit;
    let junitError;
    if (existsSync(junitPath)) {
      const xml = readFileSync(junitPath, 'utf8');
      artifacts.set(`junit/${artifactName}.xml`, xml);
      try {
        junit = parseJunitSummary(xml);
      } catch (error) {
        junitError = error instanceof Error ? error.message : String(error);
      }
    } else {
      junitError = 'Vitest did not create a JUnit report.';
    }
    packages.push({
      package: definition.name,
      ...commandSummary(command),
      junit,
      ...(jsonError === undefined ? {} : { jsonError }),
      ...(junitError === undefined ? {} : { junitError }),
      outcome:
        command.exitCode === 0 &&
        command.spawnError === undefined &&
        jsonError === undefined &&
        junit !== undefined &&
        junit.tests > 0 &&
        junit.failures === 0 &&
        junit.errors === 0
          ? 'passed'
          : 'failed',
    });
  }
  const totals = packages.reduce(
    (summary, item) => {
      if (item.junit !== undefined) {
        summary.tests += item.junit.tests;
        summary.failures += item.junit.failures;
        summary.errors += item.junit.errors;
        summary.skipped += item.junit.skipped;
        summary.timeSeconds += item.junit.timeSeconds;
      }
      return summary;
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0, timeSeconds: 0 },
  );
  const outcome =
    preparations.every((result) => result.exitCode === 0 && result.spawnError === undefined) &&
    packages.every((item) => item.outcome === 'passed')
      ? 'passed'
      : 'failed';
  return {
    outcome,
    preparations: preparations.map(commandSummary),
    packages,
    totals,
  };
}

async function capabilityQualification(temporaryDirectory, artifacts) {
  const jsonPath = join(temporaryDirectory, 'capability-qualification.vitest.json');
  const junitPath = join(temporaryDirectory, 'capability-qualification.junit.xml');
  const command = await runRecordedCommand({
    name: 'capability qualification',
    command: pnpmExecutable,
    arguments_: vitestEvidenceArguments({
      targets: ['tests/capability-qualification.e2e.test.ts'],
      jsonPath,
      junitPath,
    }),
    cwd: join(workspaceRoot, 'packages/mcp-server'),
    env: { BROWSERIR_RUN_CAPABILITY_QUALIFICATION: '1' },
  });
  addCommandLogs(artifacts, 'logs/capability-qualification', command);
  let jsonError;
  if (existsSync(jsonPath)) {
    const json = readFileSync(jsonPath, 'utf8');
    try {
      const parsed = JSON.parse(json);
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('Vitest JSON report must contain an object.');
      }
      artifacts.set('vitest/capability-qualification.json', json);
    } catch (error) {
      jsonError = error instanceof Error ? error.message : String(error);
    }
  } else {
    jsonError = 'Vitest did not create a JSON report.';
  }
  let junit;
  let junitError;
  if (existsSync(junitPath)) {
    const xml = readFileSync(junitPath, 'utf8');
    artifacts.set('junit/capability-qualification.xml', xml);
    try {
      junit = parseJunitSummary(xml);
    } catch (error) {
      junitError = error instanceof Error ? error.message : String(error);
    }
  } else {
    junitError = 'Vitest did not create a JUnit report.';
  }
  const outcome =
    command.exitCode === 0 &&
    command.spawnError === undefined &&
    jsonError === undefined &&
    junit !== undefined &&
    junit.tests > 0 &&
    junit.failures === 0 &&
    junit.errors === 0 &&
    junit.skipped === 0
      ? 'passed'
      : 'failed';
  return {
    outcome,
    command: commandSummary(command),
    junit,
    ...(jsonError === undefined ? {} : { jsonError }),
    ...(junitError === undefined ? {} : { junitError }),
  };
}

function validateGeneratedReport(name, content) {
  if (content.byteLength === 0) throw new Error(`${name} is empty.`);
  const text = content.toString('utf8');
  if (name.endsWith('.json')) {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`${name} must contain a JSON object or array.`);
    }
  } else if (name.endsWith('.ndjson')) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) throw new Error(`${name} has no NDJSON records.`);
    for (const line of lines) JSON.parse(line);
  } else if (name.endsWith('.xml')) {
    if (!/^\s*(?:<\?xml\b[^>]*>\s*)?<testsuites\b/.test(text)) {
      throw new Error(`${name} is not a JUnit testsuites document.`);
    }
  } else if (text.trim() === '') {
    throw new Error(`${name} is blank.`);
  }
}

async function generatedReportGate(options, temporaryDirectory, artifacts) {
  const reportDirectory = join(temporaryDirectory, options.gate);
  const commands = {
    'task-qualification': ['test:qualification'],
    'representation-qualification': ['benchmark:representation'],
    'performance-characterization': ['benchmark'],
  };
  const command = await runRecordedCommand({
    name: options.gate,
    command: pnpmExecutable,
    arguments_: [
      ...commands[options.gate],
      '--',
      '--run-id',
      options.runId,
      '--output',
      reportDirectory,
    ],
  });
  addCommandLogs(artifacts, `logs/${options.gate}`, command);
  const missing = [];
  const reportErrors = [];
  for (const name of reportArtifactsForGate(options.gate)) {
    const path = join(reportDirectory, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const content = readFileSync(path);
    try {
      validateGeneratedReport(name, content);
    } catch (error) {
      reportErrors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    artifacts.set(`reports/${name}`, content);
  }
  return {
    outcome:
      command.exitCode === 0 &&
      command.spawnError === undefined &&
      missing.length === 0 &&
      reportErrors.length === 0
        ? 'passed'
        : 'failed',
    command: commandSummary(command),
    expectedReports: reportArtifactsForGate(options.gate),
    missingReports: missing,
    reportErrors,
  };
}

async function packedConsumer(temporaryDirectory, artifacts) {
  const reportPath = join(temporaryDirectory, 'packed-consumer.json');
  const command = await runRecordedCommand({
    name: 'packed consumer smoke',
    command: pnpmExecutable,
    arguments_: ['verify:packed-consumer', '--', '--report', reportPath],
  });
  addCommandLogs(artifacts, 'logs/packed-consumer', command);
  let report;
  let reportError;
  if (existsSync(reportPath)) {
    const reportText = readFileSync(reportPath, 'utf8');
    try {
      report = JSON.parse(reportText);
      if (report === null || typeof report !== 'object') {
        throw new Error('Packed-consumer report must contain an object.');
      }
      if (!Array.isArray(report.archives) || !Array.isArray(report.phases)) {
        throw new Error('Packed-consumer report is missing archives or phases.');
      }
      artifacts.set('packed-consumer.json', reportText);
    } catch (error) {
      reportError = error instanceof Error ? error.message : String(error);
    }
  } else {
    reportError = 'Packed-consumer smoke did not create its report.';
  }
  const validArchives =
    report?.archives?.length === 3 &&
    report.archives.every(
      (archive) =>
        archive !== null &&
        typeof archive === 'object' &&
        typeof archive.name === 'string' &&
        Number.isInteger(archive.bytes) &&
        archive.bytes > 0 &&
        typeof archive.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(archive.sha256),
    );
  return {
    outcome:
      command.exitCode === 0 &&
      command.spawnError === undefined &&
      reportError === undefined &&
      report?.outcome === 'passed' &&
      report.phases.length > 0 &&
      report.phases.every((phase) => phase.outcome === 'passed') &&
      validArchives
        ? 'passed'
        : 'failed',
    command: commandSummary(command),
    reportOutcome: report?.outcome,
    phaseCount: report?.phases?.length,
    archiveCount: report?.archives?.length,
    ...(reportError === undefined ? {} : { reportError }),
  };
}

async function productionAudit(artifacts) {
  const command = await runRecordedCommand({
    name: 'production dependency audit',
    command: pnpmExecutable,
    arguments_: ['audit', '--prod', '--audit-level=low', '--json'],
  });
  addCommandLogs(artifacts, 'logs/production-audit', command);
  let audit;
  let normalized;
  let auditError;
  try {
    audit = JSON.parse(command.stdout);
    normalized = normalizePnpmAuditReport(audit);
    artifacts.set('production-audit.json', `${JSON.stringify(audit, null, 2)}\n`);
  } catch (error) {
    auditError = error instanceof Error ? error.message : String(error);
  }
  const muted = Array.isArray(audit?.muted) ? audit.muted.length : undefined;
  const classification = classifyPnpmAuditOutcome({
    exitCode: command.exitCode,
    normalized,
    muted,
  });
  const outcome =
    classification === 'passed' && command.spawnError === undefined ? 'passed' : 'failed';
  return {
    outcome,
    classification,
    command: commandSummary(command),
    normalized,
    muted,
    ...(auditError === undefined ? {} : { auditError }),
  };
}

async function runGate(options) {
  const startedAt = Date.now();
  const sourceBefore = sourceMetadata();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'browserir-release-evidence-run-'));
  const artifacts = new Map();
  try {
    let result;
    if (options.gate === 'workspace-verification') {
      result = await workspaceVerification(options, temporaryDirectory, artifacts);
    } else if (options.gate === 'capability-qualification') {
      result = await capabilityQualification(temporaryDirectory, artifacts);
    } else if (reportGateArtifacts.has(options.gate)) {
      result = await generatedReportGate(options, temporaryDirectory, artifacts);
    } else if (options.gate === 'packed-consumer') {
      result = await packedConsumer(temporaryDirectory, artifacts);
    } else if (options.gate === 'production-audit') {
      result = await productionAudit(artifacts);
    } else {
      throw new Error(`Unsupported release evidence gate ${JSON.stringify(options.gate)}.`);
    }
    const artifactRecords = artifactDescriptions(artifacts);
    const sourceAfter = sourceMetadata();
    const sourceVerification = verifyStableEvidenceSource({
      gateOutcome: result.outcome,
      sourceBefore,
      sourceAfter,
    });
    const completedAt = Date.now();
    const report = {
      schemaVersion: releaseEvidenceSchemaVersion,
      runId: options.runId,
      gate: options.gate,
      outcome: sourceVerification.outcome,
      startedAtUtc: new Date(startedAt).toISOString(),
      completedAtUtc: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      source: sourceVerification.source,
      sourceVerification: sourceVerification.verification,
      runtime: runtimeMetadata(),
      result,
      artifacts: artifactRecords,
    };
    artifacts.set('evidence.json', `${JSON.stringify(report, null, 2)}\n`);
    const records = finalizeEvidenceDirectory({
      targetDirectory: options.outputDirectory,
      artifacts,
    });
    process.stdout.write(`\nRelease evidence: ${resolve(options.outputDirectory)}\n`);
    process.stdout.write(`Outcome: ${report.outcome}\n`);
    process.stdout.write(`Artifacts: ${records.length + 1} including SHA256SUMS\n`);
    return report.outcome === 'passed' ? 0 : 1;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  let options;
  try {
    options = parseReleaseEvidenceArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (existsSync(resolve(options.outputDirectory))) {
    process.stderr.write(`Evidence target already exists: ${resolve(options.outputDirectory)}\n`);
    return 2;
  }
  try {
    return await runGate(options);
  } catch (error) {
    process.stderr.write(
      `Could not record release evidence: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
