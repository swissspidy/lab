// Interprets an experiment's acceptance checks. They are data written by the
// proposer, so nothing here evaluates code from them.
import type { Browser, Locator, Page } from 'playwright';
import type { AcceptanceCheck, Assertion, Step, Target } from '@lab/core';
import { newContext, screenshot } from './measure.ts';

const WAIT_MS = 3000;

export function locate(page: Page, target: Target): Locator {
	if ('role' in target) {
		return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
			...(target.name === undefined ? {} : { name: target.name }),
			...(target.exact === undefined ? {} : { exact: target.exact }),
		}).first();
	}
	if ('label' in target) return page.getByLabel(target.label).first();
	if ('text' in target) return page.getByText(target.text, target.exact === undefined ? {} : { exact: target.exact }).first();
	return page.locator(target.css).first();
}

const describeTarget = (t: Target) => JSON.stringify(t);

async function step(page: Page, siteUrl: string, s: Step): Promise<void> {
	switch (s.do) {
		case 'click':
			await locate(page, s.target).click({ timeout: WAIT_MS });
			return;
		case 'fill':
			await locate(page, s.target).fill(s.value, { timeout: WAIT_MS });
			return;
		case 'press':
			await locate(page, s.target).press(s.key, { timeout: WAIT_MS });
			return;
		case 'goto':
			await page.goto(new URL(s.page, siteUrl).href, { waitUntil: 'load' });
			return;
	}
}

/** Returns null when the assertion holds, or why it does not. */
async function assertion(page: Page, a: Assertion, viewport: { width: number; height: number }): Promise<string | null> {
	switch (a.expect) {
		case 'visible': {
			const ok = await locate(page, a.target).waitFor({ state: 'visible', timeout: WAIT_MS }).then(() => true, () => false);
			return ok ? null : `${describeTarget(a.target)} is not visible.`;
		}
		case 'hidden': {
			const ok = await locate(page, a.target).waitFor({ state: 'hidden', timeout: WAIT_MS }).then(() => true, () => false);
			return ok ? null : `${describeTarget(a.target)} is visible.`;
		}
		case 'in-viewport': {
			const locator = locate(page, a.target);
			const visible = await locator.waitFor({ state: 'visible', timeout: WAIT_MS }).then(() => true, () => false);
			if (!visible) return `${describeTarget(a.target)} is not visible.`;
			const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
			const box = await locator.boundingBox();
			if (!box) return `${describeTarget(a.target)} has no box.`;
			const top = box.y + scroll.y;
			const left = box.x + scroll.x;
			const inside = top >= 0 && left >= 0 && top + box.height <= viewport.height && left + box.width <= viewport.width;
			return inside ? null : `${describeTarget(a.target)} spans y ${Math.round(top)}–${Math.round(top + box.height)}, outside a ${viewport.width}x${viewport.height} viewport without scrolling.`;
		}
		case 'text': {
			const text = await locate(page, a.target).textContent({ timeout: WAIT_MS }).catch(() => null);
			if (text === null) return `${describeTarget(a.target)} was not found.`;
			const normalized = text.replace(/\s+/g, ' ').trim();
			if (a.equals !== undefined) return normalized === a.equals ? null : `Text is “${normalized}”, expected “${a.equals}”.`;
			return normalized.includes(a.contains!) ? null : `Text “${normalized}” does not contain “${a.contains}”.`;
		}
		case 'count': {
			const t = a.target;
			const all = 'role' in t
				? page.getByRole(t.role as Parameters<Page['getByRole']>[0], { ...(t.name === undefined ? {} : { name: t.name }), ...(t.exact === undefined ? {} : { exact: t.exact }) })
				: 'label' in t ? page.getByLabel(t.label) : 'text' in t ? page.getByText(t.text, t.exact === undefined ? {} : { exact: t.exact }) : page.locator(t.css);
			const n = await all.count();
			return n === a.equals ? null : `${describeTarget(a.target)} matches ${n} element(s), expected ${a.equals}.`;
		}
		case 'attribute': {
			const value = await locate(page, a.target).getAttribute(a.name, { timeout: WAIT_MS }).catch(() => null);
			return value === a.equals ? null : `${a.name} is ${JSON.stringify(value)}, expected ${JSON.stringify(a.equals)}.`;
		}
		case 'clipboard': {
			const text = await page.evaluate(() => navigator.clipboard.readText()).catch((e: unknown) => `<unreadable: ${String(e)}>`);
			return text === a.equals ? null : `The clipboard holds “${text}”, expected “${a.equals}”.`;
		}
		case 'url':
			return page.url().endsWith(a.endsWith) ? null : `The page is ${page.url()}, expected it to end with ${a.endsWith}.`;
	}
}

export interface AcceptanceOutcome {
	passed: boolean;
	message: string;
	screenshot?: string;
	console: string[];
}

export async function runAcceptanceCheck(
	browser: Browser,
	siteUrl: string,
	check: AcceptanceCheck,
	defaultViewport: { width: number; height: number },
	evidenceFile: string,
): Promise<AcceptanceOutcome> {
	const viewport = check.viewport ?? defaultViewport;
	const { context } = await newContext(browser, siteUrl, viewport);
	await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(siteUrl).origin });
	const page = await context.newPage();
	const consoleLines: string[] = [];
	page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
	page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
	try {
		await page.goto(new URL(check.page, siteUrl).href, { waitUntil: 'load' });
		for (const s of check.steps ?? []) {
			try {
				await step(page, siteUrl, s);
			} catch (error) {
				const shot = await screenshot(page, evidenceFile);
				return { passed: false, message: `Step ${JSON.stringify(s)} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, ...(shot ? { screenshot: shot } : {}), console: consoleLines };
			}
		}
		const problems: string[] = [];
		for (const a of check.expect) {
			const problem = await assertion(page, a, viewport);
			if (problem) problems.push(problem);
		}
		if (problems.length === 0) return { passed: true, message: `${check.expect.length} assertion(s) hold on ${check.page} at ${viewport.width}x${viewport.height}.`, console: consoleLines };
		const shot = await screenshot(page, evidenceFile);
		return { passed: false, message: problems.join(' '), ...(shot ? { screenshot: shot } : {}), console: consoleLines };
	} finally {
		await context.close();
	}
}
