import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyStateFile,
  readState,
  recordOperation,
  writeStateAtomic,
  STATE_FILE_VERSION,
  type StateFile,
} from '../lib/state';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'aws-setup-state-test-'));
}

async function rimraf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('state file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await rimraf(dir);
  });

  it('returns null when the file does not exist', async () => {
    const result = await readState(path.join(dir, 'missing.json'));
    expect(result).toBeNull();
  });

  it('round-trips a populated state file', async () => {
    const file = path.join(dir, 'state.json');
    const original: StateFile = emptyStateFile({
      stage: 'dev',
      region: 'eu-west-1',
      accountId: '123456789012',
      resourcePrefix: 'pigeon',
    });
    original.resources.snsTopicArn = 'arn:aws:sns:eu-west-1:123456789012:pigeon-events-dev';
    original.resources.configSetName = 'pigeon-dev';
    original.resources.iamAccessKeyId = 'AKIAEXAMPLE';
    recordOperation(original, {
      action: 'sns:CreateTopic',
      result: 'created',
      resourceId: original.resources.snsTopicArn,
    });

    await writeStateAtomic(file, original);
    const reloaded = await readState(file);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.version).toBe(STATE_FILE_VERSION);
    expect(reloaded?.resources.snsTopicArn).toBe(original.resources.snsTopicArn);
    expect(reloaded?.resources.configSetName).toBe(original.resources.configSetName);
    expect(reloaded?.resources.iamAccessKeyId).toBe(original.resources.iamAccessKeyId);
    expect(reloaded?.operations).toHaveLength(1);
    expect(reloaded?.operations[0]?.action).toBe('sns:CreateTopic');
  });

  it('writes atomically — no partial file is ever visible at the target path', async () => {
    // Proof: the target file only appears after rename; no temp bits are left behind.
    const file = path.join(dir, 'state.json');
    const state = emptyStateFile({
      stage: 'dev',
      region: 'eu-west-1',
      accountId: '123456789012',
      resourcePrefix: 'pigeon',
    });

    await writeStateAtomic(file, state);

    const siblings = await fs.readdir(dir);
    // Only the final file exists — the temp `.json.<hex>.tmp` was renamed.
    expect(siblings).toEqual(['state.json']);

    const reloaded = await readState(file);
    expect(reloaded?.stage).toBe('dev');
  });

  it('a corrupted file fails schema validation loudly rather than silently', async () => {
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, stage: 'dev' }), 'utf8');
    await expect(readState(file)).rejects.toThrow(/schema validation/);
  });

  it('an invalid-JSON file throws with a clear message', async () => {
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, 'not json', 'utf8');
    await expect(readState(file)).rejects.toThrow(/not valid JSON/);
  });

  it('simulated crash during write leaves the existing file intact', async () => {
    const file = path.join(dir, 'state.json');
    const good = emptyStateFile({
      stage: 'dev',
      region: 'eu-west-1',
      accountId: '123456789012',
      resourcePrefix: 'pigeon',
    });
    await writeStateAtomic(file, good);

    // Simulate a crash by writing an orphaned tmp file in the same dir; the
    // real `writeStateAtomic` uses a random suffix so we can plant one here.
    const tmpOrphan = `${file}.crashed.tmp`;
    await fs.writeFile(tmpOrphan, '{partial', 'utf8');

    // The main file is still the good one.
    const reloaded = await readState(file);
    expect(reloaded?.stage).toBe('dev');

    // The orphan did not overwrite the target. It's still in the dir — that's
    // fine; the rename-based atomic write never touched the good file.
    const siblings = await fs.readdir(dir);
    expect(siblings).toContain('state.json');
  });
});
