// The orchestrator's own reading of a patch. It does not trust the agent's
// `touches` list or its word: the scope and size checks read the diff.
import { effectiveDeny } from './config.ts';
import { sha256 } from './ledger.ts';
import type { CheckResult, LabConfig } from './types.ts';

/** Turns a glob into a RegExp over POSIX paths: `**` any depth, `*` and `?` within a segment. */
export function globToRegExp(glob: string): RegExp {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const slash = glob[i + 2] === '/';
				out += slash ? '(?:.*/)?' : '.*';
				i += slash ? 2 : 1;
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else {
			out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
		}
	}
	// `dir/` means everything below dir.
	if (glob.endsWith('/')) out += '.*';
	return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
	return globs.some((g) => globToRegExp(g).test(path));
}

export interface PatchFile {
	/** Path before the change, or null for a new file. */
	from: string | null;
	/** Path after the change, or null for a deleted file. */
	to: string | null;
	added: number;
	removed: number;
	binary: boolean;
	/** File modes other than plain 100644/100755, such as symlinks or submodules. */
	specialMode: string | null;
}

export interface ParsedPatch {
	files: PatchFile[];
	problems: string[];
}

const stripPrefix = (path: string, prefix: string): string => (path.startsWith(prefix) ? path.slice(prefix.length) : path);

function unsafePath(path: string): boolean {
	return path.startsWith('/') || path.startsWith('"') || path.split('/').includes('..') || path.includes('\\') || path.includes('\0');
}

/** Parses a `git diff` style unified diff. Anything it does not understand is a problem, not a pass. */
export function parsePatch(patch: string): ParsedPatch {
	const problems: string[] = [];
	const files: PatchFile[] = [];
	if (patch.trim() === '') return { files, problems: ['The patch is empty.'] };
	const lines = patch.split('\n');
	if (!lines[0]?.startsWith('diff --git ')) problems.push('The patch must start with `diff --git`, as `git diff` writes it.');

	let current: PatchFile | null = null;
	let inHunk = false;
	let oldLeft = 0;
	let newLeft = 0;
	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
			if (!match) {
				problems.push(`Cannot read the file header \`${line}\`. Paths with spaces or quotes are not allowed.`);
				current = null;
				continue;
			}
			current = { from: match[1]!, to: match[2]!, added: 0, removed: 0, binary: false, specialMode: null };
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		if (inHunk && (oldLeft > 0 || newLeft > 0)) {
			if (line.startsWith('+')) {
				current.added++;
				newLeft--;
			} else if (line.startsWith('-')) {
				current.removed++;
				oldLeft--;
			} else if (line.startsWith(' ') || line === '') {
				oldLeft--;
				newLeft--;
			} else if (!line.startsWith('\\')) {
				problems.push(`Unexpected line in a hunk of ${current.to ?? current.from}.`);
			}
			continue;
		}
		const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			inHunk = true;
			oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
			newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			continue;
		}
		if (line.startsWith('--- ')) {
			const path = line.slice(4);
			current.from = path === '/dev/null' ? null : stripPrefix(path, 'a/');
		} else if (line.startsWith('+++ ')) {
			const path = line.slice(4);
			current.to = path === '/dev/null' ? null : stripPrefix(path, 'b/');
		} else if (line.startsWith('new file mode ')) {
			current.from = null;
			const mode = line.slice(14);
			if (mode !== '100644' && mode !== '100755') current.specialMode = mode;
		} else if (line.startsWith('deleted file mode ')) {
			current.to = null;
		} else if (line.startsWith('new mode ')) {
			const mode = line.slice(9);
			if (mode !== '100644' && mode !== '100755') current.specialMode = mode;
		} else if (line.startsWith('rename from ')) {
			current.from = line.slice(12);
		} else if (line.startsWith('rename to ')) {
			current.to = line.slice(10);
		} else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
			current.binary = true;
		}
	}
	for (const file of files) {
		for (const path of [file.from, file.to]) {
			if (path !== null && unsafePath(path)) problems.push(`\`${path}\` is not a safe relative path.`);
		}
	}
	return { files, problems };
}

export function hashPatch(patch: string): string {
	return sha256(patch);
}

/**
 * The static patch gate: format, scope and size. Runs before anything is
 * built. Every check is reported, pass or fail, so the ledger shows what ran.
 */
export function checkPatch(patch: string, config: LabConfig): CheckResult[] {
	const { files, problems } = parsePatch(patch);
	const results: CheckResult[] = [];

	const format = [...problems];
	for (const file of files) {
		const name = file.to ?? file.from;
		if (file.binary) format.push(`${name} is a binary change. Variants may change text files only.`);
		if (file.specialMode) format.push(`${name} has mode ${file.specialMode}. Symlinks, submodules and other special files are not allowed.`);
	}
	results.push({
		gate: 'static',
		check: 'static.patch-format',
		passed: format.length === 0,
		message: format.length === 0 ? `${files.length} file(s), all plain text.` : format.join(' '),
	});

	const deny = effectiveDeny(config);
	const outside: string[] = [];
	for (const file of files) {
		for (const path of new Set([file.from, file.to])) {
			if (path === null) continue;
			if (!matchesAny(path, config.allow)) outside.push(`${path} (not in allow)`);
			else if (matchesAny(path, deny)) outside.push(`${path} (denied)`);
		}
	}
	results.push({
		gate: 'static',
		check: 'static.scope',
		passed: outside.length === 0 && files.length > 0,
		message:
			files.length === 0
				? 'The patch changes no files.'
				: outside.length === 0
					? 'Every changed path is allowed and not denied.'
					: `Out of scope: ${outside.join(', ')}.`,
	});

	const lines = files.reduce((sum, f) => sum + f.added + f.removed, 0);
	const { maxChangedLines, maxFiles } = config.limits;
	const tooBig = lines > maxChangedLines || files.length > maxFiles;
	results.push({
		gate: 'static',
		check: 'static.patch-size',
		passed: !tooBig,
		message: `${lines} changed line(s) in ${files.length} file(s); the limit is ${maxChangedLines} lines in ${maxFiles} files.`,
	});
	return results;
}
