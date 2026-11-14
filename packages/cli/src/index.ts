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
} from '@lab/core';
import type { Diagnostic, IterationResult, LabConfig, TickResult } from '@lab/core';
import { AnthropicProvider, ModelBuilder, ModelProposer, ReplayBuilder, ReplayProposer } from '@lab/agent';
import { MetricStore, ReferenceDeployer, StoreMeter, readState, startEdgeServer } from '@lab/deploy';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const USAGE = `Usage: lab <command> [dir] [options]

[dir] is the site directory with lab.config.ts. Default: the current directory.

Commands:
  doctor [dir]              Check the config and the ledger.
  run --dry [dir]           One iteration, from Propose to Verify. Ships nothing.
  run [dir]                 One scheduled step: measure the live experiment, or
                            ship an approved one, or start a new iteration.
                            Run it from a scheduler, once per interval.
  approve <id> [dir]        Approve a verified experiment for shipping.
  status [dir]              The live experiment, its numbers and the deploy state.
  kill [dir]                Stop every variant now: share 0%, no deploy.
  publish [dir]             Build the site and publish it on the reference host.
  serve [dir]               Run the reference host's edge server.

Options:
  --experiment <d>   Replay the experiment in <d> (spec.json, patch.diff)
                     instead of asking a model.
  --iterations <n>   With --dry and a model, run n iterations. Default 1.
  --ledger <file>    Default: <dir>/lab/ledger.jsonl.
  --evidence <d>     Default: <dir>/lab/evidence.
  --host <d>         The reference host's state. Default: <dir>/.lab/host.
  --port <n>         For serve. Default 8080.
  --by <name>        For approve: who approved. Default: $USER.
  --json             Print results as JSON.
  -h, --help         Show this help.

The model is Claude (LAB_MODEL, default claude-opus-5-5), with credentials
from ANTHROPIC_API_KEY or \`ant auth login\`.

Exit codes: 0 ok, 1 invalid or rejected, 2 aborted, 64 usage.`;

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
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		process.stdout.write(`${USAGE}\n`);
		return command || values.help ? 0 : 64;
	}
	const known = ['doctor', 'run', 'approve', 'status', 'kill', 'publish', 'serve'];
	if (!known.includes(command)) {
		process.stderr.write(`Unknown command \`${command}\`.\n\n${USAGE}\n`);
		return 64;
	}
	const approveId = command === 'approve' ? rest.shift() : undefined;
	if (command === 'approve' && !approveId) {
		process.stderr.write('Usage: lab approve <id> [dir]\n');
		return 64;
	}

	const report = await doctor(rest[0] ?? '.');
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

	// The kill switch needs no valid config or ledger: it only rewrites the host state.
	if (command === 'kill') {
		const result = await kill({ deployer: new ReferenceDeployer({ root: hostDir, config: report.config as LabConfig }), ledger, site });
		process.stdout.write(`Killed: every variant share is 0%${result.experiment ? `; ${result.experiment} recorded as reverted` : ''}.\n`);
		if (result.ledgerError) process.stdout.write(`The ledger could not be updated: ${result.ledgerError}\n`);
		return 0;
	}

	if (!report.ok || !report.config) {
		for (const d of report.diagnostics) process.stdout.write(`${format(d)}\n`);
		return 1;
	}
	const config = report.config;
	const store = () => new MetricStore({ intervalHours: config.traffic.intervalHours, file: resolve(hostDir, 'metrics.json') });
	const deployer = new ReferenceDeployer({ root: hostDir, config });

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
				proposer: experiment ? new ReplayProposer(experiment) : new ModelProposer({ provider: provider!, config }),
				builder: experiment ? new ReplayBuilder(experiment) : new ModelBuilder({ provider: provider!, config }),
				sandbox: new LocalSandbox({ config }),
				verifier: new BrowserVerifier({ config, siteDir }),
				evidenceDir: resolve(values.evidence ?? resolve(siteDir, 'lab', 'evidence')),
			});
			if (!values.dry) {
				const metrics = store();
				const result = await tick({
					...iteration(),
					deployer,
					meter: new StoreMeter({ store: metrics, config }),
					decider: new BetaBinomialDecider(config),
					promote: async (variant) => void gitPromote(siteDir, variant),
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
		case 'approve': {
			const event = await approve({ ledger, site }, approveId!, values.by ?? process.env.USER ?? 'unknown');
			process.stdout.write(`${event.experiment}: approved by ${String(event.payload.by)}. The next \`lab run\` ships it.\n`);
			return 0;
		}
		case 'status': {
			const events = await ledger.history();
			const live = liveExperiment(events);
			const state = readState(hostDir);
			const out: Record<string, unknown> = { host: hostDir, serving: state.live ?? 'baseline only', killedAt: state.killedAt ?? null, live };
			const lines = [`Host: ${hostDir}`, `Serving: ${state.live ? `${state.live.experiment} to ${state.live.share * 100}%` : 'the baseline only'}${state.killedAt ? ` (kill switch used ${state.killedAt})` : ''}`];
			if (live) {
				const stats = await new StoreMeter({ store: store(), config }).read(live);
				const p = probabilityExpected(stats, specFromLedger(events, live));
				out.stats = stats;
				out.probability = p;
				lines.push(`Live: ${live}`, `  baseline ${stats.baseline.conversions}/${stats.baseline.visits}, variant ${stats.variant.conversions}/${stats.variant.visits}, P(expected effect) ${p.toFixed(3)}`);
				for (const [g, v] of Object.entries(stats.guardrails)) lines.push(`  ${g}: ${v.degraded ? `degraded (${v.detail})` : 'ok'}`);
			}
			const waiting = [...experimentStates(events)].filter(([, s]) => s === 'verify_passed' || s === 'approved');
			out.waiting = waiting;
			for (const [id, s] of waiting) lines.push(`${id}: ${s === 'approved' ? 'approved, ships on the next run' : 'verified, waiting for approval'}`);
			process.stdout.write(values.json ? `${JSON.stringify(out, null, '\t')}\n` : `${lines.join('\n')}\n`);
			return 0;
		}
		case 'publish': {
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
	process.exitCode = 1;
}
