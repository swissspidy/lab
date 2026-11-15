import Link from 'next/link';

export default function Footer() {
	return (
		<footer className="site-footer">
			<nav aria-label="Footer">
				<ul>
					<li><Link href="/docs" data-lab-event="next_step_click">Documentation</Link></li>
					<li><Link href="/pricing">Pricing</Link></li>
				</ul>
			</nav>
			<p>Driftwood is a fictional product used to test the lab.</p>
		</footer>
	);
}
