// Search, signup and copy. No third-party code, no network beyond this site.

const search = document.querySelector('[data-search]');
if (search) {
	const results = search.querySelector('[data-search-results]');
	search.addEventListener('submit', async (event) => {
		event.preventDefault();
		const query = new FormData(search).get('q').toString().trim().toLowerCase();
		const index = await (await fetch(new URL('../data/search-index.json', import.meta.url))).json();
		const words = query.split(/\s+/).filter(Boolean);
		const hits = index.filter((entry) => words.every((w) => `${entry.title} ${entry.text}`.toLowerCase().includes(w)));
		results.replaceChildren();
		if (hits.length === 0) {
			results.textContent = `No results for “${query}”.`;
			return;
		}
		const list = document.createElement('ul');
		for (const hit of hits) {
			const item = document.createElement('li');
			const link = document.createElement('a');
			link.href = hit.url;
			link.textContent = hit.title;
			item.append(link);
			list.append(item);
		}
		results.append(list);
	});
}

const signup = document.querySelector('[data-signup]');
if (signup) {
	const status = signup.querySelector('[data-signup-status]');
	signup.addEventListener('submit', (event) => {
		event.preventDefault();
		const email = signup.querySelector('input[type=email]');
		if (!email.checkValidity()) {
			status.textContent = 'Enter a valid email address.';
			email.setAttribute('aria-invalid', 'true');
			return;
		}
		email.removeAttribute('aria-invalid');
		status.textContent = `Thanks. We will send release notes to ${email.value}.`;
		signup.reset();
	});
}

for (const button of document.querySelectorAll('[data-copy]')) {
	button.addEventListener('click', async () => {
		await navigator.clipboard.writeText(button.dataset.copy);
		button.textContent = 'Copied';
	});
}
