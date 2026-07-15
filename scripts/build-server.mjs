import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  minify: false,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
