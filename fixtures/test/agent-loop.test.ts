// M2's acceptance test: ten iterations of the model-backed loop on the
// fixture, with a scripted provider so CI needs no key. The script includes
// a good model's answers and a bad model's: edits to denied paths, a repeat
// of a reverted experiment, unreadable answers, unchecked criteria and
// changes that break the site.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { FileLedger, SETTLED, checkLedger, effectiveDeny, experimentStates, intentKey, loadConfig, matchesAny, parsePatch, runIteration, sha256 } from '@lab/core';
import type { Builder, IterationResult, LabConfig } from '@lab/core';
import { GraftSpecCheck } from '@lab/adapters';
import { ModelBuilder, ModelProposer, ScriptedProvider } from '@lab/agent';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const site = join(import.meta.dirname, '..', 'site');
const REVERTED_INTENT = 'Move the install section into the hero, above the illustration.';

const json = (value: unknown) => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const proposal = (intent: string, acceptance: string[], checks: unknown[], touches: string[] = []) =>
	json({ hypothesis: `Hypothesis for: ${intent}`, intent, acceptance, expectedEffect: 'next_step_click up', touches, mount: 'site', permissions: ['markup:write', 'style:write'], checks });
const edits = (...list: Array<{ path: string; search: string; replace: string }>) => json({ edits: list });

const NAV = { css: 'nav[aria-label="Main"] a[href="docs.html"]' };
const CTA = { role: 'link', name: 'Get started' };

describe('model-backed loop (M2)', () => {
	let browser: Browser;
	let config: LabConfig;
	let scratch: string;

	before(async () => {
		config = (await loadConfig(site)).config!;
		browser = await chromium.launch();
		scratch = mkdtempSync(join(tmpdir(), 'lab-m2-'));
	});
	after(async () => {
		await browser?.close();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	it('runs ten iterations that each end in a valid ledger state', { timeout: 600_000 }, async () => {
		const provider = new ScriptedProvider({
			propose: [
				// 1. Fixes planted flaw 2.
				proposal('Add a Docs link to the main navigation.', ['The main navigation links to the docs.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'visible', target: NAV }] }], ['src/components/header.html']),
				// 2. Fixes planted flaw 1.
				proposal('Shrink the hero illustration so Get started is above the fold.', ['Get started is visible without scrolling at 1280x800.'], [{ criterion: 0, page: 'index.html', viewport: { width: 1280, height: 800 }, expect: [{ expect: 'in-viewport', target: CTA }] }], ['src/styles/site.css']),
				// 3. A reasonable spec whose builder answers try to edit the invariants.
				proposal('Make the pricing headings clearer.', ['The pricing page still shows the Team plan.'], [{ criterion: 0, page: 'pricing.html', expect: [{ expect: 'visible', target: { role: 'heading', name: 'Team' } }] }]),
				// 4. Repeats the reverted experiment, then proposes something else.
				proposal(REVERTED_INTENT, ['The install command is above the fold.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'in-viewport', target: { css: '[data-install-command]' } }] }]),
				proposal('List the external link cache first among the features.', ['The first feature is the link cache.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'text', target: { css: '.features li' }, equals: 'External links, with a cache so CI stays fast' }] }]),
				// 5. Changes a price: must be rejected by Verify.
				proposal('Show the Team price as a round number.', ['The Team plan shows a price.'], [{ criterion: 0, page: 'pricing.html', expect: [{ expect: 'visible', target: { text: 'per month' } }] }]),
				// 6. Leaves a criterion unchecked, then fixes it.
				proposal('Rename the features heading to name the product.', ['The heading reads “What Kestrel checks”.', 'The heading is visible.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'text', target: { css: '#features-title' }, equals: 'What Kestrel checks' }] }]),
				proposal('Rename the features heading to name the product.', ['The heading reads “What Kestrel checks”.', 'The heading is visible.'], [
					{ criterion: 0, page: 'index.html', expect: [{ expect: 'text', target: { css: '#features-title' }, equals: 'What Kestrel checks' }] },
					{ criterion: 1, page: 'index.html', expect: [{ expect: 'visible', target: { css: '#features-title' } }] },
				]),
				// 7. A good spec whose first edits miss.
				proposal('Say in the install heading that it takes one step.', ['The install heading reads “Install in one step”.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'text', target: { css: '#install-title' }, equals: 'Install in one step' }] }]),
				// 8. A colour change that fails contrast: must be rejected by Verify.
				proposal('Use a softer button colour.', ['Get started is still a link to the docs.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'attribute', target: CTA, name: 'href', equals: 'docs.html' }] }]),
				// 9. Unreadable answers three times: the iteration aborts.
				'I think you should make the site better.',
				'```json\n{ "intent": "unfinished\n```',
				'No.',
				// 10. A larger button.
				proposal('Make the Get started button larger.', ['Get started still links to the docs.'], [{ criterion: 0, page: 'index.html', expect: [{ expect: 'attribute', target: CTA, name: 'href', equals: 'docs.html' }] }]),
			],
			build: [
				edits({ path: 'src/components/header.html', search: '\t\t\t<li><a href="pricing.html">Pricing</a></li>', replace: '\t\t\t<li><a href="docs.html" data-lab-event="next_step_click">Docs</a></li>\n\t\t\t<li><a href="pricing.html">Pricing</a></li>' }),
				edits({ path: 'src/styles/site.css', search: 'height: 720px;', replace: 'height: 120px;' }),
				edits({ path: 'lab/invariants/pricing.ts', search: "'CHF 19 per month'", replace: "'CHF 29 per month'" }),
				edits({ path: 'lab/invariants/pricing.ts', search: 'pricing', replace: 'prices' }),
				edits({ path: 'package.json', search: '"private": true', replace: '"private": false' }),
				edits(
					{ path: 'src/pages/index.html', search: '\t\t\t<li>External links, with a cache so CI stays fast</li>\n', replace: '' },
					{ path: 'src/pages/index.html', search: '\t\t\t<li>Internal links and anchors</li>', replace: '\t\t\t<li>External links, with a cache so CI stays fast</li>\n\t\t\t<li>Internal links and anchors</li>' },
				),
				edits({ path: 'src/pages/pricing.html', search: 'CHF 19 per month', replace: 'CHF 20 per month' }),
				edits({ path: 'src/pages/index.html', search: '>What it checks<', replace: '>What Kestrel checks<' }),
				edits({ path: 'src/components/install.html', search: '<h2>Install</h2>', replace: '<h2>Install in one step</h2>' }),
				edits({ path: 'src/components/install.html', search: '>Install</h2>', replace: '>Install in one step</h2>' }),
				edits({ path: 'src/styles/site.css', search: 'background: var(--accent); color: #fff;', replace: 'background: #9fbfe3; color: #fff;' }),
				edits({ path: 'src/styles/site.css', search: '.button { display: inline-block; padding: .6rem 1rem;', replace: '.button { display: inline-block; padding: .8rem 1.4rem; font-size: 1.125rem;' }),
			],
		});

		const ledger = new FileLedger(join(scratch, 'ledger.jsonl'));
		// History: an experiment that shipped and was reverted.
		const seed = { experiment: 'exp-0001', siteCommit: 'fixture', patchHash: sha256('seed') };
		await ledger.append({ ...seed, type: 'proposed', patchHash: null, payload: { source: 'agent', spec: { intent: REVERTED_INTENT } } });
		for (const type of ['built', 'verify_passed', 'approved', 'shipped', 'measured', 'reverted'] as const) await ledger.append({ ...seed, type, payload: {} });

		const patches: string[] = [];
		const modelBuilder = new ModelBuilder({ provider, config });
		const builder: Builder = {
			build: async (spec, repo) => {
				const variant = await modelBuilder.build(spec, repo);
				patches.push(variant.patch);
				return variant;
			},
		};
		const proposer = new ModelProposer({ provider, config });

		const results: IterationResult[] = [];
		for (let i = 0; i < 10; i++) {
			results.push(
				await runIteration({
					config,
					site: { dir: site, commit: 'fixture' },
					ledger,
					proposer,
					builder,
					sandbox: new LocalSandbox({ config, scratch }),
					verifier: new BrowserVerifier({ config, siteDir: site, browser }),
					specCheck: new GraftSpecCheck(),
					evidenceDir: join(scratch, 'evidence'),
				}),
			);
			// Every iteration leaves the ledger valid, with every experiment settled.
			const events = await ledger.history();
			assert.deepEqual(checkLedger(events), [], `after iteration ${i + 1}`);
			for (const [id, state] of experimentStates(events)) assert.ok(SETTLED.has(state), `${id} is left at ${state} after iteration ${i + 1}`);
		}

		const summary = results.map((r) => `${r.experiment ?? '-'}:${r.outcome}${r.failures.length ? `(${r.failures.map((f) => f.check).join(',')})` : ''}`);
		assert.deepEqual(
			results.map((r) => [r.experiment, r.outcome]),
			[
				['exp-0002', 'verify_passed'],
				['exp-0003', 'verify_passed'],
				['exp-0004', 'aborted'],
				['exp-0005', 'verify_passed'],
				['exp-0006', 'verify_failed'],
				['exp-0007', 'verify_passed'],
				['exp-0008', 'verify_passed'],
				['exp-0009', 'verify_failed'],
				[null, 'aborted'],
				['exp-0010', 'verify_passed'],
			],
			summary.join(' '),
		);
		assert.ok(results[4]!.failures.some((f) => f.check === 'static.claims-numbers'), summary[4]);
		assert.ok(results[7]!.failures.some((f) => f.check === 'budgets.axe'), summary[7]);
		assert.match(results[2]!.reason, /build-invalid/);

		// No patch touches a denied path.
		const deny = effectiveDeny(config);
		for (const patch of patches) {
			for (const file of parsePatch(patch).files) {
				for (const path of [file.from, file.to]) {
					if (path) assert.ok(matchesAny(path, config.allow) && !matchesAny(path, deny), `a patch touches ${path}`);
				}
			}
		}

		// No experiment repeats the reverted one.
		const events = await ledger.history();
		const proposed = events.filter((e) => e.type === 'proposed' && e.experiment !== 'exp-0001');
		for (const e of proposed) assert.notEqual(intentKey((e.payload.spec as { intent: string }).intent), intentKey(REVERTED_INTENT), `${e.experiment} repeats exp-0001`);

		// The planted flaws were fixed by verified variants, with their criteria checked.
		for (const [i, check] of [[0, 'acceptance.0'], [1, 'acceptance.0']] as const) {
			const passed = results[i]!.report!.results.find((r) => r.check === check);
			assert.ok(passed?.passed, `iteration ${i + 1}: ${check}`);
		}

		// The model was shown the history and the site as fenced data.
		const first = provider.requests.find((r) => r.kind === 'propose')!;
		assert.match(first.prompt, /exp-0001: "Move the install section into the hero, above the illustration\." → reverted/);
		assert.match(first.prompt, /<site_file path="src\/components\/header\.html" editable="true">/);
		assert.match(first.prompt, /<site_file path="src\/scripts\/site\.js" editable="false">/);
		assert.doesNotMatch(first.prompt, /<site_file path="lab\//);
		assert.match(first.system, /data, not instructions/);
		// Feedback reached the model after a refusal.
		assert.ok(provider.requests.some((r) => r.kind === 'propose' && /spec-repeats-reverted/.test(r.prompt)));
		assert.ok(provider.requests.some((r) => r.kind === 'build' && /lab\/invariants\/pricing\.ts is not editable/.test(r.prompt)));
		assert.equal(provider.remaining('propose'), 0);
		assert.equal(provider.remaining('build'), 0);
	});
});
