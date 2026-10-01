import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadConfig,
  updateUserConfig,
  userConfigPath,
  isPublishMode,
  DEFAULT_API_URL,
} from '../src/config';

describe('config', () => {
  let home: string;
  let repo: string;
  const env = () => ({ HOME: home }) as NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-config-home-')));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assert-config-repo-')));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('defaults to uploading to the public API with no token', () => {
    expect(loadConfig(repo, env())).toEqual({ apiUrl: DEFAULT_API_URL, token: undefined, publish: 'assert' });
  });

  it('layers user config, repo config, then environment', () => {
    updateUserConfig({ apiUrl: 'https://user.example/', token: 'user-token', publish: 'repo' }, env());
    expect(loadConfig(repo, env())).toEqual({
      apiUrl: 'https://user.example',
      token: 'user-token',
      publish: 'repo',
    });

    fs.mkdirSync(path.join(repo, '.assert'));
    fs.writeFileSync(
      path.join(repo, '.assert', 'config.json'),
      JSON.stringify({ token: 'repo-token', publish: 'assert' }),
    );
    expect(loadConfig(repo, env())).toMatchObject({ token: 'repo-token', publish: 'assert' });

    expect(
      loadConfig(repo, { ...env(), ASSERT_TOKEN: 'env-token', ASSERT_PUBLISH: 'none', ASSERT_API_URL: 'http://localhost:1' }),
    ).toEqual({ apiUrl: 'http://localhost:1', token: 'env-token', publish: 'none' });
  });

  it('ignores malformed files and unknown publish modes', () => {
    fs.mkdirSync(path.dirname(userConfigPath(env())), { recursive: true });
    fs.writeFileSync(userConfigPath(env()), '{not json');
    expect(loadConfig(repo, env()).publish).toBe('assert');
    expect(loadConfig(repo, { ...env(), ASSERT_PUBLISH: 'cloud' }).publish).toBe('assert');
    expect(isPublishMode('repo')).toBe(true);
    expect(isPublishMode('cloud')).toBe(false);
  });

  it('writes the user config owner-only and removes keys set to null', () => {
    updateUserConfig({ token: 'secret' }, env());
    const file = userConfigPath(env());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ token: 'secret' });
    updateUserConfig({ token: null, publish: 'none' }, env());
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ publish: 'none' });
  });
});
