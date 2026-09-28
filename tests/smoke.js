// End-to-end smoke test (Playwright + Chromium).
//   npx http-server -p 8765 -s .   (from the repo root, in another terminal)
//   node tests/smoke.js
// Covers: v1→v2 migration, resumable moment flow, draft persistence, log, archive,
// delete + undo, CSV/JSON export, clear + undo, import, progress, CSP / third-party
// requests, and offline reload through the service worker.
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:8765/';
let failures = 0;
function check(cond, name) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const foreign = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) foreign.push(r.url()); });

  const logsV2 = () => page.evaluate(() => JSON.parse(localStorage.getItem('tactical_logs_v2')));
  const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem('tactical_draft_v2')));
  const nav = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(150); };

  // ---- 1. v1 → v2 migration -------------------------------------------------
  await page.goto(BASE + 'index.html');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('tactical_logs_v1', JSON.stringify([
      { id: 1735689600000, date: '١ يناير', situation: 'legacy <script>x</script>', thought: 'قديم', intensity: '7', response: 'رد' }
    ]));
  });
  await page.reload();
  await page.waitForTimeout(300);
  let store = await logsV2();
  check(store && store.schemaVersion === 2 && store.logs.length === 1, 'v1 logs migrated into v2 envelope');
  check(store.logs[0].before === 7 && store.logs[0].source === 'legacy' && store.logs[0].id === '1735689600000', 'v1 intensity→before, id stringified, source=legacy');
  check(await page.evaluate(() => localStorage.getItem('tactical_logs_v1') !== null), 'v1 key kept untouched as fallback');

  // ---- 2. step-count copy ---------------------------------------------------
  check((await page.textContent('#sos-sub')).includes('٤ خطوات'), 'home copy says 4 steps');
  check(await page.locator('#moment-progress i').count() === 4, 'progress bar has 4 segments');

  // ---- 3. moment flow is resumable -----------------------------------------
  await page.click('.sos');
  await page.click('[data-group="body"] .chip >> nth=0');
  await page.click('[data-group="mind"] .chip >> nth=1');
  await page.fill('#m-before', '8');
  await page.dispatchEvent('#m-before', 'input');
  await page.click('.step.active .btn-gold');           // → step 2 (pause)
  await page.click('.step.active .btn-gold');           // → step 3 (containment)
  await nav('home');
  check((await page.textContent('#sos-sub')).includes('استكمال'), 'home offers to resume the unfinished moment');
  await page.click('.sos');
  check(await page.getAttribute('.step.active', 'data-step') === '2', 'moment resumes at the same step');
  check(await page.locator('#screen-moment .chip[aria-pressed="true"]').count() === 2, 'selected signals restored');
  check(await page.inputValue('#m-before') === '8', 'arousal rating restored');
  check(await page.isVisible('#moment-restart'), '"new situation" control visible when resumed');

  // stale moments (>1 h) start fresh
  await page.evaluate(() => {
    const m = JSON.parse(localStorage.getItem('tactical_moment_v2'));
    m.updatedAt -= 2 * 3600e3;
    localStorage.setItem('tactical_moment_v2', JSON.stringify(m));
  });
  await nav('home'); await nav('moment');
  check(await page.getAttribute('.step.active', 'data-step') === '0', 'stale moment (>1h) starts fresh');

  // complete a moment
  await page.click('[data-group="behavior"] .chip >> nth=2');
  await page.click('.step.active .btn-gold');
  await page.click('.step.active .btn-gold');
  await page.click('.step.active .btn-gold');
  await page.click('.question >> nth=1');
  await page.click('.step.active .btn-gold');
  check(await page.getAttribute('.step.active', 'data-step') === '4', 'reaches closing rating');
  check(await page.locator('#moment-progress i.on').count() === 4, 'closing rating shows all 4 segments complete');
  await page.click('text=احفظ مسودة وأكمل لاحقاً');
  await page.waitForTimeout(200);

  // ---- 4. draft keeps full state -------------------------------------------
  let d = await draft();
  check(d && d.question === 'ما أصعب جزء واجهته في ذلك؟', 'draft stores the chosen question as its own field');
  check(d.signals.length === 1 && d.source === 'moment' && typeof d.ts === 'number', 'draft stores signals, source and start time');
  check(d.behaviors && d.behaviors.asked === true && d.behaviors.noInterrupt === false, 'draft pre-fills only "asked"');
  check(await page.evaluate(() => localStorage.getItem('tactical_moment_v2') === null), 'finished moment is cleared');
  check((await page.textContent('#home-count')).includes('مسودة'), 'home shows pending draft');

  await page.click('.tile:has-text("تسجيل موقف")');
  await page.waitForTimeout(150);
  check(await page.inputValue('#f-question') === d.question, 'log form restores question');
  check(await page.isVisible('#draft-bar'), 'draft bar visible');
  check(!(await page.isVisible('#install-btn')), 'install button hidden until the browser offers install');
  await page.click('#trigger-chips .chip >> nth=1');
  await page.fill('#f-situation', 'اجتماع الفريق <img src=x onerror=alert(1)>');
  await page.fill('#f-thought', 'لا يستحق');
  await page.waitForTimeout(500);
  await page.reload();                                  // simulate leaving the app mid-form
  await nav('log');
  check(await page.inputValue('#f-situation') === 'اجتماع الفريق <img src=x onerror=alert(1)>', 'typed text survives reload (auto-saved draft)');
  check(await page.locator('#trigger-chips .chip[aria-pressed="true"]').count() === 1, 'trigger survives reload');
  await page.fill('#f-response', 'سألت وبقيت مستمعاً');
  await page.check('[data-behavior="noInterrupt"]');
  await page.check('[data-behavior="present"]');
  await page.check('[data-behavior="noDevalue"]');
  await page.click('#log-form button[type=submit]');
  await page.waitForTimeout(300);

  store = await logsV2();
  const saved = store.logs.find((l) => l.source === 'moment');
  check(store.logs.length === 2 && saved && saved.question && saved.behaviors.noDevalue === true, 'entry saved with question and behaviours');
  check(await draft() === null, 'draft cleared after save');
  check(await page.locator('#logs img').count() === 0 && await page.locator('#logs script').count() === 0, 'user text is escaped (no injected elements)');

  // ---- 5. delete + undo -----------------------------------------------------
  await page.click('[data-del] >> nth=0');
  check((await logsV2()).logs.length === 1, 'delete removes entry');
  await page.click('#toast-action');
  check((await logsV2()).logs.length === 2, 'undo restores deleted entry');

  // ---- 6. export ------------------------------------------------------------
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("تصدير (Excel)")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check(csv.charCodeAt(0) === 0xFEFF && csv.includes('السؤال') && csv.split('\r\n').length === 3, 'CSV has BOM, new columns, 2 rows');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("نسخة احتياطية")')]);
  const backupPath = await dl.path();
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  check(backup.schemaVersion === 2 && backup.logs.length === 2, 'JSON backup carries schemaVersion 2');

  // ---- 7. clear + undo, then clear + import ---------------------------------
  page.once('dialog', (dlg) => dlg.accept());
  await page.click('#clear-btn');
  check((await logsV2()).logs.length === 0, 'clear empties archive');
  check(!(await page.isVisible('#clear-btn')), '"clear archive" button hidden when archive is empty');
  await page.click('#toast-action');
  check((await logsV2()).logs.length === 2, 'undo restores cleared archive');
  page.once('dialog', (dlg) => dlg.accept());
  await page.click('#clear-btn');
  await page.waitForTimeout(300);
  await page.setInputFiles('#import-file', backupPath);
  await page.waitForTimeout(300);
  check((await logsV2()).logs.length === 2, 'import restores from backup');
  await page.setInputFiles('#import-file', backupPath);
  await page.waitForTimeout(300);
  check((await logsV2()).logs.length === 2, 're-import does not duplicate');

  // ---- 8. progress ----------------------------------------------------------
  await nav('progress');
  const prog = await page.textContent('#progress-body');
  check(prog.includes('متوسط التغيّر في الاستثارة') && !prog.includes('الانخفاض'), 'progress uses "change in arousal" wording');
  check(prog.includes('مواقف دون سلوك دفاعي') && prog.includes('من ١ موقفاً'), 'behavioural indicators computed over entries that recorded behaviour');
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/progress.png' : '/dev/null', fullPage: true }).catch(() => {});

  // ---- 9. offline via service worker ---------------------------------------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();                                   // now controlled by the SW
  await page.waitForTimeout(500);
  await nav('home');
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(500);
  check(await page.isVisible('.sos'), 'app loads offline');
  check(await page.evaluate(() => document.fonts.check('700 16px Cairo', 'أ')), 'Cairo font available offline');
  await ctx.setOffline(false);

  // ---- 10. privacy ----------------------------------------------------------
  check(foreign.length === 0, 'no third-party requests' + (foreign.length ? ': ' + foreign.join(', ') : ''));
  const realErrors = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e));
  check(realErrors.length === 0, 'no console / CSP errors' + (realErrors.length ? ': ' + realErrors.join(' | ') : ''));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
