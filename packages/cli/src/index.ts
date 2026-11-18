#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	BetaBinomialDecider,
	FileLedger,
	LEDGER_FILE,
	approve,
	doctor,
	experimentStates,
	gitPromote,
	kill,
	liveExperiment,
	probabilityExpected,
	runIteration,
	siteCommit,
	specFromLedger,
	tick,
	newTweakId,
	verifyTweak,
} from '@lab/core';
import type { Diagnostic, IterationResult, LabConfig, TickResult, Tweak } from '@lab/core';
import { AnthropicProvider, ModelBuilder, ModelProposer, ModelTweaker, ReplayBuilder, ReplayProposer } from '@lab/agent';
import { CommandPublisher, FileState, FileTweakStore, MetricStore, RemoteTweakStore, OriginDeployer, ReferenceDeployer, RemoteMeter, RemoteState, StoreMeter, startCollector, startEdgeServer } from '@lab/deploy';
import type { StateStore } from '@lab/deploy';
import { CssInjectingProxy, LocalSandbox } from '@lab/sandbox';
import { BrowserObserver, BrowserVerifier, loadInvariants } from '@lab/verify';
import { GraftSpecCheck, GraftSpecProposer, assayInvariant, checkInvariantLock, compileInvariant, isAssayInvariant, recordingGraftSpecs, writeCompiledInvariant } from '@lab/adapters';
import { writeReport } from '@lab/report';
import { existsSync, readFileSync } from 'node:fs';

const USAGE = `Usage: lab <command> [dir] [options]

[dir] is the site directory with lab.config.ts. Default: the current directory.

Commands:
  doctor [dir]              Check the config, the ledger and the locks of
                            Assay invariants.
  invariants compile [dir]  Compile every Assay invariant against the
                            baseline, stress-test and lock its checks, and
                            write them next to it. Review the diff and commit.
  observe [dir]             Build the site and list what the lab's checks find
                            on it: the findings a fix can cite.
  run --dry [dir]           One iteration, from Observe to Verify. Ships nothing.
  run [dir]                 One scheduled step: measure the live experiment, or
                            ship an approved experiment or merge an approved
                            fix, or start a new iteration. Run it from a
                            scheduler, once per interval.
  approve <id> [dir]        Approve a verified experiment for shipping, or a
                            verified fix for merging.
  status [dir]              The live experiment, its numbers and the deploy state.
  kill [dir]                Stop every variant now: share 0%, no deploy.
  report [dir]              Write the ledger as a static HTML page (--out).
  publish [dir]             Build the site and publish it on the reference host.
  serve [dir]               Run the reference host's edge server.
  collect [dir]             Run the collector for sites with their own proxy
                            (@lab/next): GET /state, POST /beacon, and with
                            LAB_TOKEN, PUT /state and GET /metrics.
  tweak [dir]               Verify a personal tweak and store it for visitors
                            to opt into: --spec and --css, or --request for a
                            model to write one. Needs \`tweaks\` in the config.

Options:
  --experiment <d>   Replay the experiment in <d> (spec.json or a Graft
                     spec.md, and patch.diff) instead of asking a model.
  --out <d>          For report. Default: <dir>/lab/report.
  --iterations <n>   With --dry and a model, run n iterations. Default 1.
  --ledger <file>    Default: <dir>/lab/ledger.jsonl.
  --evidence <d>     Default: <dir>/lab/evidence.
  --host <d>         The reference host's state. Default: <dir>/.lab/host.
  --port <n>         For serve. Default 8080.
  --by <name>        For approve and invariants compile: who approved or
                     locked. Default: $USER.
  --spec <file>      For tweak: the tweak spec (JSON). An id is made if missing.
  --css <file>       For tweak: its stylesheet.
  --request <text>   For tweak: what the visitor wants; a model writes it.
  --json             Print results as JSON.
  -h, --help         Show this help.

The model is Claude (LAB_MODEL, default claude-opus-5-5), with credentials
from ANTHROPIC_API_KEY or \`ant auth login\`.

With LAB_URL and LAB_TOKEN set, run, status and kill use that collector for
the deploy state and the metrics, so the loop can run anywhere (a scheduled
CI job). Server apps ship variants with \`deploy.publish\` from the config.

Exit codes: 0 ok, 1 rejected by Verify (doctor: invalid), 2 aborted, 3 error
(invalid config, unreachable collector, anything unexpected), 64 usage.`;

function format(d: Diagnostic): string {
	return `${d.severity === 'error' ? 'error' : 'warning'} ${d.code}${d.path ? ` (${d.path})` : ''}: ${d.message}`;
}

function summarize(result: IterationResult): string {
	const lines = [`${result.experiment ?? '(no experiment)'}: ${result.outcome}`];
	for (const f of result.failures) {
		lines.push(`  ✘ ${f.check}: ${f.message}`);
		if (f.evidence?.screenshot) lines.push(`    screenshot: ${f.evidence.screenshot}`);
	}
	if (result.outcome !== 'verify_failed') lines.push(`  ${result.reason}`);
	return `${lines.join('\n')}\n`;
}

function summarizeTick(result: TickResult): string {
	if (result.step === 'iterate') return summarize(result.result);
	if (result.step === 'wait') return `${result.experiment}: waiting for approval\n  ${result.reason}\n`;
	return `${result.result.experiment ?? '(none)'}: ${result.result.outcome}\n  ${result.result.reason}\n`;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			json: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
			dry: { type: 'boolean' },
			experiment: { type: 'string' },
			ledger: { type: 'string' },
			evidence: { type: 'string' },
			iterations: { type: 'string' },
			host: { type: 'string' },
			port: { type: 'string' },
			by: { type: 'string' },
			out: { type: 'string' },
			spec: { type: 'string' },
			css: { type: 'string' },
			request: { type: 'string' },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		process.stdout.write(`${USAGE}\n`);
		return command || values.help ? 0 : 64;
	}
	const known = ['doctor', 'observe', 'run', 'approve', 'status', 'kill', 'publish', 'serve', 'report', 'collect', 'tweak', 'invariants'];
	if (!known.includes(command)) {
		process.stderr.write(`Unknown command \`${command}\`.\n\n${USAGE}\n`);
		return 64;
	}
	const approveId = command === 'approve' ? rest.shift() : undefined;
	if (command === 'approve' && !approveId) {
		process.stderr.write('Usage: lab approve <id> [dir]\n');
		return 64;
	}

	if (command === 'invariants' && rest.shift() !== 'compile') {
		process.stderr.write('Usage: lab invariants compile [dir]\n');
		return 64;
	}

	const report = await doctor(rest[0] ?? '.');
	if (command === 'doctor' && report.config) {
		// Assay invariants carry a locked check set; an unlocked or edited one fails Verify.
		try {
			for (const inv of await loadInvariants(resolve(report.siteDir, report.config.invariants), [assayInvariant])) {
				const problem = isAssayInvariant(inv) ? checkInvariantLock(inv) : null;
				if (problem) report.diagnostics.push({ severity: 'error', code: problem.code, path: `invariants.${inv.id}`, message: problem.message });
			}
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			report.diagnostics.push({ severity: 'error', code: typeof code === 'string' ? code : 'invariant-invalid', path: 'invariants', message: (error as Error).message });
		}
		report.ok = !report.diagnostics.some((d) => d.severity === 'error');
	}
	if (command === 'doctor') {
		if (values.json) {
			process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
		} else {
			for (const d of report.diagnostics) process.stdout.write(`${format(d)}\n`);
			if (report.ok) process.stdout.write(`ok: ${report.configFile} is valid; ledger has ${report.events.length} event(s).\n`);
		}
		return report.ok ? 0 : 1;
	}

	const { siteDir } = report;
	const hostDir = resolve(values.host ?? resolve(siteDir, '.lab', 'host'));
	const ledger = new FileLedger(resolve(values.ledger ?? resolve(siteDir, LEDGER_FILE)));
	const site = { dir: siteDir, commit: siteCommit(siteDir) };

	if (process.env.LAB_URL && !process.env.LAB_TOKEN && ['run', 'status', 'kill', 'tweak'].includes(command)) {
		// Never fall back to local state when a collector is configured: a local kill would not stop it.
		process.stderr.write('LAB_URL is set but LAB_TOKEN is not. Set both to use the collector, or unset LAB_URL.\n');
		return 3;
	}
	const remote = process.env.LAB_URL && process.env.LAB_TOKEN ? { url: process.env.LAB_URL, token: process.env.LAB_TOKEN } : null;
	const stateStore: StateStore = remote ? new RemoteState(remote) : new FileState(hostDir);
	const noPublisher = { publish: async () => Promise.reject(new Error('This site is a server app: set `deploy.publish` in lab.config.ts to publish variants.')), retire: async () => {} };

	// The kill switch needs no valid config or ledger: it only rewrites the deploy state.
	if (command === 'kill') {
		const killer = report.config?.deploy || report.config?.site.serve || remote
			? new OriginDeployer({ state: stateStore, publisher: report.config?.deploy ? new CommandPublisher({ config: report.config }) : noPublisher })
			: new ReferenceDeployer({ root: hostDir, config: report.config as LabConfig });
		const result = await kill({ deployer: killer, ledger, site });
		process.stdout.write(`Killed: every variant share is 0%${result.experiment ? `; ${result.experiment} recorded as reverted` : ''}.\n`);
		if (result.ledgerError) process.stdout.write(`The ledger could not be updated: ${result.ledgerError}\n`);
		return 0;
	}

	if (!report.ok || !report.config) {
		for (const d of report.diagnostics) process.stdout.write(`${format(d)}\n`);
		return 3;
	}
	const config = report.config;
	const store = () => new MetricStore({ intervalHours: config.traffic.intervalHours, file: resolve(hostDir, 'metrics.json') });
	// Static sites use the reference host; server apps (and remote runs) serve variants from their own origin.
	const deployer =
		config.deploy || config.site.serve || remote
			? new OriginDeployer({ state: stateStore, publisher: config.deploy ? new CommandPublisher({ config }) : noPublisher })
			: new ReferenceDeployer({ root: hostDir, config });
	const meter = () => (remote ? new RemoteMeter({ ...remote, config }) : new StoreMeter({ store: store(), config }));

	switch (command) {
		case 'run': {
			const iterations = Number(values.iterations ?? 1);
			if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100 || (!values.dry && iterations !== 1)) {
				process.stderr.write('--iterations must be a whole number from 1 to 100, and works only with --dry.\n');
				return 64;
			}
			if (values.experiment && iterations !== 1) {
				process.stderr.write('A replayed experiment runs once; drop --iterations.\n');
				return 64;
			}
			const experiment = values.experiment ? resolve(values.experiment) : null;
			const provider = experiment ? null : new AnthropicProvider();
			const iteration = () => ({
				config,
				site: { dir: siteDir, commit: siteCommit(siteDir) },
				ledger,
				proposer: experiment
					? existsSync(resolve(experiment, 'spec.md')) && !existsSync(resolve(experiment, 'spec.json'))
						? new GraftSpecProposer(experiment)
						: new ReplayProposer(experiment)
					: recordingGraftSpecs(new ModelProposer({ provider: provider!, config }), resolve(siteDir, 'lab', 'specs')),
				builder: experiment ? new ReplayBuilder(experiment) : new ModelBuilder({ provider: provider!, config }),
				sandbox: new LocalSandbox({ config }),
				verifier: new BrowserVerifier({ config, siteDir, invariantKinds: [assayInvariant] }),
				observer: new BrowserObserver({ config }),
				specCheck: new GraftSpecCheck(),
				evidenceDir: resolve(values.evidence ?? resolve(siteDir, 'lab', 'evidence')),
			});
			if (!values.dry) {
				const result = await tick({
					...iteration(),
					deployer,
					meter: meter(),
					decider: new BetaBinomialDecider(config),
					promote: async (variant) => {
						const fix = specFromLedger(await ledger.history(), variant.experiment).kind === 'fix';
						gitPromote(siteDir, variant, fix ? `lab: fix ${variant.experiment}` : undefined);
					},
				});
				process.stdout.write(values.json ? `${JSON.stringify(result, null, '\t')}\n` : summarizeTick(result));
				if (result.step === 'iterate') return result.result.outcome === 'verify_passed' ? 0 : result.result.outcome === 'verify_failed' ? 1 : 2;
				return result.step === 'wait' || result.result.outcome !== 'aborted' ? 0 : 2;
			}
			const results: IterationResult[] = [];
			for (let i = 0; i < iterations; i++) {
				const result = await runIteration(iteration());
				results.push(result);
				if (!values.json) process.stdout.write(summarize(result));
			}
			if (values.json) process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, '\t')}\n`);
			const last = results.at(-1)!;
			return last.outcome === 'verify_passed' ? 0 : last.outcome === 'verify_failed' ? 1 : 2;
		}
		case 'invariants': {
			const assay = (await loadInvariants(resolve(siteDir, config.invariants), [assayInvariant])).filter(isAssayInvariant);
			if (assay.length === 0) {
				process.stdout.write(`No Assay invariants in ${config.invariants}.\n`);
				return 0;
			}
			const baseline = await new LocalSandbox({ config }).start(site);
			try {
				for (const inv of assay) {
					const compiled = await compileInvariant(inv, { url: baseline.url, viewport: config.viewports[0]!, by: values.by ?? process.env.USER ?? 'unknown' });
					const file = writeCompiledInvariant(inv, compiled);
					const { rates } = compiled.stress;
					process.stdout.write(
						`${inv.id}: ${compiled.checkSet.checks.length} check(s), locked. Stress: ${rates.variantsAccepted}/${rates.variantsTotal} variants accepted, ${rates.mutantsRejected}/${rates.mutantsTotal} breakages rejected. Wrote ${file}\n`,
					);
				}
			} finally {
				await baseline.stop();
			}
			return 0;
		}
		case 'observe': {
			const baseline = await new LocalSandbox({ config }).start(site);
			let findings;
			try {
				findings = await new BrowserObserver({ config }).observe(baseline);
			} finally {
				await baseline.stop();
			}
			if (values.json) process.stdout.write(`${JSON.stringify(findings, null, '\t')}\n`);
			else if (findings.length === 0) process.stdout.write('No findings: the baseline passes every check the lab runs on its own.\n');
			else for (const f of findings) process.stdout.write(`${f.id} (${f.kind})\n  ${f.summary}\n`);
			return 0;
		}
		case 'approve': {
			const event = await approve({ ledger, site }, approveId!, values.by ?? process.env.USER ?? 'unknown');
			const fix = specFromLedger(await ledger.history(), event.experiment).kind === 'fix';
			process.stdout.write(`${event.experiment}: approved by ${String(event.payload.by)}. The next \`lab run\` ${fix ? 'merges it' : 'ships it'}.\n`);
			return 0;
		}
		case 'status': {
			const events = await ledger.history();
			const live = liveExperiment(events);
			const { state } = await stateStore.read();
			const out: Record<string, unknown> = { host: hostDir, serving: state.live ?? 'baseline only', killedAt: state.killedAt ?? null, live };
			const lines = [`Host: ${hostDir}`, `Serving: ${state.live ? `${state.live.experiment} to ${state.live.share * 100}%` : 'the baseline only'}${state.killedAt ? ` (kill switch used ${state.killedAt})` : ''}`];
			if (live) {
				const stats = await meter().read(live);
				const p = probabilityExpected(stats, specFromLedger(events, live));
				out.stats = stats;
				out.probability = p;
				lines.push(`Live: ${live}`, `  baseline ${stats.baseline.conversions}/${stats.baseline.visits}, variant ${stats.variant.conversions}/${stats.variant.visits}, P(expected effect) ${p.toFixed(3)}`);
				for (const [g, v] of Object.entries(stats.guardrails)) lines.push(`  ${g}: ${v.degraded ? `degraded (${v.detail})` : 'ok'}`);
			}
			const waiting = [...experimentStates(events)].filter(([, s]) => s === 'verify_passed' || s === 'approved');
			out.waiting = waiting;
			for (const [id, s] of waiting) {
				const fix = specFromLedger(events, id).kind === 'fix';
				lines.push(`${id}: ${fix ? 'fix, ' : ''}${s === 'approved' ? `approved, ${fix ? 'merges' : 'ships'} on the next run` : 'verified, waiting for approval'}`);
			}
			process.stdout.write(values.json ? `${JSON.stringify(out, null, '\t')}\n` : `${lines.join('\n')}\n`);
			return 0;
		}
		case 'report': {
			const file = writeReport(await ledger.history(), resolve(values.out ?? resolve(siteDir, 'lab', 'report')), { title: `Lab report: ${siteDir.split('/').at(-1)}`, siteDir });
			process.stdout.write(`Wrote ${file}\n`);
			return 0;
		}
		case 'collect': {
			const port = Number(values.port ?? 8081);
			const collector = await startCollector({ root: hostDir, store: store(), port, host: process.env.LAB_HOST ?? '127.0.0.1', ...(process.env.LAB_TOKEN ? { token: process.env.LAB_TOKEN } : {}), ...(config.tweaks ? { tweaks: config.tweaks, budgets: config.budgets } : {}) });
			process.stdout.write(`Collector at ${collector.url} (state in ${hostDir})${process.env.LAB_TOKEN ? '' : '. No LAB_TOKEN: remote state writes and metric reads are off'}. Ctrl-C to stop.\n`);
			await new Promise<void>((done) => process.once('SIGINT', done));
			await collector.close();
			return 0;
		}
		case 'tweak': {
			if (!config.tweaks) {
				process.stderr.write('tweaks-disabled: This site offers no personal tweaks. Add `tweaks: {}` to lab.config.ts to offer them.\n');
				return 3;
			}
			if (Boolean(values.request) === Boolean(values.spec || values.css) || (!values.request && !(values.spec && values.css))) {
				process.stderr.write('Usage: lab tweak [dir] --spec <file> --css <file>, or lab tweak [dir] --request "<what the visitor wants>"\n');
				return 64;
			}
			let tweak: Tweak;
			if (values.request) {
				tweak = await new ModelTweaker({ provider: new AnthropicProvider(), config }).write(values.request, site);
			} else {
				const spec = JSON.parse(readFileSync(resolve(values.spec!), 'utf8')) as Tweak['spec'];
				tweak = { spec: { ...spec, id: spec.id ?? newTweakId() }, css: readFileSync(resolve(values.css!), 'utf8') };
			}
			const outcome = await verifyTweak(
				{ config, site, sandbox: new LocalSandbox({ config }), injector: new CssInjectingProxy(), verifier: new BrowserVerifier({ config, siteDir, invariantKinds: [assayInvariant] }), evidenceDir: resolve(values.evidence ?? resolve(siteDir, 'lab', 'evidence')), specCheck: new GraftSpecCheck() },
				tweak,
			);
			if (outcome.outcome === 'verified') {
				await (remote ? new RemoteTweakStore({ ...remote, config }) : new FileTweakStore(hostDir, config)).put(outcome.record);
			}
			if (values.json) {
				process.stdout.write(`${JSON.stringify(outcome, null, '\t')}\n`);
			} else if (outcome.outcome === 'verified') {
				process.stdout.write(`${tweak.spec.id}: verified (${outcome.results.length} checks) and stored.\n  Visitors opt in at /_lab/tweak/${tweak.spec.id} and out at /_lab/tweak/${tweak.spec.id}?off\n`);
			} else if (outcome.outcome === 'rejected') {
				process.stdout.write(`${tweak.spec.id}: rejected\n`);
				for (const d of outcome.diagnostics) process.stdout.write(`  ${format(d)}\n`);
				for (const f of outcome.failures) process.stdout.write(`  ✘ ${f.check}: ${f.message}\n`);
			} else {
				process.stdout.write(`${tweak.spec.id}: aborted\n  ${outcome.reason}\n`);
			}
			return outcome.outcome === 'verified' ? 0 : outcome.outcome === 'rejected' ? 1 : 2;
		}
		case 'publish': {
			if (!(deployer instanceof ReferenceDeployer)) {
				process.stderr.write('`lab publish` is for static sites on the reference host. A server app is published by its own deployment.\n');
				return 64;
			}
			await deployer.publish(site);
			process.stdout.write(`Published ${siteDir} at ${site.commit} to ${hostDir}.\n`);
			return 0;
		}
		case 'serve': {
			const port = Number(values.port ?? 8080);
			const edge = await startEdgeServer({ root: hostDir, store: store(), config, port });
			process.stdout.write(`Serving ${hostDir} at ${edge.url}. Ctrl-C to stop.\n`);
			await new Promise<void>((done) => process.once('SIGINT', done));
			await edge.close();
			return 0;
		}
	}
	return 64;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const code = (error as { code?: unknown }).code;
	process.stderr.write(`${typeof code === 'string' ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 3;
}
