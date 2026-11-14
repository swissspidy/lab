export const metadata = { title: 'Documentation' };

export default function Docs() {
	return (
		<>
			<h1>Documentation</h1>
			<h2 id="quick-start">Quick start</h2>
			<p>Install the CLI, then connect your repository:</p>
			<pre><code>npx driftwood-cli connect</code></pre>
			<h2 id="configuration">Configuration</h2>
			<p>Put options in <code>driftwood.json</code> next to your <code>package.json</code>.</p>
			<h2 id="ci">Running in CI</h2>
			<p>Driftwood comments on the pull request when the environment is ready, so any CI system works.</p>
		</>
	);
}
