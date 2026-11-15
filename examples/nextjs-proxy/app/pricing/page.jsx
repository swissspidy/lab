import Link from 'next/link';

export const metadata = { title: 'Pricing' };

export default function Pricing() {
	return (
		<>
			<h1>Pricing</h1>
			<div className="plans">
				<section className="plan" aria-labelledby="plan-free">
					<h2 id="plan-free">Free</h2>
					<p className="price" data-price>CHF 0 per month</p>
					<p>Up to 3 environments at a time.</p>
				</section>
				<section className="plan" aria-labelledby="plan-team">
					<h2 id="plan-team">Team</h2>
					<p className="price" data-price>CHF 24 per month</p>
					<p>Unlimited environments and custom domains.</p>
				</section>
			</div>
			<p><Link className="button" href="/docs" data-lab-event="next_step_click">Start with the free plan</Link></p>
		</>
	);
}
