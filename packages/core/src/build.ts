// Builds a site, or a patched copy of it, in a scratch directory. Shared by
// the sandbox (to test) and the deployer (to ship), so both build the same way.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { StageError } from './types.ts';
import type { LabConfig, RepoRef, Variant } from './types.ts';

/** Environment variables a build may see. Everything else, keys and tokens included, is dropped. */
const PASS_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR', 'NODE_OPTIONS'];

export const isVariant = (ref: RepoRef | Variant): ref is Variant => 'patch' in ref;

export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	return new Promise((done) => {
		const env: Record<string, string> = { CI: '1', NODE_ENV: 'production' };
		for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key]!;
		const child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		let output = '';
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-20_000);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				child.kill('SIGKILL');
			}
		}, timeoutMs);
		child.on('close', (code) => {
			clearTimeout(timer);
			done({ code, output, timedOut });
		});
	});
}

export interface ScratchBuild {
	/** The scratch copy of the site. */
	work: string;
	/** The built output inside it. */
	outDir: string;
	cleanup(): void;
}

export interface BuildOptions {
	timeoutMs?: number;
	scratch?: string;
}

/**
 * Copies the site to a scratch directory, applies the variant's patch, runs
 * `site.check` and `site.build`, and returns the output directory. The site
 * directory is never written to. Failures are StageErrors with the log.
 */
export async function buildInScratch(ref: RepoRef | Variant, config: LabConfig, options: BuildOptions = {}): Promise<ScratchBuild> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const base = isVariant(ref) ? ref.base : ref;
	const source = resolve(base.dir);
	const work = mkdtempSync(join(options.scratch ?? tmpdir(), 'lab-build-'));
	const cleanup = () => rmSync(work, { recursive: true, force: true });
	try {
		const outDir = resolve(work, config.site.outDir);
		if (!outDir.startsWith(work + sep)) throw new StageError('build-outdir', '`site.outDir` must be inside the site.');
		const skip = new Set(['node_modules', '.git', config.site.outDir.replace(/\/+$/, '')]);
		cpSync(source, work, {
			recursive: true,
			// Keep relative symlinks relative, so they cannot reach back into the site.
			verbatimSymlinks: true,
			filter: (src) => {
				const rel = relative(source, src);
				if (rel === '') return true;
				const top = rel.split(sep)[0]!;
				return !skip.has(rel) && !skip.has(top) && rel !== join('lab', 'ledger.jsonl') && !rel.startsWith(join('lab', 'evidence'));
			},
		});
		// Dependencies are copied, not linked: bundlers such as Turbopack refuse a
		// node_modules outside the project root, and a copy keeps the build from
		// writing into the site's own dependencies. A variant may not change them.
		if (existsSync(join(source, 'node_modules'))) {
			const copied = await runCommand(`cp -a ${JSON.stringify(join(source, 'node_modules'))} ${JSON.stringify(join(work, 'node_modules'))}`, work, timeoutMs);
			if (copied.code !== 0) throw new StageError('build-deps-copy-failed', 'Could not copy node_modules into the scratch directory.', copied.output);
		}

		if (isVariant(ref)) {
			const patchFile = join(work, '.lab-variant.patch');
			writeFileSync(patchFile, ref.patch.endsWith('\n') ? ref.patch : `${ref.patch}\n`);
			const applied = await runCommand('git apply --whitespace=nowarn .lab-variant.patch', work, timeoutMs);
			rmSync(patchFile, { force: true });
			if (applied.code !== 0) throw new StageError('sandbox-patch-failed', 'The patch does not apply to the base commit.', applied.output);
		}
		if (config.site.check) {
			const checked = await runCommand(config.site.check, work, timeoutMs);
			if (checked.code !== 0) {
				throw new StageError('sandbox-check-failed', checked.timedOut ? 'The check command timed out.' : `The check command failed with exit code ${checked.code}.`, checked.output);
			}
		}
		const built = await runCommand(config.site.build, work, timeoutMs);
		if (built.code !== 0) {
			throw new StageError('sandbox-build-failed', built.timedOut ? 'The build timed out.' : `The build failed with exit code ${built.code}.`, built.output);
		}
		if (!existsSync(outDir)) throw new StageError('sandbox-build-failed', `The build wrote no ${config.site.outDir}.`, built.output);
		return { work, outDir, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}
