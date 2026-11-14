export default {
	site: { repo: '.', build: 'npm run build', outDir: 'dist' },
	metric: { id: 'next_step_click', kind: 'conversion' },
	guardrailMetrics: ['js_error_rate', 'bounce'],
	allow: ['src/pages/**', 'src/components/**', 'src/styles/**'],
	deny: ['**/legal/**', '**/checkout/**', '**/*analytics*', 'src/components/signup.html'],
	invariants: 'lab/invariants/',
	budgets: { lcpMs: 2500, cls: 0.1, axeViolations: 0, bundleKbDelta: 20 },
	traffic: { share: 0.1, minSamplesPerBucket: 1000, maxDays: 14 },
	autonomy: 'gated',
};
