import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ENV_FILE_PARENT_LEVELS, getAdminUrl, listEnvSearchDirs, loadEnvFiles } from '../src/lib/config.js';
import { PigeonClient } from '../src/lib/pigeon-client.js';

/** A tree `<root>/a/b/c/d/e/f`, returned as the list of its directories from the root down. */
function makeTree(): string[] {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pigeon-env-')));
  const dirs = [root];
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const next = path.join(dirs[dirs.length - 1] ?? root, name);
    mkdirSync(next);
    dirs.push(next);
  }
  return dirs;
}

function writeEnv(dir: string | undefined, text: string): void {
  writeFileSync(path.join(dir ?? '', '.env'), text);
}

describe('listEnvSearchDirs', () => {
  it('lists the start directory and four parents, nearest first', () => {
    const dirs = makeTree();
    const start = dirs[6] ?? '';
    assert.equal(ENV_FILE_PARENT_LEVELS, 4);
    assert.deepEqual(listEnvSearchDirs(start), [dirs[6], dirs[5], dirs[4], dirs[3], dirs[2]]);
  });

  it('stops at the filesystem root', () => {
    assert.deepEqual(listEnvSearchDirs('/'), ['/']);
  });
});

describe('loadEnvFiles', () => {
  it('lets the real environment win over every file', () => {
    const dirs = makeTree();
    writeEnv(dirs[6], 'PIGEON_ADMIN_URL=http://from-file.test\n');
    const env: NodeJS.ProcessEnv = { PIGEON_ADMIN_URL: 'http://from-env.test' };
    loadEnvFiles({ startDir: dirs[6], env });
    assert.equal(env.PIGEON_ADMIN_URL, 'http://from-env.test');
  });

  it('reads the start directory first and a parent next, so the nearer file wins', () => {
    const dirs = makeTree();
    writeEnv(dirs[6], 'PIGEON_ADMIN_URL=http://near.test\n');
    writeEnv(dirs[4], 'PIGEON_ADMIN_URL=http://far.test\nPIGEON_ADMIN_SECRET=from-parent\n');
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadEnvFiles({ startDir: dirs[6], env });
    assert.equal(env.PIGEON_ADMIN_URL, 'http://near.test');
    assert.equal(env.PIGEON_ADMIN_SECRET, 'from-parent');
    assert.deepEqual(loaded, [path.join(dirs[6] ?? '', '.env'), path.join(dirs[4] ?? '', '.env')]);
  });

  it('reads up to four parents and no farther', () => {
    const dirs = makeTree();
    writeEnv(dirs[2], 'PIGEON_ADMIN_SECRET=four-levels-up\n');
    writeEnv(dirs[1], 'PIGEON_TENANT_KEY=five-levels-up\n');
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles({ startDir: dirs[6], env });
    assert.equal(env.PIGEON_ADMIN_SECRET, 'four-levels-up');
    assert.equal(env.PIGEON_TENANT_KEY, undefined);
  });

  it('skips an empty entry, so a blank line cannot hide a value in a farther file', () => {
    const dirs = makeTree();
    writeEnv(dirs[6], 'PIGEON_ADMIN_URL=\nPIGEON_ADMIN_SECRET=\n');
    writeEnv(dirs[5], 'PIGEON_ADMIN_URL=http://far.test\n');
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles({ startDir: dirs[6], env });
    assert.equal(env.PIGEON_ADMIN_URL, 'http://far.test');
    assert.equal(env.PIGEON_ADMIN_SECRET, undefined);
  });

  it('starts at INIT_CWD when it is set', () => {
    const dirs = makeTree();
    writeEnv(dirs[3], 'PIGEON_ADMIN_SECRET=from-init-cwd\n');
    const env: NodeJS.ProcessEnv = { INIT_CWD: dirs[3] };
    loadEnvFiles({ env });
    assert.equal(env.PIGEON_ADMIN_SECRET, 'from-init-cwd');
  });
});

describe('the admin URL has no default', () => {
  it('throws a clear error when PIGEON_ADMIN_URL is not set', () => {
    const before = process.env.PIGEON_ADMIN_URL;
    delete process.env.PIGEON_ADMIN_URL;
    try {
      assert.throws(() => getAdminUrl(), /PIGEON_ADMIN_URL is not set/);
      assert.throws(() => new PigeonClient(), /PIGEON_ADMIN_URL is not set/);
    } finally {
      if (before !== undefined) process.env.PIGEON_ADMIN_URL = before;
    }
  });
});
