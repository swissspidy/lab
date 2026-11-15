import type { Invariant } from '@lab/verify';

export default {
	id: 'signup-rejects-invalid',
	description: 'The signup form rejects an invalid email address',
	async run({ page, url, ok }) {
		await page.goto(new URL('index.html', url).href);
		await page.getByLabel('Email address').fill('not-an-email');
		await page.getByRole('button', { name: 'Subscribe' }).click();
		const status = (await page.getByRole('status').textContent()) ?? '';
		ok(status.includes('valid email'), `the status reads “${status}”`);
	},
} satisfies Invariant;
