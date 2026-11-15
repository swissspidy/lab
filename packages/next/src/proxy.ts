// The proxy.ts helper. Usage, in the site's proxy.ts:
//
//   import { NextResponse } from 'next/server';
//   import { createLabProxy } from '@lab/next';
//   export const proxy = createLabProxy({ NextResponse, lab: process.env.LAB_URL });
//
// `lab` is the lab's collector: it serves the current state at /state and
// takes beacons at /beacon. Next.js is passed in, so this package does not
// depend on a Next.js version.
import { BEACON_PATH, COOKIE_BUCKET, COOKIE_EXPERIMENT, COOKIE_TWEAKS, COOKIE_VISITOR, MAX_TWEAKS, TWEAK_CSS, TWEAK_OPT_IN, isTweakId, parseState, parseTweaks, route } from './route.ts';
import type { LabState } from './route.ts';

interface CookieStore {
	get(name: string): { value: string } | undefined;
}
interface ResponseCookies {
	set(name: string, value: string, options?: { path?: string; maxAge?: number; httpOnly?: boolean; sameSite?: 'lax' | 'strict' | 'none' }): unknown;
}
export interface ProxyRequest {
	method: string;
	url: string;
	cookies: CookieStore;
	text(): Promise<string>;
}
interface ProxyResponse {
	cookies: ResponseCookies;
}
export interface NextResponseLike<R extends ProxyResponse> {
	next(): R;
	rewrite(destination: URL): R;
}

export interface LabProxyOptions<R extends ProxyResponse> {
	NextResponse: NextResponseLike<R>;
	/** The lab collector's base URL. Unset: the proxy does nothing. */
	lab: string | undefined;
	/** How long to reuse the state. The kill switch takes effect within this. Default 5 s. */
	cacheMs?: number;
	fetch?: typeof fetch;
}

const YEAR = 365 * 24 * 3600;

export function createLabProxy<R extends ProxyResponse>(options: LabProxyOptions<R>): (request: ProxyRequest) => Promise<R | Response> {
	const { NextResponse } = options;
	const cacheMs = options.cacheMs ?? 5000;
	const doFetch = options.fetch ?? fetch;
	const base = options.lab ? options.lab.replace(/\/+$/, '') : null;
	let cached: { state: LabState; at: number } | null = null;
	// Each fetch is numbered; a response older than one already applied is
	// dropped, so a slow "live" answer can never undo a newer kill. Cache age
	// counts from when the request started, not when it finished.
	let issued = 0;
	let applied = 0;

	async function state(): Promise<LabState> {
		if (!base) return { live: null };
		if (cached && Date.now() - cached.at < cacheMs) return cached.state;
		const mine = ++issued;
		const startedAt = Date.now();
		let value: LabState;
		let at = startedAt;
		try {
			const res = await doFetch(`${base}/state`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
			value = res.ok ? parseState(await res.json()) : { live: null };
		} catch {
			// The lab is unreachable: serve the baseline, and try again soon.
			value = { live: null };
			at = startedAt - cacheMs + Math.min(cacheMs, 1000);
		}
		if (mine > applied) {
			applied = mine;
			cached = { state: value, at };
		}
		return cached?.state ?? value;
	}

	/** Opting in or out of a tweak: the cookie, then back to the page the link named. */
	async function optIn(url: URL, current: string | undefined): Promise<Response> {
		const name = url.pathname.slice(TWEAK_OPT_IN.length);
		let tweaks = parseTweaks(current);
		if (name === 'off') {
			tweaks = [];
		} else if (!isTweakId(name)) {
			return new Response('No such tweak.', { status: 404 });
		} else if (url.searchParams.has('off')) {
			tweaks = tweaks.filter((id) => id !== name);
		} else if (!tweaks.includes(name)) {
			// Only a tweak the lab has: a link cannot set an id nobody verified.
			const known = base ? await doFetch(`${base}/tweaks/${name}.css`, { method: 'HEAD', signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false) : false;
			if (!known) return new Response('No such tweak.', { status: 404 });
			tweaks = [...tweaks, name].slice(-MAX_TWEAKS);
		}
		// Back to a path on this site only: never an open redirect.
		const to = url.searchParams.get('to') ?? '/';
		// Absolute, on this site's origin: Next.js refuses a relative Location from a proxy. The
		// destination is parsed first and kept only if it is still on this origin: a parser drops
		// tabs and newlines, so "/\t/evil.example" would otherwise become "//evil.example".
		let destination: URL | null = null;
		try {
			destination = new URL(to, url.origin);
		} catch {}
		const location = to.startsWith('/') && destination?.origin === url.origin ? destination.href : new URL('/', url.origin).href;
		const cookie = tweaks.length > 0 ? `${COOKIE_TWEAKS}=${tweaks.join(',')}; Path=/; Max-Age=${YEAR}; SameSite=Lax` : `${COOKIE_TWEAKS}=; Path=/; Max-Age=0; SameSite=Lax`;
		return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store' } });
	}

	return async (request) => {
		const url = new URL(request.url);
		if (url.pathname === BEACON_PATH) {
			if (request.method !== 'POST') return new Response(null, { status: 405 });
			const body = await request.text();
			// Without a lab the beacon is accepted and dropped, so pages never see a 404.
			if (base && body.length <= 1024) await doFetch(`${base}/beacon`, { method: 'POST', body, signal: AbortSignal.timeout(1500) }).catch(() => undefined);
			return new Response(null, { status: 204 });
		}
		if (url.pathname.startsWith(TWEAK_CSS) && request.method === 'GET') {
			const id = url.pathname.slice(TWEAK_CSS.length).replace(/\.css$/, '');
			if (!base || !isTweakId(id)) return new Response(null, { status: 404 });
			// The body can fail after the headers arrived: both count as no stylesheet.
			const css = await doFetch(`${base}/tweaks/${id}.css`, { signal: AbortSignal.timeout(1500) })
				.then((res) => (res.ok ? res.text() : null))
				.catch(() => null);
			if (css === null) return new Response(null, { status: 404 });
			return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
		}
		if (url.pathname.startsWith(TWEAK_OPT_IN) && request.method === 'GET') {
			return optIn(url, request.cookies.get(COOKIE_TWEAKS)?.value);
		}
		// Not configured (a variant deployment, say): change nothing, set no cookies.
		// A variant served behind the site's proxy must not overwrite its cookies.
		if (!base) return NextResponse.next();
		const tweaked = parseTweaks(request.cookies.get(COOKIE_TWEAKS)?.value).length > 0;
		const decision = route(request.cookies.get(COOKIE_VISITOR)?.value, await state(), tweaked);
		// Never rewrite to ourselves: a variant deployment that also runs this proxy would loop.
		if (decision.rewriteTo && new URL(decision.rewriteTo).host === url.host) {
			decision.rewriteTo = null;
			decision.bucket = 'baseline';
		}
		const response = decision.rewriteTo ? NextResponse.rewrite(new URL(url.pathname + url.search, decision.rewriteTo)) : NextResponse.next();
		if (decision.newVisitor) response.cookies.set(COOKIE_VISITOR, decision.visitor, { path: '/', maxAge: YEAR, httpOnly: true, sameSite: 'lax' });
		// Read by the beacon; they carry nothing but the experiment id and bucket.
		response.cookies.set(COOKIE_EXPERIMENT, decision.experiment ?? '', { path: '/', sameSite: 'lax' });
		response.cookies.set(COOKIE_BUCKET, decision.bucket, { path: '/', sameSite: 'lax' });
		return response;
	};
}
