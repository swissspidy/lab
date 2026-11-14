import { execFileSync } from 'node:child_process';
import { StageError } from './types.ts';

/**
 * The commit a site directory is at. A directory outside git, or one with
 * uncommitted changes, gets a marker so the ledger never claims a clean
 * commit it does not have.
 */
export function siteCommit(dir: string): string {
	try {
		const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', ':(exclude)lab'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		return dirty ? `${commit}+dirty` : commit;
	} catch {
		return 'no-git';
	}
}

/**
 * Promotes a kept variant: applies its patch to the site's git repository
 * and commits it, so every kept change can be undone with `git revert`.
 * Refuses a dirty tree rather than mixing the variant with other changes.
 */
export function gitPromote(dir: string, variant: { experiment: string; patch: string }, message?: string): string {
	const git = (args: string[], input?: string) =>
		execFileSync('git', args, { cwd: dir, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).toString().trim();
	try {
		git(['rev-parse', '--show-toplevel']);
	} catch {
		throw new StageError('promote-no-git', `${dir} is not in a git repository, so a kept variant cannot be merged.`);
	}
	// The lab's own files (the ledger, recorded specs, evidence) may be uncommitted;
	// anything else would get mixed into the variant's commit.
	if (git(['status', '--porcelain', '--', '.', ':(exclude)lab']) !== '') throw new StageError('promote-dirty', 'The site repository has uncommitted changes outside lab/. Commit or stash them first.');
	const prefix = git(['rev-parse', '--show-prefix']);
	try {
		git(['apply', '--index', ...(prefix ? [`--directory=${prefix.replace(/\/$/, '')}`] : []), '-'], variant.patch.endsWith('\n') ? variant.patch : `${variant.patch}\n`);
	} catch (error) {
		throw new StageError('promote-apply-failed', `The patch for ${variant.experiment} no longer applies: ${(error as { stderr?: Buffer }).stderr?.toString().trim() ?? String(error)}`);
	}
	git(['commit', '-q', '-m', message ?? `lab: keep ${variant.experiment}`]);
	return git(['rev-parse', 'HEAD']);
}
