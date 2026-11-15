// The reference deployer: a static root that the edge server reads.
//   <root>/current/        the site everyone gets by default
//   <root>/variants/<id>/  a variant's build
//   <root>/state.json      which experiment is live and its share
// Rolling back or killing rewrites state.json only: no build, no deploy.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StageError, buildInScratch } from '@lab/core';
import type { Deployer, LabConfig, RepoRef, Variant } from '@lab/core';

export interface DeployState {
	/** `origin` is set when the variant is served from elsewhere (OriginDeployer). */
	live: { experiment: string; share: number; origin?: string } | null;
	/** When the kill switch was last used. */
	killedAt?: string;
}

export const readState = (root: string): DeployState => {
	try {
		return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as DeployState;
	} catch {
		// No state, or an unreadable one: serve no variant.
		return { live: null };
	}
};

export function writeState(root: string, state: DeployState): void {
	const tmp = join(root, 'state.json.tmp');
	writeFileSync(tmp, `${JSON.stringify(state, null, '\t')}\n`);
	renameSync(tmp, join(root, 'state.json'));
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class ReferenceDeployer implements Deployer {
	readonly root: string;
	readonly config: LabConfig;
	private readonly now: () => Date;

	constructor(options: { root: string; config: LabConfig; now?: () => Date }) {
		this.root = options.root;
		this.config = options.config;
		this.now = options.now ?? (() => new Date());
		mkdirSync(join(this.root, 'variants'), { recursive: true });
	}

	private async install(ref: RepoRef | Variant, target: string): Promise<void> {
		const build = await buildInScratch(ref, this.config);
		try {
			const staging = `${target}.staging`;
			rmSync(staging, { recursive: true, force: true });
			cpSync(build.outDir, staging, { recursive: true });
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
		} finally {
			build.cleanup();
		}
	}

	/** Builds the site at `ref` and serves it to everyone. */
	async publish(ref: RepoRef): Promise<void> {
		await this.install(ref, join(this.root, 'current'));
	}

	async ship(variant: Variant, share: number): Promise<void> {
		if (!SAFE_ID.test(variant.experiment)) throw new StageError('deploy-invalid-id', `Invalid experiment id ${variant.experiment}.`);
		if (!existsSync(join(this.root, 'current'))) throw new StageError('deploy-no-baseline', 'Nothing is published yet. Run `lab publish` first.');
		const state = readState(this.root);
		if (state.live) throw new StageError('deploy-busy', `${state.live.experiment} is live.`);
		await this.install(variant, join(this.root, 'variants', variant.experiment));
		writeState(this.root, { ...state, live: { experiment: variant.experiment, share } });
	}

	async rollback(experiment: string): Promise<void> {
		const state = readState(this.root);
		if (state.live?.experiment === experiment) writeState(this.root, { ...state, live: null });
		rmSync(join(this.root, 'variants', experiment), { recursive: true, force: true });
	}

	async promote(experiment: string): Promise<void> {
		const dir = join(this.root, 'variants', experiment);
		if (!existsSync(dir)) throw new StageError('deploy-no-variant', `No build for ${experiment}.`);
		const current = join(this.root, 'current');
		const old = `${current}.old`;
		rmSync(old, { recursive: true, force: true });
		renameSync(current, old);
		renameSync(dir, current);
		writeState(this.root, { ...readState(this.root), live: null });
		rmSync(old, { recursive: true, force: true });
	}

	async kill(): Promise<void> {
		writeState(this.root, { live: null, killedAt: this.now().toISOString() });
	}
}
