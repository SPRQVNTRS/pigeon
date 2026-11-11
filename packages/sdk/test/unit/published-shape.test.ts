/**
 * Guards the shape of the published package.
 *
 * 3.0.0 reached npm with entry points that named `./src/index.ts`, a file the
 * tarball does not hold. This test packs the package with the real tools, reads
 * the manifest from INSIDE the tarball, checks every entry point exists there,
 * and loads the package with plain Node from the extracted files.
 *
 * `pack` runs the `prepack` script, which runs tsup. So the test builds `dist`
 * itself and passes on a clean checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

type ExportsValue = string | { [condition: string]: ExportsValue };

interface PackedManifest {
  version: string;
  main: string;
  module: string;
  types: string;
  exports: { [subpath: string]: ExportsValue };
}

interface LoadResult {
  hasClient: boolean;
  version: string;
}

const sdkRoot = fileURLToPath(new URL('../../', import.meta.url));
const scratchDirs: string[] = [];

function isToolAvailable(tool: string): boolean {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function collectLeaves(value: ExportsValue): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value).flatMap(collectLeaves);
}

function pickDefaultPath(value: ExportsValue | undefined): string {
  if (typeof value === 'string') return value;
  const next = value?.default;
  if (next === undefined) throw new Error('exports condition has no default path');
  return pickDefaultPath(next);
}

function packAndExtract(tool: 'pnpm' | 'npm'): { packageDir: string; manifest: PackedManifest } {
  const scratch = mkdtempSync(join(tmpdir(), `pigeon-sdk-${tool}-`));
  scratchDirs.push(scratch);
  const packDir = join(scratch, 'pack');
  const extractDir = join(scratch, 'extract');
  mkdirSync(packDir);
  mkdirSync(extractDir);

  execFileSync(tool, ['pack', '--pack-destination', packDir], { cwd: sdkRoot, stdio: 'pipe' });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`${tool} pack made ${tarballs.length} tarballs, expected 1`);
  execFileSync('tar', ['-xzf', join(packDir, tarballs[0]!), '-C', extractDir]);

  const packageDir = join(extractDir, 'package');
  // The package needs `zod` at load time. Link the dev install so Node finds it,
  // the way a real install would.
  symlinkSync(join(sdkRoot, 'node_modules'), join(packageDir, 'node_modules'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackedManifest;
  return { packageDir, manifest };
}

function loadWithNode(args: { mode: 'esm' | 'cjs'; entryPath: string }): LoadResult {
  const body = {
    esm: `const m = await import(process.argv[1]);`,
    cjs: `const m = require(process.argv[1]);`,
  }[args.mode];
  const target = args.mode === 'esm' ? pathToFileURL(args.entryPath).href : args.entryPath;
  const script = `${body}
const client = new m.PigeonClient({ apiKey: 'x', baseUrl: 'https://pigeon.example.com' });
console.log(JSON.stringify({ hasClient: client instanceof m.PigeonClient, version: m.version }));`;
  const flags = args.mode === 'esm' ? ['--input-type=module'] : [];
  const stdout = execFileSync(process.execPath, [...flags, '-e', script, target], {
    cwd: sdkRoot,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as LoadResult;
}

const tools: Array<'pnpm' | 'npm'> = ['pnpm', 'npm'];
const packed = new Map<string, ReturnType<typeof packAndExtract>>();

function packOnce(tool: 'pnpm' | 'npm'): ReturnType<typeof packAndExtract> {
  const cached = packed.get(tool);
  if (cached) return cached;
  const fresh = packAndExtract(tool);
  packed.set(tool, fresh);
  return fresh;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe.each(tools)('published shape via `%s pack`', (tool) => {
  // pnpm is the repo's package manager. npm ships with Node and is the tool
  // that broke 3.0.0, so the npm run is never skipped.
  const run = tool === 'npm' || isToolAvailable('pnpm') ? it : it.skip;

  run('names only files that exist in the tarball, none under ./src', { timeout: 60_000 }, () => {
    const { packageDir, manifest } = packOnce(tool);
    const paths = [manifest.main, manifest.module, manifest.types, ...collectLeaves(manifest.exports['.']!)];

    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const path of paths) {
      expect(path.startsWith('./src'), `${path} must not start with ./src`).toBe(false);
      expect(existsSync(join(packageDir, path)), `${path} must exist in the tarball`).toBe(true);
    }
  });

  run('loads from the extracted files as ESM and as CJS', { timeout: 60_000 }, () => {
    const { packageDir, manifest } = packOnce(tool);
    const exportsRoot = manifest.exports['.'];
    if (typeof exportsRoot === 'string') throw new Error('exports["."] must use import and require conditions');

    const esm = loadWithNode({ mode: 'esm', entryPath: join(packageDir, pickDefaultPath(exportsRoot.import)) });
    const cjs = loadWithNode({ mode: 'cjs', entryPath: join(packageDir, pickDefaultPath(exportsRoot.require)) });

    expect(esm).toEqual({ hasClient: true, version: manifest.version });
    expect(cjs).toEqual({ hasClient: true, version: manifest.version });
  });
});
