import type { Invariant } from '@lab/verify';

const COMMAND = 'npm install --save-dev kestrel-links';

export default {
	id: 'install-command',
	description: 'The home page shows the install command, and Copy copies it exactly',
	async run({ page, url, ok }) {
		await page.goto(new URL('index.html', url).href);
		const code = page.locator('[data-install-command]');
		ok(await code.isVisible(), 'the install command is not visible');
		ok((await code.textContent())?.trim() === COMMAND, 'the install command text changed');
		await page.getByRole('button', { name: 'Copy' }).click();
		ok((await page.evaluate(() => navigator.clipboard.readText())) === COMMAND, 'Copy does not copy the command');
	},
} satisfies Invariant;
