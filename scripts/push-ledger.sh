#!/usr/bin/env bash
# Commits the ledger and recorded specs, and pushes them with any kept
# changes or merged fixes. Run by action.yml from the repository root, with
# SITE (the site directory) and COMMAND (the lab command that ran).
#
# Someone may have pushed since checkout: the commits are rebased onto that
# and pushed again. A merged fix (`lab: fix <id>`) was verified on the site as
# checked out, so if the upstream changes touch the site outside lab/, it is
# not rebased onto them: the job fails instead, nothing is pushed, and the
# next run finds the fix still approved and refuses to merge it onto the
# changed site (promote-site-changed).
set -euo pipefail
: "${SITE:?SITE must name the site directory}"
: "${COMMAND:?COMMAND must name the lab command}"

git add -f -- "$SITE/lab/ledger.jsonl" 2>/dev/null || true
if [ -d "$SITE/lab/specs" ]; then git add -f -- "$SITE/lab/specs"; fi
if ! git diff --cached --quiet; then git commit -q -m "lab: $COMMAND"; fi

if [ -z "$(git log --branches --not --remotes --oneline)" ]; then exit 0; fi
for attempt in 1 2 3; do
	if git push -q; then exit 0; fi
	git fetch -q
	# Compare from where our commits branch off, not from the tracking ref: an
	# earlier fetch may already have moved that past the site the fix was made on.
	base=$(git merge-base HEAD '@{u}')
	ours=$(git log --format=%s '@{u}..HEAD')
	if grep -q '^lab: fix ' <<<"$ours" && ! git diff --quiet "$base" '@{u}' -- "$SITE" ":(exclude)$SITE/lab"; then
		echo "::error::promote-site-changed: a fix was merged onto the site as checked out, but the site changed upstream since. It is not pushed onto a site it was not verified on; the next run sees it still approved and refuses to merge it." >&2
		exit 1
	fi
	git rebase -q '@{u}' || { git rebase --abort; break; }
	sleep $((attempt * ${LAB_PUSH_BACKOFF:-5}))
done
echo "::error::Could not push the ledger. The deploy state may be ahead of the committed ledger; run the workflow again or push lab/ledger.jsonl by hand." >&2
git log --branches --not --remotes --stat >&2
exit 1
