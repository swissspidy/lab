// An Assay invariant: the task and its outcome in words, with checks mined
// from the baseline and locked in signup-submits.checks.json. After changing
// the task, run `lab invariants compile` and review the diff.
import type { AssayInvariantSpec, AssayStepContext } from '@lab/adapters';

const subscribe = async ({ page, url }: AssayStepContext, address: string, submit = true) => {
	await page.goto(new URL('index.html', url).href);
	await page.getByLabel('Email address').fill(address);
	if (submit) await page.getByRole('button', { name: 'Subscribe' }).click();
};

export default {
	id: 'signup-submits',
	description: 'The signup form subscribes an email address and confirms it',
	assay: {
		task: {
			instruction: 'Subscribe reader@example.com to the release notes with the signup form.',
			outcomes: '- The page shows "Thanks. We will send release notes to reader@example.com."',
		},
		checks: 'signup-submits.checks.json',
		act: (ctx) => subscribe(ctx, 'reader@example.com'),
		negatives: {
			'not-submitted': (ctx) => subscribe(ctx, 'reader@example.com', false),
			'invalid-address': (ctx) => subscribe(ctx, 'not-an-email'),
		},
	},
} satisfies AssayInvariantSpec;
