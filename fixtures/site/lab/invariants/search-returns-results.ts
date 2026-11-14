import type { Invariant } from '@lab/verify';

export default {
	id: 'search-returns-results',
	description: 'Searching the docs for “ci” lists “Running in CI”',
	async run({ page, url, ok }) {
		for (const path of ['index.html', 'docs.html', 'pricing.html']) {
			await page.goto(new URL(path, url).href);
			await page.getByLabel('Search the docs').fill('ci');
			await page.getByRole('button', { name: 'Search' }).click();
			const link = page.getByRole('link', { name: 'Running in CI' });
			ok(await link.waitFor({ timeout: 3000 }).then(() => true, () => false), `no result on ${path}`);
			ok((await link.getAttribute('href')) === 'docs.html#ci', `the result on ${path} links elsewhere`);
		}
	},
} satisfies Invariant;
