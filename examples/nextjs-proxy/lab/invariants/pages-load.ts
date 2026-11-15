import type { Invariant } from '@lab/verify';

const PAGES = [
	['', 'A preview environment for every pull request'],
	['docs', 'Documentation'],
	['pricing', 'Pricing'],
] as const;

export default {
	id: 'pages-load',
	description: 'Every page loads with its title and main heading',
	async run({ page, url, ok }) {
		for (const [path, heading] of PAGES) {
			const response = await page.goto(new URL(path, url).href);
			ok(response?.ok(), `/${path} answered ${response?.status()}`);
			ok((await page.title()).length > 0, `/${path} has no title`);
			const h1 = (await page.getByRole('heading', { level: 1 }).first().textContent())?.trim();
			ok(h1 === heading, `/${path} has the heading “${h1}”, expected “${heading}”`);
		}
	},
} satisfies Invariant;
