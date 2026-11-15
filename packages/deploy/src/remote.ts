// Clients for a remote collector (`lab collect`), for a loop that runs
// somewhere other than the collector: a scheduled CI job, say.
//   GET  /state    public; the site's proxy reads it
//   PUT  /state    needs the token; the deployer and the kill switch write it
//   GET  /metrics  needs the token; the meter reads it
import type { BucketStats, LabConfig, Meter, TrafficEstimate } from '@lab/core';
import { StageError } from '@lab/core';
import { parseDeployState, stateVersion } from './deployer.ts';
import type { DeployState } from './deployer.ts';
import { MetricStore } from './metrics.ts';
import { StoreMeter } from './meter.ts';

/** Where a deployer keeps the state: a local directory, or a remote collector. */
export interface StateStore {
	read(): Promise<{ state: DeployState; version: string }>;
	/**
	 * With `expected`, writes only if the state is still at that version, and
	 * throws `deploy-state-changed` otherwise: a kill between a read and a
	 * write must win.
	 */
	write(state: DeployState, expected?: string): Promise<void>;
}

export const stateChanged = () =>
	new StageError('deploy-state-changed', 'The deploy state changed since it was read (a kill switch, or another run). Nothing was overwritten.');

export interface RemoteOptions {
	/** The collector's base URL. */
	url: string;
	/** The collector's write token (LAB_TOKEN). */
	token: string;
	fetch?: typeof fetch;
}

const base = (url: string) => url.replace(/\/+$/, '');

export class RemoteState implements StateStore {
	private readonly options: RemoteOptions;
	constructor(options: RemoteOptions) {
		this.options = options;
	}

	async read(): Promise<{ state: DeployState; version: string }> {
		const res = await (this.options.fetch ?? fetch)(`${base(this.options.url)}/state`, { cache: 'no-store' });
		if (!res.ok) throw new StageError('remote-state-unreadable', `The collector answered ${res.status} for /state.`);
		const state = parseDeployState(await res.json().catch(() => null));
		if (!state) throw new StageError('remote-state-malformed', 'The collector returned malformed state. Refusing to treat it as idle.');
		return { state, version: stateVersion(state) };
	}

	async write(state: DeployState, expected?: string): Promise<void> {
		const res = await (this.options.fetch ?? fetch)(`${base(this.options.url)}/state`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json', ...(expected ? { 'if-match': `"${expected}"` } : {}) },
			body: JSON.stringify(state),
		});
		if (res.status === 412) throw stateChanged();
		if (!res.ok) throw new StageError('remote-state-unwritable', `The collector refused the state (${res.status}). Check LAB_TOKEN.`);
	}
}

/** A meter over the collector's counts, fetched fresh on every read. */
export class RemoteMeter implements Meter {
	private readonly options: RemoteOptions & { config: LabConfig; now?: () => Date };
	constructor(options: RemoteOptions & { config: LabConfig; now?: () => Date }) {
		this.options = options;
	}

	private async meter(): Promise<StoreMeter> {
		const res = await (this.options.fetch ?? fetch)(`${base(this.options.url)}/metrics`, { headers: { authorization: `Bearer ${this.options.token}` }, cache: 'no-store' });
		if (!res.ok) throw new StageError('remote-metrics-unreadable', `The collector answered ${res.status} for /metrics. Check LAB_TOKEN.`);
		const store = new MetricStore({ intervalHours: this.options.config.traffic.intervalHours, data: await res.json() });
		return new StoreMeter({ store, config: this.options.config, ...(this.options.now ? { now: this.options.now } : {}) });
	}

	async read(experiment: string): Promise<BucketStats> {
		return (await this.meter()).read(experiment);
	}

	async traffic(): Promise<TrafficEstimate> {
		return (await this.meter()).traffic();
	}
}
