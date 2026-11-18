import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf } from '../src/index.ts';

const budgets = { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 };
const page = (over: Record<string, unknown>) => ({
	page: 'index.html',
	viewport: '1280x800',
	status: 200,
	axe: [],
	consoleErrors: [],
	failedRequests: [],
	foreignOrigins: [],
	overflow: false,
	lcpMs: 800,
	cls: 0,
	links: [],
	content: { numbers: [], names: [], hrefs: [], forms: [] },
	...over,
});

describe('findingsOf', () => {
	it('has nothing to say about a clean site', () => {
		assert.deepEqual(findingsOf({ measurements: [page({}), page({ viewport: '390x844' })], deadLinks: [] }, budgets), []);
	});

	it('gives each problem a stable id per rule and page, across viewports and elements', () => {
		const findings = findingsOf(
			{
				measurements: [
					page({ axe: ['color-contrast [".button"]', 'color-contrast [".cta a"]', 'image-alt ["img"]'], consoleErrors: ['Uncaught x'] }),
					page({ viewport: '390x844', axe: ['color-contrast [".button"]'], overflow: true, cls: 0.3 }),
					page({ page: 'docs.html', lcpMs: 4000, status: 404 }),
				],
				deadLinks: ['/missing.html'],
			},
			budgets,
		);
		assert.deepEqual(
			findings.map((f) => [f.id, f.kind, f.check ?? null, f.viewports]),
			[
				['a11y.color-contrast@index.html', 'accessibility', null, ['1280x800', '390x844']],
				['a11y.image-alt@index.html', 'accessibility', null, ['1280x800']],
				['errors.console@index.html', 'errors', 'budgets.console-errors', ['1280x800']],
				['errors.dead-link@/missing.html', 'errors', 'budgets.dead-links', []],
				['errors.status@docs.html', 'errors', 'budgets.status', ['1280x800']],
				['layout.overflow@index.html', 'layout', 'budgets.overflow', ['390x844']],
				['perf.cls@index.html', 'performance', 'budgets.cls', ['390x844']],
				['perf.lcp@docs.html', 'performance', 'budgets.lcp', ['1280x800']],
			],
		);
		assert.equal(findings[0]!.summary, 'aXe rule color-contrast fails on 2 element(s): [".button"]; [".cta a"] at 1280x800, 390x844.');
	});
});
