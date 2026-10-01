// Assembles the org plugin into plugin/ (committed, so this repository is the
// marketplace) and the marketplace manifests at the repository root, from the
// freshly built CLI bundle:  pnpm build:plugin
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateOrgPlugin, generateMarketplaceManifests, ORG_PLUGIN_DIR } from '../src/org-plugin';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const bundle = path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(bundle)) {
  console.error('dist/cli.js missing: run `pnpm build` first');
  process.exit(1);
}
const out = path.join(root, ORG_PLUGIN_DIR);
fs.rmSync(out, { recursive: true, force: true });
const files = generateOrgPlugin({ version: pkg.version, cliBundle: fs.readFileSync(bundle, 'utf-8') });
for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, rel.endsWith('.sh') ? { mode: 0o755 } : undefined);
}
for (const [rel, content] of Object.entries(generateMarketplaceManifests())) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
console.log(`plugin v${pkg.version} -> ${ORG_PLUGIN_DIR}/ (${Object.keys(files).length} files) + marketplace manifests`);
