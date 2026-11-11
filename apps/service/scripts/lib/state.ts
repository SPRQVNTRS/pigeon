/**
 * Bootstrap state file — a small JSON document recording what the setup
 * script created so the teardown script knows exactly what to remove.
 *
 * Location: `apps/service/.aws-setup.state.<stage>.json` (gitignored).
 *
 * Design points:
 *   - AWS is the authoritative store; this file is a convenience index.
 *   - Access key *secret* is NEVER written here. Only the key ID is recorded.
 *   - Writes are atomic: write-to-temp + fs.rename, never open-truncate.
 *   - Shape is zod-validated on read so tampering fails loudly.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const STATE_FILE_VERSION = 1 as const;

export const OperationSchema = z.object({
  action: z.string(),
  result: z.enum(['created', 'reused', 'skipped', 'failed', 'deleted']),
  at: z.string(),
  resourceId: z.string().optional(),
  note: z.string().optional(),
});

export const ResourcesSchema = z.object({
  snsTopicArn: z.string().optional(),
  configSetName: z.string().optional(),
  eventDestinations: z.array(z.string()).optional(),
  iamUserName: z.string().optional(),
  iamPolicyArn: z.string().optional(),
  iamAccessKeyId: z.string().optional(),
  snsSubscriptionArn: z.string().optional(),
  verifiedIdentity: z.string().optional(),
  // DMARC inbound pipeline
  dmarcS3BucketName: z.string().optional(),
  dmarcSnsTopicArn: z.string().optional(),
  dmarcSnsSubscriptionArn: z.string().optional(),
  dmarcReceiptRuleSetName: z.string().optional(),
  dmarcReceiptRuleName: z.string().optional(),
  dmarcRecipientDomain: z.string().optional(),
});

export const StateSchema = z.object({
  version: z.literal(STATE_FILE_VERSION),
  stage: z.string(),
  region: z.string(),
  accountId: z.string(),
  resourcePrefix: z.string(),
  createdAt: z.string(),
  resources: ResourcesSchema,
  operations: z.array(OperationSchema),
});

export type StateFile = z.infer<typeof StateSchema>;
export type StateResources = z.infer<typeof ResourcesSchema>;
export type StateOperation = z.infer<typeof OperationSchema>;

export interface StateLoadResult {
  state: StateFile;
  path: string;
}

/**
 * Return the stage-specific state file path: `<serviceRoot>/.aws-setup.state.<stage>.json`.
 */
export function stateFilePath(serviceRoot: string, stage: string): string {
  return path.join(serviceRoot, `.aws-setup.state.${stage}.json`);
}

/**
 * Read + validate the state file. Returns null if the file does not exist.
 */
export async function readState(filePath: string): Promise<StateFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (isNodeErrorCode(err, 'ENOENT')) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`State file at ${filePath} is not valid JSON`);
  }

  const result = StateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `State file at ${filePath} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Atomically write the state file. Writes to a sibling temp file then renames
 * over the target. On POSIX `rename(2)` is atomic within the same filesystem —
 * a crashing process can never leave the caller with a half-written state.
 */
export async function writeStateAtomic(filePath: string, state: StateFile): Promise<void> {
  // Validate before writing — catches programmer error early.
  const validated = StateSchema.parse(state);
  const payload = JSON.stringify(validated, null, 2) + '\n';

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const suffix = randomBytes(6).toString('hex');
  const tempPath = `${filePath}.${suffix}.tmp`;

  try {
    await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (err) {
    // Best-effort cleanup; ignore cleanup errors.
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Rename the state file to an archive path with a timestamp suffix.
 * Returns the new path. If the source file is missing this is a no-op
 * that returns null.
 */
export async function archiveState(filePath: string): Promise<string | null> {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = `${filePath.replace(/\.json$/, '')}.${now}.json.archived`;
  try {
    await fs.rename(filePath, archivePath);
    return archivePath;
  } catch (err) {
    if (isNodeErrorCode(err, 'ENOENT')) return null;
    throw err;
  }
}

export function emptyStateFile(args: {
  stage: string;
  region: string;
  accountId: string;
  resourcePrefix: string;
}): StateFile {
  return {
    version: STATE_FILE_VERSION,
    stage: args.stage,
    region: args.region,
    accountId: args.accountId,
    resourcePrefix: args.resourcePrefix,
    createdAt: new Date().toISOString(),
    resources: {},
    operations: [],
  };
}

export function recordOperation(
  state: StateFile,
  op: Omit<StateOperation, 'at'> & { at?: string },
): void {
  state.operations.push({
    ...op,
    at: op.at ?? new Date().toISOString(),
  });
}

function isNodeErrorCode(err: unknown, code: string): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
