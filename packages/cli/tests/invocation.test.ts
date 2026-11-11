import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getInvocationDir, resolveFromInvocationDir } from '../src/lib/invocation.js';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));
const packageDir = fileURLToPath(new URL('..', import.meta.url));

describe('getInvocationDir', () => {
  it('uses INIT_CWD when a package runner set it', () => {
    assert.equal(getInvocationDir({ env: { INIT_CWD: '/work/repo' }, cwd: '/work/repo/packages/cli' }), '/work/repo');
  });

  it('uses the working directory when INIT_CWD is unset, empty or relative', () => {
    assert.equal(getInvocationDir({ env: {}, cwd: '/work/here' }), '/work/here');
    assert.equal(getInvocationDir({ env: { INIT_CWD: '' }, cwd: '/work/here' }), '/work/here');
    assert.equal(getInvocationDir({ env: { INIT_CWD: 'relative/dir' }, cwd: '/work/here' }), '/work/here');
  });
});

describe('resolveFromInvocationDir', () => {
  it('takes a relative path from the invocation directory, not from the package directory', () => {
    const env = { INIT_CWD: '/work/repo' };
    assert.equal(resolveFromInvocationDir('./pigeon.toml', { env, cwd: '/work/repo/packages/cli' }), '/work/repo/pigeon.toml');
    assert.equal(resolveFromInvocationDir('../other/pigeon.toml', { env, cwd: '/elsewhere' }), '/work/other/pigeon.toml');
  });

  it('keeps an absolute path as it is', () => {
    assert.equal(resolveFromInvocationDir('/abs/pigeon.toml', { env: { INIT_CWD: '/work/repo' }, cwd: '/x' }), '/abs/pigeon.toml');
  });
});

/** Runs the real CLI in a child. The child gets a clean INIT_CWD, so a pnpm run of this test cannot leak its own. */
async function runCli(opts: {
  args: string[];
  cwd: string;
  initCwd?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.INIT_CWD;
  if (opts.initCwd !== undefined) env.INIT_CWD = opts.initCwd;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', cliPath, ...opts.args], {
      cwd: opts.cwd,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: number | null; stdout?: string; stderr?: string };
    return { code: failure.code ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('a relative manifest path, through the real CLI', () => {
  it('resolves against INIT_CWD when the process runs somewhere else (the pnpm script case)', async () => {
    const result = await runCli({
      args: ['manifest', 'validate', './example.pigeon.toml'],
      cwd: packageDir,
      initCwd: examplesDir,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /is valid: app "my-app"/);
  });

  it('resolves against the working directory when no package runner is in between', async () => {
    const result = await runCli({ args: ['manifest', 'validate', 'example.pigeon.toml'], cwd: examplesDir });
    assert.equal(result.code, 0, result.stderr);
  });

  it('defaults to ./pigeon.toml in the invocation directory and names the resolved path on failure', async () => {
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'pigeon-invoke-'));
    const result = await runCli({ args: ['manifest', 'validate'], cwd: packageDir, initCwd: emptyDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Cannot read the manifest at ${path.join(emptyDir, 'pigeon.toml')}`));
  });
});
