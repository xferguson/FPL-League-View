# FPL League View

A static site that charts an FPL mini-league gameweek by gameweek, against three
baselines: the league average, the overall FPL average, and an **index** — the mean
score of every player who featured that week, times eleven, standing in for a team of
eleven completely average performers.

Built for reading on a phone. No backend, no build step: the page loads one JSON file.

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
config.json                  league id and index settings
scripts/fetch-data.mjs       FPL API  ->  site/data/league.json
scripts/validate-data.mjs    invariant checks on that file
site/                        exactly what gets published
  index.html  styles.css  app.js
  vendor/chart.umd.js        Chart.js 4.4.7, vendored
  data/league.json           the only file the page loads
  data/index-cache.json      per-GW player means (generated; safe to delete)
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

cd site && python3 -m http.server 8000 # then open http://localhost:8000
```

No dependencies to install — the scripts are plain Node 22, and Chart.js is vendored.

## Configuration

```jsonc
{
  "leagueId": 383398,
  "season": "auto",        // or a literal like "2025/26"
  "index": {
    "pool": "played",      // "played" = players with minutes > 0; "all" = everyone
    "multiplier": 11
  }
}
```

`pool` is the interesting knob. `"played"` averages only players who actually featured,
giving an index around 30–35 points a week — a realistic baseline. `"all"` averages every
player in the game including the ones who never left the bench, which drags the mean to
roughly 1.2 and the index to the mid-teens. Both means are stored on every fetch, so
switching `pool` and re-running costs no extra API calls.

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
    "fplAverage":    { "gw": [...], "cumulative": [...] },
    "index":         { "gw": [...], "cumulative": [...] }
  },
  "indexDetail": { "pool": "played", "multiplier": 11,
                   "playedMean": [...], "allMean": [...] }
}
```

Every per-gameweek array is the same length as `gameweeks`. A team that joined late gets
`null` for the weeks before it existed, and the chart draws a gap rather than a line to
zero. Per-gameweek team scores are net of transfer hits, matching the official standings.

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
- **The three baselines** lead the legend, where they are easiest to find. They are
  reference lines rather than competitors, so they stay neutral — no team is ever
  neutral — and are drawn heavier than the team lines, because against that many
  coloured series a thin grey line disappears.
- **Light and dark** are separate palettes stepped for their own surface, not an
  automatic inversion. The page follows the OS setting.
