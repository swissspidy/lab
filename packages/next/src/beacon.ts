import { BEACON_PATH, COOKIE_BUCKET, COOKIE_EXPERIMENT } from './decide.ts';

/**
 * The beacon, as a script to inline in the root layout:
 *
 *   <script dangerouslySetInnerHTML={{ __html: labBeaconScript('next_step_click') }} />
 *
 * It sends one beacon per event: a visit, the first click on an element with
 * data-lab-event="<metric>", the first interaction, the first uncaught error.
 * It reads the experiment and bucket from the cookies the proxy sets.
 */
export function labBeaconScript(metric: string): string {
	return `(() => {
	const read = (n) => (document.cookie.split('; ').find((c) => c.startsWith(n + '=')) || '').slice(n.length + 1);
	const e = read(${JSON.stringify(COOKIE_EXPERIMENT)}), b = read(${JSON.stringify(COOKIE_BUCKET)}) || 'baseline', m = ${JSON.stringify(metric)};
	const send = (k) => { try { navigator.sendBeacon(${JSON.stringify(BEACON_PATH)}, JSON.stringify({ e, b, k })); } catch {} };
	const once = {};
	const first = (k) => { if (!once[k]) { once[k] = true; send(k); } };
	send('visit');
	addEventListener('click', (ev) => {
		first('engaged');
		const t = ev.target instanceof Element ? ev.target.closest('[data-lab-event]') : null;
		if (t && t.getAttribute('data-lab-event') === m) first('conversion');
	}, true);
	addEventListener('scroll', () => first('engaged'), { passive: true, once: true });
	addEventListener('error', () => first('js_error'));
})();`;
}
