import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import parseSpdxExpression from 'spdx-expression-parse';

import {
  packageLayoutFailures,
  readManifest,
  releasePackages,
  workspaceRoot,
} from './verify-packages.mjs';

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function isRegisteredSpdxExpression(value) {
  if (!nonEmptyString(value)) return false;
  const expression = value.trim();
  if (/^(?:UNLICENSED|TEST(?:-|$)|SEE LICENSE\b)/i.test(expression)) return false;
  try {
    const parsed = parseSpdxExpression(expression);
    const usesCustomReference = (node) => {
      if (node === null || typeof node !== 'object') return false;
      if (
        typeof node.license === 'string' &&
        /(?:^|:)LicenseRef-/i.test(node.license)
      ) {
        return true;
      }
      return usesCustomReference(node.left) || usesCustomReference(node.right);
    };
    return !usesCustomReference(parsed);
  } catch {
    return false;
  }
}

function publicHttpsUrl(value) {
  if (!nonEmptyString(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hostname === 'localhost' ||
      url.hostname.endsWith('.invalid') ||
      url.hostname.endsWith('.test')
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function canonicalRepository(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.type !== 'git' || !nonEmptyString(value.url)) return undefined;
  const rawUrl = value.url.trim();
  const normalizedUrl = rawUrl.startsWith('git+https://') ? rawUrl.slice(4) : rawUrl;
  if (publicHttpsUrl(normalizedUrl) === undefined) return undefined;
  return { type: 'git', url: rawUrl };
}

function canonicalBugs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return publicHttpsUrl(value.url) === undefined ? undefined : { url: value.url.trim() };
}

export function releaseReadinessFailures({
  root = workspaceRoot,
  packageDirectories = releasePackages,
  inspectPackedArtifacts = true,
} = {}) {
  const failures = packageLayoutFailures({
    root,
    packageDirectories,
    inspectPackedArtifacts,
  });
  const rootReadme = resolve(root, 'README.md');
  const rootLicense = resolve(root, 'LICENSE');

  if (!existsSync(rootReadme) || readFileSync(rootReadme, 'utf8').trim() === '') {
    failures.push('workspace: README.md is required before public release');
  }

  let rootManifest = {};
  try {
    rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  } catch {
    failures.push('workspace: readable package.json is required before public release');
  }

  const hasRootLicense = existsSync(rootLicense);
  let rootLicenseText;
  if (!hasRootLicense) {
    failures.push('workspace: LICENSE is required before public release');
  } else {
    rootLicenseText = readFileSync(rootLicense, 'utf8');
    if (rootLicenseText.trim() === '') {
      failures.push('workspace: LICENSE must not be empty');
    }
  }

  const rootLicenseId = rootManifest.license;
  if (rootManifest.private !== true) {
    failures.push('workspace: root package must remain private');
  }
  if (!isRegisteredSpdxExpression(rootLicenseId)) {
    failures.push('workspace: a non-placeholder SPDX license expression is required');
  }
  const rootRepository = canonicalRepository(rootManifest.repository);
  if (rootRepository === undefined) {
    failures.push('workspace: canonical public git repository metadata is required');
  }
  const rootHomepage = publicHttpsUrl(rootManifest.homepage);
  if (rootHomepage === undefined) {
    failures.push('workspace: canonical public homepage metadata is required');
  }
  const rootBugs = canonicalBugs(rootManifest.bugs);
  if (rootBugs === undefined) {
    failures.push('workspace: canonical public issue URL metadata is required');
  }

  for (const directory of packageDirectories) {
    let manifest;
    try {
      manifest = readManifest(directory, root);
    } catch {
      continue;
    }
    const label = manifest.name ?? directory;
    if (Object.hasOwn(manifest, 'private')) {
      failures.push(`${label}: private must be removed before publishing`);
    }
    if (!sameJson(manifest.publishConfig, { access: 'public' })) {
      failures.push(`${label}: publishConfig.access must be public`);
    }
    if (!isRegisteredSpdxExpression(manifest.license)) {
      failures.push(`${label}: a non-placeholder SPDX license expression is required`);
    } else if (manifest.license !== rootLicenseId) {
      failures.push(`${label}: license metadata must match the workspace license`);
    }

    const expectedRepository =
      rootRepository === undefined ? undefined : { ...rootRepository, directory };
    if (expectedRepository === undefined || !sameJson(manifest.repository, expectedRepository)) {
      failures.push(`${label}: repository must match the canonical URL and package directory`);
    }
    if (rootHomepage === undefined || manifest.homepage !== rootManifest.homepage) {
      failures.push(`${label}: homepage must match the canonical workspace homepage`);
    }
    if (rootBugs === undefined || !sameJson(manifest.bugs, rootBugs)) {
      failures.push(`${label}: bugs must match the canonical workspace issue URL`);
    }

    const packageLicense = resolve(root, directory, 'LICENSE');
    if (!existsSync(packageLicense)) {
      failures.push(`${label}: package LICENSE is required in the published tarball`);
    } else {
      const packageLicenseText = readFileSync(packageLicense, 'utf8');
      if (packageLicenseText.trim() === '') {
        failures.push(`${label}: package LICENSE must not be empty`);
      } else if (rootLicenseText !== undefined && packageLicenseText !== rootLicenseText) {
        failures.push(`${label}: package LICENSE must match the workspace LICENSE`);
      }
    }
  }

  const publicDirectories = new Set(packageDirectories);
  const packagesRoot = resolve(root, 'packages');
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `packages/${entry.name}`;
      if (publicDirectories.has(directory)) continue;
      const manifestPath = resolve(packagesRoot, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.private !== true) {
          failures.push(
            `${manifest.name ?? directory}: non-release workspace package must remain private`,
          );
        }
      } catch {
        failures.push(`${directory}: non-release package.json could not be read`);
      }
    }
  }
  return failures;
}

function main() {
  execFileSync('pnpm', ['build'], { cwd: workspaceRoot, stdio: 'inherit' });
  const failures = releaseReadinessFailures();
  if (failures.length > 0) {
    process.stderr.write(`Public release is blocked:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Public release verification passed.\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
