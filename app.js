const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let screens = [
  { name: 'User Management', type: 'normal' },
  { name: 'Booking', type: 'latest', value: '%', dateColumn: 'Booking Date' }
];
let stream = null, video = null, running = false, stopFlag = false;
let pages = [];          // { jpeg, w, h, label, status, note, time }
let lastPdf = null;

/* ---------------- persistence (screens + settings only; never credentials) ---------------- */
async function loadState() {
  const s = await chrome.storage.local.get(['screens', 'settings', 'baseUrl']);
  if (s.screens && s.screens.length) screens = s.screens;
  if (s.baseUrl) $('baseUrl').value = s.baseUrl;
  if (s.settings) for (const k of ['waitMs', 'otpMin', 'closeSel', 'logoutSel']) if (s.settings[k] !== undefined) $(k).value = s.settings[k];
  renderScreens();
}
function saveState() {
  chrome.storage.local.set({
    screens, baseUrl: $('baseUrl').value,
    settings: Object.fromEntries(['waitMs', 'otpMin', 'closeSel', 'logoutSel'].map(k => [k, $(k).value]))
  });
}
['baseUrl', 'waitMs', 'otpMin', 'closeSel', 'logoutSel'].forEach(id => $(id).addEventListener('change', saveState));

/* ---------------- screens table ---------------- */
function renderScreens() {
  const tb = $('screenRows'); tb.innerHTML = '';
  screens.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="n">${i + 1}</td>
      <td><input class="name"></td>
      <td><select class="type"><option value="normal">Normal</option><option value="latest">Search &amp; select latest</option></select></td>
      <td class="extra"><input class="val" placeholder="search value (%)"><input class="col" placeholder="date column"></td>
      <td><button class="del" title="Remove">✕</button></td>`;
    const name = tr.querySelector('.name'), type = tr.querySelector('.type'),
          val = tr.querySelector('.val'), col = tr.querySelector('.col'), extra = tr.querySelector('.extra');
    name.value = s.name || ''; type.value = s.type || 'normal';
    val.value = s.value || '%'; col.value = s.dateColumn || 'Booking Date';
    const sync = () => { extra.style.visibility = type.value === 'latest' ? 'visible' : 'hidden'; };
    sync();
    name.oninput = () => { s.name = name.value; saveState(); };
    type.onchange = () => { s.type = type.value; sync(); saveState(); };
    val.oninput = () => { s.value = val.value; saveState(); };
    col.oninput = () => { s.dateColumn = col.value; saveState(); };
    tr.querySelector('.del').onclick = () => { screens.splice(i, 1); renderScreens(); saveState(); };
    tb.appendChild(tr);
  });
}
$('addRow').onclick = () => { screens.push({ name: '', type: 'normal' }); renderScreens(); saveState(); };
$('bulkToggle').onclick = () => { $('bulkBox').hidden = !$('bulkBox').hidden; };
$('bulkAdd').onclick = () => {
  $('bulk').value.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
    const [name, tag] = line.split('|').map(x => x.trim());
    screens.push({ name, type: /latest/i.test(tag || '') ? 'latest' : 'normal', value: '%', dateColumn: 'Booking Date' });
  });
  $('bulk').value = ''; $('bulkBox').hidden = true; renderScreens(); saveState();
};

/* ---------------- UI helpers ---------------- */
function setStatus(text, cls = '') { const s = $('status'); s.textContent = text; s.className = 'status ' + cls; }
function log(msg, cls = '') {
  const li = document.createElement('li'); li.className = cls;
  li.textContent = `${new Date().toLocaleTimeString('en-GB')}  ${msg}`;
  $('log').appendChild(li); li.scrollIntoView({ block: 'nearest' });
}
function setButtons(isRunning) {
  $('start').disabled = isRunning; $('stop').disabled = !isRunning;
}
function addThumb(blob, label, status) {
  const url = URL.createObjectURL(blob);
  const fig = document.createElement('figure'); fig.className = status;
  fig.innerHTML = `<a target="_blank"><img></a><figcaption></figcaption>`;
  fig.querySelector('a').href = url; fig.querySelector('img').src = url;
  fig.querySelector('figcaption').textContent = `${status} · ${label}`;
  $('gallery').appendChild(fig);
}
const checkStop = () => { if (stopFlag) throw new Error('Stopped by user'); };
const must = r => { if (!r.ok) throw new Error(r.error || 'Step failed'); return r; };

/* ---------------- talking to the ERP tab ---------------- */
async function call(tabId, fn, ...args) {
  let injected = false, lastErr;
  for (let i = 0; i < 5 && !injected; i++) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); injected = true; }
    catch (e) { lastErr = e; await sleep(700); }
  }
  if (!injected) return { ok: false, error: 'Cannot access the ERP tab: ' + (lastErr && lastErr.message || lastErr) };
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, func: (f, a) => window.__smoke[f](...a), args: [fn, args]
    });
    return (r && r.result) || { ok: false, navigated: true, error: 'Page changed while the step was running' };
  } catch (e) { return { ok: false, navigated: true, error: e.message || String(e) }; }
}
async function waitTabComplete(tabId, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await chrome.tabs.get(tabId); if (t.status === 'complete') return; await sleep(300); }
}
async function waitForMain(tabId, ms) {
  const end = Date.now() + ms; let bannerShown = false;
  setStatus('Waiting for you to enter the OTP in the ERP window…', 'busy');
  log('Waiting for OTP (enter it in the ERP window and click Proceed)');
  while (Date.now() < end) {
    checkStop();
    const t = await chrome.tabs.get(tabId);
    if (/\/main/.test(t.url || '')) return;
    if (/\/secure/.test(t.url || '') && t.status === 'complete' && !bannerShown) {
      bannerShown = true; await call(tabId, 'banner', 'Smoke Tester: enter the OTP and click Proceed');
    }
    await sleep(1000);
  }
  throw new Error('OTP was not completed within the time limit');
}

/* ---------------- screen capture + stamping ---------------- */
async function startCapture() {
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor', frameRate: 5 }, audio: false,
    selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'include'
  });
  const track = stream.getVideoTracks()[0];
  const surface = track.getSettings().displaySurface;
  if (surface && surface !== 'monitor') {
    stream.getTracks().forEach(t => t.stop()); stream = null;
    throw new Error('Please choose "Entire Screen" (not a window or tab)');
  }
  track.addEventListener('ended', () => { if (running) { stopFlag = true; log('Screen sharing was stopped', 'bad'); } });
  video = document.createElement('video'); video.muted = true; video.srcObject = stream;
  try { await video.play(); } catch (e) {}
}
async function grab() {
  const track = stream.getVideoTracks()[0];
  if (window.ImageCapture) { try { return await new ImageCapture(track).grabFrame(); } catch (e) {} }
  return await createImageBitmap(video);
}
function fit(g, t, max) {
  if (g.measureText(t).width <= max) return t;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}
async function stampFrame(bmp, text, status, time) {
  const k = Math.min(1, 1920 / bmp.width), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k), bar = 44;
  const c = document.createElement('canvas'); c.width = w; c.height = h + bar;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  g.fillStyle = status === 'PASS' ? '#14532d' : '#7f1d1d'; g.fillRect(0, h, w, bar);
  g.fillStyle = '#fff'; g.font = 'bold 19px Arial'; g.textBaseline = 'middle';
  const when = time.toLocaleString('en-GB', { hour12: false });
  g.textAlign = 'right'; g.fillText(when, w - 14, h + bar / 2);
  const maxW = w - g.measureText(when).width - 60;
  g.textAlign = 'left'; g.fillText(fit(g, text, maxW), 14, h + bar / 2);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return { blob, jpeg: new Uint8Array(await blob.arrayBuffer()), w, h: h + bar };
}
async function shot(label, status, note = '') {
  await sleep(900);                         // let the screen repaint before grabbing
  const bmp = await grab(), time = new Date();
  const n = String(pages.length + 1).padStart(2, '0');
  const out = await stampFrame(bmp, `#${n}  ${label}  |  ${status}${note ? '  |  ' + note : ''}`, status, time);
  if (bmp.close) bmp.close();
  pages.push({ jpeg: out.jpeg, w: out.w, h: out.h, label, status, note, time });
  addThumb(out.blob, label, status);
  log(`${status}  ${label}${note ? ' — ' + note : ''}`, status === 'PASS' ? 'ok' : 'bad');
}

/* ---------------- PDF (no library: JPEG pages written directly) ---------------- */
function buildPdf(list) {
  const enc = new TextEncoder(), parts = [], off = []; let pos = 0;
  const put = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); pos += b.length; };
  const obj = (n, body) => { off[n] = pos; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
  put('%PDF-1.4\n'); put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  const N = list.length, total = 2 + 3 * N;
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${N} /Kids [${list.map((_, i) => `${5 + i * 3} 0 R`).join(' ')}] >>`));
  list.forEach((p, i) => {
    const im = 3 + i * 3, ct = 4 + i * 3, pg = 5 + i * 3;
    const pw = (p.w * 0.75).toFixed(2), ph = (p.h * 0.75).toFixed(2);
    obj(im, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      put(p.jpeg); put('\nendstream');
    });
    const c = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(ct, () => put(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`));
    obj(pg, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`));
  });
  const xref = pos;
  put(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= total; n++) put(String(off[n]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}
async function summaryFrame(cfg) {
  const rowH = 36, W = 1920, H = Math.max(1080, 270 + pages.length * rowH + 40);
  const passed = pages.filter(p => p.status === 'PASS').length, failed = pages.length - passed;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.textBaseline = 'middle';
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0b2a4a'; g.fillRect(0, 0, W, 110);
  g.fillStyle = '#fff'; g.font = 'bold 40px Arial'; g.fillText('Production Smoke Test Report', 40, 55);
  g.fillStyle = '#111'; g.font = '22px Arial';
  g.fillText(`${cfg.baseUrl}   |   User: ${cfg.user}   |   ${new Date().toLocaleString('en-GB', { hour12: false })}`, 40, 148);
  g.font = 'bold 26px Arial'; g.fillStyle = failed ? '#b91c1c' : '#15803d';
  g.fillText(`Result: ${passed} passed, ${failed} failed  (${pages.length} screenshots)`, 40, 190);
  const cols = [40, 110, 820, 960, 1100];
  g.fillStyle = '#0b2a4a'; g.fillRect(30, 222, W - 60, rowH);
  g.fillStyle = '#fff'; g.font = 'bold 20px Arial';
  ['#', 'Screen / step', 'Status', 'Time', 'Note'].forEach((t, i) => g.fillText(t, cols[i], 222 + rowH / 2));
  pages.forEach((p, i) => {
    const y = 222 + rowH * (i + 1);
    g.fillStyle = i % 2 ? '#f1f5f9' : '#fff'; g.fillRect(30, y, W - 60, rowH);
    g.font = '20px Arial'; g.fillStyle = '#111';
    g.fillText(String(i + 1).padStart(2, '0'), cols[0], y + rowH / 2);
    g.fillText(fit(g, p.label, 690), cols[1], y + rowH / 2);
    g.font = 'bold 20px Arial'; g.fillStyle = p.status === 'PASS' ? '#15803d' : '#b91c1c';
    g.fillText(p.status, cols[2], y + rowH / 2);
    g.font = '20px Arial'; g.fillStyle = '#111';
    g.fillText(p.time.toLocaleTimeString('en-GB'), cols[3], y + rowH / 2);
    g.fillText(fit(g, p.note || '', W - cols[4] - 50), cols[4], y + rowH / 2);
  });
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), w: W, h: H };
}
function fileStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
async function downloadPdf(blob) {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: `ERP-smoke-test_${fileStamp()}.pdf` });
}
$('pdf').onclick = () => lastPdf && downloadPdf(lastPdf);
$('stop').onclick = () => { stopFlag = true; log('Stop requested…'); };

/* ---------------- the run ---------------- */
$('start').onclick = run;
async function run() {
  if (running) return;
  const cfg = {
    baseUrl: $('baseUrl').value.trim(), user: $('username').value.trim(), pass: $('password').value,
    waitMs: +$('waitMs').value || 4000, otpMs: (+$('otpMin').value || 5) * 60000,
    closeSel: $('closeSel').value.trim(), logoutSel: $('logoutSel').value.trim()
  };
  const list = screens.filter(s => (s.name || '').trim());
  if (!cfg.baseUrl || !cfg.user || !cfg.pass) return alert('Enter the URL, username and password.');
  if (!list.length) return alert('Add at least one screen.');

  running = true; stopFlag = false; pages = []; lastPdf = null;
  $('log').innerHTML = ''; $('gallery').innerHTML = ''; $('pdf').disabled = true; setButtons(true);
  let win = null, tabId = null, appWin = null, loggedIn = false, runError = '';

  try {
    setStatus('Choose "Entire Screen" and click Share…', 'busy');
    await startCapture();                                  // must be the first await (needs the click)
    appWin = await chrome.windows.getCurrent();
    log('Screen capture started');

    win = await chrome.windows.create({ url: cfg.baseUrl, state: 'maximized', focused: true });
    tabId = win.tabs[0].id;
    await waitTabComplete(tabId); await sleep(2000);
    setStatus('Running…', 'busy');

    await shot('Login page (before login)', 'PASS');

    // ---- login ----
    checkStop();
    must(await call(tabId, 'clickText', 'Sign in with OTP', 15000));
    await sleep(1200);
    must(await call(tabId, 'fillLogin', cfg.user, cfg.pass));
    await sleep(500);
    const lr = await call(tabId, 'clickText', 'LOGIN', 8000);
    if (!lr.ok && !lr.navigated) throw new Error(lr.error);
    await waitForMain(tabId, cfg.otpMs);
    await waitTabComplete(tabId);
    must(await call(tabId, 'waitHome', 40000));
    loggedIn = true; setStatus('Running…', 'busy');
    await sleep(1500);
    await shot('After login (home page)', 'PASS');

    // ---- screens ----
    for (let i = 0; i < list.length; i++) {
      checkStop();
      const s = list[i]; let status = 'PASS', note = '';
      setStatus(`Screen ${i + 1}/${list.length}: ${s.name}`, 'busy');
      try {
        await call(tabId, 'closeScreens', cfg.closeSel);             // close the previous screen first
        must(await call(tabId, 'openScreen', s.name.trim(), cfg.waitMs));
        if (s.type === 'latest') {
          const r = must(await call(tabId, 'searchSelectLatest',
            { value: s.value || '%', dateColumn: s.dateColumn || 'Booking Date', waitMs: cfg.waitMs }));
          note = r.note || '';
        }
        const e = await call(tabId, 'pageError');
        if (e.ok && e.found) { status = 'FAIL'; note = `Error text on page: ${e.found}`; }
      } catch (err) { status = 'FAIL'; note = err.message; }
      await shot(s.name, status, note);
    }

    // ---- logout ----
    checkStop();
    setStatus('Logging out…', 'busy');
    await call(tabId, 'closeScreens', cfg.closeSel);
    let st = 'PASS', note = '';
    const out = await call(tabId, 'logout', cfg.logoutSel);
    if (!out.ok && !out.navigated) { st = 'FAIL'; note = out.error; }
    else {
      loggedIn = false; await sleep(2500); await waitTabComplete(tabId); await sleep(2500);
      const t = await chrome.tabs.get(tabId);
      if (/\/main/.test(t.url || '')) { st = 'FAIL'; note = 'Still on /main after logout'; loggedIn = true; }
    }
    await shot('After logout', st, note);
  } catch (e) {
    runError = e.message; log('Run ended early: ' + runError, 'bad');
  } finally {
    if (loggedIn && tabId) { try { await call(tabId, 'logout', cfg.logoutSel); log('Best-effort logout done'); } catch (e) {} }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (pages.length) {
      try {
        const sum = await summaryFrame(cfg);
        lastPdf = buildPdf([sum, ...pages]); $('pdf').disabled = false;
        await downloadPdf(lastPdf);
        log('PDF downloaded', 'ok');
      } catch (e) { log('PDF error: ' + e.message, 'bad'); }
    }
    const failed = pages.filter(p => p.status !== 'PASS').length;
    setStatus(`Finished: ${pages.length - failed} passed, ${failed} failed${runError ? ' (stopped early)' : ''}`, failed || runError ? 'bad' : 'ok');
    await sleep(1000);
    if (win) { try { await chrome.windows.remove(win.id); } catch (e) {} }
    if (appWin) { try { await chrome.windows.update(appWin.id, { focused: true }); } catch (e) {} }
    running = false; setButtons(false);
  }
}

loadState();
