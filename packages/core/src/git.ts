import { execFileSync } from 'node:child_process';

/**
 * The commit a site directory is at. A directory outside git, or one with
 * uncommitted changes, gets a marker so the ledger never claims a clean
 * commit it does not have.
 */
export function siteCommit(dir: string): string {
	try {
		const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		return dirty ? `${commit}+dirty` : commit;
	} catch {
		return 'no-git';
	}
}
