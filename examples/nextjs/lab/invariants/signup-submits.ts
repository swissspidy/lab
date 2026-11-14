import type { Invariant } from '@lab/verify';

export default {
	id: 'signup-submits',
	description: 'The signup form rejects an invalid address and confirms a valid one',
	async run({ page, url, ok }) {
		await page.goto(url);
		const email = page.getByLabel('Email address');
		const submit = page.getByRole('button', { name: 'Subscribe' });
		const status = page.getByRole('status');
		await email.fill('not-an-email');
		await submit.click();
		ok(await status.filter({ hasText: 'valid email' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'an invalid address is not rejected');
		await email.fill('reader@example.com');
		await submit.click();
		ok(await status.filter({ hasText: 'Thanks. We will send release notes to reader@example.com.' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'the confirmation does not appear');
	},
} satisfies Invariant;
