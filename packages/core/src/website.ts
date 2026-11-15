// The website as a host, in Graft's terms (Graft ADR 0015). A spec mounts
// on a slot (the whole site, or one page) and asks for permission scopes
// (kinds of files it may change). The slots and scopes come from the site
// itself: its pages and its allowed files. This module knows nothing of
// Graft; the Graft adapter turns a WebsiteHost into a Graft surface.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';
import { effectiveDeny } from './config.ts';
import { matchesAny } from './glob.ts';
import type { LabConfig } from './types.ts';

/** Every scope a website can offer, and the file extensions each one covers. */
export const WEBSITE_SCOPES = {
	'markup:write': {
		title: 'Change markup and components',
		description: 'Pages, templates and UI components: HTML, JSX, TSX, Vue, Svelte, Astro.',
		extensions: ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
	},
	'style:write': {
		title: 'Change styles',
		description: 'Stylesheets: CSS, Sass, Less.',
		extensions: ['.css', '.scss', '.sass', '.less'],
	},
	'content:write': {
		title: 'Change content files',
		description: 'Text and data the site renders: Markdown, MDX, JSON, YAML, plain text.',
		extensions: ['.md', '.mdx', '.json', '.yaml', '.yml', '.txt'],
	},
	'script:write': {
		title: 'Change scripts',
		description: 'JavaScript and TypeScript modules that are not components.',
		extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
	},
	'asset:write': {
		title: 'Change images',
		description: 'SVG images. Binary files are never allowed in a variant.',
		extensions: ['.svg'],
	},
} as const;

export type WebsiteScope = keyof typeof WEBSITE_SCOPES;

export const isWebsiteScope = (scope: unknown): scope is WebsiteScope => typeof scope === 'string' && Object.hasOwn(WEBSITE_SCOPES, scope);

/** The scope a file needs, or null when no scope covers it (such a file cannot be changed). */
export function scopeOfPath(path: string): WebsiteScope | null {
	const ext = extname(path).toLowerCase();
	for (const [scope, { extensions }] of Object.entries(WEBSITE_SCOPES)) {
		if ((extensions as readonly string[]).includes(ext)) return scope as WebsiteScope;
	}
	return null;
}

/** The slot for the whole site: shared layout, navigation, styles. */
export const SITE_SLOT = 'site';

/** A mount slot: `site`, or `page.<route>` with dot-separated segments. */
export const SLOT = /^(?:site|page(?:\.[a-z][a-z0-9-]*)+)$/;

/**
 * The slot of a page, as checks name pages: `index.html` and `.` are
 * `page.index`, `docs.html` and `docs` are `page.docs`, `docs/intro.html`
 * is `page.docs.intro`. Segments are lowercased; other characters become
 * dashes, and a segment that does not start with a letter gets a `p`.
 */
export function pageSlot(page: string): string {
	let route = page.replace(/^\.\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html?$/i, '');
	route = route.replace(/(?:^|\/)index$/, '');
	const segments = route === '' ? ['index'] : route.split('/');
	return `page.${segments.map((s) => {
		const slug = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'index';
		return /^[a-z]/.test(slug) ? slug : `p${slug}`;
	}).join('.')}`;
}

/** What a website offers a spec: its slots and the scopes it has files for. */
export interface WebsiteHost {
	/** Slot id → the page it stands for (`null` for `site`). */
	slots: Record<string, { title: string; page: string | null }>;
	/** Scope → how many allowed files it covers. Only scopes with at least one file. */
	scopes: Partial<Record<WebsiteScope, { files: number }>>;
}

/**
 * Describes a site as a host: one slot for the whole site and one per page,
 * and a scope for each kind of file the config allows changing that the
 * site actually has. Pages come from the verifier's list (config
 * `site.pages`, or the built HTML files).
 */
export function websiteHost(config: LabConfig, files: readonly string[], pages: readonly string[]): WebsiteHost {
	const slots: WebsiteHost['slots'] = { [SITE_SLOT]: { title: 'The whole site', page: null } };
	// Two pages can map to one slot (`docs.html` and `docs/index.html`, or
	// names with no Latin letters). The first, in sorted order, keeps it; the
	// others get `-2`, `-3`, ... on the last segment, so every page has a slot.
	for (const page of [...pages].toSorted()) {
		const base = pageSlot(page);
		let slot = base;
		for (let n = 2; slots[slot]; n++) slot = `${base}-${n}`;
		slots[slot] = { title: `The page ${page}`, page };
	}
	const deny = effectiveDeny(config);
	const scopes: WebsiteHost['scopes'] = {};
	for (const file of files) {
		if (!matchesAny(file, config.allow) || matchesAny(file, deny)) continue;
		const scope = scopeOfPath(file);
		if (scope) scopes[scope] = { files: (scopes[scope]?.files ?? 0) + 1 };
	}
	return { slots, scopes };
}

const SKIP = new Set(['node_modules', '.git', 'lab']);

/** The site's source files, as POSIX paths: no build output, dependencies, dotfiles or `lab/`. */
export function listSiteFiles(dir: string, config: LabConfig): string[] {
	const outDir = posix.normalize(config.site.outDir.split(sep).join('/')).replace(/\/+$/, '');
	const out: string[] = [];
	const walk = (current: string) => {
		for (const name of readdirSync(current).toSorted()) {
			const full = join(current, name);
			const rel = relative(dir, full).split(sep).join('/');
			const stat = lstatSync(full);
			if (stat.isSymbolicLink() || name.startsWith('.')) continue;
			if (stat.isDirectory()) {
				if (!(SKIP.has(name) && current === dir) && name !== 'node_modules' && rel !== outDir) walk(full);
			} else if (stat.isFile()) {
				out.push(rel);
			}
		}
	};
	walk(dir);
	return out;
}

/**
 * The pages to verify: config `site.pages`, or every HTML file in the built
 * output, sorted. Without a built root, just `index.html`.
 */
export function sitePages(config: LabConfig, root: string | undefined): string[] {
	if (config.site.pages) return [...config.site.pages];
	if (!root) return ['index.html'];
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name.endsWith('.html')) out.push(relative(root, path).split(sep).join('/'));
		}
	};
	walk(root);
	return out.toSorted();
}
