import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const VERSION = JSON.stringify(pkg.version);

/**
 * Single-entry Node build. Injects __ALLSTAK_EXPRESS_VERSION__ from
 * package.json so the SDK always reports the version it ships under, with no
 * hand-edited constant to drift. `express` and `@allstak/js` stay external —
 * `express` is a peer dependency and `@allstak/js` is resolved from the host.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'node',
  external: ['express', '@allstak/js'],
  define: {
    __ALLSTAK_EXPRESS_VERSION__: VERSION,
  },
});
