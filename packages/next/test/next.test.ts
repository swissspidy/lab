import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assignBucket as hostBucket } from '@lab/deploy';
import { assignBucket, createLabProxy, labBeaconScript, parseState, parseTweaks, route } from '../src/index.ts';
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
		for (const bad of [null, 'x', { live: { experiment: 'Exp 1', share: 0.1 } }, { live: { experiment: 'exp-0001', share: 2 } }, { live: { experiment: 'exp-0001', share: 0.6 } }, { live: { experiment: 'exp-0001', share: 0 } }, { live: { experiment: 'exp-0001', share: 0.1, origin: 'javascript:alert(1)' } }, { live: { experiment: 'exp-0001', share: 0.1, origin: ['https://v.example'] } }]) {
			assert.equal(parseState(bad).live, null, JSON.stringify(bad));
		}
	});

	it('sends a variant visitor to the variant origin and a baseline visitor to the app', () => {
		assert.equal(route(visitorIn('variant'), live()).rewriteTo, 'http://variant.test');
		assert.equal(route(visitorIn('baseline'), live()).rewriteTo, null);
		assert.equal(route(visitorIn('variant'), { live: { experiment: 'exp-0001', share: 0.5 } }).bucket, 'baseline', 'no origin, no variant');
		assert.deepEqual(route(visitorIn('variant'), { live: null }), { ...route(visitorIn('variant'), { live: null }), experiment: null, bucket: 'baseline', rewriteTo: null }, 'no experiment is null, not an empty id');
		const fresh = route(undefined, live());
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

	it('never lets an older, slower state response undo a newer kill', async () => {
		const { calls, NextResponse } = fakeNext();
		let n = 0;
		const fetchImpl = (async () => {
			n++;
			if (n === 1) {
				// The first request is slow and answers "live".
				await new Promise((r) => setTimeout(r, 120));
				return Response.json(live());
			}
			return Response.json({ live: null });
		}) as typeof fetch;
		const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', cacheMs: 0, fetch: fetchImpl });
		const vid = visitorIn('variant');
		const slow = proxy(request('http://site.test/a', { lab_vid: vid }));
		await new Promise((r) => setTimeout(r, 20));
		await proxy(request('http://site.test/b', { lab_vid: vid }));
		await slow;
		// The kill arrived second but was observed by the newer request; the stale answer is dropped.
		const proxy2Calls = calls.map((c) => c.kind);
		assert.deepEqual(proxy2Calls, ['next', 'next']);
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

	describe('personal tweaks', () => {
		const TW = 'tw-0123456789ab';
		const lab = (known: string[] = [TW]) =>
			(async (url: string, init?: RequestInit) => {
				const tweak = /\/tweaks\/(tw-[0-9a-f]{12})\.css$/.exec(url)?.[1];
				if (tweak) return known.includes(tweak) ? new Response(init?.method === 'HEAD' ? null : 'h1 { font-size: 3rem }', { headers: { 'content-type': 'text/css' } }) : new Response(null, { status: 404 });
				return Response.json(live());
			}) as typeof fetch;

		it('opts a visitor in to a tweak the lab has, and back to the page the link names', async () => {
			const { NextResponse } = fakeNext();
			const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: lab() });
			const res = (await proxy(request(`http://site.test/_lab/tweak/${TW}?to=/docs`))) as Response;
			assert.equal(res.status, 303);
			assert.equal(res.headers.get('location'), 'http://site.test/docs');
			assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`^lab_tweaks=${TW}; Path=/; Max-Age=\\d+; SameSite=Lax$`));
			const off = (await proxy(request(`http://site.test/_lab/tweak/${TW}?off`, { lab_tweaks: `${TW},tw-ffffffffffff` }))) as Response;
			assert.match(off.headers.get('set-cookie') ?? '', /^lab_tweaks=tw-ffffffffffff;/);
			const all = (await proxy(request('http://site.test/_lab/tweak/off', { lab_tweaks: TW }))) as Response;
			assert.match(all.headers.get('set-cookie') ?? '', /^lab_tweaks=; Path=\/; Max-Age=0/);
		});

		it('refuses a tweak the lab does not have, and never redirects off the site', async () => {
			const { NextResponse } = fakeNext();
			const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: lab([]) });
			assert.equal(((await proxy(request(`http://site.test/_lab/tweak/${TW}`))) as Response).status, 404);
			assert.equal(((await proxy(request('http://site.test/_lab/tweak/not-an-id'))) as Response).status, 404);
			const known = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: lab() });
			for (const to of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
				const res = (await known(request(`http://site.test/_lab/tweak/${TW}?to=${encodeURIComponent(to)}`))) as Response;
				assert.equal(res.headers.get('location'), 'http://site.test/', to);
			}
			assert.equal(((await createLabProxy({ NextResponse, lab: undefined })(request(`http://site.test/_lab/tweak/${TW}`))) as Response).status, 404, 'no lab, no tweaks');
		});

		it('serves a tweak’s stylesheet from the lab', async () => {
			const { NextResponse } = fakeNext();
			const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: lab() });
			const css = (await proxy(request(`http://site.test/_lab/tweaks/${TW}.css`))) as Response;
			assert.equal(css.status, 200);
			assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
			assert.equal(await css.text(), 'h1 { font-size: 3rem }');
			assert.equal(((await proxy(request('http://site.test/_lab/tweaks/tw-ffffffffffff.css'))) as Response).status, 404);
			assert.equal(((await proxy(request('http://site.test/_lab/tweaks/state.css'))) as Response).status, 404, 'only a tweak id');
		});

		it('leaves a tweaked visitor out of the experiment: baseline, and no experiment for the beacon', async () => {
			const { calls, NextResponse } = fakeNext();
			const proxy = createLabProxy({ NextResponse, lab: 'http://lab.test', fetch: lab() });
			await proxy(request('http://site.test/', { lab_vid: visitorIn('variant'), lab_tweaks: TW }));
			assert.equal(calls[0]!.kind, 'next');
			assert.equal(calls[0]!.cookies.lab_exp, '');
			assert.equal(calls[0]!.cookies.lab_bucket, 'baseline');
			assert.deepEqual(parseTweaks(`${TW},bogus,${TW},tw-1,tw-111111111111`), [TW, 'tw-111111111111']);
		});

		it('the beacon script adds the tweaks and sends nothing without an experiment', () => {
			const script = labBeaconScript('next_step_click');
			assert.match(script, /lab_tweaks/);
			assert.match(script, /\/_lab\/tweaks\//);
			assert.match(script, /if \(!e\) return;/);
		});
	});
});
