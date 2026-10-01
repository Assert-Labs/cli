/**
 * Assert configuration: where captured sessions are published once they leave
 * the local mirror, and how the CLI reaches the Assert API.
 *
 * Sources, highest precedence first: `ASSERT_*` environment variables, the
 * repo's `.assert/config.json`, the user's `~/.assert/config.json`, defaults.
 * A repo config is committed, so it may carry a repo-scoped write token and
 * a publish mode for everyone who clones it; the user config is per machine.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Where a session goes after it is captured locally. */
export type PublishMode = 'assert' | 'repo' | 'none';

export interface AssertConfig {
  /** Base URL of the Assert API, without a trailing slash. */
  apiUrl: string;
  /** Bearer token for uploads; absent means nothing is uploaded yet. */
  token?: string;
  /** `assert` uploads to the API, `repo` writes `.sessions/`, `none` keeps
   * sessions in the local mirror only. */
  publish: PublishMode;
}

export const DEFAULT_API_URL = 'https://api.assert.dev';
export const PUBLISH_MODES: readonly PublishMode[] = ['assert', 'repo', 'none'];

type RawConfig = Partial<Record<keyof AssertConfig, unknown>>;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || '';
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), '.assert', 'config.json');
}

export function repoConfigPath(gitRoot: string): string {
  return path.join(gitRoot, '.assert', 'config.json');
}

function readJson(file: string): RawConfig {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function isPublishMode(value: unknown): value is PublishMode {
  return PUBLISH_MODES.includes(value as PublishMode);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asMode(value: unknown): PublishMode | undefined {
  return isPublishMode(value) ? value : undefined;
}

/** The effective configuration for a repo (or, without one, for the machine). */
export function loadConfig(
  gitRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): AssertConfig {
  const user = readJson(userConfigPath(env));
  const repo = gitRoot ? readJson(repoConfigPath(gitRoot)) : {};
  const apiUrl =
    asString(env.ASSERT_API_URL) ?? asString(repo.apiUrl) ?? asString(user.apiUrl) ?? DEFAULT_API_URL;
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    token: asString(env.ASSERT_TOKEN) ?? asString(repo.token) ?? asString(user.token),
    publish: asMode(env.ASSERT_PUBLISH) ?? asMode(repo.publish) ?? asMode(user.publish) ?? 'assert',
  };
}

/** Values the user config file may hold; `null` removes a key. */
export type UserConfigPatch = {
  [K in keyof AssertConfig]?: AssertConfig[K] | null;
};

/** Merge `patch` into `~/.assert/config.json` and return the stored object.
 * The file may hold a token, so it is created owner-readable only. */
export function updateUserConfig(
  patch: UserConfigPatch,
  env: NodeJS.ProcessEnv = process.env,
): RawConfig {
  const file = userConfigPath(env);
  const current = readJson(file);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete current[key as keyof AssertConfig];
    else current[key as keyof AssertConfig] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  return current;
}
