import { packager as packageElectron } from '@electron/packager';
import { listPackage } from '@electron/asar';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'out');
const packageInput = resolve(output, '.package-input');
const runtimeFiles = new Set([
  'package.json',
  'THIRD_PARTY_NOTICES.md',
  'electron/main.cjs',
  'electron/paths.cjs',
  'electron/secret.cjs',
  'assets/icon.ico',
  'assets/fonts/NotoSansCJKsc-Regular.otf',
  'assets/fonts/OFL.txt',
]);

function normalizedArchivePath(path) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isAllowedApplicationEntry(path) {
  const normalized = normalizedArchivePath(path);
  return (
    normalized === 'dist' ||
    normalized.startsWith('dist/') ||
    runtimeFiles.has(normalized) ||
    [...runtimeFiles].some((file) => file.startsWith(`${normalized}/`))
  );
}

function isSensitiveEntry(path) {
  const normalized = normalizedArchivePath(path);
  return (
    /(^|\/)(?:\.env[^/]*|\.local-secret|cookies(?:-journal)?|desktop-smoke\.png)(?:\/|$)/i.test(
      normalized,
    ) ||
    /(^|\/)(?:smoke-data|release-smoke)(?:\/|$)/i.test(normalized) ||
    /(^|\/)[^/]*\.db[^/]*$/i.test(normalized)
  );
}

function listFiles(directory, prefix = '') {
  const entries = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) entries.push(...listFiles(join(directory, item.name), relativePath));
    else entries.push(relativePath);
  }
  return entries;
}

function cleanupPackagingTemps() {
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('win32-x64-template-')) {
      rmSync(resolve(output, entry.name), { recursive: true, force: true });
    }
  }
}

rmSync(packageInput, { recursive: true, force: true });
mkdirSync(packageInput, { recursive: true });
cpSync(resolve(root, 'dist'), resolve(packageInput, 'dist'), { recursive: true });
for (const file of runtimeFiles) {
  mkdirSync(resolve(packageInput, dirname(file)), { recursive: true });
  copyFileSync(resolve(root, file), resolve(packageInput, file));
}

let paths;
const originalRename = fsPromises.rename.bind(fsPromises);
fsPromises.rename = async (source, destination) => {
  try {
    await originalRename(source, destination);
  } catch (error) {
    const sourcePath = resolve(String(source));
    const destinationPath = resolve(String(destination));
    const isPackagerInitialization =
      sourcePath.startsWith(`${output}\\win32-x64-template-`) &&
      destinationPath === resolve(output, 'DiangaoQuoteAssistant-win32-x64');
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EPERM' ||
      !isPackagerInitialization
    ) {
      throw error;
    }
    await fsPromises.cp(source, destination, {
      force: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    await fsPromises.rm(source, { force: true, recursive: true });
  }
};
try {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    cleanupPackagingTemps();
    try {
      paths = await packageElectron({
        dir: packageInput,
        out: output,
        tmpdir: false,
        overwrite: true,
        platform: 'win32',
        arch: 'x64',
        asar: { unpackDir: '{dist,assets}' },
        prune: false,
        name: 'DiangaoQuoteAssistant',
        executableName: '店告报价助手',
        icon: resolve(root, 'assets', 'icon.ico'),
        afterExtract: [async () => delay(1_500)],
      });
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EPERM' ||
        attempt === 3
      ) {
        throw error;
      }
      await delay(attempt * 1_500);
    }
  }
} finally {
  fsPromises.rename = originalRename;
  cleanupPackagingTemps();
  rmSync(packageInput, { recursive: true, force: true });
}

if (paths.length !== 1)
  throw new Error(`Expected one packaged application, received ${paths.length}`);

const archivePath = join(paths[0], 'resources', 'app.asar');
const archiveEntries = listPackage(archivePath, { isPack: false });
const unpackedRoot = `${archivePath}.unpacked`;
const unpackedEntries = listFiles(unpackedRoot);
const unexpectedEntries = archiveEntries.filter((entry) => !isAllowedApplicationEntry(entry));
const sensitiveEntries = [...archiveEntries, ...unpackedEntries].filter(isSensitiveEntry);
const unexpectedUnpackedEntries = unpackedEntries.filter((entry) => {
  const normalized = normalizedArchivePath(entry);
  return !normalized.startsWith('dist/') && !runtimeFiles.has(normalized);
});
if (unexpectedEntries.length > 0) {
  throw new Error(
    `Unexpected files entered app.asar: ${unexpectedEntries.slice(0, 10).join(', ')}`,
  );
}
if (unexpectedUnpackedEntries.length > 0) {
  throw new Error(
    `Unexpected files entered app.asar.unpacked: ${unexpectedUnpackedEntries.slice(0, 10).join(', ')}`,
  );
}
if (sensitiveEntries.length > 0) {
  throw new Error(
    `Sensitive files entered the application package: ${sensitiveEntries.join(', ')}`,
  );
}
process.stdout.write(`Packaged Windows application: ${paths[0]}\n`);
