// What the verifier measures on one page of one site at one viewport.
import type { Browser, BrowserContext, Page } from 'playwright';

export interface PageMeasurement {
	page: string;
	viewport: string;
	status: number;
	axe: string[];
	consoleErrors: string[];
	failedRequests: string[];
	/** Origins other than the site's own that the page tried to reach. */
	foreignOrigins: string[];
	overflow: boolean;
	lcpMs: number;
	cls: number;
	/** Same-origin link targets, without the fragment. */
	links: string[];
	content: { numbers: string[]; names: string[]; hrefs: string[]; forms: string[] };
}

/** Collects LCP and CLS the way the browser reports them. */
const VITALS = `
window.labVitals = { lcp: 0, cls: 0 };
try {
	new PerformanceObserver((list) => { for (const e of list.getEntries()) window.labVitals.lcp = e.startTime; })
		.observe({ type: 'largest-contentful-paint', buffered: true });
	new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.labVitals.cls += e.value; })
		.observe({ type: 'layout-shift', buffered: true });
} catch {}
`;

/** How long to watch a page after `load`, for late errors and layout shifts. */
export const SETTLE_MS = 1200;

export async function newContext(browser: Browser, siteUrl: string, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; foreign: Set<string> }> {
	const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
	const own = new URL(siteUrl).origin;
	const foreign = new Set<string>();
	// The sandbox has no network beyond the site: every other request is
	// recorded and refused.
	await context.route('**/*', (route) => {
		const url = route.request().url();
		const origin = url.startsWith('data:') || url.startsWith('blob:') ? own : new URL(url).origin;
		if (origin === own) return route.continue();
		foreign.add(origin);
		return route.abort('blockedbyclient');
	});
	await context.addInitScript(VITALS);
	return { context, foreign };
}

export async function measurePage(browser: Browser, siteUrl: string, path: string, viewport: { width: number; height: number }, axeSource: string): Promise<PageMeasurement> {
	const { context, foreign } = await newContext(browser, siteUrl, viewport);
	const page = await context.newPage();
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error' && !m.text().includes('net::ERR_BLOCKED_BY_CLIENT')) consoleErrors.push(m.text());
	});
	page.on('pageerror', (e) => consoleErrors.push(`Uncaught ${e.message}`));
	const own = new URL(siteUrl).origin;
	// Requests to other origins are refused by the sandbox and reported as new origins instead.
	const isOwn = (url: string) => url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === own;
	page.on('requestfailed', (r) => {
		// ERR_ABORTED is the page cancelling its own request (a prefetch cut
		// short by navigation or by closing the page), not a failure to serve.
		const error = r.failure()?.errorText ?? '';
		if (isOwn(r.url()) && error !== 'net::ERR_ABORTED') failedRequests.push(`${r.url()} (${error})`);
	});
	page.on('response', (r) => {
		if (r.status() >= 400) failedRequests.push(`${r.url()} (${r.status()})`);
	});
	try {
		const response = await page.goto(new URL(path, siteUrl).href, { waitUntil: 'load' });
		await page.waitForTimeout(SETTLE_MS);
		await page.addScriptTag({ content: axeSource });
		const data = await page.evaluate(collect);
		return {
			page: path,
			viewport: `${viewport.width}x${viewport.height}`,
			status: response?.status() ?? 0,
			axe: data.axe,
			consoleErrors,
			failedRequests: [...new Set(failedRequests)],
			foreignOrigins: [...foreign],
			overflow: data.overflow,
			lcpMs: data.lcp,
			cls: data.cls,
			links: data.links,
			content: data.content,
		};
	} finally {
		await context.close();
	}
}

/** Runs in the page. Must not close over anything. */
async function collect() {
	type Axe = { run(ctx: Document, options: object): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown[] }> }> }> };
	const g = globalThis as unknown as { axe: Axe; labVitals: { lcp: number; cls: number } };
	const result = await g.axe.run(document, { resultTypes: ['violations'] });
	const axe = result.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${JSON.stringify(n.target)}`));

	const own = location.origin;
	const links = new Set<string>();
	const hrefs = new Set<string>();
	for (const a of Array.from(document.querySelectorAll('a[href]'))) {
		const url = new URL((a as HTMLAnchorElement).href, location.href);
		hrefs.add(url.href.replace(own, ''));
		if (url.origin === own) {
			url.hash = '';
			links.add(url.href);
		}
	}

	// Text the visitor can read, one text node at a time.
	const numbers = new Set<string>();
	const names = new Set<string>();
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const parent = node.parentElement;
		if (!parent || parent.closest('script, style, noscript, template')) continue;
		const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
		if (!text) continue;
		for (const m of text.matchAll(/(?:(?:CHF|USD|EUR|GBP|[$€£])\s?)?\d[\d.,'’]*\d|(?:(?:CHF|USD|EUR|GBP|[$€£])\s?)?\d/g)) numbers.add(m[0].replace(/\s+/g, ' '));
		// A capitalized word that does not start a sentence is taken as a name.
		for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
			const words = sentence.split(' ').slice(1);
			for (const word of words) {
				const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
				if (/^\p{Lu}[\p{L}\p{N}-]*$/u.test(clean)) names.add(clean);
			}
		}
	}
	const forms = Array.from(document.forms).map((f) => {
		const fields = Array.from(f.elements)
			.map((e) => `${(e as HTMLInputElement).name || ''}:${(e as HTMLInputElement).type || e.tagName.toLowerCase()}`)
			.filter((s) => !s.startsWith(':submit') && !s.startsWith(':button'))
			.toSorted();
		return `${f.getAttribute('action') ?? ''}|${(f.getAttribute('method') ?? 'get').toLowerCase()}|${fields.join(',')}`;
	});

	return {
		axe,
		overflow: document.documentElement.scrollWidth > window.innerWidth,
		lcp: g.labVitals.lcp,
		cls: g.labVitals.cls,
		links: [...links],
		content: { numbers: [...numbers], names: [...names], hrefs: [...hrefs], forms },
	};
}

export async function screenshot(page: Page, file: string): Promise<string | undefined> {
	try {
		await page.screenshot({ path: file, fullPage: true });
		return file;
	} catch {
		return undefined;
	}
}
