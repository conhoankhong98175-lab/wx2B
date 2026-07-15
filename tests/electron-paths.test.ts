import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveApplicationRoot, resolveServerEntryUrl } = require('../electron/paths.cjs') as {
  resolveApplicationRoot: (applicationPath: string) => string;
  resolveServerEntryUrl: (applicationPath: string) => string;
};

describe('Electron application paths', () => {
  it('turns a Windows path with spaces and CJK text into a file URL', () => {
    const applicationPath = String.raw`C:\安装目录\店告 助手\resources\app`;
    const expectedEntry = join(applicationPath, 'dist', 'server', 'index.mjs');

    expect(resolveApplicationRoot(applicationPath)).toBe(applicationPath);
    expect(resolveServerEntryUrl(applicationPath)).toBe(pathToFileURL(expectedEntry).href);
    expect(resolveServerEntryUrl(applicationPath)).toMatch(/^file:\/\/\//);
    expect(resolveServerEntryUrl(applicationPath)).not.toMatch(/^c:/i);
  });

  it('uses app.asar.unpacked for runtime server resources', () => {
    const applicationPath = String.raw`C:\安装目录\店告 助手\resources\app.asar`;
    const unpackedPath = `${applicationPath}.unpacked`;

    expect(resolveApplicationRoot(applicationPath)).toBe(unpackedPath);
    expect(resolveServerEntryUrl(applicationPath)).toBe(
      pathToFileURL(join(unpackedPath, 'dist', 'server', 'index.mjs')).href,
    );
  });
});
