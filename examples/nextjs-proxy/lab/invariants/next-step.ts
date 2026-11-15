import type { Invariant } from '@lab/verify';

export default {
	id: 'next-step',
	description: 'Every page offers a visible, tracked link to the docs, and the home page has Get started',
	async run({ page, url, ok }) {
		for (const path of ['', 'docs', 'pricing']) {
			await page.goto(new URL(path, url).href);
			const tracked = page.locator('a[data-lab-event="next_step_click"][href="/docs"]');
			const count = await tracked.count();
			let visible = false;
			for (let i = 0; i < count; i++) visible ||= await tracked.nth(i).isVisible();
			ok(visible, `/${path} has no visible tracked link to the docs`);
		}
		await page.goto(url);
		const start = page.getByRole('link', { name: 'Get started' });
		ok(await start.isVisible(), 'Get started is not visible');
		await start.click();
		await page.waitForURL(/\/docs$/, { timeout: 5000 });
		ok((await page.getByRole('heading', { level: 1 }).textContent())?.trim() === 'Documentation', 'Get started does not lead to the docs');
	},
} satisfies Invariant;
