import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
};

/** Serves a directory on a free loopback port. Test helper only; M1's Sandbox replaces it. */
export async function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
	const root = normalize(dir);
	const server = createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		let file = normalize(join(root, path));
		if (file !== root && !file.startsWith(root + sep)) {
			res.writeHead(403).end();
			return;
		}
		if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
		if (!existsSync(file)) {
			res.writeHead(404).end('Not found');
			return;
		}
		res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
		createReadStream(file).pipe(res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
	};
}
