/**
 * @fileoverview The one credential reader `codeman attach`, `codeman tui` and
 * `codeman agent` share: env first, the data dir's `.env` as the fallback.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basicAuthHeader, readCodemanCredentials, readCodemanEnvFile } from '../src/codeman-credentials.js';

describe('readCodemanCredentials', () => {
  let dir: string;
  const saved = { user: process.env.CODEMAN_USERNAME, pass: process.env.CODEMAN_PASSWORD };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-cred-'));
    delete process.env.CODEMAN_USERNAME;
    delete process.env.CODEMAN_PASSWORD;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.user === undefined) delete process.env.CODEMAN_USERNAME;
    else process.env.CODEMAN_USERNAME = saved.user;
    if (saved.pass === undefined) delete process.env.CODEMAN_PASSWORD;
    else process.env.CODEMAN_PASSWORD = saved.pass;
  });

  it('falls back to the .env file, quotes and an export prefix stripped, default user admin', () => {
    const env = join(dir, '.env');
    writeFileSync(env, '# a comment\nnot an assignment\nexport CODEMAN_PASSWORD="hunter2"\n');
    expect(readCodemanCredentials(env)).toEqual({ username: 'admin', password: 'hunter2' });
  });

  it('prefers the environment over the file', () => {
    const env = join(dir, '.env');
    writeFileSync(env, 'CODEMAN_USERNAME=file\nCODEMAN_PASSWORD=file-pass\n');
    process.env.CODEMAN_USERNAME = 'envuser';
    process.env.CODEMAN_PASSWORD = 'env-pass';
    expect(readCodemanCredentials(env)).toEqual({ username: 'envuser', password: 'env-pass' });
  });

  it('an absent file means no password, and no header to send', () => {
    const creds = readCodemanCredentials(join(dir, 'missing'));
    expect(creds).toEqual({ username: 'admin' });
    expect(basicAuthHeader(creds)).toBeUndefined();
    expect(readCodemanEnvFile(join(dir, 'missing'))).toEqual({});
  });

  it('takes an explicit environment, field by field', () => {
    const env = join(dir, '.env');
    writeFileSync(env, 'CODEMAN_USERNAME=joe\n');
    expect(readCodemanCredentials(env, { CODEMAN_PASSWORD: 'pw' })).toEqual({ username: 'joe', password: 'pw' });
  });

  it('builds a Basic header from a password', () => {
    expect(basicAuthHeader({ username: 'joe', password: 'pw' })).toBe(
      `Basic ${Buffer.from('joe:pw').toString('base64')}`
    );
  });
});
