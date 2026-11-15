// A reverse proxy in front of a running site that adds a stylesheet to
// every HTML page, after the site's own styles. It is how a personal tweak
// is verified: the same site, the same verifier, with the tweak applied the
// way a browser will apply it. The CSS is served from the proxy's own
// origin and linked, never written into the page: a site's CSP that allows
// only same-origin styles still applies it, and nothing in the CSS is ever
// parsed as HTML.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CssInjector, RunningSite } from '@lab/core';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'accept-encoding', 'content-length']);

async function body(req: IncomingMessage): Promise<Buffer | undefined> {
	if (req.method === 'GET' || req.method === 'HEAD') return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/** Where the proxy serves the tweak's CSS, on the site's own origin. */
export const TWEAK_STYLESHEET = '/__lab-tweak.css';

/** Links the tweak's stylesheet before `</head>`, after the site's own styles, or at the start when there is none. */
export function injectStylesheet(html: string): string {
	const tag = `<link rel="stylesheet" href="${TWEAK_STYLESHEET}" data-lab-tweak>`;
	const at = html.search(/<\/head\s*>/i);
	return at === -1 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

export class CssInjectingProxy implements CssInjector {
	async inject(site: RunningSite, css: string): Promise<RunningSite> {
		const upstream = new URL(site.url);
		const server = createServer(async (req, res) => {
			if (new URL(req.url ?? '/', 'http://proxy').pathname === TWEAK_STYLESHEET) {
				res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : css);
				return;
			}
			try {
				const headers = new Headers();
				for (const [name, value] of Object.entries(req.headers)) {
					if (!HOP.has(name) && typeof value === 'string') headers.set(name, value);
				}
				const init: RequestInit = { method: req.method ?? 'GET', headers, redirect: 'manual' };
				const sent = await body(req);
				if (sent) init.body = new Uint8Array(sent);
				const answer = await fetch(new URL(req.url ?? '/', upstream), init);
				const out: Record<string, string | string[]> = {};
				answer.headers.forEach((value, name) => {
					if (!HOP.has(name) && name !== 'content-encoding' && name !== 'set-cookie') out[name] = value;
				});
				// Each cookie stays its own header: joined, they would be one broken cookie.
				const cookies = answer.headers.getSetCookie();
				if (cookies.length > 0) out['set-cookie'] = cookies;
				const location = answer.headers.get('location');
				if (location) out.location = location.replace(upstream.origin, `http://${req.headers.host}`);
				const type = answer.headers.get('content-type') ?? '';
				if (type.includes('text/html')) {
					// Only pages are read whole, to add the link.
					const page = injectStylesheet(await answer.text());
					res.writeHead(answer.status, out).end(req.method === 'HEAD' ? undefined : page);
					return;
				}
				// Everything else streams as it arrives (event streams, large files).
				res.writeHead(answer.status, out);
				if (req.method === 'HEAD' || !answer.body) return void res.end();
				const stream = Readable.fromWeb(answer.body as never);
				stream.on('error', () => res.destroy());
				stream.pipe(res);
			} catch {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			}
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		const { port } = server.address() as AddressInfo;
		return {
			url: `http://127.0.0.1:${port}/`,
			...(site.root === undefined ? {} : { root: site.root }),
			// The proxy only: the site underneath belongs to whoever started it.
			stop: () => new Promise<void>((done) => server.close(() => done())),
		};
	}
}
