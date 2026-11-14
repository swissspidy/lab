// Site invariants: what the site must always do. The site owner writes them
// once, against the baseline; they live under `lab/`, which no variant may
// touch, and they are always loaded from the base site, never the variant.
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { StageError } from '@lab/core';
import { newContext, screenshot } from './measure.ts';

export interface InvariantContext {
	page: Page;
	/** The site's root URL, ending in `/`. */
	url: string;
	viewport: { width: number; height: number };
	/** Throws with `message` unless `condition` holds. */
	ok(condition: unknown, message: string): void;
}

export interface Invariant {
	/** Stable, kebab-case. The check id is `invariants.<id>`. */
	id: string;
	description: string;
	run(ctx: InvariantContext): Promise<void>;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

export async function loadInvariants(dir: string): Promise<Invariant[]> {
	const absolute = resolve(dir);
	if (!existsSync(absolute)) return [];
	const files = readdirSync(absolute)
		.filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts'))
		.toSorted();
	const invariants: Invariant[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const mod = (await import(pathToFileURL(join(absolute, file)).href)) as { default?: unknown };
		const inv = mod.default as Partial<Invariant> | undefined;
		if (!inv || typeof inv.id !== 'string' || !ID.test(inv.id) || typeof inv.run !== 'function' || typeof inv.description !== 'string') {
			throw new StageError('invariant-invalid', `${file} must default-export { id, description, run }.`);
		}
		if (seen.has(inv.id)) throw new StageError('invariant-duplicate', `Two invariants have the id ${inv.id}.`);
		seen.add(inv.id);
		invariants.push(inv as Invariant);
	}
	return invariants;
}

export interface InvariantOutcome {
	passed: boolean;
	message: string;
	screenshot?: string;
	console: string[];
}

const TIMEOUT_MS = 15_000;

export async function runInvariant(browser: Browser, siteUrl: string, invariant: Invariant, viewport: { width: number; height: number }, evidenceFile: string): Promise<InvariantOutcome> {
	const { context } = await newContext(browser, siteUrl, viewport);
	await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(siteUrl).origin });
	context.setDefaultTimeout(5000);
	const page = await context.newPage();
	const consoleLines: string[] = [];
	page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
	page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
	const ok: InvariantContext['ok'] = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	try {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS} ms.`)), TIMEOUT_MS);
		});
		try {
			await Promise.race([invariant.run({ page, url: siteUrl, viewport, ok }), timeout]);
		} finally {
			clearTimeout(timer);
		}
		return { passed: true, message: invariant.description, console: consoleLines };
	} catch (error) {
		const shot = await screenshot(page, evidenceFile);
		const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
		return { passed: false, message: `${invariant.description}: ${message}`, ...(shot ? { screenshot: shot } : {}), console: consoleLines };
	} finally {
		await context.close();
	}
}
