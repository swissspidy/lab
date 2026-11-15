// A deployer for sites that serve variants from their own origin, behind a
// proxy that reads the lab's state (a Next.js app with @lab/next, say).
// Publishing a variant is host-specific and pluggable; rollback and the kill
// switch only rewrite the state, which the proxy picks up within its cache time.
import { mkdirSync } from 'node:fs';
import { StageError, buildInScratch, runFile, startService } from '@lab/core';
import type { Deployer, LabConfig, ScratchBuild, Service, Variant } from '@lab/core';
import { readState, writeState } from './deployer.ts';
import type { DeployState } from './deployer.ts';
import type { StateStore } from './remote.ts';

/** Puts a variant somewhere a proxy can reach it, and takes it down again. */
export interface VariantPublisher {
	/** Returns the origin that serves the variant, such as https://exp-0007.preview.example.com. */
	publish(variant: Variant): Promise<string>;
	retire(experiment: string): Promise<void>;
}

/** The deploy state in a local directory's state.json, as the local collector serves it. */
export class FileState implements StateStore {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
	}
	async read(): Promise<DeployState> {
		return readState(this.root);
	}
	async write(state: DeployState): Promise<void> {
		writeState(this.root, state);
	}
}

export class OriginDeployer implements Deployer {
	readonly state: StateStore;
	readonly publisher: VariantPublisher;
	private readonly now: () => Date;

	/** `state` is a StateStore, or a directory for a local one. */
	constructor(options: { root?: string; state?: StateStore; publisher: VariantPublisher; now?: () => Date }) {
		const state = options.state ?? (options.root ? new FileState(options.root) : null);
		if (!state) throw new StageError('deploy-no-state', 'OriginDeployer needs `state` or `root`.');
		this.state = state;
		this.publisher = options.publisher;
		this.now = options.now ?? (() => new Date());
	}

	async ship(variant: Variant, share: number): Promise<void> {
		const state = await this.state.read();
		if (state.live) throw new StageError('deploy-busy', `${state.live.experiment} is live.`);
		const origin = await this.publisher.publish(variant);
		await this.state.write({ ...state, live: { experiment: variant.experiment, share, origin } });
	}

	async rollback(experiment: string): Promise<void> {
		const state = await this.state.read();
		if (state.live?.experiment === experiment) await this.state.write({ ...state, live: null });
		await this.publisher.retire(experiment);
	}

	/**
	 * The kept patch is merged into the site's repository before this runs; the
	 * site's own deployment ships it to everyone. Here the variant stops being
	 * served on the side.
	 */
	async promote(experiment: string): Promise<void> {
		await this.rollback(experiment);
	}

	async kill(): Promise<void> {
		const live = (await this.state.read().catch(() => ({ live: null }))).live;
		await this.state.write({ live: null, killedAt: this.now().toISOString() });
		if (live) await this.publisher.retire(live.experiment).catch(() => undefined);
	}
}

/**
 * Publishes a variant on this machine: builds it and runs the site's
 * `site.serve` command on a free port. For local runs and self-hosted sites
 * where the proxy can reach the lab's machine.
 */
export class LocalServePublisher implements VariantPublisher {
	readonly config: LabConfig;
	private readonly running = new Map<string, { build: ScratchBuild; service: Service }>();

	constructor(options: { config: LabConfig }) {
		if (!options.config.site.serve) throw new StageError('deploy-no-serve', 'LocalServePublisher needs `site.serve` in the config.');
		this.config = options.config;
	}

	async publish(variant: Variant): Promise<string> {
		const build = await buildInScratch(variant, this.config);
		try {
			const service = await startService(this.config.site.serve!, build.work, 120_000);
			this.running.set(variant.experiment, { build, service });
			return service.url.replace(/\/$/, '');
		} catch (error) {
			build.cleanup();
			throw error;
		}
	}

	async retire(experiment: string): Promise<void> {
		const entry = this.running.get(experiment);
		if (!entry) return;
		this.running.delete(experiment);
		await entry.service.stop();
		entry.build.cleanup();
	}

	async retireAll(): Promise<void> {
		for (const id of this.running.keys()) await this.retire(id);
	}
}

/**
 * Publishes a variant with the site's own deploy command (`deploy.publish`),
 * for hosts with preview deployments (Vercel, Netlify, Cloudflare Pages, a
 * script of your own). The command runs in a built scratch copy of the
 * variant with LAB_EXPERIMENT set, and must print the variant's URL as the
 * last line of its output. Only the variables named in `deploy.env` reach it.
 */
export class CommandPublisher implements VariantPublisher {
	readonly config: LabConfig;
	private readonly env: Record<string, string>;

	constructor(options: { config: LabConfig; env?: NodeJS.ProcessEnv }) {
		if (!options.config.deploy) throw new StageError('deploy-no-command', 'CommandPublisher needs `deploy.publish` in the config.');
		this.config = options.config;
		const source = options.env ?? process.env;
		this.env = {};
		for (const name of options.config.deploy.env ?? []) if (source[name] !== undefined) this.env[name] = source[name]!;
	}

	async publish(variant: Variant): Promise<string> {
		const build = await buildInScratch(variant, this.config);
		try {
			const result = await runFile('sh', ['-c', this.config.deploy!.publish], build.work, 600_000, { ...this.env, LAB_EXPERIMENT: variant.experiment });
			if (result.code !== 0) throw new StageError('deploy-publish-failed', `The publish command failed with exit code ${result.code}.`, result.output);
			const url = result.output.trim().split('\n').map((l) => l.trim()).findLast(Boolean) ?? '';
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('not http');
				return parsed.origin;
			} catch {
				throw new StageError('deploy-publish-no-url', 'The publish command must print the variant URL as its last line.', result.output);
			}
		} finally {
			build.cleanup();
		}
	}

	async retire(experiment: string): Promise<void> {
		if (!this.config.deploy?.retire) return;
		await runFile('sh', ['-c', this.config.deploy.retire], process.cwd(), 300_000, { ...this.env, LAB_EXPERIMENT: experiment });
	}
}
