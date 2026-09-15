#!/usr/bin/env node
// Builds site/data/league.json from the public Fantasy Premier League API.
//
// This is a build-time tool: it runs in GitHub Actions (or on your machine) and
// commits plain JSON. Nothing here ships to the browser.
//
//   node scripts/fetch-data.mjs             # fetch and write
//   node scripts/fetch-data.mjs --dry-run   # print the request plan, touch no network

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(ROOT, 'site/data');
const OUT_FILE = resolve(DATA_DIR, 'league.json');
const API = 'https://fantasy.premierleague.com/api';

const DRY_RUN = process.argv.includes('--dry-run');

const config = JSON.parse(await readFile(resolve(ROOT, 'config.json'), 'utf8'));
const DELAY_MS = config.requestDelayMs ?? 150;
const UA = config.userAgent ?? 'FPL-League-View';

const planned = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with polite pacing and backoff on 429/5xx. */
async function api(path, { attempt = 0 } = {}) {
  const url = `${API}${path}`;
  planned.push(url);
  if (DRY_RUN) return null;

  await sleep(DELAY_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
    const wait = 2 ** attempt * 1000;
    console.warn(`  network error on ${path}, retrying in ${wait}ms — ${err.message}`);
    await sleep(wait);
    return api(path, { attempt: attempt + 1 });
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = 2 ** attempt * 1000;
    console.warn(`  HTTP ${res.status} on ${path}, retrying in ${wait}ms`);
    await sleep(wait);
    return api(path, { attempt: attempt + 1 });
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

/** Running total of a per-GW series, carrying nulls forward as gaps. */
function runningTotal(values) {
  let sum = 0;
  let seen = false;
  return values.map((v) => {
    if (v === null || v === undefined) return seen ? round1(sum) : null;
    seen = true;
    sum += v;
    return round1(sum);
  });
}

/** "2025/26" from the season's first deadline. */
function seasonLabel(events) {
  if (config.season && config.season !== 'auto') return config.season;
  const first = events.find((e) => e.deadline_time);
  if (!first) return '';
  const year = new Date(first.deadline_time).getUTCFullYear();
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

async function main() {
  console.log(`Fetching FPL data for league ${config.leagueId}${DRY_RUN ? ' (dry run)' : ''}`);

  // 1. Gameweek metadata and the official FPL average per GW.
  const bootstrap = await api('/bootstrap-static/');
  const events = bootstrap?.events ?? [];
  // A GW counts once its bonus and stats are final; otherwise the numbers move under us.
  const finished = events.filter((e) => e.finished && e.data_checked);
  const gameweeks = finished.map((e) => e.id);
  const fplAverageGw = finished.map((e) => e.average_entry_score ?? null);

  if (!DRY_RUN && gameweeks.length === 0) {
    console.log('No completed gameweeks yet — leaving existing data in place.');
    return;
  }

  // 2. League standings (paginated).
  const entries = [];
  let leagueName = '';
  for (let page = 1; ; page += 1) {
    const standings = await api(`/leagues-classic/${config.leagueId}/standings/?page_standings=${page}`);
    if (DRY_RUN) break;
    leagueName = standings.league?.name ?? leagueName;
    for (const row of standings.standings?.results ?? []) {
      entries.push({
        entry: row.entry,
        name: row.entry_name,
        manager: row.player_name,
        rank: row.rank,
        total: row.total,
      });
    }
    if (!standings.standings?.has_next) break;
  }
  if (!DRY_RUN) console.log(`  ${entries.length} teams in "${leagueName}"`);

  // 3. Per-team gameweek history.
  const teams = [];
  for (const entry of DRY_RUN ? [{ entry: 1234567 }] : entries) {
    const history = await api(`/entry/${entry.entry}/history/`);
    if (DRY_RUN) continue;

    const byGw = new Map();
    for (const row of history.current ?? []) byGw.set(row.event, row);

    const gw = [];
    const cumulative = [];
    const bench = [];
    const overallRank = [];
    for (const id of gameweeks) {
      const row = byGw.get(id);
      if (!row) {
        // Team joined after this GW, or has no entry for it: leave a gap.
        gw.push(null);
        cumulative.push(null);
        bench.push(null);
        overallRank.push(null);
        continue;
      }
      // `points` is the gross GW score; hits are deducted separately so that the
      // per-GW series matches what the official standings count.
      gw.push(row.points - (row.event_transfers_cost ?? 0));
      cumulative.push(row.total_points);
      bench.push(row.points_on_bench ?? null);
      overallRank.push(row.overall_rank ?? null);
    }

    // total_points should be the running net total; warn rather than silently diverge.
    const recomputed = runningTotal(gw);
    const last = cumulative.at(-1);
    if (last !== null && recomputed.at(-1) !== null && Math.abs(last - recomputed.at(-1)) > 0.5) {
      console.warn(
        `  ${entry.name}: FPL total ${last} != summed GW points ${recomputed.at(-1)} ` +
          `(likely a pre-join carry-over); using FPL's total.`
      );
    }

    teams.push({ ...entry, gw, cumulative, bench, overallRank });
  }
  teams.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  if (DRY_RUN) {
    console.log(`\nWould issue ${planned.length} request(s):`);
    for (const url of planned) console.log(`  GET ${url}`);
    console.log('\nNo files written.');
    return;
  }

  // 4. League average per GW, over the teams that actually have a score that week.
  const leagueAverageGw = gameweeks.map((_, i) => {
    const scores = teams.map((t) => t.gw[i]).filter((v) => v !== null && v !== undefined);
    if (!scores.length) return null;
    return round1(scores.reduce((a, b) => a + b, 0) / scores.length);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    season: seasonLabel(events),
    league: { id: config.leagueId, name: leagueName },
    gameweeks,
    teams,
    series: {
      leagueAverage: { gw: leagueAverageGw, cumulative: runningTotal(leagueAverageGw) },
      fplAverage: { gw: fplAverageGw, cumulative: runningTotal(fplAverageGw) },
    },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  ${teams.length} teams, GW ${gameweeks[0]}-${gameweeks.at(-1)}, ${planned.length} requests`);
}

await main();
