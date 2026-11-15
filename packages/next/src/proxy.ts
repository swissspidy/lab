// The proxy.ts helper. Usage, in the site's proxy.ts:
//
//   import { NextResponse } from 'next/server';
//   import { createLabProxy } from '@lab/next';
//   export const proxy = createLabProxy({ NextResponse, lab: process.env.LAB_URL });
//
// `lab` is the lab's collector: it serves the current state at /state and
// takes beacons at /beacon. Next.js is passed in, so this package does not
// depend on a Next.js version.
import { BEACON_PATH, COOKIE_BUCKET, COOKIE_EXPERIMENT, COOKIE_VISITOR, decide, parseState } from './decide.ts';
import type { LabState } from './decide.ts';

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

	async function state(): Promise<LabState> {
		if (!base) return { live: null };
		if (cached && Date.now() - cached.at < cacheMs) return cached.state;
		try {
			const res = await doFetch(`${base}/state`, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
			const value = res.ok ? parseState(await res.json()) : { live: null };
			cached = { state: value, at: Date.now() };
		} catch {
			// The lab is unreachable: serve the baseline, and try again soon.
			cached = { state: { live: null }, at: Date.now() - cacheMs + 1000 };
		}
		return cached.state;
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
		// Not configured (a variant deployment, say): change nothing, set no cookies.
		// A variant served behind the site's proxy must not overwrite its cookies.
		if (!base) return NextResponse.next();
		const decision = decide(request.cookies.get(COOKIE_VISITOR)?.value, await state());
		// Never rewrite to ourselves: a variant deployment that also runs this proxy would loop.
		if (decision.rewriteTo && new URL(decision.rewriteTo).host === url.host) {
			decision.rewriteTo = null;
			decision.bucket = 'baseline';
		}
		const response = decision.rewriteTo ? NextResponse.rewrite(new URL(url.pathname + url.search, decision.rewriteTo)) : NextResponse.next();
		if (decision.newVisitor) response.cookies.set(COOKIE_VISITOR, decision.visitor, { path: '/', maxAge: YEAR, httpOnly: true, sameSite: 'lax' });
		// Read by the beacon; they carry nothing but the experiment id and bucket.
		response.cookies.set(COOKIE_EXPERIMENT, decision.experiment, { path: '/', sameSite: 'lax' });
		response.cookies.set(COOKIE_BUCKET, decision.bucket, { path: '/', sameSite: 'lax' });
		return response;
	};
}
