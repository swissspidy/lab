# Fixtures

## `site/`

A small static site for a fictional link checker, Kestrel: three pages
(home, docs, pricing), a search box and a signup form. `npm run build`
writes `dist/`. Its `lab.config.ts` is what a site owner would write.

It has two planted flaws that a good experiment can fix:

1. On the home page, the install command and the **Get started** button sit
   below a 720px illustration, so at 1280x800 they are below the fold.
2. The main navigation has no link to the docs. The docs are reachable only
   from the footer.

Both flaws are pinned by `test/site.test.ts`, together with what must hold
on the baseline: no aXe violations, no console errors, no sideways scroll,
search returns results and the signup form submits.

This file sits outside `site/` on purpose: the Proposer reads the site's
source, and must not read the answers.
