# FPL League View

A static site that charts an FPL mini-league gameweek by gameweek against two baselines:
the league average and the overall FPL average.

Six views, from two controls: **Points**, **% Lg** or **% FPL**, each either **Cumulative**
or **Per GW**. In a percentage view the chosen baseline is a flat 100% line and every team
is read against it.

Built for reading on a phone. No backend, no build step: the page loads one JSON file.
It's also a installable PWA — add it to your homescreen and it opens like an app, works
offline (both the page itself and the most recent stats), and remembers your chart type
and which teams you've hidden or focused.

Configured for league **383398** (`config.json`).

## Setup — two things to do by hand

Neither can be done from a commit, and the deploy fails until the first is done:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   The deploy workflow does ask `configure-pages` to enable Pages itself
   (`enablement: true`), but `GITHUB_TOKEN` is refused that call with
   *"Resource not accessible by integration"*, so it has to be switched on in the
   settings UI. The flag is kept because it costs nothing and makes the workflow
   self-sufficient on any repository where the token is allowed to do it.
2. **Settings → Actions → General → Workflow permissions → Read and write
   permissions.** The refresh workflow commits the JSON it fetches; without
   write access that commit step fails.

Then run **Actions → Refresh FPL data → Run workflow** to pull real data for the first
time. Until that runs, the site shows clearly-labelled placeholder numbers.

## How it fits together

```
config.json                  league id and request settings
scripts/fetch-data.mjs       FPL API  ->  site/data/league.json
scripts/validate-data.mjs    invariant checks on that file
site/                        exactly what gets published
  index.html  styles.css  app.js
  vendor/chart.umd.js        Chart.js 4.4.7, vendored
  data/league.json           the only file the page loads
  manifest.json               PWA metadata (name, icons, theme colour)
  sw.js                        service worker: caches the app shell for offline
  icons/                       homescreen icon, generated at build time (see below)
```

Nothing in `scripts/` ever reaches the browser. It runs in Actions, writes JSON, and
commits it.

### Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push and PR | syntax-checks the scripts, dry-runs the fetcher, validates the data |
| `refresh.yml` | daily 06:00 UTC, plus 12:00 and 18:00 on Mon/Tue; or manually | fetches, validates, commits only if something changed, then calls the deploy |
| `deploy.yml` | push to the default branch, manually, or called by `refresh.yml` | validates and publishes `site/` to Pages |

The Monday/Tuesday runs exist because a gameweek is only counted once FPL marks it
`data_checked` — bonus points confirmed. Fetching mid-gameweek would add nothing.

> GitHub disables scheduled workflows after 60 days with no repository activity. If the
> data goes stale over a long off-season, re-enable the schedule in the Actions tab.

## Running it yourself

```bash
node scripts/fetch-data.mjs            # fetch and write site/data/league.json
node scripts/fetch-data.mjs --dry-run  # print the request plan, touch no network
node scripts/validate-data.mjs         # check the data holds together
node scripts/gen-icon-svg.mjs          # regenerate site/icons/icon.svg after editing it

cd site && python3 -m http.server 8000 # then open http://localhost:8000
```

No dependencies to install — the scripts are plain Node 22, and Chart.js is vendored.
The service worker means a plain reload can serve a stale copy of the app shell while
you're editing it locally; hard-refresh (or open DevTools → Application → Service
Workers → Unregister) if a change to `index.html`/`styles.css`/`app.js` isn't showing up.

## Configuration

```jsonc
{
  "leagueId": 383398,
  "season": "auto",        // or a literal like "2025/26"
  "requestDelayMs": 150,   // pacing between FPL API calls
  "userAgent": "..."
}
```

## The data file

`site/data/league.json` is the whole contract between the pipeline and the page:

```jsonc
{
  "generatedAt": "2026-09-15T18:00:00.000Z",
  "sample": true,                 // absent once real data lands
  "season": "2025/26",
  "league": { "id": 383398, "name": "..." },
  "gameweeks": [1, 2, 3],
  "teams": [{
    "entry": 1234567, "name": "...", "manager": "...", "rank": 1, "total": 158,
    "gw": [45, 61, 52],           // net of transfer hits
    "cumulative": [45, 106, 158],
    "bench": [8, 12, 4],
    "overallRank": [...]
  }],
  "series": {
    "leagueAverage": { "gw": [...], "cumulative": [...] },
    "fplAverage":    { "gw": [...], "cumulative": [...] }
  }
}
```

Every per-gameweek array is the same length as `gameweeks`. A team that joined late gets
`null` for the weeks before it existed, and the chart draws a gap rather than a line to
zero. Per-gameweek team scores are net of transfer hits, matching the official standings.

## Installing it as an app

`site/manifest.json` + `site/sw.js` make this a PWA. On a phone, "Add to Home Screen"
(Safari) or the install prompt (Chrome/Edge) gives it a soccer-ball icon and opens it
without browser chrome, like a native app.

The service worker only caches the **app shell** — `index.html`, `styles.css`, `app.js`,
the vendored Chart.js, and the icons — so the page itself opens instantly with no network
at all. It deliberately leaves `data/league.json` alone; that's handled separately, one
layer up, by the browser cache logic below. Splitting it this way means the app can tell
"the shell is cached" apart from "the stats are stale", which a single cache-everything
strategy can't do.

The cache is versioned (`VERSION` in `sw.js`) and cleans up the previous version on
activate, so a shell update reaches installed copies the next time they're opened online
— bump `VERSION` when changing anything under `site/` that the service worker lists.

## Offline stats and remembered preferences

Two independent things live in `localStorage`, both under a versioned key prefix
(`fplview:v1:...`) so a future change to what's stored can't collide with an old shape
left behind in someone's browser:

- **`fplview:v1:prefs`** — chart type (measure + basis), which teams are hidden via the
  legend, and which team is focused. Restored on load, so the page reopens exactly how
  you left it.
- **`fplview:v1:data`** — the most recent successful `data/league.json` fetch, with a
  timestamp. If a fetch fails for any reason — offline, a dead link, GitHub Pages
  hiccuping — the page falls back to this instead of an empty page, and a banner says
  so: *"You're offline — showing data from 2 hours ago."* (or *"Could not reach the
  server..."* if `navigator.onLine` says the connection itself is fine, so the wording
  doesn't lie about the actual cause).

Reconnecting is handled too: an `online` event triggers a quiet background refetch, and
the banner clears the moment fresh data lands.

Every `localStorage` read and write is wrapped in `try/catch` — private browsing, a full
quota, or storage disabled entirely all degrade to "works the same, just doesn't
remember", never a broken page.

## Notes on the page

- **Every team gets its own colour and line style.** The nine hues were generated in
  OKLCH and validated for colourblind separation and contrast against both surfaces.
  Nine is the ceiling, not a preference: ten or more evenly-spaced hues fail the
  separation gates in one mode or the other, so past nine a team reuses a hue with a
  different line style (solid, dashed, dotted). That gives 27 unique colour+style pairs,
  enough for a 23-team league with room to spare.
- **Twenty-odd lines cannot be told apart by hue alone** — no palette can do that, which
  is why the style channel exists. For reading one team, tap its row in the standings
  table: it thickens and everything else recedes.
- **The two baselines** lead the legend, where they are easiest to find. They are
  reference lines rather than competitors, so they stay neutral — no team is ever
  neutral — and are drawn heavier than the team lines, because against that many
  coloured series a thin grey line disappears.
- **Percentage views bound their own y-axis** around the data, always keeping 100% in
  frame. Left to itself Chart.js rounds the axis floor down to zero and squashes every
  line into the top third of the plot.
- **Light and dark** are separate palettes stepped for their own surface, not an
  automatic inversion. The page follows the OS setting.
