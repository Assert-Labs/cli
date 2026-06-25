# AGENTS.md

Guidance for coding agents (and humans) working in this repo. For project
context, contribution process, and security policy, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## The bar

- **All changes must be tested.** If you didn't add or update a test, you're not
  done. Bug fixes get a regression test that fails before the fix and passes
  after.
- **Run the tests. If you didn't run them, the code does not work.** A change is
  finished only when `pnpm test` and `pnpm typecheck` both pass locally — the
  same checks CI enforces.
- **Type-check the whole repo, not just src.** `pnpm typecheck` covers `src/`
  and `tests/` (via `tsconfig.test.json`). Keep it green; no `as any` to silence
  the checker — fix the type at its source.
- **Match the surrounding code.** Check neighboring files for naming, structure,
  and comment style before introducing your own. Prefer the existing pattern
  over a new one.

## Where tests go

Put new tests in the existing file that covers the area before creating a new
one — tests live in `tests/`, one file per `src/` module (e.g.
`tests/session-writer.test.ts` for `src/session-writer.ts`). Tests use Vitest;
import the unit under test from `../src/...`.

## Commands

```bash
pnpm install          # install deps (CI uses --frozen-lockfile)
pnpm typecheck        # tsc over src + tests, no emit
pnpm test             # vitest run (single pass)
pnpm test:watch       # vitest in watch mode
pnpm build            # esbuild bundle -> dist/cli.js (ESM)
pnpm build:sea        # CJS bundle for the single-executable (SEA) release
pnpm dev -- <args>    # run the CLI from source via tsx
```

## Before requesting review

Run `pnpm typecheck`, `pnpm test`, and `pnpm build`, and make sure CI is green.
This is your product — `assert install` and commit normally so your session data
lands in `.sessions/`; leave it in the PR.
