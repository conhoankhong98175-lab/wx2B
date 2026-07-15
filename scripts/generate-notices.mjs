import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const packages = [];
const licenseTexts = new Map();

for (const [relativePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!relativePath.startsWith('node_modules/') || metadata.dev) continue;
  const directory = resolve(root, relativePath);
  const manifestPath = resolve(directory, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const name = manifest.name ?? basename(directory);
  const version = manifest.version ?? metadata.version ?? 'unknown';
  const license = manifest.license ?? metadata.license ?? 'See package license';
  packages.push({ name, version, license });

  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']) {
    const path = resolve(directory, candidate);
    if (!existsSync(path)) continue;
    const text = (await readFile(path, 'utf8')).trim();
    const hash = createHash('sha256').update(text).digest('hex');
    const existing = licenseTexts.get(hash) ?? { text, packages: [] };
    existing.packages.push(`${name}@${version}`);
    licenseTexts.set(hash, existing);
    break;
  }
}

packages.sort((left, right) => left.name.localeCompare(right.name, 'en'));
const lines = [
  '# Third-party notices',
  '',
  '店告的发行构建包含以下第三方开源软件。此文件由 `npm run notices` 根据锁文件和已安装依赖生成。',
  '',
  '| Package | Version | Declared license |',
  '| --- | --- | --- |',
  ...packages.map((item) => `| ${item.name} | ${item.version} | ${item.license} |`),
  '',
  '## License texts',
  '',
];

for (const entry of licenseTexts.values()) {
  lines.push(`### ${entry.packages.join(', ')}`, '', '```text', entry.text, '```', '');
}

await writeFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), `${lines.join('\n')}\n`, 'utf8');
