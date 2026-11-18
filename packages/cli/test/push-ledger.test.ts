// The action's push step: a merged fix is never rebased onto site changes
// it was not verified on; ledger commits and kept changes still are.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = join(import.meta.dirname, '..', '..', '..', 'scripts', 'push-ledger.sh');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', LAB_PUSH_BACKOFF: '0' };

describe('push-ledger.sh', () => {
	let root: string;
	let lab: string;
	let other: string;
	const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
	const write = (dir: string, file: string, text: string) => {
		mkdirSync(join(dir, file, '..'), { recursive: true });
		writeFileSync(join(dir, file), text);
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'lab-push-'));
		git(root, 'init', '-q', '--bare', 'remote.git');
		git(root, 'clone', '-q', 'remote.git', 'seed');
		const seed = join(root, 'seed');
		write(seed, 'site/src/a.html', 'a\n');
		write(seed, 'site/lab/ledger.jsonl', '');
		git(seed, 'add', '-A');
		git(seed, 'commit', '-qm', 'site');
		git(seed, 'push', '-q', 'origin', 'HEAD:main');
		git(root, 'clone', '-q', '-b', 'main', 'remote.git', 'lab');
		git(root, 'clone', '-q', '-b', 'main', 'remote.git', 'other');
		lab = join(root, 'lab');
		other = join(root, 'other');
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const push = () => spawnSync('bash', [script], { cwd: lab, env: { ...env, SITE: 'site', COMMAND: 'run' }, encoding: 'utf8' });
	const upstream = (file: string, text: string) => {
		write(other, file, text);
		git(other, 'add', '-A');
		git(other, 'commit', '-qm', `someone: ${file}`);
		git(other, 'push', '-q');
	};
	const mergeFix = () => {
		write(lab, 'site/src/a.html', 'fixed\n');
		git(lab, 'commit', '-qam', 'lab: fix exp-0001');
		write(lab, 'site/lab/ledger.jsonl', '{"type":"merged"}\n');
	};

	it('refuses to rebase a merged fix onto site changes, and pushes nothing', () => {
		mergeFix();
		upstream('site/src/b.html', 'b\n');
		const before = git(root, '--git-dir=remote.git', 'rev-parse', 'main');
		const result = push();
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /promote-site-changed/);
		assert.equal(git(root, '--git-dir=remote.git', 'rev-parse', 'main'), before);
	});

	it('lets a ledger change upstream through the guard, and fails loudly when the rebase conflicts', () => {
		mergeFix();
		upstream('site/lab/ledger.jsonl', '{"type":"other"}\n');
		// Only lab/ changed upstream, so the guard passes; both sides changed the ledger, so the rebase conflicts.
		const before = git(root, '--git-dir=remote.git', 'rev-parse', 'main');
		const conflicted = push();
		assert.equal(conflicted.status, 1);
		assert.doesNotMatch(conflicted.stderr, /promote-site-changed/);
		assert.match(conflicted.stderr, /Could not push the ledger/);
		assert.equal(git(root, '--git-dir=remote.git', 'rev-parse', 'main'), before);
	});

	it('rebases a merged fix when upstream changed nothing of the site', () => {
		mergeFix();
		upstream('README.md', 'docs\n');
		const result = push();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(git(root, '--git-dir=remote.git', 'log', '--format=%s', '-3', 'main').split('\n'), ['lab: run', 'lab: fix exp-0001', 'someone: README.md']);
	});

	it('still rebases ledger commits and kept changes onto site changes', () => {
		write(lab, 'site/src/a.html', 'kept\n');
		git(lab, 'commit', '-qam', 'lab: keep exp-0002');
		upstream('site/src/b.html', 'b\n');
		const result = push();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(git(root, '--git-dir=remote.git', 'log', '--format=%s', '-2', 'main').split('\n'), ['lab: keep exp-0002', 'someone: site/src/b.html']);
	});
});
