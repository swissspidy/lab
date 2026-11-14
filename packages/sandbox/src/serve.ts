import { createReadStream, realpathSync } from 'node:fs';
import { resolveStatic } from '@lab/core';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.woff2': 'font/woff2',
};

export interface StaticServer {
	url: string;
	close(): Promise<void>;
}

/** Serves a directory, read-only, on a free 127.0.0.1 port. Nothing outside the directory is reachable. */
export async function serveDir(dir: string): Promise<StaticServer> {
	const root = realpathSync(dir);
	const server = createServer((req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405).end();
			return;
		}
		let path: string;
		try {
			path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		} catch {
			res.writeHead(400).end();
			return;
		}
		const real = resolveStatic(root, path);
		if (real === 'forbidden') {
			res.writeHead(403).end();
			return;
		}
		if (real === null) {
			res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
			return;
		}
		res.writeHead(200, { 'content-type': TYPES[extname(real)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
		if (req.method === 'HEAD') res.end();
		else createReadStream(real).pipe(res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () =>
			new Promise((resolve, reject) => {
				server.closeAllConnections();
				server.close((e) => (e ? reject(e) : resolve()));
			}),
	};
}
