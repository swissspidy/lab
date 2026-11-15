import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CssInjectingProxy, injectStyle } from '../src/index.ts';

describe('CssInjectingProxy', () => {
	let upstream: ReturnType<typeof createServer>;
	let url: string;
	before(async () => {
		upstream = createServer((req, res) => {
			if (req.url === '/site.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end('h1 { color: red }');
			if (req.url === '/go') return void res.writeHead(302, { location: `${url}docs` }).end();
			if (req.method === 'POST') {
				let body = '';
				req.on('data', (c: Buffer) => (body += c));
				req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(`got ${body}`));
				return;
			}
			res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head><title>T</title></head><body><h1>Hi</h1></body></html>');
		});
		await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
		url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/`;
	});
	after(() => upstream.close());

	it('adds the stylesheet to HTML pages, after the site’s own styles, and nowhere else', async () => {
		const site = await new CssInjectingProxy().inject({ url, root: '/built', stop: async () => {} }, 'h1 { font-size: 3rem }');
		try {
			assert.equal(site.root, '/built');
			const page = await fetch(site.url);
			assert.equal(await page.text(), '<html><head><title>T</title><style data-lab-tweak>h1 { font-size: 3rem }</style></head><body><h1>Hi</h1></body></html>');
			assert.deepEqual(page.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'], 'cookies stay separate');
			assert.equal(await (await fetch(new URL('site.css', site.url))).text(), 'h1 { color: red }');
			const posted = await fetch(site.url, { method: 'POST', body: 'x=1' });
			assert.equal(await posted.text(), 'got x=1');
			const moved = await fetch(new URL('go', site.url), { redirect: 'manual' });
			assert.equal(moved.headers.get('location'), new URL('docs', site.url).href, 'redirects stay on the proxy');
		} finally {
			await site.stop();
		}
	});

	it('puts the style first when a page has no head', () => {
		assert.equal(injectStyle('<p>x</p>', 'p{}'), '<style data-lab-tweak>p{}</style><p>x</p>');
		assert.equal(injectStyle('<HEAD></HEAD >', 'p{}'), '<HEAD><style data-lab-tweak>p{}</style></HEAD >');
	});
});
