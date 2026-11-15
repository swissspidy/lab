// Where verified personal tweaks are kept: a directory next to the deploy
// state (the collector serves it), or a remote collector.
//   PUT /tweaks/<id>      with the token: the lab stores a verified tweak
//   GET /tweaks/<id>.css  public: the site's proxy forwards it to visitors
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StageError, TWEAK_ID, parseTweakRecord } from '@lab/core';
import type { LabConfig, TweakRecord, TweakStore } from '@lab/core';
import type { RemoteOptions } from './remote.ts';

export class FileTweakStore implements TweakStore {
	readonly dir: string;
	readonly config: Pick<LabConfig, 'tweaks'>;

	/** `root` is the deploy state directory; tweaks go in its `tweaks/`. */
	constructor(root: string, config: Pick<LabConfig, 'tweaks'>) {
		this.dir = join(root, 'tweaks');
		this.config = config;
	}

	async put(record: TweakRecord): Promise<void> {
		// Checked again here: nothing unverified-looking is stored, whoever calls.
		const valid = parseTweakRecord(record, this.config);
		if (!valid) throw new StageError('tweak-record-invalid', 'The tweak record is malformed or its CSS does not pass the static gate.');
		mkdirSync(this.dir, { recursive: true });
		const file = join(this.dir, `${valid.spec.id}.json`);
		writeFileSync(`${file}.tmp`, `${JSON.stringify(valid, null, '\t')}\n`);
		renameSync(`${file}.tmp`, file);
	}

	async get(id: string): Promise<TweakRecord | null> {
		if (!TWEAK_ID.test(id)) return null;
		const file = join(this.dir, `${id}.json`);
		if (!existsSync(file)) return null;
		try {
			return parseTweakRecord(JSON.parse(readFileSync(file, 'utf8')), this.config);
		} catch {
			return null;
		}
	}
}

const base = (url: string) => url.replace(/\/+$/, '');

/** Stores and reads tweaks in a remote collector, with the token. */
export class RemoteTweakStore implements TweakStore {
	private readonly options: RemoteOptions & { config: Pick<LabConfig, 'tweaks'> };
	constructor(options: RemoteOptions & { config: Pick<LabConfig, 'tweaks'> }) {
		this.options = options;
	}

	async put(record: TweakRecord): Promise<void> {
		const res = await (this.options.fetch ?? fetch)(`${base(this.options.url)}/tweaks/${record.spec.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
			body: JSON.stringify(record),
		});
		if (res.status === 404) throw new StageError('tweaks-disabled', 'The collector offers no tweaks. Add `tweaks: {}` to lab.config.ts where it runs.');
		if (!res.ok) throw new StageError('remote-tweak-unwritable', `The collector refused the tweak (${res.status}). Check LAB_TOKEN.`);
	}

	async get(id: string): Promise<TweakRecord | null> {
		if (!TWEAK_ID.test(id)) return null;
		const res = await (this.options.fetch ?? fetch)(`${base(this.options.url)}/tweaks/${id}.json`, { headers: { authorization: `Bearer ${this.options.token}` }, cache: 'no-store' });
		if (!res.ok) return null;
		return parseTweakRecord(await res.json().catch(() => null), this.options.config);
	}
}
