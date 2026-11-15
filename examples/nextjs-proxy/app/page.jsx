import Install from '../components/Install.jsx';
import Signup from '../components/Signup.jsx';

export default function Home() {
	return (
		<>
			<section className="hero">
				<h1>A preview environment for every pull request</h1>
				<p>Driftwood builds each pull request in its own environment and posts the link in the review.</p>
				<div className="hero-art" role="img" aria-label="A row of small preview windows floating on water" />
			</section>
			<section className="features" aria-labelledby="features-title">
				<h2 id="features-title">What you get</h2>
				<ul>
					<li>A fresh environment for each pull request</li>
					<li>Links posted in the review automatically</li>
					<li>Environments removed when the pull request closes</li>
				</ul>
			</section>
			<Install />
			<Signup />
		</>
	);
}
