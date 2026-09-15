/* Renders the league chart and standings from site/data/league.json.
   Everything is read from that one file — there is no API call at page load. */

(() => {
  'use strict';

  const DATA_URL = 'data/league.json';
  const TEAM_SLOTS = 8; // categorical palette depth; teams past this go neutral
  const TOOLTIP_TEAMS = 8; // keep the readout shorter than the screen in a big league
  const LEGEND_COLLAPSE_AT = 12; // past this many teams the chip list is folded

  const el = (id) => document.getElementById(id);

  let data = null;
  let chart = null;
  let mode = 'cumulative'; // 'cumulative' | 'gw'
  let focusedEntry = null; // entry id of the team singled out, or null
  let legendExpanded = false;
  const hidden = new Set(); // dataset keys switched off via the legend

  /** Read a CSS custom property off .viz-root so JS and CSS share one palette. */
  const token = (name) =>
    getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();

  function palette() {
    return {
      series: Array.from({ length: TEAM_SLOTS }, (_, i) => token(`--series-${i + 1}`)),
      primary: token('--text-primary'),
      secondary: token('--text-secondary'),
      muted: token('--text-muted'),
      grid: token('--gridline'),
      baseline: token('--baseline'),
      surface: token('--surface-1'),
    };
  }

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const lastValue = (arr) => {
    for (let i = (arr?.length ?? 0) - 1; i >= 0; i -= 1) if (isNum(arr[i])) return arr[i];
    return null;
  };
  const fmt = (v) => (isNum(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : '–');

  function relativeTime(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  /* ---------- series assembly ---------- */

  // The three baselines are reference lines, not competitors: neutral ink, and
  // told apart by dash pattern as well as weight.
  function baselineSpecs(p) {
    return [
      { key: 'index', label: 'Index', color: p.primary, dash: [], width: 2.5, style: 'solid' },
      { key: 'leagueAverage', label: 'League average', color: p.secondary, dash: [7, 4], width: 2, style: 'dashed' },
      { key: 'fplAverage', label: 'FPL average', color: p.muted, dash: [2, 3], width: 2, style: 'dotted' },
    ];
  }

  function teamColor(index, p) {
    return index < TEAM_SLOTS ? p.series[index] : p.muted;
  }

  function values(source) {
    return mode === 'cumulative' ? source.cumulative : source.gw;
  }

  function buildDatasets(p) {
    const dimmed = focusedEntry !== null;

    const teams = data.teams.map((team, i) => {
      const color = teamColor(i, p);
      const isFocus = focusedEntry === team.entry;
      return {
        key: `team:${team.entry}`,
        label: team.name,
        data: values(team),
        borderColor: color,
        backgroundColor: color,
        borderWidth: isFocus ? 3.5 : 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: p.surface,
        tension: 0.25,
        spanGaps: false,
        order: 1,
        hidden: hidden.has(`team:${team.entry}`),
        // Focusing one team pushes the rest back without removing them.
        _dim: dimmed && !isFocus,
      };
    });

    const baselines = baselineSpecs(p)
      .filter((spec) => data.series?.[spec.key])
      .map((spec) => ({
        key: spec.key,
        label: spec.label,
        data: values(data.series[spec.key]),
        borderColor: spec.color,
        backgroundColor: spec.color,
        borderWidth: spec.width,
        borderDash: spec.dash,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: p.surface,
        tension: 0.25,
        spanGaps: false,
        order: 2, // drawn last, so the baselines stay readable over the team lines
        hidden: hidden.has(spec.key),
        _dim: false,
      }));

    // Dimming is applied to the resolved color rather than via global alpha so
    // the focused line keeps full contrast.
    for (const ds of teams) {
      if (ds._dim) {
        ds.borderColor = p.grid;
        ds.borderWidth = 1.5;
      }
    }

    return [...teams, ...baselines];
  }

  /* ---------- crosshair ---------- */

  // A vertical hairline so the reader aims at a gameweek, not at a 2px line.
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(c) {
      const active = c.tooltip?.getActiveElements?.() ?? [];
      if (!active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = c.chartArea;
      const ctx = c.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.$viz.baseline;
      ctx.stroke();
      ctx.restore();
    },
  };

  /* ---------- chart ---------- */

  /* Every baseline always shows; teams are capped at the highest scorers that
     gameweek (plus the focused team) so the readout can't outgrow the screen. */
  function tooltipFilter(item) {
    const key = item.dataset.key ?? '';
    if (!key.startsWith('team:')) return true;
    if (focusedEntry !== null) return key === `team:${focusedEntry}`;

    const i = item.dataIndex;
    const scores = chart.data.datasets
      .filter((ds) => ds.key.startsWith('team:') && !ds.hidden && isNum(ds.data[i]))
      .map((ds) => ds.data[i])
      .sort((a, b) => b - a);
    if (scores.length <= TOOLTIP_TEAMS) return true;
    return item.parsed.y >= scores[TOOLTIP_TEAMS - 1];
  }

  function chartOptions(p) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      layout: { padding: { top: 4, right: 4 } },
      scales: {
        x: {
          title: { display: false },
          grid: { display: false },
          border: { color: p.baseline },
          ticks: {
            color: p.muted,
            font: { size: 11 },
            maxRotation: 0,
            autoSkipPadding: 12,
          },
        },
        y: {
          beginAtZero: mode === 'gw',
          grid: { color: p.grid, drawTicks: false },
          border: { display: false, dash: [] },
          ticks: {
            color: p.muted,
            font: { size: 11 },
            padding: 8,
            maxTicksLimit: 6,
          },
        },
      },
      plugins: {
        legend: { display: false }, // replaced by the HTML legend, which survives on a phone
        tooltip: {
          backgroundColor: p.surface,
          titleColor: p.muted,
          bodyColor: p.primary,
          borderColor: p.baseline,
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          usePointStyle: true,
          titleFont: { size: 11, weight: '600' },
          bodyFont: { size: 12 },
          // Sorted high to low, so the readout doubles as a snapshot ranking.
          itemSort: (a, b) => (b.parsed.y ?? -Infinity) - (a.parsed.y ?? -Infinity),
          filter: tooltipFilter,
          callbacks: {
            title: (items) => `Gameweek ${items[0].label}`,
            // Value leads, name follows: the reader already knows the series.
            label: (ctx) => `${fmt(ctx.parsed.y)}   ${ctx.dataset.label}`,
          },
        },
      },
    };
  }

  function render() {
    const p = palette();
    const labels = data.gameweeks.map(String);
    const datasets = buildDatasets(p);

    if (chart) chart.destroy();
    const ctx = el('chart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: chartOptions(p),
      plugins: [crosshair],
    });
    chart.$viz = p;

    renderLegend();
    renderNote();
  }

  /* ---------- legend ---------- */

  function renderLegend() {
    const box = el('legend');
    box.replaceChildren();

    // In a big league the full chip list buries the page, so the neutral teams
    // past the palette collapse behind a toggle.
    const teamCount = chart.data.datasets.filter((d) => d.key.startsWith('team:')).length;
    const collapsible = teamCount > LEGEND_COLLAPSE_AT;
    let shown = 0;

    for (const ds of chart.data.datasets) {
      const isTeam = ds.key.startsWith('team:');
      if (collapsible && !legendExpanded && isTeam) {
        shown += 1;
        // A hidden team keeps its chip even when collapsed, or there would be no
        // way to switch its line back on.
        if (shown > TEAM_SLOTS && !hidden.has(ds.key)) continue;
      }
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      if (hidden.has(ds.key)) chip.classList.add('is-off');
      chip.setAttribute('aria-pressed', String(!hidden.has(ds.key)));

      const key = document.createElement('i');
      key.className = 'chip-key';
      if (ds.borderDash?.length === 2) key.classList.add('dotted');
      else if (ds.borderDash?.length) key.classList.add('dashed');
      // Keyed with the line's own color, except where focus has greyed it out.
      key.style.borderTopColor = ds.borderColor;
      chip.appendChild(key);

      const name = document.createElement('span');
      name.textContent = ds.label; // names come from the API — never innerHTML
      chip.appendChild(name);

      chip.addEventListener('click', () => {
        if (hidden.has(ds.key)) hidden.delete(ds.key);
        else hidden.add(ds.key);
        render();
      });

      box.appendChild(chip);
    }

    if (collapsible) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chip chip-more';
      more.textContent = legendExpanded
        ? 'Show fewer'
        : `Show all ${teamCount} teams`;
      more.addEventListener('click', () => {
        legendExpanded = !legendExpanded;
        renderLegend();
      });
      box.appendChild(more);
    }
  }

  function renderNote() {
    const detail = data.indexDetail ?? {};
    const pool = detail.pool === 'all' ? 'every player in the game' : 'every player who featured';
    el('chart-note').textContent =
      mode === 'cumulative'
        ? 'Running season total after each gameweek.'
        : 'Points scored in each individual gameweek.';
    el('index-def').textContent =
      `A synthetic baseline: the mean score of ${pool} that gameweek, times ` +
      `${detail.multiplier ?? 11} — roughly what a team of ${detail.multiplier ?? 11} completely ` +
      'average performers would have scored.';
  }

  /* ---------- table ---------- */

  function renderTable() {
    const p = palette();
    const body = el('standings-body');
    body.replaceChildren();

    const indexTotal = lastValue(data.series?.index?.cumulative ?? []);

    data.teams.forEach((team, i) => {
      const row = document.createElement('tr');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (focusedEntry === team.entry) row.classList.add('is-focused');

      const rank = document.createElement('td');
      rank.className = 'num';
      rank.textContent = team.rank ?? i + 1;

      const teamCell = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'team-cell';
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = teamColor(i, p);
      const names = document.createElement('div');
      const nameEl = document.createElement('span');
      nameEl.className = 'team-name';
      nameEl.textContent = team.name;
      const managerEl = document.createElement('span');
      managerEl.className = 'manager';
      managerEl.textContent = team.manager ?? '';
      names.append(nameEl, managerEl);
      wrap.append(swatch, names);
      teamCell.appendChild(wrap);

      const total = document.createElement('td');
      total.className = 'num';
      const cumulative = lastValue(team.cumulative);
      total.textContent = fmt(team.total ?? cumulative);

      const last = document.createElement('td');
      last.className = 'num';
      last.textContent = fmt(lastValue(team.gw));

      const vs = document.createElement('td');
      vs.className = 'num';
      if (isNum(cumulative) && isNum(indexTotal)) {
        const diff = cumulative - indexTotal;
        vs.textContent = `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`;
        vs.classList.add(diff >= 0 ? 'pos' : 'neg');
      } else {
        vs.textContent = '–';
      }

      row.append(rank, teamCell, total, last, vs);

      const toggle = () => {
        focusedEntry = focusedEntry === team.entry ? null : team.entry;
        el('clear-focus').hidden = focusedEntry === null;
        render();
        renderTable();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });

      body.appendChild(row);
    });
  }

  /* ---------- header ---------- */

  function renderHead() {
    document.title = data.league?.name ? `${data.league.name} — FPL League View` : 'FPL League View';
    el('league-name').textContent = data.league?.name || 'FPL League View';

    el('season').textContent = data.season ? `${data.season} season` : '';
    const gws = data.gameweeks ?? [];
    el('gw-range').textContent = gws.length
      ? gws.length === 1
        ? `GW ${gws[0]}`
        : `GW ${gws[0]}–${gws.at(-1)}`
      : '';

    el('updated').textContent = data.generatedAt ? `Updated ${relativeTime(data.generatedAt)}` : '';
    el('sample-notice').hidden = data.sample !== true;
  }

  /* ---------- wiring ---------- */

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    const cumulative = next === 'cumulative';
    el('mode-cumulative').classList.toggle('is-active', cumulative);
    el('mode-weekly').classList.toggle('is-active', !cumulative);
    el('mode-cumulative').setAttribute('aria-pressed', String(cumulative));
    el('mode-weekly').setAttribute('aria-pressed', String(!cumulative));
    render();
  }

  function fail(message) {
    const box = el('load-error');
    box.textContent = message;
    box.hidden = false;
  }

  async function main() {
    el('mode-cumulative').addEventListener('click', () => setMode('cumulative'));
    el('mode-weekly').addEventListener('click', () => setMode('gw'));
    el('clear-focus').addEventListener('click', () => {
      focusedEntry = null;
      el('clear-focus').hidden = true;
      render();
      renderTable();
    });

    let payload;
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (err) {
      fail(`Could not load ${DATA_URL} — ${err.message}`);
      return;
    }

    if (!Array.isArray(payload.teams) || !Array.isArray(payload.gameweeks) || !payload.gameweeks.length) {
      fail('The data file has no completed gameweeks yet. Check back after the first deadline.');
      return;
    }

    data = payload;
    renderHead();
    render();
    renderTable();

    // Re-resolve the palette when the OS theme flips under us.
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      render();
      renderTable();
    });
  }

  main();
})();
