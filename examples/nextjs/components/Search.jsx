'use client';
import Link from 'next/link';
import { useState } from 'react';
import { searchIndex } from './search-index.js';

export default function Search() {
	const [results, setResults] = useState(null);
	const [query, setQuery] = useState('');
	function onSubmit(event) {
		event.preventDefault();
		const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		setResults(searchIndex.filter((e) => words.every((w) => `${e.title} ${e.text}`.toLowerCase().includes(w))));
	}
	return (
		<form className="search" role="search" onSubmit={onSubmit}>
			<label htmlFor="search-input">Search the docs</label>
			<input id="search-input" name="q" type="search" autoComplete="off" required value={query} onChange={(e) => setQuery(e.target.value)} />
			<button type="submit">Search</button>
			<div className="search-results" aria-live="polite">
				{results && results.length === 0 && <p>No results for “{query}”.</p>}
				{results && results.length > 0 && (
					<ul>{results.map((r) => <li key={r.url}><Link href={r.url}>{r.title}</Link></li>)}</ul>
				)}
			</div>
		</form>
	);
}
