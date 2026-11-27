(() => {
  if (window.__smoke) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ok = note => ({ ok: true, note: note || '' });
  const fail = error => ({ ok: false, error });

  /* ---------- DOM helpers (main page + same-origin iframes) ---------- */
  function docs(root = document, out = []) {
    out.push(root);
    root.querySelectorAll('iframe,frame').forEach(f => { try { if (f.contentDocument) docs(f.contentDocument, out); } catch (e) {} });
    return out;
  }
  const all = sel => docs().flatMap(d => [...d.querySelectorAll(sel)]);
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  const SKIP = /^(SCRIPT|STYLE|OPTION|SELECT|INPUT|TEXTAREA|NOSCRIPT|HTML|BODY|HEAD)$/;
  const exact = text => {                       // visible elements whose whole text equals `text`
    const t = norm(text);
    return all('body *').filter(el => !SKIP.test(el.tagName) && visible(el) && norm(el.textContent) === t);
  };
  const deepest = list => list.filter(el => !list.some(o => o !== el && el.contains(o)));
  const lowest = list => [...list].sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

  async function waitFor(fn, timeout = 10000, step = 250) {
    const end = Date.now() + timeout;
    do { const v = fn(); if (v) return v; await sleep(step); } while (Date.now() < end);
    return null;
  }
  function click(el) {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    if (el.click) el.click(); else el.dispatchEvent(new MouseEvent('click', o));
  }
  function dblclick(el) {
    click(el); click(el);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
  }
  function setNative(input, v) {
    const proto = input.ownerDocument.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function typeInto(input, text, delay = 30) {
    input.focus(); setNative(input, '');
    let cur = '';
    for (const ch of String(text)) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      cur += ch; setNative(input, cur);
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(delay);
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // Wait for ERP loading spinners/overlays to go away. Edit LOADERS if your app uses other class names.
  const LOADERS = '.loading,.loader,.spinner,.blockUI,.blockOverlay,.preloader,.ui-widget-overlay,.ag-overlay-loading-wrapper,[class*="spinner"],[class*="preloader"]';
  async function settle(minMs, maxMs = 10000) {
    await sleep(minMs);
    await waitFor(() => !all(LOADERS).some(visible), maxMs, 300);
  }

  /* ---------- login ---------- */
  async function clickText(text, timeoutMs = 10000) {
    const el = await waitFor(() => deepest(exact(text))[0], timeoutMs, 300);
    if (!el) return fail(`"${text}" not found on the page`);
    click(el); return ok();
  }
  async function fillLogin(user, pass) {
    const p = await waitFor(() => all('input[type="password"]').find(visible), 10000, 300);
    if (!p) return fail('Password field not found');
    const isText = x => x !== p && visible(x) && /^(text|email|)$/i.test(x.type);
    let n = p.parentElement, u = null;
    for (let i = 0; i < 8 && n && !u; i++, n = n.parentElement) u = [...n.querySelectorAll('input')].find(isText);
    if (!u) return fail('Username field not found');
    await typeInto(u, user, 15); await typeInto(p, pass, 15);
    return ok();
  }
  function banner(text) {
    let b = document.getElementById('__smoke_banner');
    if (!b) {
      b = document.createElement('div'); b.id = '__smoke_banner';
      b.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#b45309;color:#fff;font:600 15px Arial;padding:8px 18px;border-radius:6px;box-shadow:0 2px 8px #0006';
      document.body.appendChild(b);
    }
    b.textContent = text;
    const i = all('input').find(x => visible(x) && /^(text|tel|number|password|)$/i.test(x.type));
    if (i) i.focus();
    return ok();
  }

  /* ---------- global search + opening screens ---------- */
  const searchInput = () =>
    all('input').find(i => visible(i) && /module search/i.test(`${i.placeholder} ${i.title} ${i.getAttribute('aria-label') || ''}`)) ||
    all('input').find(i => visible(i) && /search/i.test(i.placeholder || '') && i.getBoundingClientRect().top < 80);

  async function waitHome(ms) {
    const i = await waitFor(searchInput, ms, 500);
    if (!i) return fail('Home page (Module Search box) did not appear');
    await settle(1500); return ok();
  }

  function closeBtn(sel) {
    if (sel) return all(sel).find(visible);
    const c = all('a,span,i,button,div,svg,b,em').filter(el => {
      if (el.ownerDocument !== document || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top < 50 || r.top > 160 || r.width > 40 || r.height > 40) return false;      // tab-strip area only
      const sig = `${el.getAttribute('class') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`;
      return /close|times|xmark|remove|cross/i.test(sig) || /^[×✖✕✗xX]$/.test((el.textContent || '').trim());
    });
    return deepest(c)[0];
  }
  async function closeScreens(sel) {
    for (const t of [document, document.body])                                         // dismiss any popup first
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    for (let i = 0; i < 8; i++) {
      const b = closeBtn(sel);
      if (!b) break;
      click(b); await sleep(800);
    }
    return ok();
  }

  function dropdownItem(name, input, before) {
    const t = norm(name), minW = Math.max(100, input.getBoundingClientRect().width);
    const rows = all('body *').filter(el => !SKIP.test(el.tagName) && !before.has(el) && visible(el) &&
      el.getBoundingClientRect().width >= minW && norm(el.textContent) === t);        // full-width row whose whole text matches
    return deepest(rows)[0] || null;
  }
  async function openScreen(name, waitMs) {
    const input = searchInput();
    if (!input) return fail('Module Search box not found');
    const before = new Set(exact(name));                                               // ignore menu items / tabs already on screen
    await typeInto(input, name, 35);
    const item = await waitFor(() => dropdownItem(name, input, before), 10000, 300);
    if (!item) { setNative(input, ''); return fail(`No exact match for "${name}" in the search results`); }
    click(item);
    await settle(waitMs);
    return ok();
  }

  /* ---------- special screens: search popup -> % -> pick latest -> Select ---------- */
  function popupInput(btn) {
    let n = btn.parentElement;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      const ins = [...n.querySelectorAll('input')].filter(x => visible(x) && /^(text|search|)$/i.test(x.type) && !x.readOnly && !x.disabled);
      if (ins.length) return ins.find(x => x === x.ownerDocument.activeElement) || ins[0];
    }
    return null;
  }
  function pressAltH() {
    for (const t of [document, document.body])
      for (const type of ['keydown', 'keyup'])
        t.dispatchEvent(new KeyboardEvent(type, { key: 'h', code: 'KeyH', keyCode: 72, which: 72, altKey: true, bubbles: true }));
  }
  function toolbarSearchIcon() {
    return all('i,span,button,a,div').filter(el => el.ownerDocument === document && visible(el) &&
      /search|magnif/i.test(el.getAttribute('class') || '') &&
      el.getBoundingClientRect().top > 50 && el.getBoundingClientRect().top < 170 && el.getBoundingClientRect().width < 50)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
  }
  function latestRow(rows, colName) {
    const want = norm(colName);
    const head = all('.ag-header-cell,[role="columnheader"],th').filter(visible).find(h => norm(h.textContent).startsWith(want));
    let best = null;
    if (head) for (const row of rows) {
      const id = head.getAttribute('col-id');
      const cell = id ? row.querySelector(`[col-id="${CSS.escape(id)}"]`) : row.children[[...head.parentElement.children].indexOf(head)];
      if (!cell) continue;
      const txt = (cell.textContent || '').trim(), t = Date.parse(txt.replace(' ', 'T'));
      const better = !best || (isFinite(t) && isFinite(best.t) ? t > best.t : txt > best.txt);
      if (better) best = { row, cell, txt, t };
    }
    return best;
  }
  async function searchSelectLatest({ value = '%', dateColumn = 'Booking Date', waitMs = 3000 } = {}) {
    const beforeSearch = new Set(exact('Search'));
    const opened = () => exact('Search').some(e => !beforeSearch.has(e));
    const attempts = [
      () => { const b = all('[title*="ALT+H" i],[data-original-title*="ALT+H" i],[aria-label*="ALT+H" i]').find(visible); if (b) click(b); return !!b; },
      () => { pressAltH(); return true; },
      () => { const b = toolbarSearchIcon(); if (b) click(b); return !!b; }
    ];
    let done = false;
    for (const a of attempts) if (a() && await waitFor(opened, 4000, 250)) { done = true; break; }
    if (!done) return fail('Search popup did not open');

    const goBtn = lowest(deepest(exact('Search').filter(e => !beforeSearch.has(e))))[0];   // the SEARCH button
    const input = popupInput(goBtn);
    if (!input) return fail('Value field in the search popup not found');
    await typeInto(input, value, 25);
    click(goBtn);

    const below = r => r.getBoundingClientRect().top > goBtn.getBoundingClientRect().top;
    const getRows = () => {
      let r = all('.ag-row').filter(x => visible(x) && below(x));
      if (!r.length) r = all('tbody tr,[role="row"]').filter(x => visible(x) && below(x) && x.querySelector('td,[role="gridcell"]'));
      return r;
    };
    const rows = await waitFor(() => { const r = getRows(); return r.length ? r : null; }, 25000, 400);
    if (!rows) return fail(`No records listed after searching "${value}"`);
    await sleep(1000);

    let pick = latestRow(getRows(), dateColumn), note;
    if (!pick) {
      const row = getRows()[0];
      pick = { row, cell: row.querySelector('.ag-cell,td,[role="gridcell"]') || row, txt: '' };
      note = `"${dateColumn}" column not found - first row used. `;
    }
    const first = (pick.row.querySelector('.ag-cell,td,[role="gridcell"]') || pick.row).textContent.trim();
    click(pick.cell);
    await sleep(500);

    const selBtn = () => lowest(deepest(exact('Select')))[0];
    const s1 = selBtn();
    if (!s1) return fail("'Select' button not found in the popup");
    click(s1);
    const closed = () => !goBtn.isConnected || !visible(goBtn);
    if (!await waitFor(closed, 4000, 300)) {
      dblclick(pick.cell);
      if (!await waitFor(closed, 4000, 300)) { const s2 = selBtn(); if (s2) click(s2); if (!await waitFor(closed, 3000, 300)) return fail('Select did not close the popup'); }
    }
    await settle(waitMs);
    return ok(`${note || ''}Latest: ${first}${pick.txt ? ' (' + pick.txt + ')' : ''}`);
  }

  /* ---------- checks + logout ---------- */
  const ERR = /(internal server error|something went wrong|unexpected error|http status\s*[45]\d\d|service unavailable|bad gateway|java\.lang\.|ora-\d{5})/i;
  function pageError() {
    const txt = docs().map(d => (d.body ? d.body.innerText : '')).join('\n');
    const m = txt.match(ERR);
    return { ok: true, found: m ? m[0] : '' };
  }
  function findLogout() {
    const sel = '[title*="logout" i],[title*="log out" i],[title*="sign out" i],[aria-label*="logout" i],[class*="logout" i],[class*="signout" i],[id*="logout" i],[onclick*="logout" i]';
    const hit = all(sel).filter(visible).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    if (hit) return hit;
    return all('a,button,i,span,div,img,svg').filter(el => el.ownerDocument === document && visible(el)).filter(el => {
      const r = el.getBoundingClientRect();
      return r.top < 70 && r.right > innerWidth - 90 && r.width < 80 && r.height < 80;      // top-right orange icon
    }).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.right - ra.right) || (rb.width * rb.height - ra.width * ra.height);
    })[0];
  }
  async function logout(sel) {
    const el = sel ? all(sel).find(visible) : findLogout();
    if (!el) return fail('Logout button not found');
    click(el);
    const yes = await waitFor(() => deepest(all('button,a,input[type="button"],input[type="submit"],[role="button"],.btn,span,div')
      .filter(e => visible(e) && /^(yes|ok|confirm|logout|log out|sign out|proceed)$/.test(norm(e.value || e.textContent))))[0], 3000, 300);
    if (yes) click(yes);
    return ok();
  }

  window.__smoke = { clickText, fillLogin, banner, waitHome, closeScreens, openScreen, searchSelectLatest, pageError, logout };
})();
