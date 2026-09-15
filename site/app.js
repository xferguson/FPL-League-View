/* Renders the league chart and standings from site/data/league.json.
   Everything is read from that one file — there is no API call at page load. */

(() => {
  'use strict';

  const DATA_URL = 'data/league.json';
  const TEAM_HUES = 9; // validated categorical hues; see the note in styles.css
  // Second identity channel. Nine hues is the most that clears the colourblind
  // and contrast gates, so beyond nine a team reuses a hue with a new line
  // style: every team ends up a unique colour+style pair, 27 in all.
  const TEAM_STYLES = [
    { name: 'solid', dash: [] },
    { name: 'dashed', dash: [7, 4] },
    { name: 'dotted', dash: [1, 4] },
  ];
  const TOOLTIP_TEAMS = 8; // keep the readout shorter than the screen in a big league

  // Versioned so a future change to what's stored can't collide with an old shape
  // left behind in a visitor's browser.
  const PREFS_KEY = 'fplview:v1:prefs'; // chart type + which teams are shown/focused
  const CACHE_KEY = 'fplview:v1:data'; // most recent successful data/league.json fetch

  const el = (id) => document.getElementById(id);

  /* localStorage can throw (private browsing, quota, disabled storage) and can
     hold garbage from a future/foreign version of this page, so every read and
     write is wrapped and every read is treated as untrusted until validated. */
  function storageGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Best-effort only — the page works the same without it, just un-persisted.
    }
  }

  let data = null;
  let chart = null;
  let measure = 'points'; // 'points' | 'league' | 'fpl' — what the y-axis counts
  let basis = 'cumulative'; // 'cumulative' | 'gw' — running total or single week
  let focusedEntry = null; // entry id of the team singled out, or null
  const hidden = new Set(); // dataset keys switched off via the legend

  /** Read a CSS custom property off .viz-root so JS and CSS share one palette. */
  const token = (name) =>
    getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim();

  function palette() {
    return {
      series: Array.from({ length: TEAM_HUES }, (_, i) => token(`--series-${i + 1}`)),
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
  const fmtValue = (v) => (isNum(v) ? (isPercent() ? `${v.toFixed(1)}%` : fmt(v)) : '–');

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

  /* The baselines are reference lines, not competitors, so they stay
     neutral — no team is ever neutral, which is what separates the two groups.
     They are drawn heavier than the team lines because against twenty-odd
     coloured series a thin grey line simply disappears. */
  function baselineSpecs(p) {
    return [
      { key: 'leagueAverage', label: 'League average', color: p.primary, dash: [8, 4], width: 2.75, style: 'dashed' },
      { key: 'fplAverage', label: 'FPL average', color: p.secondary, dash: [1, 4], width: 2.75, style: 'dotted' },
    ];
  }

  /* Hue cycles fastest so the top of the table is nine clearly different
     colours; the line style only changes once the hues are used up. */
  function teamStyle(index, p) {
    const style = TEAM_STYLES[Math.floor(index / TEAM_HUES) % TEAM_STYLES.length];
    return { color: p.series[index % TEAM_HUES], dash: style.dash, styleName: style.name };
  }

  const isPercent = () => measure !== 'points';

  /** The series everything is measured against, or null in plain points mode. */
  function denominatorSeries() {
    if (measure === 'league') return data.series?.leagueAverage;
    if (measure === 'fpl') return data.series?.fplAverage;
    return null;
  }

  const rawValues = (source) => (basis === 'cumulative' ? source.cumulative : source.gw) ?? [];

  /* In points mode this is the score itself; otherwise it is that score over the
     chosen baseline, as a percentage. The baseline's own line therefore sits flat
     at 100, which is exactly the reference the reader wants to see. */
  function values(source) {
    const raw = rawValues(source);
    const denom = denominatorSeries();
    if (!denom) return raw;
    const scale = rawValues(denom);
    return raw.map((v, i) => {
      const d = scale[i];
      if (v === null || v === undefined || d === null || d === undefined || d === 0) return null;
      return Math.round((v / d) * 1000) / 10;
    });
  }

  function buildDatasets(p) {
    const dimmed = focusedEntry !== null;

    const teams = data.teams.map((team, i) => {
      const { color, dash, styleName } = teamStyle(i, p);
      const isFocus = focusedEntry === team.entry;
      return {
        key: `team:${team.entry}`,
        label: team.name,
        data: values(team),
        borderColor: color,
        backgroundColor: color,
        borderDash: dash,
        styleName,
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
        styleName: spec.style,
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

    // Baselines lead the array so they head the legend, where they are easiest
    // to find; a higher `order` still draws them over the team lines.
    return [...baselines, ...teams];
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

  /* Chart.js rounds an axis minimum down to a round number, which on a
     percentage view drags the floor to 0 and squashes every line into the top
     third. Bound it to the data instead, always keeping 100% in view since that
     is the line everything is read against. */
  function percentBounds(datasets) {
    const vals = datasets.filter((d) => !d.hidden).flatMap((d) => d.data).filter(isNum);
    if (!vals.length) return {};
    const lo = Math.min(...vals, 100);
    const hi = Math.max(...vals, 100);
    const pad = Math.max((hi - lo) * 0.08, 2);
    return { min: Math.floor((lo - pad) / 10) * 10, max: Math.ceil((hi + pad) / 10) * 10 };
  }

  function chartOptions(p, bounds = {}) {
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
          beginAtZero: measure === 'points' && basis === 'gw',
          ...bounds,
          grid: { color: p.grid, drawTicks: false },
          border: { display: false, dash: [] },
          ticks: {
            color: p.muted,
            font: { size: 11 },
            padding: 8,
            maxTicksLimit: 6,
            callback: (v) => (isPercent() ? `${v}%` : v),
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
            label: (ctx) => `${fmtValue(ctx.parsed.y)}   ${ctx.dataset.label}`,
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
      options: chartOptions(p, isPercent() ? percentBounds(datasets) : {}),
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

    for (const ds of chart.data.datasets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      if (hidden.has(ds.key)) chip.classList.add('is-off');
      chip.setAttribute('aria-pressed', String(!hidden.has(ds.key)));

      // The chip repeats both identity channels: the line's colour and its style.
      const key = document.createElement('i');
      key.className = `chip-key ${ds.styleName ?? 'solid'}`;
      key.style.borderTopColor = ds.borderColor;
      chip.appendChild(key);

      const name = document.createElement('span');
      name.textContent = ds.label; // names come from the API — never innerHTML
      chip.appendChild(name);

      chip.addEventListener('click', () => {
        if (hidden.has(ds.key)) hidden.delete(ds.key);
        else hidden.add(ds.key);
        savePrefs();
        render();
      });

      box.appendChild(chip);
    }

  }

  const MEASURE_LABEL = { points: 'points', league: 'the league average', fpl: 'the FPL average' };

  const MEASURE_HEADING = {
    points: 'Points by gameweek',
    league: '% of league average',
    fpl: '% of FPL average',
  };

  function renderNote() {
    const cumulative = basis === 'cumulative';
    el('chart-heading').textContent = MEASURE_HEADING[measure];
    const note = measure === 'points'
      ? (cumulative
          ? 'Running season total after each gameweek.'
          : 'Points scored in each individual gameweek.')
      : (cumulative
          ? `Season total so far as a percentage of ${MEASURE_LABEL[measure]} over the same weeks. 100% is level with it.`
          : `Each gameweek's score as a percentage of ${MEASURE_LABEL[measure]} that week. 100% is level with it.`);
    el('chart-note').textContent = note;
  }

  /* ---------- table ---------- */

  function renderTable() {
    const p = palette();
    const body = el('standings-body');
    body.replaceChildren();

    const leagueTotal = lastValue(data.series?.leagueAverage?.cumulative ?? []);

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
      const { color, styleName } = teamStyle(i, p);
      const swatch = document.createElement('i');
      // Same line sample as the legend, so the two views key identically.
      swatch.className = `chip-key ${styleName}`;
      swatch.style.borderTopColor = color;
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
      if (isNum(cumulative) && isNum(leagueTotal)) {
        const diff = cumulative - leagueTotal;
        vs.textContent = `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}`;
        vs.classList.add(diff >= 0 ? 'pos' : 'neg');
      } else {
        vs.textContent = '–';
      }

      row.append(rank, teamCell, total, last, vs);

      const toggle = () => {
        focusedEntry = focusedEntry === team.entry ? null : team.entry;
        el('clear-focus').hidden = focusedEntry === null;
        savePrefs();
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

  /* Both readings of "when": how stale it is at a glance, and the exact local
     timestamp, since "2 days ago" is no help when you want to know if today's
     gameweek is in yet. */
  function renderUpdated() {
    const box = el('updated');
    box.replaceChildren();
    if (!data.generatedAt) return;

    const when = new Date(data.generatedAt);
    if (Number.isNaN(when.getTime())) return;

    box.appendChild(document.createTextNode('Last updated '));

    const rel = document.createElement('time');
    rel.dateTime = data.generatedAt;
    rel.className = 'updated-rel';
    rel.textContent = relativeTime(data.generatedAt);
    rel.title = when.toString();
    box.appendChild(rel);

    const abs = document.createElement('span');
    abs.className = 'updated-abs';
    abs.textContent = when.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    box.appendChild(abs);

    // Say what the data actually covers, not just when it was pulled.
    const gws = data.gameweeks ?? [];
    if (gws.length) {
      const through = document.createElement('span');
      through.className = 'updated-abs';
      through.textContent = `complete through GW ${gws.at(-1)}`;
      box.appendChild(through);
    }
  }

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

    renderUpdated();
    el('sample-notice').hidden = data.sample !== true;
  }

  /* ---------- persisted preferences ---------- */

  const MEASURES = ['points', 'league', 'fpl'];
  const BASES = ['cumulative', 'gw'];

  /** Restore chart type, which teams are shown, and which is focused. */
  function loadPrefs() {
    const saved = storageGet(PREFS_KEY);
    if (!saved || typeof saved !== 'object') return;
    if (MEASURES.includes(saved.measure)) measure = saved.measure;
    if (BASES.includes(saved.basis)) basis = saved.basis;
    if (Array.isArray(saved.hidden)) {
      for (const key of saved.hidden) if (typeof key === 'string') hidden.add(key);
    }
    if (typeof saved.focus === 'number') focusedEntry = saved.focus;
  }

  function savePrefs() {
    storageSet(PREFS_KEY, { measure, basis, hidden: [...hidden], focus: focusedEntry });
  }

  /** Make the two segmented controls match the (possibly restored) state. */
  function syncSegmentedControls() {
    for (const [attr, value] of [['measure', measure], ['basis', basis]]) {
      for (const button of document.querySelectorAll(`[data-${attr}]`)) {
        const on = button.dataset[attr] === value;
        button.classList.toggle('is-active', on);
        button.setAttribute('aria-pressed', String(on));
      }
    }
  }

  /* ---------- wiring ---------- */

  /* Both controls work the same way: mark the pressed button, store the choice,
     redraw. Three measures x two bases gives the six views. */
  function wireSegmented(attr, apply) {
    const buttons = [...document.querySelectorAll(`[data-${attr}]`)];
    for (const button of buttons) {
      button.addEventListener('click', () => {
        const next = button.dataset[attr];
        if (!apply(next)) return;
        for (const other of buttons) {
          const on = other === button;
          other.classList.toggle('is-active', on);
          other.setAttribute('aria-pressed', String(on));
        }
        savePrefs();
        render();
      });
    }
  }

  function fail(message) {
    const box = el('load-error');
    box.textContent = message;
    box.hidden = false;
  }

  function isValidPayload(payload) {
    return (
      payload &&
      Array.isArray(payload.teams) &&
      Array.isArray(payload.gameweeks) &&
      payload.gameweeks.length > 0
    );
  }

  /* ---------- data loading + offline fallback ---------- */

  /* Network first, always. A successful fetch is cached to localStorage so that
     when the network next fails — offline, a dead link, GitHub Pages hiccup —
     there is a most-recent-known-good copy of the stats to fall back to instead
     of an empty page. The cache is separate from the service worker's own cache:
     the service worker makes the app shell itself load offline, while this is
     what lets app.js tell the difference between fresh and stale data and say so. */
  async function loadLeagueData() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (!isValidPayload(payload)) {
        return { payload: null, error: 'The data file has no completed gameweeks yet. Check back after the first deadline.' };
      }
      const fetchedAt = Date.now();
      storageSet(CACHE_KEY, { payload, fetchedAt });
      return { payload, stale: false, fetchedAt };
    } catch (err) {
      const cached = storageGet(CACHE_KEY);
      if (cached && isValidPayload(cached.payload)) {
        return { payload: cached.payload, stale: true, fetchedAt: cached.fetchedAt };
      }
      return { payload: null, error: `Could not load ${DATA_URL} — ${err.message}` };
    }
  }

  /** Show or hide the "you're looking at stale data" banner. */
  function setOfflineNotice(stale, fetchedAt) {
    const box = el('offline-notice');
    if (!stale) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const when = fetchedAt ? relativeTime(new Date(fetchedAt).toISOString()) : 'a previous visit';
    // The network call can fail for reasons other than being offline (a bad
    // deploy, GitHub Pages itself down), so only claim "offline" when the
    // browser actually reports that.
    box.textContent = navigator.onLine
      ? `Could not reach the server — showing data from ${when}.`
      : `You're offline — showing data from ${when}.`;
  }

  /** Drop a focus that no longer refers to a team in the current data. */
  function pruneFocus() {
    if (focusedEntry !== null && !data.teams.some((t) => t.entry === focusedEntry)) {
      focusedEntry = null;
      el('clear-focus').hidden = true;
      savePrefs();
    }
  }

  /* Fired on 'online'/'offline' and covers two cases: connectivity drops while
     data already loaded fine (just show the banner, nothing to refetch yet),
     and connectivity returns while showing a stale cache (quietly try to
     refresh, and only bother the reader if that actually produces new data). */
  async function handleConnectivityChange() {
    if (!navigator.onLine) {
      const cached = storageGet(CACHE_KEY);
      setOfflineNotice(true, cached?.fetchedAt ?? null);
      return;
    }
    const result = await loadLeagueData();
    if (result.payload && !result.stale) {
      data = result.payload;
      pruneFocus();
      renderHead();
      render();
      renderTable();
    }
    setOfflineNotice(Boolean(result.stale), result.fetchedAt);
  }

  /* ---------- install prompt ---------- */

  const INSTALL_DISMISS_KEY = 'fplview:v1:installDismissedAt';
  const INSTALL_DISMISS_DAYS = 30; // re-offer after a while rather than never again

  let deferredInstallPrompt = null; // the captured beforeinstallprompt event

  function isStandaloneDisplay() {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS Safari's own older, non-standard signal — still the only one it exposes.
      window.navigator.standalone === true
    );
  }

  function isIOSDevice() {
    // iPadOS 13+ identifies as "MacIntel" with touch support, indistinguishable
    // from a real Mac by user agent string alone.
    return (
      /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function installDismissedRecently() {
    const at = Number(storageGet(INSTALL_DISMISS_KEY));
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
  }

  function hideInstallBanner() {
    el('install-banner').hidden = true;
  }

  function dismissInstallBanner() {
    storageSet(INSTALL_DISMISS_KEY, Date.now());
    hideInstallBanner();
  }

  /* A small inline share-square-with-arrow glyph, close enough to iOS's own
     Share icon to be recognisable without shipping an image asset. */
  function shareIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('share-icon');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute(
      'd',
      'M12 2.5v11.75M8 6.5 12 2.5 16 6.5M5.5 10h-1A1.5 1.5 0 0 0 3 11.5v8A1.5 1.5 0 0 0 4.5 21h15a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 19.5 10h-1'
    );
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  /* iOS never fires beforeinstallprompt and has no programmatic install call
     at all — "Share, then Add to Home Screen" is the only path there ever is. */
  function renderIOSInstallCopy() {
    const text = el('install-copy-text');
    text.replaceChildren();
    text.appendChild(document.createTextNode('Tap'));
    text.appendChild(shareIcon());
    text.appendChild(document.createTextNode(', then "Add to Home Screen".'));
  }

  /* Nothing here assumes installability — it only ever reacts to the browser's
     own signals, so the banner simply never appears on a browser that can't
     install (Firefox desktop, for instance), rather than offering a button
     that would do nothing. */
  function setupInstallPrompt() {
    if (isStandaloneDisplay()) return; // already installed — nothing to offer
    if (installDismissedRecently()) return;

    el('install-dismiss').addEventListener('click', dismissInstallBanner);

    if (isIOSDevice()) {
      renderIOSInstallCopy();
      el('install-banner').hidden = false;
      return; // no button: there is nothing to invoke programmatically
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); // suppress the browser's own mini-infobar; we show ours
      deferredInstallPrompt = event;
      el('install-btn').hidden = false;
      el('install-banner').hidden = false;
    });

    el('install-btn').addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      hideInstallBanner();
    });

    // Covers installing via the browser's own UI (omnibox icon) rather than
    // our button, so the banner doesn't linger after the app is already added.
    window.addEventListener('appinstalled', hideInstallBanner);
  }

  /* ---------- service worker ---------- */

  // Makes the app shell (this HTML/CSS/JS, not the data) load with no network
  // at all, so the page opens instantly from a homescreen icon. Registration
  // failure (unsupported browser, http instead of https) is not fatal — the
  // page works the same, just without the offline app shell.
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  async function main() {
    loadPrefs();
    syncSegmentedControls();

    wireSegmented('measure', (next) => (next === measure ? false : ((measure = next), true)));
    wireSegmented('basis', (next) => (next === basis ? false : ((basis = next), true)));
    el('clear-focus').addEventListener('click', () => {
      focusedEntry = null;
      el('clear-focus').hidden = true;
      savePrefs();
      render();
      renderTable();
    });

    registerServiceWorker();
    setupInstallPrompt();

    const result = await loadLeagueData();
    if (!result.payload) {
      fail(result.error);
      return;
    }

    data = result.payload;
    pruneFocus();
    el('clear-focus').hidden = focusedEntry === null;

    renderHead();
    render();
    renderTable();
    setOfflineNotice(Boolean(result.stale), result.fetchedAt);

    // Re-resolve the palette when the OS theme flips under us.
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      render();
      renderTable();
    });

    window.addEventListener('online', handleConnectivityChange);
    window.addEventListener('offline', handleConnectivityChange);
  }

  main();
})();
