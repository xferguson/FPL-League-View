#!/usr/bin/env node
// Checks site/data/league.json holds together before it reaches the browser.
// Run after a fetch, or in CI:  node scripts/validate-data.mjs

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(ROOT, 'site/data/league.json');

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const data = JSON.parse(await readFile(file, 'utf8'));
const gws = data.gameweeks ?? [];
const n = gws.length;

if (!Array.isArray(gws) || n === 0) fail('gameweeks is empty');
if (!data.league?.id) fail('league.id missing');
if (!Array.isArray(data.teams) || data.teams.length === 0) fail('no teams');

const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol;

/** Every per-GW array must line up with gameweeks, or the chart silently misaligns. */
function checkLength(label, arr) {
  if (!Array.isArray(arr)) return fail(`${label} is not an array`);
  if (arr.length !== n) fail(`${label} has ${arr.length} values, expected ${n}`);
}

for (const team of data.teams ?? []) {
  const label = `team "${team.name}"`;
  checkLength(`${label}.gw`, team.gw);
  checkLength(`${label}.cumulative`, team.cumulative);

  // cumulative should be the running sum of gw, allowing for a late join.
  let sum = 0;
  let started = false;
  for (let i = 0; i < n; i += 1) {
    const g = team.gw?.[i];
    const c = team.cumulative?.[i];
    if (g === null || g === undefined) {
      if (c !== null && c !== undefined && started) {
        warn(`${label} GW${gws[i]}: cumulative present but no GW score`);
      }
      continue;
    }
    if (!started && i > 0) {
      // Joined mid-season: FPL carries their pre-join total, so only track from here.
      sum = (c ?? 0) - g;
    }
    started = true;
    sum += g;
    if (c !== null && c !== undefined && !near(sum, c)) {
      warn(`${label} GW${gws[i]}: cumulative ${c} != running sum ${sum}`);
      sum = c; // resync so one discrepancy doesn't cascade
    }
  }

  if (team.total !== undefined && team.cumulative?.at(-1) != null && !near(team.total, team.cumulative.at(-1))) {
    warn(`${label}: standings total ${team.total} != final cumulative ${team.cumulative.at(-1)}`);
  }
}

for (const key of ['leagueAverage', 'fplAverage']) {
  const s = data.series?.[key];
  if (!s) {
    fail(`series.${key} missing`);
    continue;
  }
  checkLength(`series.${key}.gw`, s.gw);
  checkLength(`series.${key}.cumulative`, s.cumulative);

  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = s.gw?.[i];
    if (v === null || v === undefined) continue;
    sum += v;
    const c = s.cumulative?.[i];
    if (c !== null && c !== undefined && !near(sum, c)) {
      fail(`series.${key} GW${gws[i]}: cumulative ${c} != running sum ${Math.round(sum * 10) / 10}`);
    }
  }
}

// League average must be reproducible from the team rows.
for (let i = 0; i < n; i += 1) {
  const scores = (data.teams ?? []).map((t) => t.gw?.[i]).filter((v) => v !== null && v !== undefined);
  if (!scores.length) continue;
  const expected = scores.reduce((a, b) => a + b, 0) / scores.length;
  const actual = data.series?.leagueAverage?.gw?.[i];
  if (actual !== null && actual !== undefined && !near(expected, actual, 0.11)) {
    fail(`leagueAverage GW${gws[i]}: ${actual} != recomputed ${Math.round(expected * 10) / 10}`);
  }
}

for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL: ${e}`);
  console.error(`\n${errors.length} problem(s) in ${file}`);
  process.exit(1);
}
console.log(
  `OK — ${data.teams.length} teams, GW ${gws[0]}-${gws.at(-1)}` +
    `${data.sample ? ' (sample data)' : ''}` +
    `${warnings.length ? `, ${warnings.length} warning(s)` : ''}`
);
