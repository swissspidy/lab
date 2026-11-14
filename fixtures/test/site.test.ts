// The fixture site is the lab's test bed. These tests pin down what M1+
// rely on: the baseline is clean, its features work, and both planted
// flaws are really there.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { serveDir } from './serve.ts';

const site = join(import.meta.dirname, '..', 'site');
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PAGES = ['index.html', 'docs.html', 'pricing.html'];
const VIEWPORTS = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 },
];

describe('fixture site', () => {
	let browser: Browser;
	let server: Awaited<ReturnType<typeof serveDir>>;

	before(async () => {
		execFileSync('npm', ['run', 'build', '--silent'], { cwd: site, stdio: 'pipe' });
		server = await serveDir(join(site, 'dist'));
		browser = await chromium.launch();
	});
	after(async () => {
		await browser?.close();
		await server?.close();
	});

	async function open(path: string, viewport = VIEWPORTS[0]!): Promise<{ page: Page; errors: string[] }> {
		const page = await browser.newPage({ viewport });
		const errors: string[] = [];
		page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
		await page.goto(new URL(path, server.url).href, { waitUntil: 'load' });
		return { page, errors };
	}

	for (const path of PAGES) {
		for (const viewport of VIEWPORTS) {
			it(`${path} at ${viewport.width}x${viewport.height} has no aXe violations, console errors or overflow`, async () => {
				const { page, errors } = await open(path, viewport);
				await page.addScriptTag({ content: axeSource });
				const violations = await page.evaluate(async () => {
					const result = await (globalThis as unknown as { axe: { run(): Promise<{ violations: Array<{ id: string }> }> } }).axe.run();
					return result.violations.map((v) => v.id);
				});
				assert.deepEqual(violations, []);
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
				assert.equal(overflow, false, 'page scrolls sideways');
				assert.deepEqual(errors, []);
				await page.close();
			});
		}
	}

	it('search returns results', async () => {
		const { page } = await open('index.html');
		await page.getByLabel('Search the docs').fill('ci');
		await page.getByRole('button', { name: 'Search' }).click();
		await assert.doesNotReject(page.getByRole('link', { name: 'Running in CI' }).waitFor({ timeout: 5000 }));
		await page.close();
	});

	it('the signup form submits', async () => {
		const { page } = await open('index.html');
		await page.getByLabel('Email address').fill('reader@example.com');
		await page.getByRole('button', { name: 'Subscribe' }).click();
		assert.match(await page.getByRole('status').textContent() ?? '', /^Thanks\./);
		await page.close();
	});

	it('planted flaw 1: the primary action is below the fold at 1280x800', async () => {
		const { page } = await open('index.html');
		const box = await page.getByRole('link', { name: 'Get started' }).boundingBox();
		assert.ok(box && box.y > 800, `Get started sits at y=${box?.y}`);
		await page.close();
	});

	it('planted flaw 2: the main navigation has no link to the docs', async () => {
		const { page } = await open('index.html');
		const nav = page.getByRole('navigation', { name: 'Main' });
		assert.equal(await nav.locator('a[href="docs.html"]').count(), 0);
		assert.equal(await page.getByRole('navigation', { name: 'Footer' }).locator('a[href="docs.html"]').count(), 1);
		await page.close();
	});
});
