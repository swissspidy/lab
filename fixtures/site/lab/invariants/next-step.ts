import type { Invariant } from '@lab/verify';

export default {
	id: 'next-step',
	description: 'Every page offers a visible, tracked link to the docs, and the home page has Get started',
	async run({ page, url, ok }) {
		for (const path of ['index.html', 'docs.html', 'pricing.html']) {
			await page.goto(new URL(path, url).href);
			const tracked = page.locator('a[data-lab-event="next_step_click"][href="docs.html"]');
			const count = await tracked.count();
			let visible = false;
			for (let i = 0; i < count; i++) visible ||= await tracked.nth(i).isVisible();
			ok(visible, `${path} has no visible tracked link to the docs`);
		}
		await page.goto(new URL('index.html', url).href);
		ok(await page.getByRole('link', { name: 'Get started' }).isVisible(), 'Get started is not visible');
	},
} satisfies Invariant;
