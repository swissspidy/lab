import './globals.css';
import Header from '../components/Header.jsx';
import Footer from '../components/Footer.jsx';

export const metadata = {
	title: { default: 'Driftwood: a preview environment for every pull request', template: '%s · Driftwood' },
	description: 'Driftwood builds a preview environment for every pull request and posts the link in the review.',
};

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>
				<Header />
				<main>{children}</main>
				<Footer />
			</body>
		</html>
	);
}
