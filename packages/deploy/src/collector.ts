// The lab's collector for sites that run their own proxy (see @lab/next):
//   GET  /state    the deploy state: which experiment is live, its share and origin
//   POST /beacon   one beacon, counted per experiment, bucket and interval
//   PUT  /state    with the token: the loop's deployer and kill switch write here
//   GET  /metrics  with the token: the loop's meter reads the counts
// The site's proxy reads /state and forwards beacons; visitors never talk to it.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { readState, writeState } from './deployer.ts';
import type { DeployState } from './deployer.ts';
import { recordBeacon } from './edge.ts';
import type { MetricStore } from './metrics.ts';

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
}

const EXPERIMENT = /^[a-z0-9][a-z0-9-]{1,62}$/;

function validState(value: unknown): DeployState | null {
	if (typeof value !== 'object' || value === null) return null;
	const { live, killedAt } = value as { live?: unknown; killedAt?: unknown };
	if (killedAt !== undefined && typeof killedAt !== 'string') return null;
	if (live === null || live === undefined) return { live: null, ...(typeof killedAt === 'string' ? { killedAt } : {}) };
	const l = live as Record<string, unknown>;
	if (typeof l.experiment !== 'string' || !EXPERIMENT.test(l.experiment)) return null;
	if (typeof l.share !== 'number' || !(l.share > 0 && l.share <= 0.5)) return null;
	if (l.origin !== undefined) {
		try {
			if (!['http:', 'https:'].includes(new URL(String(l.origin)).protocol)) return null;
		} catch {
			return null;
		}
	}
	return { live: { experiment: l.experiment, share: l.share, ...(typeof l.origin === 'string' ? { origin: l.origin } : {}) }, ...(typeof killedAt === 'string' ? { killedAt } : {}) };
}

export async function startCollector(options: CollectorOptions): Promise<{ url: string; server: Server; close(): Promise<void> }> {
	const now = options.now ?? (() => new Date());
	const authorized = (header: string | undefined) => {
		if (!options.token) return false;
		const given = Buffer.from(header ?? '');
		const wanted = Buffer.from(`Bearer ${options.token}`);
		return given.length === wanted.length && timingSafeEqual(given, wanted);
	};
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://collector').pathname;
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
					state = validState(JSON.parse(body));
				} catch {}
				if (!state) return void res.writeHead(400).end();
				writeState(options.root, state);
				res.writeHead(204).end();
			});
			return;
		}
		if (path === '/metrics' && req.method === 'GET') {
			if (!authorized(req.headers.authorization)) return void res.writeHead(401).end();
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(options.store.toJSON()));
			return;
		}
		if (path === '/state' && req.method === 'GET') {
			const { live } = readState(options.root);
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ live }));
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
