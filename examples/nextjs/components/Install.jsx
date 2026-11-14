'use client';
import Link from 'next/link';
import { useState } from 'react';

const COMMAND = 'npm install --save-dev driftwood-cli';

export default function Install() {
	const [copied, setCopied] = useState(false);
	return (
		<section className="install" aria-labelledby="install-title">
			<h2 id="install-title">Install</h2>
			<p>Driftwood runs on Node 22 or later.</p>
			<div className="command">
				<code data-install-command>{COMMAND}</code>
				<button type="button" onClick={async () => { await navigator.clipboard.writeText(COMMAND); setCopied(true); }}>
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<p><Link className="button" href="/docs" data-lab-event="next_step_click">Get started</Link></p>
		</section>
	);
}
