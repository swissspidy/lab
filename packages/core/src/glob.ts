// Globs over POSIX paths, for allow and deny lists.

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
