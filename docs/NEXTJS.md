# Running the lab on a Next.js site

Three parts, each where it can run:

| Part | Runs | Does |
| --- | --- | --- |
| `proxy.js` with `@lab/next` | in the site, on every request | buckets visitors with a random first-party cookie, rewrites the variant bucket (pages and `_next` assets) to the variant's origin, forwards beacons, honours the kill switch |
| The collector (`lab collect`) | always on, anywhere | serves the deploy state to the proxy, counts beacons per bucket, and, with a token, takes state writes and serves metrics to the loop |
| The loop (`lab run`) | on a schedule, as a GitHub Action | proposes, builds and verifies variants, publishes approved ones, measures, keeps or reverts, and commits the ledger and kept changes |

A person approves each experiment by running the workflow with
`command: approve` until auto mode is unlocked (see the README).

## 1. The site

Install `@lab/next` and add a `proxy.js` (Next.js 16) next to `app/`:

```js
import { NextResponse } from 'next/server';
import { createLabProxy } from '@lab/next';

export const proxy = createLabProxy({ NextResponse, lab: process.env.LAB_URL });
```

In `next.config.mjs`, add `transpilePackages: ['@lab/next']`. In the root
layout, add the beacon:

```jsx
import { labBeaconScript } from '@lab/next';
// inside <html>:
<head>
	<script dangerouslySetInnerHTML={{ __html: labBeaconScript('next_step_click') }} />
</head>
```

Mark what counts as the metric with `data-lab-event="next_step_click"` on the
links or buttons. Set `LAB_URL` in the production environment only. Without it
the proxy changes nothing and sets no cookies, which is what a variant
deployment needs.

If the lab cannot be reached, every visitor gets the production site. The kill
switch takes effect within the proxy's cache time (5 seconds by default,
`cacheMs`).

With `tweaks: {}` in the config, the same proxy serves personal tweaks: link
visitors to `/_lab/tweak/<id>` to opt in (`?off` to opt out, `?to=/path` to
land on a page of this site), and the beacon script adds the tweak's
stylesheet from `/_lab/tweaks/<id>.css`. A tweaked visitor is in no experiment.
A script runs after the first paint; to apply tweaks before it, render their
links in the root layout too (the script skips links already there):

```jsx
import { cookies } from 'next/headers';
import { COOKIE_TWEAKS, tweakStylesheets } from '@lab/next';
// in an async RootLayout, inside <head>:
{tweakStylesheets((await cookies()).get(COOKIE_TWEAKS)?.value).map((t) => (
	<link key={t.id} rel="stylesheet" href={t.href} data-lab-tweak={t.id} />
))}
```

Reading cookies makes the layout render per request.

## 2. The collector

Run `lab collect` somewhere always on (a small VM or container), with
`LAB_TOKEN` set to a long random secret and `LAB_HOST=0.0.0.0` behind HTTPS:

```sh
LAB_TOKEN=... LAB_HOST=0.0.0.0 npx lab collect path/to/site --port 8081
```

`GET /state` and `POST /beacon` are public; the proxy uses them.
`PUT /state` and `GET /metrics` need the token.

With `tweaks` in the config where `lab collect` runs, the collector also
keeps personal tweaks:

| Route | Who |
| --- | --- |
| `PUT /tweaks/<id>` | token: `lab tweak` stores a verified tweak |
| `GET /tweaks/<id>.json` | token: the stored record |
| `GET`, `HEAD /tweaks/<id>.css` | public: the stylesheet the proxy forwards to visitors |

Without `tweaks`, these routes do not exist.

## 3. The config

`lab.config.ts` for a server app:

```ts
export default {
	site: {
		repo: '.',
		build: 'npm run build',
		outDir: '.next/static',
		serve: 'node_modules/.bin/next start -p "$PORT" -H 127.0.0.1',
		pages: ['.', 'docs', 'pricing'],
	},
	deploy: {
		// Runs in a built copy of the variant; must print the variant URL last.
		publish: 'npx vercel deploy --yes --token "$VERCEL_TOKEN"',
		env: ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'],
	},
	// metric, allow, deny, budgets, traffic as usual
};
```

`serve` lets the sandbox verify the app as it runs in production. `pages` is
required with it: a server app's build output (`.next`) is not a list of its
pages, so the config names the routes to verify (`config-pages-required`). `deploy`
publishes a variant on any host with preview deployments; only the variables
named in `env` reach the command. On Vercel, preview deployments must be
reachable by the proxy: turn off Deployment Protection for previews, or use a
protection bypass.

When a variant is kept, or an approved fix merged, the lab commits its
patch to the site's repository; the site's own deployment then ships it to
everyone. If that deployment is a
GitHub workflow triggered by `push`, give the lab workflow a token that starts
workflows (`LAB_PUSH_TOKEN` in the example): pushes made with the default
`GITHUB_TOKEN` do not.

## 4. The workflow

Copy [examples/lab-workflow.yml](examples/lab-workflow.yml) to
`.github/workflows/lab.yml`. Set `LAB_URL` as a variable and `LAB_TOKEN`,
`ANTHROPIC_API_KEY` and any deploy token as secrets. The schedule runs one step
every 6 hours (match `traffic.intervalHours`). To approve, run the workflow
with `command: approve` and the experiment id; the GitHub user who runs it is
recorded as the approver. To stop everything, run it with `command: kill`, or
run `lab kill` anywhere with `LAB_URL` and `LAB_TOKEN`.

## Tried locally

`examples/nextjs-proxy` is a Next.js server app set up this way.
`examples/test/nextjs-proxy.test.ts` runs it end to end: the lab verifies a
variant in server mode, the operator approves, the variant starts on its own
server, the site's production server routes real Chromium visitors through its
proxy (pages, assets and interactivity from the variant build for the variant
bucket), beacons reach the collector, and the kill switch sends everyone back
to production. The Vercel publish command above has not been run.
