import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

/**
 * Maps a URL path to a file under `root`, the way static hosts do:
 * the exact file, then `<path>.html` (Next.js and other static exports
 * write `/docs` as `docs.html`), then `<path>/index.html`. Returns null
 * when nothing matches, and 'forbidden' when the match resolves outside
 * `root` (a symlink, or `..`).
 */
export function resolveStatic(root: string, pathname: string): string | null | 'forbidden' {
	const base = realpathSync(root);
	const target = normalize(join(base, pathname));
	if (target !== base && !target.startsWith(base + sep)) return 'forbidden';
	const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
	const candidates = [target, `${target.replace(/\/+$/, '')}.html`, join(target, 'index.html')];
	for (const candidate of candidates) {
		if (!isFile(candidate)) continue;
		const real = realpathSync(candidate);
		return real === base || real.startsWith(base + sep) ? real : 'forbidden';
	}
	return null;
}
