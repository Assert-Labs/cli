import { defineConfig } from 'vitest/config';

/**
 * Live agent capture tests. See tests/live/agents.live.ts.
 *
 * Separate from vitest.config.ts because these drive real agent binaries:
 * they need each agent installed and authenticated, spend tokens, and take
 * minutes. `pnpm test` must stay fast and hermetic, so they are opt-in via
 * `pnpm test:live`. They run serially: several agents write to the same
 * central session store.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
