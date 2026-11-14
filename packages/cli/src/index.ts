#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FileLedger, LEDGER_FILE, doctor, runIteration, siteCommit } from '@lab/core';
import type { Diagnostic, IterationResult } from '@lab/core';
import { ReplayBuilder, ReplayProposer } from '@lab/agent';
import { LocalSandbox } from '@lab/sandbox';
import { BrowserVerifier } from '@lab/verify';

const USAGE = `Usage: lab <command> [options]

Commands:
  doctor [dir]          Check the site's lab.config.ts and its ledger.
  run --dry [dir]       Run one iteration, from Propose to Verify, and record it.
      --experiment <d>  Replay the experiment in <d> (spec.json, patch.diff)
                        instead of asking a model.
      --ledger <file>   Ledger to use. Default: <dir>/lab/ledger.jsonl.
      --evidence <d>    Where screenshots go. Default: <dir>/lab/evidence.

Options:
  --json         Print the result as JSON.
  -h, --help     Show this help.

Exit codes: 0 ok or verify_passed, 1 invalid or verify_failed, 2 aborted, 64 usage.
Planned: status, kill (M3), report (M4).`;

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
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		process.stdout.write(`${USAGE}\n`);
		return command || values.help ? 0 : 64;
	}
	switch (command) {
		case 'doctor': {
			const report = await doctor(rest[0] ?? '.');
			if (values.json) {
				process.stdout.write(`${JSON.stringify(report, null, '\t')}\n`);
			} else {
				for (const d of report.diagnostics) process.stdout.write(`${format(d)}\n`);
				if (report.ok) {
					process.stdout.write(`ok: ${report.configFile} is valid; ledger has ${report.events.length} event(s).\n`);
				}
			}
			return report.ok ? 0 : 1;
		}
		case 'run': {
			if (!values.dry) {
				process.stderr.write('Only `lab run --dry` exists until Ship arrives in M3.\n');
				return 64;
			}
			if (!values.experiment) {
				process.stderr.write('`lab run --dry` needs --experiment <dir> until the model-backed proposer arrives in M2.\n');
				return 64;
			}
			const report = await doctor(rest[0] ?? '.');
			if (!report.ok || !report.config) {
				for (const d of report.diagnostics) process.stdout.write(`${format(d)}\n`);
				return 1;
			}
			const { config, siteDir } = report;
			const experiment = resolve(values.experiment);
			const result = await runIteration({
				config,
				site: { dir: siteDir, commit: siteCommit(siteDir) },
				ledger: new FileLedger(resolve(values.ledger ?? resolve(siteDir, LEDGER_FILE))),
				proposer: new ReplayProposer(experiment),
				builder: new ReplayBuilder(experiment),
				sandbox: new LocalSandbox({ config }),
				verifier: new BrowserVerifier({ config, siteDir }),
				evidenceDir: resolve(values.evidence ?? resolve(siteDir, 'lab', 'evidence')),
				dry: true,
			});
			if (values.json) process.stdout.write(`${JSON.stringify(result, null, '\t')}\n`);
			else process.stdout.write(summarize(result));
			return result.outcome === 'verify_passed' ? 0 : result.outcome === 'verify_failed' ? 1 : 2;
		}
		default:
			process.stderr.write(`Unknown command \`${command}\`.\n\n${USAGE}\n`);
			return 64;
	}
}

process.exitCode = await main(process.argv.slice(2));
