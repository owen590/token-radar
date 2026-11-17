// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail view with the model's own
// inputs and the protocol's farm plan, a live-token view, and a sandbox that re-ranks the board
// under tweaked model parameters. No network: every byte it shows is in data.js.
//
// The model, in the page, in the same words as lib/model.ts, so the page's code and the board's
// data are visibly the same arithmetic:
//
//   categoryMultiple   a category's mcap/TVL multiple, calibrated on the snapshot's own
//                        token-bearing protocols (the dashboard's data.js carries the table
//                        main.ts computed; a category with fewer than 3 trading comparables
//                        takes the market median outright).
//   impliedValueOf     tvl_usd x categoryMultiple x growthMultiplier x maturityMultiplier,
//                        growth clamped to [-50, +100] at half weight, maturity 0.7 to 1.0
//                        over 1,095 days of age with no token.
//   farmStepsFor       the seven-step farm plan, derived from the protocol's category, chains,
//                        TVL and age. The page renders the steps board.json carries and checks
//                        each one against this derivation, so a plan the code cannot reproduce
//                        shows up as a mismatch instead of silently passing.
//
// Views are addressed by the hash, so each screenshot is a real state of the page:
//   #detail=<slug>  open one protocol's detail view
//   #cat=<category> filter the board to one category
//   #tab=live       the live-token view
//   #q=<text>       search the board
//   #watchlist=1    watchlist rows only

(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var model = DATA.model;

  var state = { q: '', category: 'all', chain: 'all', watchlist: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3) + 'x';
  }

  // --- the model, as the page runs it ---------------------------------------

  /** The growth multiplier of one row's 7-day TVL change, clamped, at half weight. */
  function growthMultiplierOf(row, m) {
    var raw = row.change_7d === null || row.change_7d === undefined || !isFinite(row.change_7d) ? 0 : row.change_7d;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, raw));
    return 1 + (growth / 100) * m.growth_weight;
  }

  /** The maturity multiplier of one row's age with no token: older, longer-running, higher. */
  function maturityMultiplierOf(row, m) {
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    return m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
  }

  /** The implied value of one row: TVL x category multiple x growth x maturity. */
  function impliedValueOf(row, m) {
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * growthMultiplierOf(row, m) * maturityMultiplierOf(row, m)));
  }

  /** The gas one transaction costs on a chain, in whole dollars: the chain sets the price. */
  function gasFor(chain) {
    var c = (chain || '').toLowerCase();
    if (c === 'ethereum') return 8;
    if (c === 'solana') return 1;
    if (c === 'binance' || c === 'bnb' || c === 'bsc') return 1;
    var cheap = ['base', 'arbitrum', 'optimism', 'polygon', 'unichain', 'ink', 'katana', 'monad', 'sonic', 'berachain', 'scroll', 'blast', 'mode', 'zksync', 'linea', 'mantle'];
    for (var i = 0; i < cheap.length; i++) if (c.indexOf(cheap[i]) >= 0) return 1;
    return 3;
  }

  /** How much capital one farm position needs, from the protocol's own TVL. */
  function capitalFor(row) {
    if (row.tvl_usd >= 1e9) return 250;
    if (row.tvl_usd >= 1e8) return 150;
    return 100;
  }

  /** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
  function holdDaysFor(row) {
    var age = row.age_days;
    if (age === null || age === undefined) return 45;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /** The category's first action, in the words a farmer can follow. */
  function actionFor(row, capital, chain) {
    var c = (row.category || '').toLowerCase();
    var name = row.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and borrow $' + Math.round(capital / 2) + ' of a stablecoin against it, then repay the borrow.';
    if (c.indexOf('cdp') >= 0) return 'Lock $' + capital + ' of collateral in ' + name + ' on ' + chain + ' and mint $' + Math.round(capital / 2) + ' of its stablecoin, then burn it back.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('risk curat') >= 0 || c.indexOf('capital allocat') >= 0 || c.indexOf('curator') >= 0) return 'Deposit $' + capital + ' of USDC into a ' + name + ' curator vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('yield aggregator') >= 0 || c.indexOf('yield') >= 0) return 'Deposit $' + capital + ' of USDC into ' + name + "'s highest-TVL vault on " + chain + ' and keep the shares.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of ' + name + "'s yield-bearing asset on " + chain + ' and hold it in your wallet.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('restak') >= 0) return 'Restake $' + capital + " of the chain's staking asset through " + name + ' on ' + chain + ' and keep the receipt token.';
    if (c.indexOf('staking') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trad') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge, then close it the same week.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' on ' + name + ' and place one market position, then settle it when the market closes.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy open.';
    if (c.indexOf('governance') >= 0) return 'Deposit $' + capital + ' into ' + name + ' on ' + chain + ' and vote on one live proposal.';
    if (c.indexOf('payment') >= 0) return 'Route $' + capital + ' through ' + name + ' on ' + chain + ' and settle one payment in its app.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + " and use " + name + "'s flagship app for one swap or deposit.";
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  /** The category's second position: a different pool, vault or action inside the same protocol. */
  function secondActionFor(row, capital, chain) {
    var c = (row.category || '').toLowerCase();
    var name = row.name;
    var half = Math.round(capital / 2);
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply another $' + half + ' to a second market on ' + name + ' so more than one market is on record.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Add $' + half + ' of liquidity to a second pool on ' + name + ' on ' + chain + ', in a different token pair.';
    if (c.indexOf('risk curat') >= 0 || c.indexOf('capital allocat') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('yield') >= 0) return 'Deposit $' + half + ' into a second ' + name + ' vault on ' + chain + ' so two vaults are on record.';
    if (c.indexOf('rwa') >= 0) return 'Mint another $' + half + ' of the yield asset through ' + name + ' on a second chain it supports.';
    if (c.indexOf('bridge') >= 0) return 'Bridge another $' + half + ' back the other way through ' + name + ' so both directions are on record.';
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0) return 'Stake another $' + half + ' through a second ' + name + ' pool or validator on ' + chain + '.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trad') >= 0) return 'Open a second small hedge on ' + name + ' in the opposite direction and close it the same week.';
    if (c.indexOf('prediction') >= 0) return 'Place a second, smaller market position on ' + name + ' on a different market.';
    return 'Make a second $' + half + ' deposit into ' + name + ' on ' + chain + ', in a different market or pool.';
  }

  /** A step as one string: its action, then its cost and time. */
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
    return s;
  }

  /** One protocol's farm plan: seven steps, each an action with a cost and a time. */
  function farmStepsFor(row) {
    var chain = row.chains && row.chains.length > 0 ? row.chains[0] : 'its main chain';
    var capital = capitalFor(row);
    var gas = gasFor(chain);
    var hold = holdDaysFor(row);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $' + (gas + 2) + ' of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(row, capital, chain), cost: '$' + capital + ' of capital and about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: secondActionFor(row, capital, chain), cost: '$' + Math.round(capital / 2) + ' of capital and about $' + gas + ' of gas', time: '20 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $' + gas + ' of gas a week', time: '10 minutes a week' },
      { text: 'Open ' + row.name + "'s points or quests page and finish one quest or task it lists.", cost: 'no fee to check', time: '15 minutes' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, check the protocol\'s own page for a claim and claim only from the link it publishes; then write the wallet, the dates and every transaction in a farm log.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    ].map(stepText);
  }

  /** How many of the board's shipped farm plans this derivation reproduces exactly. */
  function planCheck() {
    var ok = 0;
    for (var i = 0; i < DATA.rows.length; i++) {
      var want = farmStepsFor(DATA.rows[i]);
      var got = DATA.rows[i].farm_steps || [];
      if (want.length === got.length && want.every(function (s, j) { return s === got[j]; })) ok++;
    }
    return { ok: ok, total: DATA.rows.length };
  }

  /** How many of the board's shipped implied values this page's model reproduces exactly. */
  function valueCheck() {
    var ok = 0;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (impliedValueOf(DATA.rows[i], model) === DATA.rows[i].implied_value_usd) ok++;
    }
    return { ok: ok, total: DATA.rows.length };
  }

  // --- page furniture ---------------------------------------------------------

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) {
        if (c === null || c === undefined) return;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  /** The view's state out of the URL hash, so each view is a real address. */
  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('detail')) state.selected = params.get('detail');
    if (params.get('cat')) state.category = params.get('cat');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('q') !== null) state.q = params.get('q');
    if (params.get('watchlist') === '1') state.watchlist = true;
    if (params.get('sort')) state.sort = params.get('sort');
  }

  /** The URL hash out of the view's state, so a filtered view can be shared. */
  function writeHash() {
    var params = new URLSearchParams();
    if (state.selected) params.set('detail', state.selected);
    if (state.category !== 'all') params.set('cat', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.q) params.set('q', state.q);
    if (state.watchlist) params.set('watchlist', '1');
    if (state.sort !== 'implied') params.set('sort', state.sort);
    var h = params.toString();
    if (h) window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + h);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The board rows the current filters keep. */
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchlist && !r.on_watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  /** The filtered rows in the current sort order. */
  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var d = 0;
      if (key === 'name') d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      else if (key === 'category') d = (a.category || 'Other') < (b.category || 'Other') ? -1 : (a.category || 'Other') > (b.category || 'Other') ? 1 : 0;
      else if (key === 'tvl') d = a.tvl_usd - b.tvl_usd;
      else if (key === 'growth') d = (a.change_7d || 0) - (b.change_7d || 0);
      else if (key === 'age') d = (a.age_days === null ? -1 : a.age_days) - (b.age_days === null ? -1 : b.age_days);
      else d = a.implied_value_usd - b.implied_value_usd;
      if (d === 0) d = a.rank - b.rank;
      return d * dir;
    });
  }

  function renderHero() {
    var top = DATA.rows[0];
    return el('section', { class: 'hero' },
      el('h1', {}, 'The radar for tokens that ', el('span', { class: 'accent', text: 'do not exist yet.' })),
      el('p', {}, [
        'Every protocol in one DefiLlama snapshot — ', el('strong', { text: DATA.board_size + ' pre-token protocols' }),
        ' ranked by what a token would be worth if it traded like its peers. The snapshot is frozen at ',
        el('strong', { text: DATA.as_of }), '; the watchlist holds ',
        el('strong', { text: String(DATA.watchlist_size) }),
        ' protocols of $50M TVL or more with no token recorded. The strongest implied value on the board is ',
        el('strong', { text: top ? top.name + ' at ' + fmtUsd(top.implied_value_usd) : 'n/a' }),
        '. An implied value is this radar\u2019s own claim, never a prediction that a token will be issued.',
      ]));
  }

  function renderStats() {
    var top = DATA.rows[0];
    var med = DATA.calibration.overall_median;
    return el('section', { class: 'stats', 'aria-label': 'Snapshot summary' },
      el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Watchlist' }), el('div', { class: 'value', text: String(DATA.watchlist_size) }), el('div', { class: 'sub', text: 'protocols ≥ $50M TVL, no token' })),
      el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Board rows' }), el('div', { class: 'value', text: String(DATA.board_size) }), el('div', { class: 'sub', text: 'every rankable pre-token protocol' })),
      el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Market multiple' }), el('div', { class: 'value cyan', text: fmtMult(med) }), el('div', { class: 'sub', text: 'median mcap/TVL of trading protocols' })),
      el('div', { class: 'stat' }, el('div', { class: 'label', text: 'Top implied value' }), el('div', { class: 'value cyan', text: top ? fmtUsd(top.implied_value_usd) : 'n/a' }), el('div', { class: 'sub', text: top ? top.name : '' })));
  }

  function renderModel() {
    var vc = valueCheck();
    var pc = planCheck();
    // Every category on the board, with its multiple: trading categories from the calibration,
    // the rest taking the market median outright (fewer than 3 trading peers).
    var shownCats = {};
    DATA.calibration.categories.forEach(function (c) { shownCats[c.category] = c; });
    DATA.rows.forEach(function (r) {
      var cat = r.category || 'Other';
      if (!shownCats[cat]) shownCats[cat] = { category: cat, n: 0, median: null, multiple: DATA.calibration.overall_median };
    });
    var catRows = Object.keys(shownCats).sort().map(function (k) { return shownCats[k]; });
    var table = el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: 'Category' }), el('th', { text: 'Trading peers' }), el('th', { text: 'Median mcap/TVL' }), el('th', { text: 'Multiple used' }))),
      el('tbody', {}, catRows.map(function (c) {
        return el('tr', {},
          el('td', { text: c.category }),
          el('td', { text: String(c.n) }),
          el('td', { text: c.median === null ? '—' : fmtMult(c.median) }),
          el('td', { class: 'multiple', text: fmtMult(c.multiple) }));
      })));
    return el('details', { class: 'model' },
      el('summary', { text: 'How the model works — radar-2 (click to open)' }),
      el('div', { class: 'formula' }, el('b', { text: 'implied = TVL × category multiple × growth × maturity' })),
      el('p', {}, [
        'The ', el('b', { text: 'category multiple' }),
        ' is calibrated on this snapshot\u2019s own token-bearing protocols: the median of their mcap/TVL ratios, winsorised to [0.02, 2.0], shrunk toward the market median of ',
        el('b', { text: fmtMult(DATA.calibration.overall_median) }),
        ' with a prior weight of 4. A category with fewer than 3 trading comparables takes the market median outright, so no single protocol can set a whole category. ',
        el('b', { text: 'Growth' }),
        ' is the 7-day TVL change, clamped to [−50%, +100%] at half weight. ',
        el('b', { text: 'Maturity' }),
        ' runs 0.7 to 1.0 over 1,095 days of age with no token. No protocol name is ever special-cased: the same three functions score every row.',
      ]),
      el('p', { text: 'The page recomputes every number it shows from the snapshot figures, and checks its own work:' }),
      el('p', {}, [
        'Implied values reproduced exactly: ', el('b', { text: vc.ok + ' / ' + vc.total }),
        '. Farm plans reproduced exactly: ', el('b', { text: pc.ok + ' / ' + pc.total }),
        '.',
      ]),
      table,
      el('p', { text: 'Categories with fewer than 3 trading peers show a dash for their own median and take the market median as their multiple.' }));
  }

  function renderTabs() {
    return el('div', { class: 'tabs', role: 'tablist' },
      el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': state.tab === 'pre-token' ? 'true' : 'false', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } }, 'Pre-token board ', el('span', { class: 'count', text: '(' + DATA.board_size + ')' })),
      el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': state.tab === 'live' ? 'true' : 'false', onclick: function () { state.tab = 'live'; writeHash(); render(); } }, 'Live tokens ', el('span', { class: 'count', text: '(' + DATA.live_size + ')' })));
  }

  function renderControls(total) {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []))).sort();
    var search = el('input', { type: 'search', placeholder: 'Search a protocol…', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); renderBoardOnly(); });
    var cat = el('select', { 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c }); }));
    cat.value = state.category;
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chain = el('select', { 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c }); }));
    chain.value = state.chain;
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var wl = el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: state.watchlist ? true : null }),
      'Watchlist only');
    wl.querySelector('input').addEventListener('change', function (e) { state.watchlist = e.target.checked; writeHash(); render(); });
    return el('div', { class: 'controls' }, search, cat, chain, wl,
      el('span', { class: 'result-count', text: total + ' of ' + DATA.board_size + ' rows' }));
  }

  function sortHeader(key, label) {
    return el('th', {},
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null));
  }

  function renderBoardTable(list) {
    var maxImp = DATA.rows.length > 0 ? DATA.rows[0].implied_value_usd : 1;
    var body = list.map(function (r) {
      var growth = r.change_7d;
      var growthClass = growth === null ? 'flat' : growth > 0 ? 'up' : growth < 0 ? 'down' : 'flat';
      var tr = el('tr', { tabindex: '0', class: r.rank <= 3 ? 'top' : '', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', {}, el('span', { class: 'name', text: r.name }), r.on_watchlist ? el('span', { class: 'wl', text: 'WATCHLIST' }) : null),
        el('td', { class: 'cat', text: r.category || 'Other' }),
        el('td', { class: 'chains', text: r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') }),
        el('td', { text: fmtUsd(r.tvl_usd) }),
        el('td', { class: growthClass, text: fmtPct(growth) }),
        el('td', { text: fmtAge(r.age_days) }),
        el('td', { class: 'implied' }, fmtUsd(r.implied_value_usd), el('span', { class: 'implied-bar' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / maxImp) * 100)) + '%' }))));
      return tr;
    });
    if (list.length === 0) {
      body = [el('tr', {}, el('td', { class: 'empty', colspan: '8' }, 'No protocol matches that filter. ', el('button', { class: 'tab', type: 'button', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlist = false; writeHash(); render(); } }, 'Clear filters')))];
    }
    return el('div', { class: 'board-wrap' },
      el('table', { class: 'board' },
        el('caption', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
        el('thead', {}, el('tr', {},
          sortHeader('implied', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('category', 'Category'),
          el('th', { text: 'Chains' }), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'),
          sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'))),
        el('tbody', {}, body)));
  }

  function renderLiveTable() {
    var body = DATA.live.map(function (r, i) {
      return el('tr', { tabindex: '0' },
        el('td', { class: 'rank', text: String(i + 1) }),
        el('td', {}, el('span', { class: 'name', text: r.name })),
        el('td', { class: 'cat', text: r.category || 'Other' }),
        el('td', { class: 'chains', text: r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') }),
        el('td', { text: fmtUsd(r.tvl_usd) }),
        el('td', { text: r.mcap_usd === null ? 'n/a' : fmtUsd(r.mcap_usd) }),
        el('td', { text: r.mcap_tvl === null ? 'n/a' : fmtMult(r.mcap_tvl) }),
        el('td', { text: fmtPct(r.change_7d) }));
    });
    return el('div', { class: 'board-wrap' },
      el('table', { class: 'board' },
        el('caption', { text: 'Tokens that already trade, by market cap. These are the market\u2019s own values — and the comparables the model is calibrated on — never a model\u2019s claim.' }),
        el('thead', {}, el('tr', {},
          el('th', { text: '#' }), el('th', { text: 'Protocol' }), el('th', { text: 'Category' }),
          el('th', { text: 'Chains' }), el('th', { text: 'TVL' }), el('th', { text: 'Market cap' }),
          el('th', { text: 'Mcap / TVL' }), el('th', { text: '7d' }))),
        el('tbody', {}, body)));
  }

  function renderSandbox() {
    var gw = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(model.growth_weight), 'aria-label': 'Growth weight' });
    var gwOut = el('output', { text: String(model.growth_weight) });
    var mf = el('input', { type: 'range', min: '0.5', max: '0.9', step: '0.05', value: String(model.maturity_floor), 'aria-label': 'Maturity floor' });
    var mfOut = el('output', { text: String(model.maturity_floor) });
    var preview = el('ol', {});
    function update() {
      var m = Object.assign({}, model, { growth_weight: parseFloat(gw.value), maturity_floor: parseFloat(mf.value) });
      gwOut.textContent = m.growth_weight.toFixed(2);
      mfOut.textContent = m.maturity_floor.toFixed(2);
      var top = DATA.rows.map(function (r) { return { row: r, implied: impliedValueOf(r, m) }; })
        .sort(function (a, b) { return b.implied - a.implied || a.row.rank - b.row.rank; })
        .slice(0, 10);
      preview.innerHTML = '';
      top.forEach(function (t, i) {
        preview.appendChild(el('li', {}, (i + 1) + '. ' + t.row.name + ' — ', el('span', { class: 'imp', text: fmtUsd(t.implied) })));
      });
    }
    gw.addEventListener('input', update);
    mf.addEventListener('input', update);
    var box = el('section', { class: 'sandbox' },
      el('h2', { text: 'Try the model' }),
      el('p', { text: 'Two of the model\u2019s parameters, moved live. The board above is the submitted ranking; this preview re-ranks the top 10 under your settings, so you can see what the model is sensitive to.' }),
      el('div', { class: 'sliders' },
        el('label', {}, 'Growth weight ', gwOut, el('br', {}), gw),
        el('label', {}, 'Maturity floor ', mfOut, el('br', {}), mf)),
      preview,
      el('button', { class: 'reset', type: 'button', onclick: function () { gw.value = String(model.growth_weight); mf.value = String(model.maturity_floor); update(); } }, 'Reset to the submitted model'));
    update();
    return box;
  }

  var dialog = null;

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    if (!dialog) {
      dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
      document.body.appendChild(dialog);
      dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
    }
    var growth = row.change_7d;
    var mult = row.category_multiple;
    var cal = DATA.calibration.categories.filter(function (c) { return c.category === (row.category || 'Other'); })[0];
    dialog.innerHTML = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', {},
        el('h2', { id: 'detail-title', text: row.name }),
        el('div', { class: 'sub', text: (row.category || 'Other') + ' · ' + row.chains.join(', ') + (row.on_watchlist ? ' · on the watchlist' : ' · below the watchlist floor') })),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })));
    var body = el('div', { class: 'detail-body' });
    body.appendChild(el('div', { class: 'detail-big-label', text: 'Implied value if its token traded like its peers' }));
    body.appendChild(el('div', { class: 'detail-big', text: fmtUsdFull(row.implied_value_usd) }));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'The model, on this protocol' }),
      el('div', { class: 'kv' },
        el('div', {}, el('div', { class: 'k', text: 'TVL' }), el('div', { class: 'v', text: fmtUsdFull(row.tvl_usd) })),
        el('div', {}, el('div', { class: 'k', text: '7-day change' }), el('div', { class: 'v', text: fmtPct(growth) })),
        el('div', {}, el('div', { class: 'k', text: 'Age, no token' }), el('div', { class: 'v', text: fmtAge(row.age_days) })),
        el('div', {}, el('div', { class: 'k', text: 'Category multiple' }), el('div', { class: 'v', text: fmtMult(mult) })),
        el('div', {}, el('div', { class: 'k', text: 'Growth multiplier' }), el('div', { class: 'v', text: row.growth_multiplier.toFixed(3) + 'x' })),
        el('div', {}, el('div', { class: 'k', text: 'Maturity multiplier' }), el('div', { class: 'v', text: row.maturity_multiplier.toFixed(3) + 'x' }))),
      el('p', { class: 'detail-note' }, (cal && cal.n >= 3 ? 'Its category, ' + row.category + ', has ' + cal.n + ' trading peers with a median mcap/TVL of ' + fmtMult(cal.median) + ', shrunk toward the market median of ' + fmtMult(DATA.calibration.overall_median) + '.' : 'Its category has fewer than 3 trading peers, so it takes the market median multiple of ' + fmtMult(DATA.calibration.overall_median) + '.')),
      el('div', { class: 'math' }, el('b', { text: fmtUsdFull(row.tvl_usd) }), ' × ' + mult.toFixed(4) + ' × ' + row.growth_multiplier.toFixed(4) + ' × ' + row.maturity_multiplier.toFixed(4) + ' = ', el('b', { text: fmtUsdFull(row.implied_value_usd) }))));
    var farm = el('ol', { class: 'farm' });
    row.farm_steps.forEach(function (s) {
      var costAt = s.indexOf(' Cost: ');
      var timeAt = s.indexOf(' Time: ', costAt > 0 ? costAt : 0);
      var text = costAt > 0 ? s.slice(0, costAt) : s;
      var cost = costAt > 0 ? s.slice(costAt + 7, timeAt > 0 ? timeAt : s.length - 1) : '';
      var time = timeAt > 0 ? s.slice(timeAt + 7).replace(/\.$/, '') : '';
      farm.appendChild(el('li', {}, text, el('div', { class: 'cost-time' }, 'Cost: ', el('b', { text: cost }), ' · Time: ', el('b', { text: time }))));
    });
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — seven steps' }),
      farm,
      el('p', { class: 'detail-note', text: 'A plan is a claim about what to do, not a promise of a token. Never pay to claim an airdrop, and claim only from the protocol\u2019s own page.' })));
    dialog.appendChild(body);
    if (!dialog.open) dialog.showModal();
  }

  function renderBoardOnly() {
    var slot = document.getElementById('board-table-slot');
    if (!slot) return;
    var list = sortedRows(rows());
    var count = slot.querySelector('.result-count');
    if (count) count.textContent = list.length + ' of ' + DATA.board_size + ' rows';
    var wrap = slot.querySelector('.board-wrap');
    if (wrap) wrap.replaceWith(state.tab === 'live' ? renderLiveTable() : renderBoardTable(list));
  }

  function render() {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = '';
    app.appendChild(renderHero());
    app.appendChild(renderStats());
    app.appendChild(renderModel());
    app.appendChild(renderTabs());
    var slot = el('div', { id: 'board-table-slot' });
    var list = sortedRows(rows());
    slot.appendChild(renderControls(list.length));
    slot.appendChild(state.tab === 'live' ? renderLiveTable() : renderBoardTable(list));
    app.appendChild(slot);
    var sb = el('div', { id: 'sandbox-slot' });
    sb.appendChild(renderSandbox());
    app.appendChild(sb);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () {
    var prev = state.selected;
    readHash();
    render();
    if (prev && !state.selected && dialog && dialog.open) dialog.close();
  });
})();
