export default {
	site: { repo: '.', build: 'npm run build', outDir: 'out' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	guardrailMetrics: ['js_error_rate', 'bounce'],
	allow: ['app/**', 'components/**'],
	deny: ['app/layout.jsx', 'components/Signup.jsx', '**/*analytics*'],
	invariants: 'lab/invariants/',
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.5, minSamplesPerBucket: 1000, maxDays: 14, intervalHours: 6 },
	autonomy: 'gated',
};
