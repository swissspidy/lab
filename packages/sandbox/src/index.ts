import { buildInScratch } from '@lab/core';
import type { LabConfig, RepoRef, RunningSite, Sandbox, Variant } from '@lab/core';
import { serveDir } from './serve.ts';

export { serveDir } from './serve.ts';
export type { StaticServer } from './serve.ts';

export interface LocalSandboxOptions {
	config: LabConfig;
	/** Milliseconds a check or build command may run. */
	timeoutMs?: number;
	/** Where scratch directories go. Defaults to the OS temp directory. */
	scratch?: string;
}

/**
 * Builds a site, or a patched copy of it, in a scratch directory and serves
 * the output on 127.0.0.1. The site directory itself is never written to.
 */
export class LocalSandbox implements Sandbox {
	readonly config: LabConfig;
	readonly options: LocalSandboxOptions;

	constructor(options: LocalSandboxOptions) {
		this.config = options.config;
		this.options = options;
	}

	async start(ref: RepoRef | Variant): Promise<RunningSite> {
		const build = await buildInScratch(ref, this.config, {
			...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
			...(this.options.scratch === undefined ? {} : { scratch: this.options.scratch }),
		});
		try {
			const server = await serveDir(build.outDir);
			return {
				url: server.url,
				root: build.outDir,
				stop: async () => {
					await server.close();
					build.cleanup();
				},
			};
		} catch (error) {
			build.cleanup();
			throw error;
		}
	}
}
