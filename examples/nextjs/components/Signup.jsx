'use client';
import { useState } from 'react';

export default function Signup() {
	const [status, setStatus] = useState('');
	const [invalid, setInvalid] = useState(false);
	function onSubmit(event) {
		event.preventDefault();
		const email = event.currentTarget.elements.email;
		if (!email.checkValidity()) {
			setInvalid(true);
			setStatus('Enter a valid email address.');
			return;
		}
		setInvalid(false);
		setStatus(`Thanks. We will send release notes to ${email.value}.`);
		event.currentTarget.reset();
	}
	return (
		<section className="signup" aria-labelledby="signup-title">
			<h2 id="signup-title">Release notes by email</h2>
			<form noValidate onSubmit={onSubmit}>
				<label htmlFor="signup-email">Email address</label>
				<input id="signup-email" name="email" type="email" autoComplete="email" required aria-invalid={invalid || undefined} />
				<button type="submit">Subscribe</button>
				<p className="form-status" role="status">{status}</p>
			</form>
		</section>
	);
}
