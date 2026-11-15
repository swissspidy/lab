import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignBucket as hostBucket } from '@lab/deploy';
import { assignBucket, createLabProxy, decide, labBeaconScript, parseState } from '../src/index.ts';
import type { LabState } from '../src/index.ts';

type Call = { kind: 'next' | 'rewrite'; to?: string; cookies: Record<string, string> };
const fakeNext = () => {
	const calls: Call[] = [];
	const make = (kind: Call['kind'], to?: string) => {
		const call: Call = { kind, ...(to ? { to } : {}), cookies: {} };
		calls.push(call);
		return { cookies: { set: (name: string, value: string) => void (call.cookies[name] = value) } };
	};
	return { calls, NextResponse: { next: () => make('next'), rewrite: (url: URL) => make('rewrite', url.href) } };
};
const request = (url: string, cookies: Record<string, string> = {}, method = 'GET', body = '') => ({
	method,
	url,
	cookies: { get: (n: string) => (n in cookies ? { value: cookies[n]! } : undefined) },
	text: async () => body,
});
const live = (origin = 'http://variant.test'): LabState => ({ live: { experiment: 'exp-0001', share: 0.5, origin } });
function visitorIn(bucket: 'baseline' | 'variant'): string {
	for (let i = 0; ; i++) {
		const id = i.toString(16).padStart(32, '0');
		if (assignBucket(id, 'exp-0001', 0.5) === bucket) return id;
	}
}

describe('@lab/next', () => {
	it('buckets exactly like the reference host', () => {
		for (let i = 0; i < 200; i++) {
			const id = i.toString(16).padStart(32, '0');
			assert.equal(assignBucket(id, 'exp-0042', 0.3), hostBucket(id, 'exp-0042', 0.3));
		}
	});

	it('parses only well-formed state; anything else serves the baseline', () => {
		assert.deepEqual(parseState({ live: { experiment: 'exp-0001', share: 0.1, origin: 'https://v.example' } }).live?.origin, 'https://v.example');
		for (const bad of [null, 'x', { live: { experiment: 'Exp 1', share: 0.1 } }, { live: { experiment: 'exp-0001', share: 2 } }, { live: { experiment: 'exp-0001', share: 0.1, origin: 'javascript:alert(1)' } }]) {
			assert.equal(parseState(bad).live, null, JSON.stringify(bad));
		}
	});

	it('sends a variant visitor to the variant origin and a baseline visitor to the app', () => {
		assert.equal(decide(visitorIn('variant'), live()).rewriteTo, 'http://variant.test');
		assert.equal(decide(visitorIn('baseline'), live()).rewriteTo, null);
		assert.equal(decide(visitorIn('variant'), { live: { experiment: 'exp-0001', share: 0.5 } }).bucket, 'baseline', 'no origin, no variant');
		const fresh = decide(undefined, live());
		assert.ok(fresh.newVisitor && /^[0-9a-f]{32}$/.test(fresh.visitor));
	});

	it('rewrites pages and assets for the variant bucket, keeping the path and query', async () => {
		const { calls, NextResponse } = fakeNext();
		const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: (async () => Response.json(live())) as typeof fetch });
		await proxy(request('http://site.test/_next/static/chunks/a.js?v=1', { lab_vid: visitorIn('variant') }));
		await proxy(request('http://site.test/docs', { lab_vid: visitorIn('baseline') }));
		assert.deepEqual(calls.map((c) => [c.kind, c.to ?? '', c.cookies.lab_bucket]), [
			['rewrite', 'http://variant.test/_next/static/chunks/a.js?v=1', 'variant'],
			['next', '', 'baseline'],
		]);
		assert.equal(calls[0]!.cookies.lab_exp, 'exp-0001');
		assert.equal(calls[0]!.cookies.lab_vid, undefined, 'a known visitor keeps its cookie');
	});

	it('serves the baseline when the lab is unreachable, unset, or killed the experiment', async () => {
		for (const fetchImpl of [async () => Promise.reject(new Error('down')), async () => new Response('nope', { status: 500 }), async () => Response.json({ live: null })]) {
			const { calls, NextResponse } = fakeNext();
			const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: fetchImpl as typeof fetch });
			await proxy(request('http://site.test/', { lab_vid: visitorIn('variant') }));
			assert.equal(calls[0]!.kind, 'next');
		}
		const { calls, NextResponse } = fakeNext();
		await createLabProxy({ NextResponse, lab: undefined })(request('http://site.test/'));
		assert.equal(calls[0]!.kind, 'next');
		// Unconfigured, it sets no cookies: a variant behind the site's proxy must not overwrite them.
		assert.deepEqual(calls[0]!.cookies, {});
	});

	it('takes the kill switch within the cache time', async () => {
		let state = live();
		const { calls, NextResponse } = fakeNext();
		const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', cacheMs: 50, fetch: (async () => Response.json(state)) as typeof fetch });
		const vid = visitorIn('variant');
		await proxy(request('http://site.test/', { lab_vid: vid }));
		state = { live: null };
		await new Promise((r) => setTimeout(r, 80));
		await proxy(request('http://site.test/', { lab_vid: vid }));
		assert.deepEqual(calls.map((c) => c.kind), ['rewrite', 'next']);
	});

	it('never rewrites to its own host', async () => {
		const { calls, NextResponse } = fakeNext();
		const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: (async () => Response.json(live('http://site.test'))) as typeof fetch });
		await proxy(request('http://site.test/', { lab_vid: visitorIn('variant') }));
		assert.equal(calls[0]!.kind, 'next');
	});

	it('forwards beacons to the lab and answers 204', async () => {
		const sent: Array<[string, string]> = [];
		const { NextResponse } = fakeNext();
		const proxy = createLabProxy({
			NextResponse,
			lab: 'http://lab.test/',
			fetch: (async (url: string, init?: RequestInit) => {
				sent.push([url, String(init?.body)]);
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});
		const res = await proxy(request('http://site.test/_lab/beacon', {}, 'POST', '{"e":"exp-0001","b":"variant","k":"visit"}'));
		assert.equal((res as Response).status, 204);
		assert.deepEqual(sent, [['http://lab.test/beacon', '{"e":"exp-0001","b":"variant","k":"visit"}']]);
		assert.equal(((await proxy(request('http://site.test/_lab/beacon'))) as Response).status, 405);
		// Without a lab, beacons are accepted and dropped: no 404s on the page.
		const unset = createLabProxy({ NextResponse, lab: undefined });
		assert.equal(((await unset(request('http://site.test/_lab/beacon', {}, 'POST', '{}'))) as Response).status, 204);
	});

	it('builds a beacon that reads the proxy cookies', () => {
		const script = labBeaconScript('next_step_click');
		assert.match(script, /lab_exp/);
		assert.match(script, /"\/_lab\/beacon"/);
		assert.doesNotThrow(() => new Function(script));
	});
});
