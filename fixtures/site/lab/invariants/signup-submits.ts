import type { Invariant } from '@lab/verify';

export default {
	id: 'signup-submits',
	description: 'The signup form accepts an email address and confirms it, and rejects an invalid one',
	async run({ page, url, ok }) {
		await page.goto(new URL('index.html', url).href);
		const email = page.getByLabel('Email address');
		const submit = page.getByRole('button', { name: 'Subscribe' });
		await email.fill('not-an-email');
		await submit.click();
		ok(((await page.getByRole('status').textContent()) ?? '').includes('valid email'), 'an invalid address is not rejected');
		await email.fill('reader@example.com');
		await submit.click();
		const status = (await page.getByRole('status').textContent()) ?? '';
		ok(status.startsWith('Thanks.') && status.includes('reader@example.com'), `the confirmation reads “${status}”`);
	},
} satisfies Invariant;
