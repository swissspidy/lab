// Builds a site, or a patched copy of it, in a scratch directory. Shared by
// the sandbox (to test) and the deployer (to ship), so both build the same way.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { StageError } from './types.ts';
import type { LabConfig, RepoRef, Variant } from './types.ts';

/** Environment variables a build may see. Everything else, keys and tokens included, is dropped. */
const PASS_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR', 'NODE_OPTIONS'];

export const isVariant = (ref: RepoRef | Variant): ref is Variant => 'patch' in ref;

/** Where and how long a site-owned process runs. */
export interface ProcessOptions {
	cwd: string;
	timeoutMs: number;
	/**
	 * Variables added to the stripped environment (only PASS_ENV survives from
	 * the lab's own). The lab passes deploy tokens here, never its own secrets.
	 */
	env?: Record<string, string>;
}

export interface ProcessResult {
	code: number | null;
	output: string;
	timedOut: boolean;
}

/** Runs a site-owned shell command (`site.check`, `site.build`). */
export function runCommand(command: string, options: ProcessOptions): Promise<ProcessResult> {
	return runFile('sh', ['-c', command], options);
}

export interface Service {
	url: string;
	stop(): Promise<void>;
}

/** A free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((done) => server.close(() => done()));
	return port;
}

/**
 * Starts a site-owned server command (`site.serve`) on a free port, with the
 * same stripped environment as builds plus `PORT`, and waits until it
 * answers. `timeoutMs` bounds the wait for the first answer.
 */
export async function startService(command: string, options: ProcessOptions): Promise<Service> {
	const { cwd, timeoutMs } = options;
	const port = await freePort();
	const env: Record<string, string> = { CI: '1', NODE_ENV: 'production', ...options.env, PORT: String(port), HOSTNAME: '127.0.0.1' };
	for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key]!;
	const child: ChildProcess = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
	let output = '';
	const collect = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-20_000);
	};
	child.stdout?.on('data', collect);
	child.stderr?.on('data', collect);
	let exited = false;
	child.on('exit', () => {
		exited = true;
	});
	const stop = async () => {
		if (exited) return;
		const done = new Promise<void>((settle) => child.once('exit', () => settle()));
		try {
			process.kill(-child.pid!, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {}
		}, 5000);
		await done;
		clearTimeout(timer);
	};
	const url = `http://127.0.0.1:${port}/`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exited) throw new StageError('sandbox-serve-failed', 'The serve command exited before it answered.', output);
		const ok = await fetch(url, { redirect: 'manual' }).then((r) => r.status < 500, () => false);
		if (ok) return { url, stop };
		await new Promise((r) => setTimeout(r, 250));
	}
	await stop();
	throw new StageError('sandbox-serve-failed', `The serve command did not answer on port ${port} within ${Math.round(timeoutMs / 1000)} s.`, output);
}

/** Runs a program with literal arguments, no shell: paths are never interpreted. */
export function runFile(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
	const { cwd, timeoutMs } = options;
	return new Promise((done) => {
		const env: Record<string, string> = { CI: '1', NODE_ENV: 'production', ...options.env };
		for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key]!;
		const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
			const copied = await runFile('cp', ['-a', join(source, 'node_modules'), join(work, 'node_modules')], { cwd: work, timeoutMs });
			if (copied.code !== 0) throw new StageError('build-deps-copy-failed', 'Could not copy node_modules into the scratch directory.', copied.output);
		}

		if (isVariant(ref)) {
			const patchFile = join(work, '.lab-variant.patch');
			writeFileSync(patchFile, ref.patch.endsWith('\n') ? ref.patch : `${ref.patch}\n`);
			const applied = await runFile('git', ['apply', '--whitespace=nowarn', '.lab-variant.patch'], { cwd: work, timeoutMs });
			rmSync(patchFile, { force: true });
			if (applied.code !== 0) throw new StageError('sandbox-patch-failed', 'The patch does not apply to the base commit.', applied.output);
		}
		if (config.site.check) {
			const checked = await runCommand(config.site.check, { cwd: work, timeoutMs });
			if (checked.code !== 0) {
				throw new StageError('sandbox-check-failed', checked.timedOut ? 'The check command timed out.' : `The check command failed with exit code ${checked.code}.`, checked.output);
			}
		}
		const built = await runCommand(config.site.build, { cwd: work, timeoutMs });
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
