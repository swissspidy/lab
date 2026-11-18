import { execFileSync } from 'node:child_process';
import { parsePatch } from './patch.ts';
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

export interface PromoteOptions {
	/**
	 * The commit the patch was verified on. When given, the patch is committed
	 * only if nothing outside `lab/` changed since: a fix is not verified
	 * against any other site.
	 */
	verifiedAt?: string;
}

/**
 * Promotes a kept variant or a fix: applies its patch to the site's git
 * repository and commits it, so every change can be undone with
 * `git revert`. Refuses a dirty tree rather than mixing the variant with
 * other changes. A retry after the commit landed (the ledger write failed)
 * finds it at HEAD and returns it instead of applying the patch twice.
 */
export function gitPromote(dir: string, variant: { experiment: string; patch: string }, message?: string, options: PromoteOptions = {}): string {
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
	const subject = message ?? `lab: keep ${variant.experiment}`;
	const patch = variant.patch.endsWith('\n') ? variant.patch : `${variant.patch}\n`;
	const directory = prefix ? [`--directory=${prefix.replace(/\/$/, '')}`] : [];
	// Already committed by an earlier attempt: HEAD is this promotion and the patch is in it.
	if (git(['log', '-1', '--format=%s']) === subject) {
		try {
			git(['apply', '--check', '--reverse', ...directory, '-'], patch);
			return git(['rev-parse', 'HEAD']);
		} catch {
			// Same subject, other content: fall through and let apply decide.
		}
	}
	if (options.verifiedAt !== undefined) {
		if (!/^[0-9a-f]{7,64}$/.test(options.verifiedAt)) {
			throw new StageError('promote-unverified-base', `${variant.experiment} was verified on \`${options.verifiedAt}\`, not a clean commit, so what it was checked against cannot be compared. Verify it again from a clean tree.`);
		}
		try {
			git(['diff', '--quiet', options.verifiedAt, 'HEAD', '--', '.', ':(exclude)lab']);
		} catch {
			throw new StageError('promote-site-changed', `The site changed outside lab/ since ${variant.experiment} was verified at ${options.verifiedAt.slice(0, 12)}. It is not merged onto a site it was not checked against; the next iteration can propose it again.`);
		}
	}
	try {
		git(['apply', '--index', ...directory, '-'], patch);
	} catch (error) {
		throw new StageError('promote-apply-failed', `The patch for ${variant.experiment} no longer applies: ${(error as { stderr?: Buffer }).stderr?.toString().trim() ?? String(error)}`);
	}
	// Commit only the variant's own paths: anything else staged (the ledger,
	// say) stays staged and out of this commit.
	const paths = [...new Set(parsePatch(variant.patch).files.flatMap((f) => [f.from, f.to]).filter((p): p is string => p !== null))];
	git(['commit', '-q', '-m', subject, '--', ...paths]);
	return git(['rev-parse', 'HEAD']);
}
