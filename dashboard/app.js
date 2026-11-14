// Token Radar's dashboard, restated. It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, a filterable table, a per-protocol detail view with
// the comps model's own inputs and the protocol's farm plan, and the live-token view set
// apart. No network: every byte it shows is in data.js. Deep links: #detail=<slug> opens a
// protocol, #category=, #chain=, #tvl=, #watchlist=1 and #q= restore a filtered view.
(() => {
  "use strict";

  var RADAR = window.RADAR;
  if (!RADAR) return;
  var mount = document.getElementById('board');
  var view = { q: '', category: 'all', chain: 'all', tvl: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function isMissing(n) { return n === null || n === undefined || !isFinite(n); }
  function money(n) {
    if (isMissing(n)) return 'n/a';
    var size = Math.abs(n);
    return size >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
      : size >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
      : size >= 1e3 ? '$' + Math.round(n / 1e3) + 'K'
      : usdFmt.format(n);
  }
  function pctText(n) {
    if (isMissing(n)) return 'n/a';
    var sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days < 365) return Math.max(0, Math.round(days)) + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function multText(n) { return 'x' + n.toFixed(3); }

  function h(tag, attrs) {
    var nodeEl = document.createElement(tag);
    if (attrs != null) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'class') nodeEl.className = attrs[key];
        else if (key === 'text') nodeEl.textContent = attrs[key];
        else if (key === 'html') nodeEl.innerHTML = attrs[key];
        else if (key.slice(0, 2) === 'on') nodeEl.addEventListener(key.slice(2), attrs[key]);
        else if (attrs[key] !== null && attrs[key] !== undefined) nodeEl.setAttribute(key, attrs[key]);
      });
    }
    for (var idx = 2; idx < arguments.length; idx++) {
      var kid = arguments[idx];
      if (kid === null || kid === undefined) continue;
      if (Array.isArray(kid)) kid.forEach(function (item) { if (item) nodeEl.appendChild(item); });
      else if (typeof kid === 'string') nodeEl.appendChild(document.createTextNode(kid));
      else nodeEl.appendChild(kid);
    }
    return nodeEl;
  }

  // The model, recomputed in the page: a row is re-scored from the snapshot figures and
  // checked against the number board.json carries, so the page's arithmetic and the board's
  // data are visibly the same calculation.
  function recompute(row, model, comps) {
    var mult = row.category_multiple;
    var chg = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var chgMult = 1 + (chg / 100) * model.growth_weight;
    var ageVal = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var matMult = model.maturity_floor + (Math.min(Math.max(ageVal, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * mult * chgMult * matMult));
  }

  function bandOf(v) {
    if (v >= 1e9) return '1B+';
    if (v >= 1e8) return '100M-1B';
    if (v >= 5e7) return '50M-100M';
    if (v >= 1e7) return '10M-50M';
    return 'under 10M';
  }
  function inBand(v, band) {
    if (band === 'all') return true;
    if (band === '1B+') return v >= 1e9;
    if (band === '100M-1B') return v >= 1e8 && v < 1e9;
    if (band === '50M-100M') return v >= 5e7 && v < 1e8;
    if (band === '10M-50M') return v >= 1e7 && v < 5e7;
    return v < 1e7;
  }

  function loadHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var query = new URLSearchParams(raw);
    if (query.get('q')) view.q = query.get('q');
    if (query.get('detail')) view.selected = query.get('detail');
    if (query.get('p')) view.selected = query.get('p');
    if (query.get('category')) view.category = query.get('category');
    if (query.get('chain')) view.chain = query.get('chain');
    if (query.get('tvl')) view.tvl = query.get('tvl');
    if (query.get('watchlist') === '1') view.watchlistOnly = true;
    if (query.get('tab') === 'live') view.tab = 'live';
  }
  function saveHash() {
    var query = new URLSearchParams();
    if (view.q) query.set('q', view.q);
    if (view.category !== 'all') query.set('category', view.category);
    if (view.chain !== 'all') query.set('chain', view.chain);
    if (view.tvl !== 'all') query.set('tvl', view.tvl);
    if (view.watchlistOnly) query.set('watchlist', '1');
    if (view.tab === 'live') query.set('tab', 'live');
    if (view.selected) query.set('detail', view.selected);
    var joined = query.toString();
    var target = joined ? '#' + joined : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', target);
  }

  function visible() {
    var needle = view.q.trim().toLowerCase();
    return RADAR.rows.filter(function (it) {
      if (view.category !== 'all' && (it.category || 'Other') !== view.category) return false;
      if (view.chain !== 'all' && !(it.chains || []).includes(view.chain)) return false;
      if (!inBand(it.tvl_usd, view.tvl)) return false;
      if (view.watchlistOnly && !it.watchlist) return false;
      if (!needle) return true;
      var haystack = [it.name, it.slug, it.category, (it.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }
  function sortVisible(list) {
    var key = view.sort;
    return list.slice().sort(function (x, y) {
      var lo, hi;
      if (key === 'name') { lo = x.name.toLowerCase(); hi = y.name.toLowerCase(); }
      else if (key === 'tvl') { lo = x.tvl_usd; hi = y.tvl_usd; }
      else if (key === 'growth') { lo = x.change_7d === null ? -Infinity : x.change_7d; hi = y.change_7d === null ? -Infinity : y.change_7d; }
      else if (key === 'category') { lo = (x.category || 'Other').toLowerCase(); hi = (y.category || 'Other').toLowerCase(); }
      else if (key === 'age') { lo = x.age_days === null ? Infinity : x.age_days; hi = y.age_days === null ? Infinity : y.age_days; }
      else { lo = x.implied_value_usd; hi = y.implied_value_usd; }
      if (lo < hi) return -view.dir;
      if (lo > hi) return view.dir;
      return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
    });
  }

  function topBar() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('span', { class: 'brand-name', text: 'Token Radar' })),
      h('div', { class: 'top-meta' },
        h('span', { text: 'Snapshot ' + RADAR.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: RADAR.model_version + ' model' })
      )
    );
  }

  function intro() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: RADAR.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(RADAR.floor_usd / 1e6) + 'M of TVL and no token on record. The radar ranks all ' + RADAR.board_size + ' rankable pre-token protocols, watchlist plus ' + RADAR.early_size + ' early ones below the floor. Implied value is a comps model, not a promise.' })
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: RADAR.watchlist_size + ' / ' + RADAR.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows ranked' }), h('b', { text: String(RADAR.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(RADAR.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(RADAR.live_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Global comps multiple' }), h('b', { text: multText(RADAR.comps.global_multiple) + ' (' + RADAR.comps.global_peers + ' peers)' }))
      )
    );
  }

  function dropdown(id, label, choices, value, onPick) {
    var picker = h('select', { id: id, 'aria-label': label },
      choices.map(function (choice) { return h('option', { value: choice[0], text: choice[1], selected: choice[0] === value ? 'selected' : null }); })
    );
    picker.addEventListener('change', function () { onPick(picker.value); saveHash(); draw(); });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), picker);
  }

  function filterBar() {
    var cats = Array.from(new Set(RADAR.rows.map(function (it) { return it.category || 'Other'; }))).sort();
    var nets = Array.from(new Set(RADAR.rows.flatMap(function (it) { return it.chains || []; }))).sort();
    var finder = h('input', { type: 'search', id: 'q', placeholder: 'Search the board', value: view.q, 'aria-label': 'Search the board', autocomplete: 'off', spellcheck: 'false' });
    finder.addEventListener('input', function () { view.q = finder.value; saveHash(); draw(); });
    var wlBox = h('input', { type: 'checkbox', id: 'wl', checked: view.watchlistOnly ? 'checked' : null });
    wlBox.addEventListener('change', function () { view.watchlistOnly = wlBox.checked; saveHash(); draw(); });
    var preBtn = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; draw(); } });
    var liveBtn = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; draw(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), finder),
      dropdown('category', 'Category', [['all', 'All categories']].concat(cats.map(function (c) { return [c, c]; })), view.category, function (v) { view.category = v; }),
      dropdown('chain', 'Chain', [['all', 'All chains']].concat(nets.map(function (c) { return [c, c]; })), view.chain, function (v) { view.chain = v; }),
      dropdown('tvl', 'TVL range', [['all', 'Any TVL'], ['1B+', '$1B+'], ['100M-1B', '$100M-$1B'], ['50M-100M', '$50M-$100M'], ['10M-50M', '$10M-$50M'], ['under10M', 'under $10M']], view.tvl, function (v) { view.tvl = v; }),
      h('div', { class: 'field' }, h('span', { class: 'lab', text: 'Watchlist' }), h('label', { class: 'check', for: 'wl' }, wlBox, 'Watchlist only')),
      h('div', { class: 'field' }, h('span', { class: 'lab', text: 'Token status' }), h('div', { class: 'tabs' }, preBtn, liveBtn)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visible().length + ' of ' + RADAR.board_size + ' rows shown' : RADAR.live.length + ' live-token protocols' })
    );
  }

  function sortCell(col, caption) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === col) view.dir = -view.dir; else { view.sort = col; view.dir = -1; } draw(); } },
        caption,
        view.sort === col ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function statusBadge(it) {
    return it.watchlist
      ? h('span', { class: 'badge watch', text: 'Watchlist' })
      : h('span', { class: 'badge early', text: 'Early' });
  }

  function boardView() {
    var shown = sortVisible(visible());
    if (shown.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.tvl = 'all'; view.watchlistOnly = false; saveHash(); draw(); } })
      ));
    }
    var top = RADAR.rows[0].implied_value_usd || 1;
    var body = h('tbody');
    shown.forEach(function (it) {
      var chg = it.change_7d === null ? 'n/a' : pctText(it.change_7d);
      var chgCls = it.change_7d === null ? '' : it.change_7d >= 0 ? 'pos' : 'neg';
      var rowEl = h('tr', {
        'data-selected': view.selected === it.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { showDetail(it.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(it.slug); } }
      },
        h('td', { class: 'num', text: String(it.rank) }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: it.name }),
          h('span', { class: 'sub', text: (it.category || 'Other') + ' on ' + (it.chains && it.chains.length ? it.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: money(it.tvl_usd) }),
        h('td', { class: 'num ' + chgCls, text: chg }),
        h('td', { class: 'num', text: ageText(it.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((it.implied_value_usd / top) * 100)) + '%' })),
          h('span', { class: 'num', text: money(it.implied_value_usd) })
        )),
        h('td', null, statusBadge(it))
      );
      body.appendChild(rowEl);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, comps and farm plan.' }),
          h('thead', null, h('tr', null,
            sortCell('implied', 'Rank'),
            sortCell('name', 'Protocol'),
            sortCell('tvl', 'TVL'),
            sortCell('growth', '7d'),
            sortCell('age', 'Age'),
            sortCell('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Board' })
          )),
          body
        )
      )
    );
  }

  function liveView() {
    var body = h('tbody');
    RADAR.live.forEach(function (it) {
      body.appendChild(h('tr', null,
        h('td', null, h('span', { class: 'badge live', text: 'Live' })),
        h('td', null, h('div', { class: 'name' }, h('b', { text: it.name }), h('span', { class: 'sub', text: (it.category || 'Other') + ' on ' + (it.chains && it.chains.length ? it.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: money(it.tvl_usd) }),
        h('td', { class: 'num ' + (it.change_7d !== null && it.change_7d >= 0 ? 'pos' : 'neg'), text: pctText(it.change_7d) }),
        h('td', { class: 'num', text: money(it.mcap_usd) }),
        h('td', { class: 'num', text: it.mcap_usd && it.tvl_usd ? multText(it.mcap_usd / it.tvl_usd) : 'n/a' })
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their FDV/TVL ratios are the comps the model prices the board with.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'MC / TVL' }))),
          body
        )
      )
    );
  }

  function methodPanel() {
    var mdl = RADAR.model;
    var compLines = RADAR.comps.categories.map(function (comp) {
      return h('tr', null,
        h('td', { text: comp.category }),
        h('td', { class: 'num', text: String(comp.peers) }),
        h('td', { class: 'num', text: multText(comp.median_ratio) }),
        h('td', { class: 'num', text: multText(comp.multiple) })
      );
    });
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The multiple comes from the traded protocols of the same category, so a lending protocol is priced like lending, not like a DEX.' }),
      h('div', { class: 'formula' },
        'implied = round( tvl_usd x multiple(category) x (1 + clamp(change_7d, ' + mdl.growth_floor + ', ' + mdl.growth_cap + ') / 100 x ' + mdl.growth_weight + ') x (' + mdl.maturity_floor + ' + min(age_days, ' + mdl.maturity_days + ') / ' + mdl.maturity_days + ' x ' + mdl.maturity_range + ') )'
      ),
      h('p', { class: 'sub', text: 'Multiple: the winsorized median market-cap-over-TVL of the category\'s traded peers (market cap stands in for FDV), clamped to [' + mdl.multiple_floor + ', ' + mdl.multiple_cap + ']. A category with fewer than ' + mdl.min_peers + ' traded peers uses the global multiple ' + multText(RADAR.comps.global_multiple) + ' from ' + RADAR.comps.global_peers + ' traded protocols. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + mdl.unknown_age_days + ' days. Wrapped, staked and bridged products are excluded outright: they are not launches waiting to happen.' }),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'comps' },
          h('caption', { class: 'sub', text: 'Category comps used by the model (median ratio winsorized at the 5th/95th percentile).' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Category' }), h('th', { scope: 'col', text: 'Peers' }), h('th', { scope: 'col', text: 'Median MC/TVL' }), h('th', { scope: 'col', text: 'Multiple used' }))),
          h('tbody', null, compLines)
        )
      )
    );
  }

  function warningPanel() {
    return h('section', { class: 'panel note' },
      h('h2', { text: 'Read this before you farm' }),
      h('p', { text: 'DefiLlama\'s record says a protocol records no token; it is not proof it has none. A protocol on this board may still have a token its record does not carry. Implied value is the entry\'s own claim from the snapshot\'s figures, never a price, and the board does not predict whether or when a token is issued. Never pay to claim an airdrop, never approve an unlimited spend, and never farm with money you cannot lose.' })
    );
  }

  function riskNotes(rec) {
    var notes = [];
    if (rec.age_days === null) notes.push('Age unknown: DefiLlama records no listing date, so maturity uses the 365-day default.');
    else if (rec.age_days < 180) notes.push('Young protocol (' + ageText(rec.age_days) + ' tracked): less history with no token, so the maturity factor is at its low end.');
    if (rec.change_7d === null) notes.push('No seven-day growth reported: the growth factor is neutral (1.00x).');
    else if (rec.change_7d < -20) notes.push('TVL fell ' + pctText(rec.change_7d) + ' in seven days: capital is leaving faster than the model discounts.');
    else if (rec.change_7d > 50) notes.push('TVL jumped ' + pctText(rec.change_7d) + ' in seven days: a spike can reverse, and the growth factor is capped.');
    if (rec.multiple_source === 'global') notes.push('Thin comps: fewer than ' + RADAR.model.min_peers + ' traded peers in ' + (rec.category || 'this category') + ', so the multiple is the global median ' + multText(RADAR.comps.global_multiple) + ', not a category price.');
    if ((rec.chains || []).length > 3) notes.push('TVL spread across ' + rec.chains.length + ' chains: farm on the chain where the protocol\'s main activity lives, not everywhere at once.');
    if (!rec.watchlist) notes.push('Outside the house watchlist: below the $' + Math.round(RADAR.floor_usd / 1e6) + 'M floor or left out by the house rule, so it is an early find, not a confirmed large launch.');
    return notes;
  }

  var detailDlg = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  detailDlg.addEventListener('close', function () { view.selected = null; saveHash(); });

  function showDetail(slug) {
    var rec = RADAR.rows.filter(function (it) { return it.slug === slug; })[0];
    if (!rec) return;
    view.selected = slug;
    saveHash();
    detailDlg.textContent = '';
    var plan = rec.farm_steps || [];
    var rechecked = recompute(rec, RADAR.model, RADAR.comps);
    var compLine = rec.multiple_source === 'category'
      ? 'Category comps: ' + rec.peers + ' traded peers in ' + (rec.category || 'this category') + ', median MC/TVL ' + multText(rec.category_multiple) + '.'
      : 'Thin comps: fewer than ' + RADAR.model.min_peers + ' traded peers in ' + (rec.category || 'this category') + ', so the global multiple ' + multText(RADAR.comps.global_multiple) + ' from ' + RADAR.comps.global_peers + ' peers is used.';
    detailDlg.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + rec.rank + ' of ' + RADAR.board_size }),
        h('h2', { id: 'detail-title', text: rec.name }),
        h('p', { class: 'sub', text: (rec.category || 'Other') + ' on ' + (rec.chains && rec.chains.length ? rec.chains.join(', ') : 'an unnamed chain') + (rec.watchlist ? ' - on the house watchlist' : ' - early find below the watchlist floor') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { detailDlg.close(); } })
    ));
    detailDlg.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(rec.tvl_usd) })),
        h('div', null, h('span', { text: 'Category multiple' }), h('b', { class: 'num', text: multText(rec.category_multiple) + ' (' + rec.multiple_source + ', ' + rec.peers + ' peers)' })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pctText(rec.change_7d) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(rec.growth_multiplier) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageText(rec.age_days) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(rec.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(rec.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: compLine }),
      h('p', { class: 'sub', text: 'Model ' + RADAR.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(rechecked) + (rechecked === rec.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    detailDlg.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, plan.map(function (s) {
        var cut = s.indexOf(' Cost: ');
        var head = cut >= 0 ? s.slice(0, cut) : s;
        var rest = cut >= 0 ? s.slice(cut + 1) : '';
        return h('li', null, h('b', { text: head }), h('span', { class: 'cost', text: rest }));
      }))
    ));
    var notes = riskNotes(rec);
    if (notes.length > 0) {
      detailDlg.appendChild(h('section', { class: 'detail-section' },
        h('h3', { text: 'Risks to check' }),
        h('ul', { class: 'risks' }, notes.map(function (note) { return h('li', { text: note }); }))
      ));
    }
    if (typeof detailDlg.showModal !== 'function') {
      detailDlg.setAttribute('open', '');
      return;
    }
    if (!detailDlg.open) detailDlg.showModal();
  }

  function draw() {
    mount.textContent = '';
    var wrap = h('div', { class: 'shell' });
    wrap.appendChild(topBar());
    wrap.appendChild(intro());
    wrap.appendChild(filterBar());
    wrap.appendChild(view.tab === 'pre-token' ? boardView() : liveView());
    if (view.tab === 'pre-token') wrap.appendChild(methodPanel());
    wrap.appendChild(warningPanel());
    mount.appendChild(wrap);
    mount.setAttribute('aria-busy', 'false');
    if (!detailDlg.isConnected) mount.appendChild(detailDlg);
    if (view.selected) showDetail(view.selected);
  }

  loadHash();
  draw();
  window.addEventListener('keydown', function (evt) {
    if (evt.key === 'Escape' && detailDlg.open) detailDlg.close();
  });
})();
