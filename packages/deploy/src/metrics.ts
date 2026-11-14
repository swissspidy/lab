// Aggregate counts per experiment, bucket and interval. No per-visitor rows:
// the store cannot tell one visitor from another.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BucketCounts } from '@lab/core';

export const BUCKETS = ['baseline', 'variant'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const EVENTS = ['visit', 'conversion', 'js_error', 'engaged'] as const;
export type BeaconEvent = (typeof EVENTS)[number];
/** Site-wide totals, recorded with every event, for traffic estimates. */
export const SITE = '_site';

type Row = Record<Bucket, Record<BeaconEvent, number>>;
interface Data {
	intervalMs: number;
	/** experiment → interval index → counts */
	series: Record<string, Record<string, Row>>;
}

const emptyRow = (): Row => ({
	baseline: { visit: 0, conversion: 0, js_error: 0, engaged: 0 },
	variant: { visit: 0, conversion: 0, js_error: 0, engaged: 0 },
});

export const emptyCounts = (): BucketCounts => ({ visits: 0, conversions: 0, jsErrors: 0, engaged: 0 });

const toCounts = (r: Record<BeaconEvent, number>): BucketCounts => ({ visits: r.visit, conversions: r.conversion, jsErrors: r.js_error, engaged: r.engaged });

export class MetricStore {
	readonly file: string | null;
	private data: Data;
	private dirty = false;

	constructor(options: { intervalHours: number; file?: string }) {
		this.file = options.file ?? null;
		const intervalMs = options.intervalHours * 3_600_000;
		this.data = this.file && existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Data) : { intervalMs, series: {} };
		if (this.data.intervalMs !== intervalMs) throw new Error(`${this.file} uses a different interval. Move it aside to change traffic.intervalHours.`);
	}

	get intervalMs(): number {
		return this.data.intervalMs;
	}

	intervalOf(at: Date): number {
		return Math.floor(at.getTime() / this.data.intervalMs);
	}

	record(experiment: string, bucket: Bucket, event: BeaconEvent, at: Date, count = 1): void {
		const interval = String(this.intervalOf(at));
		const add = (key: string, b: Bucket) => {
			const series = (this.data.series[key] ??= {});
			const row = (series[interval] ??= emptyRow());
			row[b][event] += count;
		};
		add(experiment, bucket);
		if (experiment !== SITE) add(SITE, 'baseline');
		this.dirty = true;
	}

	/** Totals per bucket over intervals in [from, to]. */
	totals(experiment: string, from = -Infinity, to = Infinity): Record<Bucket, BucketCounts> {
		const sum = emptyRow();
		for (const [interval, row] of Object.entries(this.data.series[experiment] ?? {})) {
			const i = Number(interval);
			if (i < from || i > to) continue;
			for (const b of BUCKETS) for (const e of EVENTS) sum[b][e] += row[b][e];
		}
		return { baseline: toCounts(sum.baseline), variant: toCounts(sum.variant) };
	}

	intervals(experiment: string): number[] {
		return Object.keys(this.data.series[experiment] ?? {}).map(Number).toSorted((a, b) => a - b);
	}

	/** Writes the store atomically, if it has a file and changed. */
	flush(): void {
		if (!this.file || !this.dirty) return;
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data));
		renameSync(tmp, this.file);
		this.dirty = false;
	}
}
