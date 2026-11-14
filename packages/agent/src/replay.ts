// A scripted proposer and builder: they replay an experiment from a
// directory holding `spec.json` and `patch.diff`. M1 uses them to drive the
// loop without a model.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StageError, hashPatch } from '@lab/core';
import type { Builder, ExperimentSpec, Observation, Proposer, RepoRef, Variant } from '@lab/core';

export class ReplayProposer implements Proposer {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	async propose(_ctx: Observation): Promise<ExperimentSpec> {
		const file = join(this.dir, 'spec.json');
		if (!existsSync(file)) throw new StageError('replay-spec-missing', `No spec.json in ${this.dir}.`);
		try {
			return JSON.parse(readFileSync(file, 'utf8')) as ExperimentSpec;
		} catch (error) {
			throw new StageError('replay-spec-invalid', `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export class ReplayBuilder implements Builder {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}

	async build(spec: ExperimentSpec, repo: RepoRef): Promise<Variant> {
		const file = join(this.dir, 'patch.diff');
		if (!existsSync(file)) throw new StageError('replay-patch-missing', `No patch.diff in ${this.dir}.`);
		const patch = readFileSync(file, 'utf8');
		return { experiment: spec.id, base: repo, patch, patchHash: hashPatch(patch) };
	}
}
