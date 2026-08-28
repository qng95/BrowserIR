import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = 'browserir';
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const parseJson = (source, label) => {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export function candidateManifestFailures(manifest, archiveName) {
  const failures = [];
  if (manifest?.name !== packageName) failures.push(`package name must be ${packageName}`);
  if (typeof manifest?.version !== 'string' || !semverPattern.test(manifest.version)) {
    failures.push('package version must be valid SemVer');
  } else if (archiveName !== `browserir-${manifest.version}.tgz`) {
    failures.push('archive filename must match the embedded package version');
  }
  if (manifest?.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    failures.push('publish registry must be https://registry.npmjs.org/');
  }
  if (manifest?.publishConfig?.access !== 'public') failures.push('package access must be public');
  if (manifest?.publishConfig?.tag !== 'latest') failures.push('package dist-tag must be latest');
  return failures;
}

export function auditPayloadFailures(payload) {
  const failures = [];
  const vulnerabilities = payload?.metadata?.vulnerabilities;
  if (vulnerabilities === null || typeof vulnerabilities !== 'object') {
    failures.push('npm audit did not return vulnerability metadata');
    return failures;
  }
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    if (vulnerabilities[severity] !== 0) {
      failures.push(`npm audit reported ${String(vulnerabilities[severity])} ${severity} vulnerabilities`);
    }
  }
  if (
    payload.vulnerabilities === null ||
    typeof payload.vulnerabilities !== 'object' ||
    Object.keys(payload.vulnerabilities).length !== 0
  ) failures.push('npm audit returned one or more vulnerability records');
  return failures;
}

function parseArguments(argv) {
  let archive;
  let report;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--archive' || argument === '--report') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a path.`);
      }
      if (argument === '--archive') archive = resolve(value);
      else report = resolve(value);
      index += 1;
    } else if (argument === '--help') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (archive === undefined) throw new Error('--archive is required.');
  return { help: false, archive, report };
}

function isolatedNpmEnvironment(temporaryRoot) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^npm_config_/iu.test(key) ||
      /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu.test(key)
    ) delete environment[key];
  }
  const userConfig = join(temporaryRoot, 'empty-user.npmrc');
  writeFileSync(userConfig, '', { flag: 'wx' });
  environment.NPM_CONFIG_USERCONFIG = userConfig;
  environment.NPM_CONFIG_CACHE = join(temporaryRoot, 'npm-cache');
  environment.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  environment.NPM_CONFIG_FUND = 'false';
  return environment;
}

function runNpm(arguments_, options) {
  return execFileSync('npm', arguments_, {
    ...options,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 180_000,
  });
}

export function auditBrowserIrArchive({ archive, reportPath }) {
  const resolvedArchive = resolve(archive);
  const archiveStatus = lstatSync(resolvedArchive);
  if (!archiveStatus.isFile() || archiveStatus.isSymbolicLink()) {
    throw new Error('Release archive must be a regular file, not a link.');
  }
  const realArchive = realpathSync(resolvedArchive);
  const archiveName = basename(realArchive);
  if (!archiveName.endsWith('.tgz')) throw new Error('Release archive must use the .tgz extension.');

  const packedManifest = parseJson(
    execFileSync('tar', ['-xOf', realArchive, 'package/package.json'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    }),
    'Packed package.json',
  );
  const manifestFailures = candidateManifestFailures(packedManifest, archiveName);
  if (manifestFailures.length > 0) {
    throw new Error(`Archive manifest is blocked:\n- ${manifestFailures.join('\n- ')}`);
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'browserir-archive-audit-'));
  try {
    const consumerRoot = join(temporaryRoot, 'consumer');
    mkdirSync(consumerRoot);
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: 'browserir-archive-audit-consumer',
      version: '0.0.0',
      private: true,
      type: 'module',
    }, null, 2)}\n`, { flag: 'wx' });
    const environment = isolatedNpmEnvironment(temporaryRoot);

    runNpm([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      realArchive,
    ], { cwd: consumerRoot, env: environment });

    const probe = [
      "const main = await import('browserir');",
      "const policies = await import('browserir/reference-policies');",
      "if (typeof main.createAdaptivePlaywrightTools !== 'function') throw new Error('missing main factory');",
      "for (const name of ['createGridCoordinateReferencePolicy', 'createScheduleCoordinateReferencePolicy', 'createCrossTreeLabelReferencePolicy']) {",
      "  if (typeof policies[name] !== 'function') throw new Error(`missing policy factory ${name}`);",
      '}',
    ].join('\n');
    execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
      cwd: consumerRoot,
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    });

    const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=low', '--json'], {
      cwd: consumerRoot,
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 180_000,
    });
    const auditPayload = parseJson(audit.stdout, 'npm audit output');
    const auditFailures = auditPayloadFailures(auditPayload);
    if (audit.status !== 0 || auditFailures.length > 0) {
      throw new Error(`Production dependency audit is blocked:\n- ${[
        ...(audit.status === 0 ? [] : [`npm audit exited with status ${String(audit.status)}`]),
        ...auditFailures,
      ].join('\n- ')}`);
    }

    const archiveBytes = readFileSync(realArchive);
    const report = {
      schemaVersion: 'browserir-archive-audit/1',
      package: { name: packedManifest.name, version: packedManifest.version },
      archive: {
        filename: archiveName,
        bytes: statSync(realArchive).size,
        sha256: sha256(archiveBytes),
      },
      install: {
        lifecycleScripts: false,
        registry: 'https://registry.npmjs.org/',
        publicEntriesImported: ['.', './reference-policies'],
      },
      audit: {
        vulnerabilities: auditPayload.metadata.vulnerabilities,
        dependencies: auditPayload.metadata.dependencies,
      },
    };
    if (reportPath !== undefined) {
      const resolvedReport = resolve(reportPath);
      mkdirSync(dirname(resolvedReport), { recursive: true });
      writeFileSync(resolvedReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    }
    return report;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/audit-browserir-archive.mjs --archive PATH [--report PATH]\n',
    );
    return;
  }
  const report = auditBrowserIrArchive({
    archive: options.archive,
    reportPath: options.report,
  });
  process.stdout.write(
    `Archive consumer audit passed for ${report.package.name}@${report.package.version}: ` +
    `${report.audit.vulnerabilities.total} vulnerabilities.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
