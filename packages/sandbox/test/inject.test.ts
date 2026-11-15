import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CssInjectingProxy, TWEAK_STYLESHEET, injectStylesheet } from '../src/index.ts';

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
			assert.equal(await page.text(), '<html><head><title>T</title><link rel="stylesheet" href="/__lab-tweak.css" data-lab-tweak></head><body><h1>Hi</h1></body></html>');
			const sheet = await fetch(new URL(TWEAK_STYLESHEET, site.url));
			assert.equal(sheet.headers.get('content-type'), 'text/css; charset=utf-8');
			assert.equal(await sheet.text(), 'h1 { font-size: 3rem }', 'the CSS is served from the same origin, never written into the page');
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

	it('puts the link first when a page has no head', () => {
		assert.equal(injectStylesheet('<p>x</p>'), '<link rel="stylesheet" href="/__lab-tweak.css" data-lab-tweak><p>x</p>');
		assert.equal(injectStylesheet('<HEAD></HEAD >'), '<HEAD><link rel="stylesheet" href="/__lab-tweak.css" data-lab-tweak></HEAD >');
	});

	it('streams what is not a page, so an open event stream reaches the browser', async () => {
		const events = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('data: first\n\n');
		});
		await new Promise<void>((done) => events.listen(0, '127.0.0.1', done));
		const site = await new CssInjectingProxy().inject({ url: `http://127.0.0.1:${(events.address() as AddressInfo).port}/`, stop: async () => {} }, 'p{}');
		try {
			const res = await fetch(site.url);
			const reader = res.body!.getReader();
			const { value } = await reader.read();
			assert.equal(new TextDecoder().decode(value), 'data: first\n\n');
			await reader.cancel();
		} finally {
			await site.stop();
			events.closeAllConnections();
			events.close();
		}
	});

	it('applies the tweak on a site whose CSP allows only its own styles', async () => {
		const strict = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'self'" }).end('<html><head></head><body><h1>Hi</h1></body></html>');
		});
		await new Promise<void>((done) => strict.listen(0, '127.0.0.1', done));
		const site = await new CssInjectingProxy().inject({ url: `http://127.0.0.1:${(strict.address() as AddressInfo).port}/`, stop: async () => {} }, 'h1 { color: rgb(1, 2, 3) }');
		const { chromium } = await import('playwright');
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(site.url);
			assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color), 'rgb(1, 2, 3)');
		} finally {
			await browser.close();
			await site.stop();
			strict.close();
		}
	});
});
