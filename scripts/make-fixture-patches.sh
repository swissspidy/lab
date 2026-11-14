#!/usr/bin/env bash
# Regenerates fixtures/{good,breakages}/*/patch.diff from scripted edits of
# fixtures/site. Run it after changing the fixture site, then commit.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
site="$root/fixtures/site"

patch() { # patch <dir> <edit command...>
	local out="$root/fixtures/$1"; shift
	local work; work="$(mktemp -d)"
	cp -a "$site/." "$work/"
	rm -rf "$work/dist" "$work/node_modules" "$work/lab/ledger.jsonl" "$work/lab/evidence"
	(cd "$work" && git init -q && git add -A && git -c user.name=lab -c user.email=lab@example.invalid commit -qm base)
	(cd "$work" && "$@")
	(cd "$work" && git add -A && git diff --cached) > "$out/patch.diff"
	rm -rf "$work"
	[ -s "$out/patch.diff" ] || { echo "empty patch for $out" >&2; exit 1; }
}

# Good patches: each must pass.
patch good/hero-height sed -i 's/height: 720px;/height: 120px;/' src/styles/site.css
patch good/nav-docs sed -i 's|\t\t\t<li><a href="pricing.html">Pricing</a></li>|\t\t\t<li><a href="docs.html" data-lab-event="next_step_click">Docs</a></li>\n&|' src/components/header.html
patch good/install-in-hero sh -c '
	sed -i "/<!-- component:install -->/d" src/pages/index.html
	sed -i "s|\t\t<div class=\"hero-art\"|\t\t<!-- component:install -->\n&|" src/pages/index.html'
patch good/features-order sh -c '
	sed -i "/<li>External links, with a cache so CI stays fast<\/li>/d" src/pages/index.html
	sed -i "s|\t\t\t<li>Internal links and anchors</li>|\t\t\t<li>External links, with a cache so CI stays fast</li>\n&|" src/pages/index.html'
patch good/features-heading sed -i 's|>What it checks<|>What Kestrel checks<|' src/pages/index.html

# Breakages: each must be rejected, naming the check in expect.json.
patch breakages/dead-link sed -i 's|<a href="docs.html" data-lab-event="next_step_click">Documentation|<a href="documentation.html" data-lab-event="next_step_click">Documentation|' src/components/footer.html
patch breakages/hidden-button sh -c 'printf ".signup button { display: none; }\n" >> src/styles/site.css'
patch breakages/broken-form sed -i 's|name="q"|name="query"|' src/components/search.html
patch breakages/contrast-failure sed -i 's|background: var(--accent); color: #fff;|background: #9fbfe3; color: #fff;|' src/styles/site.css
patch breakages/layout-shift sed -i 's|<body>|<body>\n<script>setTimeout(() => { const d = document.createElement("div"); d.style.height = "300px"; document.body.prepend(d); }, 300);</script>|' src/pages/index.html
patch breakages/console-error sed -i 's|<body>|<body>\n<script>console.error("Widget failed to start");</script>|' src/pages/docs.html
patch breakages/oversized-bundle sh -c 'for i in $(seq 1 120); do printf ".pad-%s { background-image: linear-gradient(%s); }\n" "$i" "$(head -c 240 /dev/zero | tr "\0" "x")"; done > src/styles/extra.css'
patch breakages/out-of-scope-file sed -i 's|No results for|Nothing found for|' src/scripts/site.js
patch breakages/changed-price sed -i 's|CHF 19 per month|CHF 29 per month|' src/pages/pricing.html
patch breakages/edits-invariants sed -i "s|'CHF 19 per month'|'CHF 29 per month'|" lab/invariants/pricing.ts
patch breakages/new-dependency sh -c 'node -e "const p=require(\"./package.json\");p.dependencies={\"left-pad\":\"1.3.0\"};require(\"fs\").writeFileSync(\"package.json\",JSON.stringify(p,null,\"\\t\")+\"\\n\")"'
patch breakages/third-party-script sed -i 's|<script type="module" src="scripts/site.js"></script>|&\n<script src="https://cdn.example.com/widget.js"></script>|' src/components/layout-head.html
patch breakages/layout-overflow sh -c 'printf "main { min-width: 1400px; }\n" >> src/styles/site.css'
patch breakages/build-break sed -i 's|<!-- component:signup -->|<!-- component:newsletter -->|' src/pages/index.html
patch breakages/oversized-patch sh -c 'for i in $(seq 1 230); do printf "/* spacing note %s */\n" "$i"; done >> src/styles/site.css'
patch breakages/symlink sh -c 'ln -s ../../package.json src/styles/package.css'
patch breakages/removed-page rm src/pages/pricing.html
patch breakages/new-claim sed -i 's|<p>Kestrel crawls your built site|<p>Trusted by Initech and Globex. Kestrel crawls your built site|' src/pages/index.html
patch breakages/misses-acceptance sed -i 's|>What it checks<|>What Kestrel checks<|' src/pages/index.html
echo "Patches written."
