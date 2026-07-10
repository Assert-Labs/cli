// Builds the CLI with esbuild, injecting the package version into the bundle as
// the `__ASSERT_VERSION__` global (read at runtime via the VERSION constant in
// src/cli.ts). Two targets:
//   node scripts/build.mjs esm   -> dist/cli.js      (ESM, for npm / `assert.js`)
//   node scripts/build.mjs sea   -> dist/sea/cli.cjs (CJS, for the SEA release)
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

const target = process.argv[2];

const common = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  define: { __ASSERT_VERSION__: JSON.stringify(pkg.version) },
};

if (target === 'esm') {
  await esbuild.build({
    ...common,
    format: 'esm',
    outfile: 'dist/cli.js',
    // Keep Node builtins external (matches the previous inline build).
    external: ['fs', 'path', 'child_process', 'os', 'crypto'],
  });
  // The `@assertlabs/cli/core` subpath: pure, node-free interpretation layer.
  await esbuild.build({
    entryPoints: ['src/core.ts'],
    bundle: true,
    format: 'esm',
    outfile: 'dist/core.js',
  });
  execSync('tsc -p tsconfig.core.json', { stdio: 'inherit' });
} else if (target === 'sea') {
  await esbuild.build({
    ...common,
    format: 'cjs',
    outfile: 'dist/sea/cli.cjs',
  });
} else {
  console.error('Usage: node scripts/build.mjs <esm|sea>');
  process.exit(1);
}
