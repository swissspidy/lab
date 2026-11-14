#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { doctor } from '@lab/core';
import type { Diagnostic } from '@lab/core';

const USAGE = `Usage: lab <command> [options]

Commands:
  doctor [dir]   Check the site's lab.config.ts and its ledger.

Options:
  --json         Print the result as JSON.
  -h, --help     Show this help.

Planned: run [--dry] (M1), status, kill (M3), report (M4).`;

function format(d: Diagnostic): string {
	return `${d.severity === 'error' ? 'error' : 'warning'} ${d.code}${d.path ? ` (${d.path})` : ''}: ${d.message}`;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
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
		default:
			process.stderr.write(`Unknown command \`${command}\`.\n\n${USAGE}\n`);
			return 64;
	}
}

process.exitCode = await main(process.argv.slice(2));
