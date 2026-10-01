/**
 * The Assert plugin an organization installs once so every cloud session
 * captures without touching a repo: Claude Code via managed settings, Devin as
 * an org-required plugin, Codex and Cursor locally from a marketplace.
 *
 * One directory carries every host's manifest side by side. Each host reads
 * only its own files, verified against real cloud sessions:
 *
 * - Claude Code honors the `hooks` path in `.claude-plugin/plugin.json`.
 * - Devin ignores that path and reads a bare `hooks.json` at the plugin root.
 * - Codex and Cursor take the path in their own manifests.
 *
 * Hooks run the bundled CLI through `scripts/run.sh`, which finds a Node
 * binary even where the hook environment has no PATH to one (Devin).
 */

import { DEVIN_HOOK_EVENTS } from './plugins';

const CLAUDE_EVENTS = ['SessionStart', 'SessionEnd', 'Stop', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'];
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const CURSOR_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'stop',
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'afterFileEdit',
];

/** This repository is the marketplace; the plugin is its `plugin/` directory. */
export const ORG_PLUGIN_REPO = 'Assert-Labs/cli';
export const ORG_PLUGIN_DIR = 'plugin';
export const ORG_PLUGIN_NAME = 'assert';

const DESCRIPTION = 'Capture AI coding sessions for code attribution and review';

/** A hook command for hosts that expand `${CLAUDE_PLUGIN_ROOT}` in commands. */
function pluginCommand(agent: string, event: string): string {
  return `sh "\${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ${agent} ${event}`;
}

/** Claude Code's hooks shape, shared by Codex. */
function claudeShape(agent: string, events: string[]): unknown {
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ type: 'command', command: pluginCommand(agent, event) }] }];
  }
  return { hooks };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The runner every hook goes through. POSIX sh: finds `node` on PATH or in the
 * usual install locations, then runs the bundled CLI with the hook payload
 * still on stdin. Exits 0 without node so a missing runtime never fails a
 * tool call; capture is simply unavailable there.
 */
export const RUN_SH = `#!/bin/sh
# Assert hook runner (generated). Finds Node and runs the bundled CLI:
#   run.sh <agent> <event>   with the hook payload on stdin.
set -u
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_bin=""
if command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
else
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node \\
    "$HOME"/.nvm/versions/node/*/bin/node /opt/node*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \\
    "$HOME"/.volta/bin/node; do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
[ -n "$node_bin" ] || exit 0
exec "$node_bin" "$root/dist/cli.mjs" hook "$@"
`;

export interface OrgPluginOptions {
  version: string;
  /** The built ESM CLI bundle, shipped as dist/cli.mjs. */
  cliBundle: string;
}

/** Every file of the plugin, keyed by path relative to the plugin root. */
export function generateOrgPlugin(options: OrgPluginOptions): Record<string, string> {
  const { version } = options;
  const meta = {
    name: ORG_PLUGIN_NAME,
    version,
    description: DESCRIPTION,
    author: { name: 'Assert Labs' },
    homepage: 'https://assert.dev',
    repository: `https://github.com/${ORG_PLUGIN_REPO}`,
    license: 'MIT',
  };

  const devinHooks: Record<string, unknown> = {};
  for (const event of DEVIN_HOOK_EVENTS) {
    // Devin's hook processes carry CLAUDE_PLUGIN_ROOT in the environment, so
    // the shell expands it whether or not Devin templates the command.
    devinHooks[event] = [
      { hooks: [{ type: 'command', command: `sh "$CLAUDE_PLUGIN_ROOT/scripts/run.sh" devin ${event}`, timeout: 30 }] },
    ];
  }

  const cursorHooks: Record<string, unknown> = {};
  for (const event of CURSOR_EVENTS) cursorHooks[event] = [{ command: pluginCommand('cursor', event) }];

  return {
    '.claude-plugin/plugin.json': json({ ...meta, hooks: './hooks/claude.json' }),
    '.codex-plugin/plugin.json': json({ ...meta, hooks: './hooks/codex.json' }),
    '.cursor-plugin/plugin.json': json({ ...meta, hooks: './hooks/cursor.json' }),
    'hooks/claude.json': json(claudeShape('claude-code', CLAUDE_EVENTS)),
    'hooks/codex.json': json(claudeShape('codex', CODEX_EVENTS)),
    'hooks/cursor.json': json({ hooks: cursorHooks }),
    'hooks.json': json(devinHooks),
    'scripts/run.sh': RUN_SH,
    'dist/cli.mjs': options.cliBundle,
    'README.md': readme(version),
  };
}

/**
 * The marketplace manifests at the repository root, each listing the plugin
 * by its relative path so "add marketplace → this repo" is the whole install.
 * Claude Code and Codex both read `.claude-plugin/marketplace.json`; Cursor
 * reads `.cursor-plugin/marketplace.json`.
 */
export function generateMarketplaceManifests(): Record<string, string> {
  const manifest = json({
    name: ORG_PLUGIN_NAME,
    description: DESCRIPTION,
    owner: { name: 'Assert Labs', url: 'https://assert.dev' },
    plugins: [{ name: ORG_PLUGIN_NAME, source: `./${ORG_PLUGIN_DIR}`, description: DESCRIPTION }],
  });
  return {
    '.claude-plugin/marketplace.json': manifest,
    '.cursor-plugin/marketplace.json': manifest,
  };
}

/** The managed-settings block a Claude Code org owner pastes once. */
export function claudeManagedSettings(): string {
  return json({
    env: { CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1' },
    extraKnownMarketplaces: {
      [ORG_PLUGIN_NAME]: { source: { source: 'github', repo: ORG_PLUGIN_REPO }, autoUpdate: true },
    },
    enabledPlugins: { [`${ORG_PLUGIN_NAME}@${ORG_PLUGIN_NAME}`]: true },
  });
}

/** The Devin org-manifest entry. */
export function devinRequiredPlugin(): string {
  return json({
    requiredPlugins: [
      { source: 'git-subdir', url: `https://github.com/${ORG_PLUGIN_REPO}.git`, path: ORG_PLUGIN_DIR },
    ],
  });
}

function readme(version: string): string {
  return `# Assert plugin (v${version})

Capture AI coding sessions for code attribution and review. Generated by
\`pnpm build:plugin\` in https://github.com/${ORG_PLUGIN_REPO} — do not edit here.

Install it by adding that repository as a marketplace (Claude Code, Codex,
Cursor) or with \`devin plugins install ${ORG_PLUGIN_REPO}#${ORG_PLUGIN_DIR}\`. See the
repository README for the one-step setup per host.
`;
}
