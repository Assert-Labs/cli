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

## Committing

- **Do not default to committing unless the user explicitly asks.** Do not default to
  committing when a task looks done, when tests pass, or to "save progress."
  Finishing a change typically means the edits are made and verified (typecheck/test) and
  left in the working tree. Wait for an explicit "commit".
- Same rule for `git push`, branch creation, and PRs — git actions need an explicit request.

## Where tests go

Put new tests in the existing file that covers the area before creating a new
one. Tests live under `tests/`, mirroring the `src/` layout — one file per
`src/` module at the matching path (e.g. `tests/session-writer.test.ts` for
`src/session-writer.ts`, `tests/hooks/codex.test.ts` for
`src/hooks/codex.ts`). Tests use Vitest; import the unit under test with the
matching relative depth (`../src/...` at the top level, `../../src/...` under
`tests/hooks/`).

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
This is your product — `assert init` so your session data lands in
`.sessions/`. When you do commit (only once asked — see **Committing**), generally keep
the session data in the PR unless specifically asked otherwise.
