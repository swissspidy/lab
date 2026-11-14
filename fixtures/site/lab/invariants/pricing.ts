import type { Invariant } from '@lab/verify';

export default {
	id: 'pricing',
	description: 'The pricing page shows both plans with their prices',
	async run({ page, url, ok }) {
		await page.goto(new URL('pricing.html', url).href);
		for (const [plan, price] of [['Free', 'CHF 0 per month'], ['Team', 'CHF 19 per month']]) {
			const section = page.getByRole('region', { name: plan });
			ok(await section.isVisible(), `the ${plan} plan is not visible`);
			ok((await section.locator('[data-price]').textContent())?.trim() === price, `the ${plan} price is not “${price}”`);
		}
	},
} satisfies Invariant;
