import Link from 'next/link';
import Search from './Search.jsx';

export default function Header() {
	return (
		<header className="site-header">
			<Link className="brand" href="/">Driftwood</Link>
			<nav aria-label="Main">
				<ul>
					<li><Link href="/">Home</Link></li>
					<li><Link href="/pricing">Pricing</Link></li>
				</ul>
			</nav>
			<Search />
		</header>
	);
}
