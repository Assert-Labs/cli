#!/usr/bin/env node
// npm / from-source entry. The CLI bundle (dist/cli.js) is ESM and does not
// self-run when imported, so invoke its exported run() explicitly. The SEA
// build self-runs instead (see the require.main guard in src/cli.ts).
import { run } from '../dist/cli.js';
run();
