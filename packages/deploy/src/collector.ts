// The lab's collector for sites that run their own proxy (see @lab/next):
//   GET  /state    the deploy state: which experiment is live, its share and origin
//   POST /beacon   one beacon, counted per experiment, bucket and interval
//   PUT  /state    with the token: the loop's deployer and kill switch write here
//   GET  /metrics  with the token: the loop's meter reads the counts
//   PUT  /tweaks/<id>       with the token: the lab stores a verified personal tweak
//   GET  /tweaks/<id>.json  with the token: the stored record
//   GET  /tweaks/<id>.css   public (and HEAD): the tweak's stylesheet, which the proxy forwards
// The tweak routes exist only when the site offers tweaks (`tweaks` in the config).
// The site's proxy reads /state and forwards beacons; visitors never talk to it.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { parseDeployState, readState, stateVersion, writeState } from './deployer.ts';
import type { DeployState } from './deployer.ts';
import { recordBeacon } from './edge.ts';
import type { MetricStore } from './metrics.ts';
import { FileTweakStore } from './tweaks.ts';
import { StageError } from '@lab/core';
import type { LabConfig } from '@lab/core';

export interface CollectorOptions {
	/** The deploy state directory (state.json), as written by the deployer and `lab kill`. */
	root: string;
	store: MetricStore;
	now?: () => Date;
	port?: number;
	host?: string;
	/**
	 * Required for PUT /state and GET /metrics. Without it, both are refused:
	 * the state can then only change on this machine (`lab kill`, the deployer).
	 */
	token?: string;
	/** The site's `tweaks` config. Absent: no tweak routes. */
	tweaks?: LabConfig['tweaks'];
	/** The site's budgets: a stored tweak counts against `bundleKbDelta` as well. */
	budgets?: LabConfig['budgets'];
}

const TWEAK_PATH = /^\/tweaks\/(tw-[0-9a-f]{12})(\.css|\.json)?$/;

export async function startCollector(options: CollectorOptions): Promise<{ url: string; server: Server; close(): Promise<void> }> {
	const now = options.now ?? (() => new Date());
	const authorized = (header: string | undefined) => {
		if (!options.token) return false;
		const given = Buffer.from(header ?? '');
		const wanted = Buffer.from(`Bearer ${options.token}`);
		return given.length === wanted.length && timingSafeEqual(given, wanted);
	};
	const tweaks = options.tweaks ? new FileTweakStore(options.root, { tweaks: options.tweaks, ...(options.budgets ? { budgets: options.budgets } : {}) }) : null;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://collector').pathname;
		const tweak = TWEAK_PATH.exec(path);
		if (tweak && tweaks) {
			const [, id, ext] = tweak as unknown as [string, string, string | undefined];
			if (req.method === 'PUT' && ext === undefined) {
				if (!authorized(req.headers.authorization)) return void res.writeHead(401).end();
				// Bytes, counted before decoding; one 413 once the limit is passed.
				const chunks: Buffer[] = [];
				let size = 0;
				let tooLarge = false;
				req.on('data', (chunk: Buffer) => {
					if (tooLarge) return;
					size += chunk.length;
					if (size > 200_000) {
						tooLarge = true;
						res.writeHead(413, { connection: 'close' }).end();
						return;
					}
					chunks.push(chunk);
				});
				req.on('end', () => {
					if (tooLarge) return;
					const body = Buffer.concat(chunks).toString('utf8');
					let record: unknown = null;
					try {
						record = JSON.parse(body);
					} catch {}
					const named = (record as { spec?: { id?: unknown } } | null)?.spec?.id;
					if (named !== id) return void res.writeHead(400).end();
					tweaks.put(record as never).then(
						() => res.writeHead(204).end(),
						// A record that fails the gate is the caller's; anything else (a full disk) is ours.
						(error: unknown) => res.writeHead(error instanceof StageError && error.code === 'tweak-record-invalid' ? 400 : 500).end(),
					);
				});
				return;
			}
			// HEAD too: the proxy asks whether a tweak exists before a visitor opts in.
			if ((req.method === 'GET' || req.method === 'HEAD') && ext !== undefined) {
				if (ext === '.json' && !authorized(req.headers.authorization)) return void res.writeHead(401).end();
				void tweaks.get(id).then((record) => {
					if (!record) return res.writeHead(404).end();
					if (ext === '.json') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(record));
					return res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' }).end(record.css);
				});
				return;
			}
			return void res.writeHead(405).end();
		}
		if (path === '/state' && req.method === 'PUT') {
			if (!authorized(req.headers.authorization)) return void res.writeHead(401).end();
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString();
				if (body.length > 4096) req.destroy();
			});
			req.on('end', () => {
				let state: DeployState | null = null;
				try {
					state = parseDeployState(JSON.parse(body));
				} catch {}
				if (!state) return void res.writeHead(400).end();
				// A conditional write fails if the state changed since the writer read it (a kill, say).
				const expected = req.headers['if-match'];
				if (expected && expected.replaceAll('"', '') !== stateVersion(readState(options.root))) return void res.writeHead(412).end();
				writeState(options.root, state);
				res.writeHead(204, { etag: `"${stateVersion(state)}"` }).end();
			});
			return;
		}
		if (path === '/metrics' && req.method === 'GET') {
			if (!authorized(req.headers.authorization)) return void res.writeHead(401).end();
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(options.store.toJSON()));
			return;
		}
		if (path === '/state' && req.method === 'GET') {
			const state = readState(options.root);
			res
				.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', etag: `"${stateVersion(state)}"` })
				.end(JSON.stringify({ live: state.live, ...(state.killedAt ? { killedAt: state.killedAt } : {}) }));
			return;
		}
		if (path === '/beacon' && req.method === 'POST') {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString();
				if (body.length > 1024) req.destroy();
			});
			req.on('end', () => void res.writeHead(recordBeacon(body, readState(options.root), options.store, now()) ? 204 : 400).end());
			return;
		}
		res.writeHead(404).end();
	});
	const flush = setInterval(() => options.store.flush(), 1000);
	const host = options.host ?? '127.0.0.1';
	await new Promise<void>((done) => server.listen(options.port ?? 0, host, done));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://${host}:${port}`,
		server,
		close: () =>
			new Promise((done, fail) => {
				clearInterval(flush);
				options.store.flush();
				server.closeAllConnections();
				server.close((e) => (e ? fail(e) : done()));
			}),
	};
}
