#!/usr/bin/env bash
# Regenerates examples/nextjs/experiments/*/patch.diff from scripted edits of
# the example Next.js site. Run it after changing the site, then commit.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
site="$root/examples/nextjs"

patch() { # patch <experiment> <edit command...>
	local out="$site/experiments/$1"; shift
	local work; work="$(mktemp -d)"
	mkdir -p "$out"
	(cd "$site" && tar --exclude=./node_modules --exclude=./.next --exclude=./out --exclude=./experiments --exclude=./.lab --exclude=./lab/ledger.jsonl --exclude=./lab/evidence -cf - .) | (cd "$work" && tar -xf -)
	(cd "$work" && git init -q && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm base --no-gpg-sign)
	(cd "$work" && "$@")
	(cd "$work" && git add -A && git diff --cached) > "$out/patch.diff"
	rm -rf "$work"
	[ -s "$out/patch.diff" ] || { echo "empty patch for $out" >&2; exit 1; }
}

patch nav-docs sed -i 's|\t\t\t\t\t<li><Link href="/pricing">Pricing</Link></li>|\t\t\t\t\t<li><Link href="/docs" data-lab-event="next_step_click">Docs</Link></li>\n&|' components/Header.jsx
patch hero-height sed -i 's/height: 720px;/height: 120px;/' app/globals.css
patch signup-first sh -c '
	sed -i "/\t\t\t<Signup \/>/d" app/page.jsx
	sed -i "s|\t\t\t<Install />|\t\t\t<Signup />\n&|" app/page.jsx'
patch changed-price sed -i 's|CHF 24 per month|CHF 29 per month|' app/pricing/page.jsx
echo "Patches written."
