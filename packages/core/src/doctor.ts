import { resolve } from 'node:path';
import { autonomyEntry } from './autonomy.ts';
import { effectiveDeny, loadConfig } from './config.ts';
import { FileLedger, LEDGER_FILE, SETTLED, experimentStates } from './ledger.ts';
import type { Diagnostic, LabConfig, LedgerEvent } from './types.ts';

export interface DoctorReport {
	ok: boolean;
	configFile: string;
	siteDir: string;
	config: LabConfig | null;
	deny: string[];
	ledgerFile: string;
	events: LedgerEvent[];
	diagnostics: Diagnostic[];
}

/** Checks a site's config and ledger. `ok` is false when any error was found. */
export async function doctor(path: string): Promise<DoctorReport> {
	const loaded = await loadConfig(path);
	const diagnostics = [...loaded.diagnostics];
	const ledgerFile = resolve(loaded.siteDir, LEDGER_FILE);
	const { events, diagnostics: ledgerDiagnostics } = await new FileLedger(ledgerFile).read();
	diagnostics.push(...ledgerDiagnostics);
	if (ledgerDiagnostics.length === 0) {
		for (const [experiment, state] of experimentStates(events)) {
			if (!SETTLED.has(state)) {
				diagnostics.push({
					code: 'ledger-experiment-open',
					severity: 'warning',
					path: experiment,
					message: `${experiment} stopped at \`${state}\`. The next run resumes it or aborts it.`,
				});
			}
		}
	}
	if (loaded.config?.autonomy === 'auto' && ledgerDiagnostics.length === 0) {
		for (const check of autonomyEntry(events).checks) {
			if (!check.met) diagnostics.push({ code: `autonomy-entry-${check.id}`, severity: 'warning', path: 'autonomy', message: check.detail });
		}
	}
	return {
		ok: !diagnostics.some((d) => d.severity === 'error'),
		configFile: loaded.file,
		siteDir: loaded.siteDir,
		config: loaded.config,
		deny: loaded.config ? effectiveDeny(loaded.config) : [],
		ledgerFile,
		events,
		diagnostics,
	};
}
