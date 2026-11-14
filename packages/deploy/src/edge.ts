// The edge function and beacon endpoint for the reference host. On a real
// host this logic runs at the edge (it only reads state and rewrites the
// path); here it is a Node HTTP server.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import type { LabConfig } from '@lab/core';
import { readState } from './deployer.ts';
import { BUCKETS, EVENTS, SITE } from './metrics.ts';
import type { BeaconEvent, Bucket, MetricStore } from './metrics.ts';

export const COOKIE = 'lab_vid';
export const BEACON_PATH = '/_lab/beacon';
export const BEACON_SCRIPT = '/_lab/beacon.js';

/** Sticky bucketing: the same visitor always lands in the same bucket of an experiment. */
export function assignBucket(visitorId: string, experiment: string, share: number): Bucket {
	const hash = createHash('sha256').update(`${experiment}:${visitorId}`).digest();
	return hash.readUInt32BE(0) / 2 ** 32 < share ? 'variant' : 'baseline';
}

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

/** Sends one beacon per event: a visit, the first conversion, the first engagement, the first uncaught error. */
export const beaconScript = (metric: string) => `(() => {
	const s = document.currentScript;
	const e = s.dataset.experiment, b = s.dataset.bucket, m = ${JSON.stringify(metric)};
	const send = (k) => { try { navigator.sendBeacon(${JSON.stringify(BEACON_PATH)}, JSON.stringify({ e, b, k })); } catch {} };
	const once = {};
	const first = (k) => { if (!once[k]) { once[k] = true; send(k); } };
	send('visit');
	addEventListener('click', (ev) => {
		first('engaged');
		const t = ev.target instanceof Element ? ev.target.closest('[data-lab-event]') : null;
		if (t && t.getAttribute('data-lab-event') === m) first('conversion');
	}, true);
	addEventListener('scroll', () => first('engaged'), { passive: true, once: true });
	addEventListener('error', () => first('js_error'));
})();`;

function cookie(req: IncomingMessage, name: string): string | undefined {
	for (const part of (req.headers.cookie ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return v.join('=');
	}
	return undefined;
}

export interface EdgeOptions {
	root: string;
	store: MetricStore;
	config: LabConfig;
	now?: () => Date;
}

export function createEdgeHandler(options: EdgeOptions): (req: IncomingMessage, res: ServerResponse) => void {
	const { root, store, config } = options;
	const now = options.now ?? (() => new Date());
	const script = beaconScript(config.metric.id);

	return (req, res) => {
		const url = new URL(req.url ?? '/', 'http://edge');
		if (url.pathname === BEACON_PATH) {
			if (req.method !== 'POST') return void res.writeHead(405).end();
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString();
				if (body.length > 1024) req.destroy();
			});
			req.on('end', () => {
				try {
					const { e, b, k } = JSON.parse(body) as { e: unknown; b: unknown; k: unknown };
					const state = readState(root);
					const experiment = typeof e === 'string' && e !== '' && state.live?.experiment === e ? e : SITE;
					if (!BUCKETS.includes(b as Bucket) || !EVENTS.includes(k as BeaconEvent)) throw new Error('invalid');
					store.record(experiment, experiment === SITE ? 'baseline' : (b as Bucket), k as BeaconEvent, now());
					res.writeHead(204).end();
				} catch {
					res.writeHead(400).end();
				}
			});
			return;
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
		if (url.pathname === BEACON_SCRIPT) return void res.writeHead(200, { 'content-type': TYPES['.js']!, 'cache-control': 'no-store' }).end(script);
		if (url.pathname.startsWith('/_lab/')) return void res.writeHead(404).end();

		let visitor = cookie(req, COOKIE);
		const headers: Record<string, string> = { 'cache-control': 'no-store' };
		if (!visitor || !/^[0-9a-f]{32}$/.test(visitor)) {
			visitor = randomBytes(16).toString('hex');
			headers['set-cookie'] = `${COOKIE}=${visitor}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
		}
		const state = readState(root);
		const bucket: Bucket = state.live ? assignBucket(visitor, state.live.experiment, state.live.share) : 'baseline';
		const base = bucket === 'variant' && state.live ? join(root, 'variants', state.live.experiment) : join(root, 'current');
		if (!existsSync(base)) return void res.writeHead(503).end('Nothing is published.');
		const dir = realpathSync(base);
		let file = normalize(join(dir, decodeURIComponent(url.pathname)));
		if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
		if (!existsSync(file)) return void res.writeHead(404, headers).end('Not found');
		const real = realpathSync(file);
		if (!real.startsWith(dir + sep)) return void res.writeHead(403).end();
		const type = TYPES[extname(real)] ?? 'application/octet-stream';
		if (type.startsWith('text/html')) {
			const tag = `<script src="${BEACON_SCRIPT}" data-experiment="${state.live?.experiment ?? ''}" data-bucket="${bucket}" defer></script>`;
			const html = readFileSync(real, 'utf8');
			const out = html.includes('</head>') ? html.replace('</head>', `${tag}\n</head>`) : `${tag}\n${html}`;
			return void res.writeHead(200, { ...headers, 'content-type': type }).end(req.method === 'HEAD' ? undefined : out);
		}
		res.writeHead(200, { ...headers, 'content-type': type });
		if (req.method === 'HEAD') res.end();
		else createReadStream(real).pipe(res);
	};
}

export async function startEdgeServer(options: EdgeOptions & { port?: number; host?: string }): Promise<{ url: string; server: Server; close(): Promise<void> }> {
	const handler = createEdgeHandler(options);
	const server = createServer(handler);
	const flush = setInterval(() => options.store.flush(), 1000);
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://${options.host ?? '127.0.0.1'}:${port}/`,
		server,
		close: () =>
			new Promise((resolve, reject) => {
				clearInterval(flush);
				options.store.flush();
				server.closeAllConnections();
				server.close((e) => (e ? reject(e) : resolve()));
			}),
	};
}
