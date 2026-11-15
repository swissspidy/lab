import './globals.css';
import { cookies } from 'next/headers';
import { COOKIE_TWEAKS, labBeaconScript, tweakStylesheets } from '@lab/next';
import Header from '../components/Header.jsx';
import Footer from '../components/Footer.jsx';

export const metadata = {
	title: { default: 'Driftwood: a preview environment for every pull request', template: '%s · Driftwood' },
	description: 'Driftwood builds a preview environment for every pull request and posts the link in the review.',
};

export default async function RootLayout({ children }) {
	// Personal tweaks in <head>, so they apply before the first paint.
	const tweaks = tweakStylesheets((await cookies()).get(COOKIE_TWEAKS)?.value);
	return (
		<html lang="en">
			<head>
				{tweaks.map((t) => (
					<link key={t.id} rel="stylesheet" href={t.href} data-lab-tweak={t.id} />
				))}
				<script dangerouslySetInnerHTML={{ __html: labBeaconScript('next_step_click') }} />
			</head>
			<body>
				<Header />
				<main>{children}</main>
				<Footer />
			</body>
		</html>
	);
}
