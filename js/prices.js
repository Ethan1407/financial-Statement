// ==========================================
// 股價走勢頁（prices.html）
// A. 自選股價格總覽：盤中每 15 秒更新即時成交價，非盤中顯示收盤價
// B. 個股 K 線：日／週／月 K、均線、成交量、財報燈號與法說會標記
// C. 長期趨勢：本益比河流圖、報酬率比較（還原權息）
// 後端：prices.py（/api/prices/live、/api/prices/history/<代號>、/api/prices/summary）
// ==========================================

const PX_PREFS_KEY = 'prices_prefs';
const PX_ID_RE = /^[0-9]{4,6}[A-Za-z]?$/;
const PX_MAX_IDS = 60;                     // 即時報價：後端一次最多 60 檔
const PX_SUMMARY_BATCH = 10;               // 近一月走勢、52 週區間：後端一次最多 10 檔
const PX_CLOSED_RECHECK_MAX = 30 * 60;     // 非盤中最多 30 分鐘重新整理一次（秒）
const PX_ERROR_RETRY = 30;                 // 失敗後 30 秒重試（主機可能正在喚醒）
const PX_MA = [5, 20, 60];
const PX_MA_COLORS = { 5: '#f59e0b', 20: '#a855f7', 60: '#0ea5e9' };
const PX_BAND_COLORS = ['#10b981', '#84cc16', '#eab308', '#f97316', '#ef4444'];
const PX_COMPARE_COLORS = ['#3b82f6', '#f59e0b', '#a855f7', '#10b981', '#ef4444', '#0ea5e9', '#ec4899', '#84cc16'];
const PX_COMPARE_MAX = 8;
const PX_RANGE_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 };
const PX_BENCHMARK = '0050';
const PX_TABLE_MAX = 10;                   // 價格表最多顯示 10 檔，其餘放在下拉選單

const PX = {
  quotes: {}, summary: {}, status: null, liveError: null, timer: null, lastFetchAt: 0, nextDelay: 15, fetching: false,
  prevPrice: {}, history: {}, historyPending: {}, conf: {}, fin: {},
  selected: null, extra: null, chart: null, series: null, bars: [], barIndex: new Map(), maValues: {}, markerInfo: new Map(),
  longChart: null, longToken: 0,
  prefs: {
    sort: 'order', range: '6M', period: 'D', ma5: true, ma20: true, ma60: false,
    adjusted: false, fin: true, conf: true, ex: false, longTab: 'pe', compareRange: '3Y', compare: null, selected: null
  }
};

// ================= 共用小工具 =================
function pxLoadPrefs() {
  try { Object.assign(PX.prefs, JSON.parse(localStorage.getItem(PX_PREFS_KEY)) || {}); } catch {}
}
function pxSavePrefs() {
  try { localStorage.setItem(PX_PREFS_KEY, JSON.stringify(PX.prefs)); } catch {}
}
function pxIds() { return (portfolio || []).filter(id => PX_ID_RE.test(id)); }
// 要抓報價的代號：自選股＋用查詢框看的那一檔（不在自選股內）
function pxQuoteIds() {
  const ids = pxIds();
  return PX.extra && !ids.includes(PX.extra) ? [...ids, PX.extra] : ids;
}
function pxName(id) {
  const d = loadStockDatabase()[id];
  return (d && d.name) || (PX.quotes[id] && PX.quotes[id].name) || '';
}
function pxFmt(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2);
  return Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pxSigned(v, digits) { return v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${pxFmt(v, digits)}`; }
function pxPct(v) { return v === null || v === undefined || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`; }
function pxDir(v) { return !v ? 'px-flat' : (v > 0 ? 'px-up' : 'px-down'); }
function pxShortDate(iso) { return iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : ''; }
function pxChunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// 'YYYY-MM-DD' ↔ UTC Date，避免時區造成日期差一天
function pxDate(iso) { return new Date(`${iso}T00:00:00Z`); }
function pxIso(d) { return d.toISOString().slice(0, 10); }
function pxMonthsBefore(iso, months) { const d = pxDate(iso); d.setUTCMonth(d.getUTCMonth() - months); return pxIso(d); }
// Lightweight Charts 回傳的時間可能是字串、{year,month,day} 或秒數
function pxTimeKey(t) {
  if (typeof t === 'string') return t;
  if (typeof t === 'number') return pxIso(new Date(t * 1000));
  if (t && t.year) return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return null;
}

async function pxGetJson(path, timeoutMs = 30000) {
  if (typeof whenBackendReady === 'function') await whenBackendReady(); // 主機醒來後才出發（見 app.js）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(httpErrorReason(res.status, body));
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('連線逾時：主機可能正在從睡眠中喚醒，稍後會自動重試');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function pxErr(err) { return fetchErrorReason(err); }

function pxShowMsg(id, html) { const el = document.getElementById(id); if (el) { el.innerHTML = html; el.style.display = 'flex'; } }
function pxHideMsg(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function pxThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return {
    text: v('--text-light', '#9ca3af'), strong: v('--text', '#f9fafb'), border: v('--border', '#374151'), bg: v('--card-bg', '#1f2937'),
    red: v('--red', '#ef4444'), green: v('--green', '#10b981'), primary: v('--primary', '#3b82f6')
  };
}
function pxChartOptions(c, extra = {}) {
  return {
    autoSize: true,
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: c.border }, horzLines: { color: c.border } },
    rightPriceScale: { borderColor: c.border },
    // 最右邊固定在最新一根 K 棒，不能再往右拉到沒有資料的未來
    timeScale: { borderColor: c.border, rightOffset: 0, fixRightEdge: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
    ...extra
  };
}
function pxChartLibReady(msgId) {
  if (window.LightweightCharts) return true;
  pxShowMsg(msgId, '圖表元件載入失敗，請確認網路連線後重新整理頁面。');
  return false;
}

// ================= 初始化 =================
function initPrices() {
  pxLoadPrefs();
  document.getElementById('px-sort').value = PX.prefs.sort;
  pxBindToolbar();

  pxInitSearch();
  pxBindTip();
  const ids = pxIds();
  // 網址 ?id=、上次看的股票（可能是查詢的、不在自選股內），都沒有就看第一檔自選股
  const urlId = (new URLSearchParams(location.search).get('id') || '').toUpperCase();
  const start = [urlId, PX.prefs.selected, ids[0]].find(id => PX_ID_RE.test(id || ''));
  if (!ids.length) {
    document.getElementById('px-empty').style.display = 'block';
    document.querySelector('#px-table').style.display = 'none';
  }
  if (start && !ids.includes(start)) PX.extra = start;
  PX.selected = start || null;
  pxFillStockSelect();
  pxRenderTable();
  pxRenderStatus();
  if (!start) {
    pxShowMsg('px-chart-msg', '請用上方的查詢框輸入股票代號或名稱。');
    pxShowMsg('px-long-msg', '請用上方的查詢框輸入股票代號或名稱。');
  } else {
    pxFetchLive();
    pxFetchSummary();
    pxSelect(PX.selected, false);
  }

  // 分頁切到背景時暫停自動更新，回來時立刻補一次
  document.addEventListener('visibilitychange', () => {
    clearTimeout(PX.timer);
    if (document.hidden) return;
    const waited = (Date.now() - PX.lastFetchAt) / 1000;
    if (waited >= PX.nextDelay) pxFetchLive();
    else PX.timer = setTimeout(pxFetchLive, (PX.nextDelay - waited) * 1000);
  });
  // 主機（重新）醒來後：補抓先前失敗的資料
  window.addEventListener('backendready', () => {
    // 只補失敗的；正在等主機、還在路上的請求不重複發
    if (PX.liveError && !PX.fetching) pxFetchLive();
    const failed = Object.keys(PX.summary).filter(id => PX.summary[id] && PX.summary[id].error);
    if (failed.length) {
      failed.forEach(id => delete PX.summary[id]);
      pxFetchSummary();
    }
    if (PX.selected && !PX.history[PX.selected] && !PX.historyPending[PX.selected]) pxSelect(PX.selected, false);
  });
  window.addEventListener('themechange', () => {
    pxRebuildMainChart();
    pxRenderLong();
  });
}

function pxBindToolbar() {
  const bindSeg = (id, key, after) => {
    const seg = document.getElementById(id);
    const sync = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === PX.prefs[key]));
    seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      PX.prefs[key] = b.dataset.v;
      pxSavePrefs();
      sync();
      after();
    });
    sync();
  };
  bindSeg('px-range', 'range', () => pxApplyRange());
  bindSeg('px-period', 'period', () => { pxUpdateMaLabels(); pxRenderChart(false); });

  document.querySelectorAll('#px-toggles input[data-opt]').forEach(input => {
    const key = input.dataset.opt;
    input.checked = !!PX.prefs[key];
    input.addEventListener('change', async () => {
      PX.prefs[key] = input.checked;
      pxSavePrefs();
      if (key === 'conf' && input.checked && PX.selected) await pxLoadConf(PX.selected);
      pxRenderChart(true);
    });
  });
  pxUpdateMaLabels();
}

function pxUpdateMaLabels() {
  const unit = { D: '日', W: '週', M: '月' }[PX.prefs.period] || '日';
  PX_MA.forEach(n => {
    const label = document.querySelector(`#px-toggles input[data-opt="ma${n}"]`).parentElement;
    label.querySelector('.px-ma-text').textContent = `${n} ${unit}均線`;
  });
}

function pxFillStockSelect() {
  const sel = document.getElementById('px-stock');
  const ids = pxQuoteIds();
  sel.innerHTML = ids.map(id => `<option value="${id}">${id} ${escapeHtml(pxName(id))}${id === PX.extra ? '（查詢）' : ''}</option>`).join('');
  if (PX.selected) sel.value = PX.selected;
  sel.style.display = ids.length ? '' : 'none';
}

// ================= 查詢股票 =================
let pxSearchAc = null;
function pxInitSearch() {
  const input = document.getElementById('px-search-input');
  if (!input || typeof attachStockAutocomplete !== 'function') return;
  pxSearchAc = attachStockAutocomplete(input, async id => {
    if (!PX_ID_RE.test(id)) return false;
    pxShowStock(id);
    return true;
  }, document.getElementById('px-search-hint'));
}
function pxSearchSubmit() { if (pxSearchAc) pxSearchAc.submit(); }

// 看任一檔股票：不在自選股內的記為 extra，一起抓即時報價
function pxShowStock(id) {
  const ids = pxIds();
  const isNew = !ids.includes(id) && PX.extra !== id;
  if (!ids.includes(id)) PX.extra = id;
  pxFillStockSelect();
  pxSelect(id, true);
  if (isNew || !PX.quotes[id]) pxFetchLive();
}

// ================= A. 即時／收盤價 =================
async function pxFetchLive() {
  clearTimeout(PX.timer);
  const ids = pxQuoteIds();
  if (!ids.length) return;
  if (PX.fetching) { PX.refetch = true; return; } // 正在抓時又查了新股票，抓完再補一次
  PX.fetching = true;
  let next = PX_ERROR_RETRY;
  try {
    const parts = await Promise.all(pxChunks(ids, PX_MAX_IDS).map(chunk => pxGetJson(`/api/prices/live?ids=${chunk.join(',')}`, 25000)));
    const quotes = {};
    parts.forEach(p => Object.assign(quotes, p.quotes));
    PX.quotes = quotes;
    PX.status = { ...parts[0], marketOpen: parts.some(p => p.marketOpen), warning: parts.map(p => p.warning).find(Boolean) || null };
    PX.liveError = null;
    PX.lastFetchAt = Date.now();
    // 後端依時段決定下次更新時間（盤中 15 秒、剛開盤 30 秒、其他時間最多 30 分鐘）
    next = Math.max(5, Math.min(PX_CLOSED_RECHECK_MAX, Math.min(...parts.map(p => p.nextRefreshSeconds || PX_CLOSED_RECHECK_MAX))));
  } catch (err) {
    PX.liveError = pxErr(err);
  } finally {
    PX.fetching = false;
  }
  PX.nextDelay = next;
  pxRenderStatus();
  pxRenderTable();
  // 第一次拿到報價後補上下拉選單的股名（之後不再重建，避免手機上打開中的選單被關掉）
  if (!PX.selectNamed && PX.status) { PX.selectNamed = true; pxFillStockSelect(); }
  pxRenderChartTitle();
  if (PX.chart && PX.history[PX.selected]) pxRenderChart(true);
  if (PX.refetch) { PX.refetch = false; next = 0.2; }
  if (!document.hidden) PX.timer = setTimeout(pxFetchLive, next * 1000);
}

async function pxFetchSummary() {
  const ids = pxIds();
  if (!ids.length) return;
  try {
    // 每次 10 檔、依序送出：第一次每檔都要抓日 K，一次要太多會被主機逾時中斷
    const parts = [];
    for (const chunk of pxChunks(ids, PX_SUMMARY_BATCH)) {
      parts.push(await pxGetJson(`/api/prices/summary?ids=${chunk.join(',')}`, 90000));
      parts.forEach(p => Object.assign(PX.summary, p.summary));
      pxRenderTable();
    }
    parts.forEach(p => Object.assign(PX.summary, p.summary));
  } catch (err) {
    ids.forEach(id => { if (!PX.summary[id]) PX.summary[id] = { error: pxErr(err) }; });
  }
  pxRenderTable();
}

function pxRefreshNow() {
  PX.summary = {};
  pxFetchLive();
  pxFetchSummary();
}

function pxSetSort(v) {
  PX.prefs.sort = v;
  pxSavePrefs();
  pxRenderTable();
}

function pxRenderStatus() {
  const el = document.getElementById('px-status');
  const st = PX.status;
  const waiting = typeof isBackendReady === 'function' && !isBackendReady();
  let state = 'loading', text = waiting ? '等待主機喚醒（約 1 分鐘），醒來後會自動載入股價…' : '股價載入中…';
  if (!pxQuoteIds().length) {
    state = 'closed'; text = '沒有自選股，可以用上方的查詢框看任一檔股票';
  } else if (PX.liveError && !st) {
    state = 'error'; text = `股價載入失敗：${PX.liveError}（${PX_ERROR_RETRY} 秒後自動重試）`;
  } else if (st) {
    const time = new Date(PX.lastFetchAt).toLocaleTimeString('zh-TW', { hour12: false });
    if (st.realtime === false) {
      // 未開啟即時報價：只用證交所／櫃買中心開放資料的每日收盤價
      state = 'closed';
      const dates = Object.values(PX.quotes).filter(Boolean).map(q => q.date).filter(Boolean).sort();
      const latest = dates[dates.length - 1];
      text = `顯示 ${latest ? pxShortDate(latest) + ' ' : '最近一個交易日的'}收盤價（證交所、櫃買中心開放資料，每個交易日收盤後更新）`;
    } else if (st.marketOpen) {
      state = 'open';
      text = `盤中即時：每 ${st.pollSeconds || 15} 秒自動更新，最後更新 ${time}`;
    } else {
      state = 'closed';
      const dates = Object.values(PX.quotes).filter(Boolean).map(q => q.date).filter(Boolean).sort();
      const latest = dates[dates.length - 1];
      text = `非交易時間：顯示 ${latest ? pxShortDate(latest) + ' ' : ''}收盤價`;
      if (st.nextOpenInSeconds !== null && st.nextOpenInSeconds < 18 * 3600) text += '，開盤（9:00）後會自動切換成即時報價';
    }
    if (st.warning) text += `。⚠️ ${st.warning}`;
    if (PX.liveError) { state = 'error'; text += `。⚠️ 最近一次更新失敗：${PX.liveError}`; }
  }
  el.dataset.state = state;
  el.innerHTML = `<span class="px-live-dot" aria-hidden="true"></span>${escapeHtml(text)}`;
}

function pxTtmEps(data) {
  const qs = (data && data.quarters) || [];
  if (qs.length < 4) return null;
  const eps = qs.slice(-4).map(q => q.eps);
  if (eps.some(v => typeof v !== 'number')) return null;
  return eps.reduce((a, b) => a + b, 0);
}

function pxPe(id, db) {
  if (isEtfId(id)) return { value: null, text: '—', title: 'ETF 沒有本益比' };
  const q = PX.quotes[id];
  const ttm = pxTtmEps(db[id]);
  if (ttm === null) return { value: null, text: '—', title: '尚未取得財報（到首頁更新後即可計算）' };
  if (ttm <= 0) return { value: null, text: '虧損', title: `近 4 季 EPS 合計 ${ttm.toFixed(2)} 元` };
  if (!q) return { value: null, text: '—', title: '' };
  const pe = q.price / ttm;
  return { value: pe, text: `${pe.toFixed(1)} 倍`, title: `近 4 季 EPS 合計 ${ttm.toFixed(2)} 元` };
}

function pxSortedIds(db) {
  const ids = pxIds();
  const chg = id => (PX.quotes[id] && PX.quotes[id].changePct) ?? null;
  const by = {
    order: () => ids,
    id: () => [...ids].sort(),
    chgDesc: () => [...ids].sort((a, b) => (chg(b) ?? -Infinity) - (chg(a) ?? -Infinity)),
    chgAsc: () => [...ids].sort((a, b) => (chg(a) ?? Infinity) - (chg(b) ?? Infinity)),
    pe: () => [...ids].sort((a, b) => (pxPe(a, db).value ?? Infinity) - (pxPe(b, db).value ?? Infinity))
  };
  return (by[PX.prefs.sort] || by.order)();
}

// 近一月收盤價 + 今天的即時價
function pxSparkSeries(id) {
  const s = PX.summary[id];
  if (!s || !s.spark) return null;
  const closes = s.spark.slice();
  const q = PX.quotes[id];
  if (q && q.date && s.lastDate) {
    if (q.date > s.lastDate) closes.push(q.price);
    else if (q.date === s.lastDate) closes[closes.length - 1] = q.price;
  }
  return closes;
}

function pxSparkSvg(closes) {
  if (!closes || closes.length < 2) return '';
  const w = 90, h = 28, min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
  const pts = closes.map((c, i) => `${(i / (closes.length - 1) * w).toFixed(1)},${(h - 2 - (c - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  const c = pxThemeColors();
  const color = closes[closes.length - 1] >= closes[0] ? c.red : c.green;
  return `<svg class="px-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" points="${pts}"/></svg>`;
}

function pxRangeHtml(id) {
  const s = PX.summary[id], q = PX.quotes[id];
  if (!s || s.high52 == null || !q) return s && s.error ? '<span class="px-sub">無資料</span>' : '';
  const low = Math.min(s.low52, q.low || q.price, q.price), high = Math.max(s.high52, q.high || q.price, q.price);
  const pos = high > low ? (q.price - low) / (high - low) * 100 : 50;
  return `<div class="px-range" title="52 週最低 ${pxFmt(low)}、最高 ${pxFmt(high)}"><span class="px-range-dot" style="left:${pos.toFixed(1)}%"></span></div>
    <div class="px-range-labels"><span>${pxFmt(low)}</span><span>${pxFmt(high)}</span></div>`;
}

function pxRenderTable() {
  const body = document.getElementById('px-table-body');
  if (!body) return;
  const db = loadStockDatabase();
  const sorted = pxSortedIds(db);
  pxRenderMoreSelect(sorted.slice(PX_TABLE_MAX));
  body.innerHTML = sorted.slice(0, PX_TABLE_MAX).map(id => {
    const q = PX.quotes[id];
    const dir = pxDir(q && q.change);
    const prev = PX.prevPrice[id];
    const flash = q && prev !== undefined && prev !== q.price ? (q.price > prev ? 'px-flash-up' : 'px-flash-down') : '';
    if (q) PX.prevPrice[id] = q.price;
    let sub = PX.status || PX.liveError ? '無報價' : '載入中';
    if (q) sub = q.source === 'live' ? `${(q.time || '').slice(0, 5)} 成交${q.estimated ? '（委買價）' : ''}` : `${pxShortDate(q.date)} 收盤`;
    const pe = pxPe(id, db);
    const spark = pxSparkSeries(id);
    return `<tr data-id="${id}" class="${id === PX.selected ? 'selected' : ''}" onclick="pxSelect('${id}')">
      <td><div class="px-name"><strong>${id}</strong><span>${escapeHtml(pxName(id))}</span></div></td>
      <td class="num ${flash}"><span class="px-price ${dir}">${q ? pxFmt(q.price) : '—'}</span><span class="px-sub">${escapeHtml(sub)}</span></td>
      <td class="num px-col-chg ${dir}">${q ? pxSigned(q.change) : '—'}</td>
      <td class="num ${dir}">${q ? pxPct(q.changePct) : '—'}</td>
      <td class="num px-col-vol">${q ? pxFmt(q.volume, 0) : '—'}</td>
      <td>${spark ? pxSparkSvg(spark) : (PX.summary[id] && PX.summary[id].error ? '<span class="px-sub">無資料</span>' : '<span class="px-sub">…</span>')}</td>
      <td class="px-col-range">${pxRangeHtml(id)}</td>
      <td class="num px-col-pe" title="${escapeHtml(pe.title)}">${pe.text}</td>
    </tr>`;
  }).join('');
}

// 表格放不下的自選股（第 11 檔以後）：清單有變才重建，避免手機上打開中的選單被每 15 秒的更新關掉
function pxRenderMoreSelect(rest) {
  const box = document.getElementById('px-more');
  const sel = document.getElementById('px-more-select');
  if (!box || !sel) return;
  box.style.display = rest.length ? '' : 'none';
  const key = rest.join(',');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    document.getElementById('px-more-label').textContent = `其他自選股（${rest.length} 檔）：`;
    sel.innerHTML = `<option value="">選擇要看的股票…</option>` +
      rest.map(id => `<option value="${id}">${id} ${escapeHtml(pxName(id))}</option>`).join('');
  }
  sel.value = rest.includes(PX.selected) ? PX.selected : '';
}

// ================= B. K 線 =================
async function pxLoadHistory(id) {
  if (PX.history[id]) return PX.history[id];
  if (!PX.historyPending[id]) {
    PX.historyPending[id] = pxGetJson(`/api/prices/history/${id}`, 90000)
      .then(data => { PX.history[id] = data; return data; })
      .finally(() => { delete PX.historyPending[id]; });
  }
  return PX.historyPending[id];
}

async function pxLoadConf(id) {
  if (PX.conf[id] || isEtfId(id)) return PX.conf[id] || [];
  try {
    const data = await pxGetJson(`/api/conferences/${id}`, 30000);
    PX.conf[id] = data.items || [];
  } catch {
    PX.conf[id] = [];
  }
  return PX.conf[id];
}

// 河流圖與財報標記需要較長的財報歷史：另外向後端要 24 季（約 6 年），只放記憶體，不改動瀏覽器存的 8 季資料
const PX_FIN_QUARTERS = 24;
async function pxLoadFin(id) {
  if (isEtfId(id)) return null;
  if (!(id in PX.fin)) {
    PX.fin[id] = pxGetJson(`/api/stock/${id}?limit=${PX_FIN_QUARTERS}`, 90000).catch(() => null);
  }
  const data = await PX.fin[id];
  PX.finData = PX.finData || {};
  if (data) PX.finData[id] = data;
  return pxFinData(id);
}
function pxFinData(id) {
  return (PX.finData && PX.finData[id]) || loadStockDatabase()[id] || null;
}

async function pxSelect(id, scroll = true) {
  if (!PX_ID_RE.test(id || '')) return;
  PX.selected = id;
  PX.prefs.selected = id;
  pxSavePrefs();
  document.getElementById('px-stock').value = id;
  document.querySelectorAll('#px-table-body tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.id === id));
  const more = document.getElementById('px-more-select');
  if (more) more.value = [...more.options].some(o => o.value === id) ? id : '';
  pxRenderChartTitle();
  if (scroll) {
    const card = document.getElementById('px-chart-card');
    if (typeof scrollToWithOffset === 'function') scrollToWithOffset(card); else card.scrollIntoView({ behavior: 'smooth' });
  }

  if (!PX.history[id]) {
    const waiting = typeof isBackendReady === 'function' && !isBackendReady();
    pxShowMsg('px-chart-msg', waiting ? '等待主機喚醒（約 1 分鐘），醒來後會自動載入 K 線…' : 'K 線資料載入中…（第一次查詢這檔需要幾秒）');
  }
  try {
    await pxLoadHistory(id);
    if (PX.selected !== id) return;
    pxRenderChart(false);
    if (!isEtfId(id)) {
      const extras = [pxLoadFin(id)];
      if (PX.prefs.conf && !PX.conf[id]) extras.push(pxLoadConf(id));
      Promise.all(extras).then(() => { if (PX.selected === id) pxRenderChart(true); });
    }
  } catch (err) {
    if (PX.selected === id) {
      pxShowMsg('px-chart-msg', `<span>K 線資料無法取得：${escapeHtml(pxErr(err))}<br><button class="btn-outline" style="margin-top:10px;" onclick="pxSelect('${id}', false)">重試</button></span>`);
    }
  }
  pxRenderLong();
}

function pxRenderChartTitle() {
  const el = document.getElementById('px-chart-title');
  const id = PX.selected;
  if (!el || !id) return;
  const q = PX.quotes[id];
  const dir = pxDir(q && q.change);
  const when = !q ? '' : (q.source === 'live' ? `盤中 ${(q.time || '').slice(0, 5)}` : `${pxShortDate(q.date)} 收盤`);
  el.innerHTML = `<strong style="font-size:1.1rem;">${id} ${escapeHtml(pxName(id))}</strong>
    <span class="px-big ${dir}">${q ? pxFmt(q.price) : '--'}</span>
    <span class="${dir}">${q ? `${pxSigned(q.change)}（${pxPct(q.changePct)}）` : ''}</span>
    <span class="px-sub">${escapeHtml(when)}</span>`;
}

// 除權息、分割：該日以前的價格乘上係數（由新往舊累乘），成交量不調整
function pxAdjust(rows, events) {
  if (!events.length) return rows;
  const ev = [...events].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const out = new Array(rows.length);
  let factor = 1, i = 0;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k];
    while (i < ev.length && r[0] < ev[i][0]) { factor *= ev[i][1]; i++; }
    out[k] = factor === 1 ? r : [r[0], r[1] * factor, r[2] * factor, r[3] * factor, r[4] * factor, r[5]];
  }
  return out;
}

// 日資料合併成週 K／月 K。time 用該期間第一個交易日，last 是最後一個交易日（標記對齊用）
function pxAggregate(rows, period) {
  if (period === 'D') return rows.map(r => ({ time: r[0], last: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  const keyOf = iso => {
    if (period === 'M') return iso.slice(0, 7);
    const d = pxDate(iso);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 該週星期一
    return pxIso(d);
  };
  const out = [];
  let cur = null, curKey = null;
  for (const r of rows) {
    const k = keyOf(r[0]);
    if (k !== curKey) {
      cur = { time: r[0], last: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] };
      curKey = k;
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, r[2]);
      cur.low = Math.min(cur.low, r[3]);
      cur.close = r[4];
      cur.volume += r[5];
      cur.last = r[0];
    }
  }
  return out;
}

// 歷史日 K + 今天的即時報價（盤中 FinMind 還沒有今天的資料）
function pxRowsWithLive(id) {
  const rows = PX.history[id].rows.slice();
  const q = PX.quotes[id];
  if (q && q.date && q.open && q.high && q.low && q.price) {
    const last = rows[rows.length - 1];
    const live = [q.date, q.open, q.high, q.low, q.price, q.volume || 0];
    if (!last || q.date > last[0]) rows.push(live);
    else if (q.date === last[0] && q.source === 'live') rows[rows.length - 1] = live;
  }
  return rows;
}

function pxBuildBars(id, opts = {}) {
  const h = PX.history[id];
  const adjusted = opts.adjusted ?? PX.prefs.adjusted;
  const events = (h.events || []).filter(e => e[2] === 'split' || (adjusted && e[2] === 'div'));
  return pxAggregate(pxAdjust(pxRowsWithLive(id), events), opts.period || PX.prefs.period);
}

function pxSma(bars, n) {
  const out = [];
  let sum = 0;
  bars.forEach((b, i) => {
    sum += b.close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: b.time, value: sum / n });
  });
  return out;
}

function pxCreateMainChart() {
  const c = pxThemeColors();
  const el = document.getElementById('px-chart');
  PX.chart = LightweightCharts.createChart(el, pxChartOptions(c));
  const candle = PX.chart.addCandlestickSeries({
    upColor: c.red, downColor: c.green, borderUpColor: c.red, borderDownColor: c.green, wickUpColor: c.red, wickDownColor: c.green
  });
  candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
  const volume = PX.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  PX.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  PX.series = { candle, volume };
  PX_MA.forEach(n => {
    PX.series[`ma${n}`] = PX.chart.addLineSeries({ color: PX_MA_COLORS[n], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  });
  PX.chart.subscribeCrosshairMove(param => { pxUpdateLegend(param); pxMarkerHover(param); });
  PX.chart.subscribeClick(pxOnChartClick);
}

function pxRebuildMainChart() {
  if (!PX.chart) return;
  const range = PX.chart.timeScale().getVisibleLogicalRange();
  PX.chart.remove();
  PX.chart = null;
  pxRenderChart(false);
  if (range && PX.chart) PX.chart.timeScale().setVisibleLogicalRange(range);
}

function pxRenderChart(keepRange) {
  const id = PX.selected;
  if (!id || !PX.history[id] || !pxChartLibReady('px-chart-msg')) return;
  const bars = pxBuildBars(id);
  if (!bars.length) { pxShowMsg('px-chart-msg', '這檔股票沒有股價資料。'); return; }
  const fresh = !PX.chart;
  if (fresh) pxCreateMainChart();
  const c = pxThemeColors();
  const range = keepRange && !fresh ? PX.chart.timeScale().getVisibleLogicalRange() : null;

  PX.bars = bars;
  PX.barIndex = new Map(bars.map((b, i) => [b.time, i]));
  PX.series.candle.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  PX.series.volume.setData(bars.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? `${c.red}80` : `${c.green}80` })));
  PX.maValues = {};
  PX_MA.forEach(n => {
    const data = PX.prefs[`ma${n}`] ? pxSma(bars, n) : [];
    PX.series[`ma${n}`].setData(data);
    PX.maValues[n] = new Map(data.map(p => [p.time, p.value]));
  });
  PX.markerList = pxBuildMarkers(id, bars);
  // 盤中每 15 秒重畫時，滑鼠正停在某個標記上的話保持放大與小視窗
  const keep = PX.tipTime && PX.markerInfo.has(PX.tipTime) ? PX.tipTime : null;
  PX.tipTime = undefined;
  PX.series.candle.setMarkers(PX.markerList);
  if (keep) pxSetEnlarged(keep); else pxHideTip();

  if (range) PX.chart.timeScale().setVisibleLogicalRange(range);
  else pxApplyRange();
  pxHideMsg('px-chart-msg');
  pxUpdateLegend(null);
}

function pxApplyRange() {
  if (!PX.chart || !PX.bars.length) return;
  const months = PX_RANGE_MONTHS[PX.prefs.range];
  if (!months) { PX.chart.timeScale().fitContent(); return; }
  const from = pxMonthsBefore(PX.bars[PX.bars.length - 1].last, months);
  let idx = PX.bars.findIndex(b => b.last >= from);
  if (idx < 0) idx = 0;
  PX.chart.timeScale().setVisibleLogicalRange({ from: idx - 0.5, to: PX.bars.length - 0.5 });
}

// 每季財報的法定公布期限（一般公司）
function pxReportDeadline(q) {
  const m = /^(\d{4})Q([1-4])$/.exec(q || '');
  if (!m) return null;
  const y = Number(m[1]);
  return ['', `${y}-05-15`, `${y}-08-14`, `${y}-11-14`, `${y + 1}-03-31`][Number(m[2])];
}

// 每一季「當下」的燈號（只用該季以前的資料，和個股詳情的歷史風險分數同一套規則）
function pxQuarterLevels(id) {
  const data = pxFinData(id);
  const analysis = typeof analyzeData === 'function' ? analyzeData(id, data) : null;
  if (!analysis) return [];
  const rules = getEffectiveRules(analysis.effectiveType);
  return data.quarters.map((q, i) => {
    const slice = data.quarters.slice(0, i + 1);
    let level = 'green';
    const names = [];
    Object.values(rules).forEach(rule => {
      const res = rule.check(slice, rule);
      if (res && res.status === 'alert') {
        names.push(rule.name);
        const lvl = res.level || rule.level;
        if (lvl === 'red') level = 'red';
        else if (level === 'green') level = 'yellow';
      }
    });
    return { q: q.q, level, names };
  });
}

function pxBuildMarkers(id, bars) {
  PX.markerInfo = new Map();
  const list = [];
  const c = pxThemeColors();
  const lastDay = bars[bars.length - 1].last;
  // 找出包含（或緊接在後）這一天的 K 棒；遇到假日會落在下一個交易日
  const snap = date => {
    if (!date || date > lastDay) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].last >= date) hi = mid; else lo = mid + 1; }
    return bars[lo].time;
  };
  // note = { text, links: [{ label, kind: 'url' | 'slide' | 'mops', value }] }，第一個連結是點標記時直接開啟的
  PX.markerById = new Map();
  const add = (date, marker, note) => {
    const time = snap(date);
    if (!time) return;
    const markerId = `m${list.length}`;
    list.push({ time, id: markerId, ...marker });
    PX.markerById.set(markerId, { time, note });
    PX.markerInfo.set(time, [...(PX.markerInfo.get(time) || []), note]);
  };

  if (PX.prefs.fin && !isEtfId(id)) {
    const label = { red: '紅燈（警戒）', yellow: '黃燈（注意）', green: '綠燈（正常）' };
    pxQuarterLevels(id).forEach(ql => {
      const date = pxReportDeadline(ql.q);
      const color = ql.level === 'red' ? c.red : (ql.level === 'yellow' ? '#f59e0b' : c.green);
      add(date, { position: 'aboveBar', color, shape: 'circle', text: ql.q.slice(4) }, {
        text: `📑 ${ql.q} 財報（公布期限 ${date}）：${label[ql.level]}${ql.names.length ? `，${ql.names.join('、')}` : ''}`,
        links: pxReportLinks(id, ql.q)
      });
    });
  }
  if (PX.prefs.conf) {
    (PX.conf[id] || []).forEach(item => {
      add(item.date, { position: 'belowBar', color: c.primary, shape: 'arrowUp', text: '法說' }, {
        text: `🎤 ${item.date} 法人說明會${item.summary ? `：${item.summary.slice(0, 80)}` : ''}`,
        links: pxConfLinks(id, item)
      });
    });
  }
  if (PX.prefs.ex) {
    (PX.history[id].events || []).forEach(e => {
      const isSplit = e[2] === 'split';
      add(e[0], { position: 'belowBar', color: '#9ca3af', shape: 'square', text: isSplit ? '分割' : '除權息' },
        { text: `${isSplit ? '✂️ 股票分割' : '💰 除權息'} ${e[0]}（股價調整係數 ${e[1]}）`, links: [] });
    });
  }
  return list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

// ---------------- 標記的連結 ----------------
// 財報：證交所「電子資料查詢作業」該年度的財務報告書（PDF 清單，可直接帶入代號），以及本站的財報分析
function pxReportLinks(id, q) {
  const year = Number(String(q).slice(0, 4)) - 1911; // 民國年
  return [
    { label: `${q.slice(0, 4)} 年財務報告書（證交所）`, kind: 'url',
      value: `https://doc.twse.com.tw/server-java/t57sb01?step=1&colorchg=1&co_id=${encodeURIComponent(id)}&year=${year}&mtype=A` },
    { label: '本站財報分析', kind: 'url', value: `details.html?id=${encodeURIComponent(id)}`, sameTab: true }
  ];
}

// 法說會：以網頁優先（公司投資人關係網頁、影音 → 觀測站法說會查詢頁），簡報放最後，
// 簡報 PDF 用官方網址在瀏覽器內直接看，不會下載檔案（見 app.js openMopsSlide）
function pxConfLinks(id, item) {
  const links = [];
  (item.links || []).forEach(l => { const url = safeHttpUrl(l.url); if (url) links.push({ label: l.label, kind: 'url', value: url }); });
  links.push({ label: '觀測站法說會資料', kind: 'mops', value: 't100sb02_1' });
  const slide = (file, label) => {
    if (!file || !MOPS_FILE_RE.test(file)) return;
    links.push({ label: mopsSlideUrl(file) ? `${label}（線上看）` : `${label}（PPT 下載）`, kind: 'slide', value: file });
  };
  slide(item.fileZh, '中文簡報');
  slide(item.fileEn, '英文簡報');
  return links;
}

function pxOpenLink(link) {
  if (!link) return;
  if (link.kind === 'slide') openMopsSlide(link.value);
  else if (link.kind === 'mops') openMopsQuery(link.value, PX.selected);
  else if (link.sameTab) location.href = link.value;
  else window.open(link.value, '_blank', 'noopener');
}

// 點標記：直接開啟它的資料（財報 → 證交所財務報告書；法說會 → 公司網頁或觀測站法說會資料）
function pxOnChartClick(param) {
  const hit = pxHitMarker(param);
  if (hit && hit.note.links.length) pxOpenLink(hit.note.links[0]);
}

function pxHitMarker(param) {
  return (param && param.hoveredObjectId && PX.markerById && PX.markerById.get(param.hoveredObjectId)) || null;
}

// 滑鼠移到有標記的日期（不必剛好指在圖案上）：那天的標記放大，旁邊跳出可以點的說明與連結。
// 滑鼠移進小視窗時不會消失；離開小視窗或移到沒有標記的日期，稍等一下才收起來（讓滑鼠來得及移過去）
const PX_TIP_HIDE_DELAY = 500;
const PX_TIP_SHOW_DELAY = 500; // 停在有標記的日期 0.5 秒才跳出小視窗，滑鼠只是經過不會一直閃
function pxMarkerHover(param) {
  const time = param && param.point && param.time !== undefined ? pxTimeKey(param.time) : null;
  const notes = time ? PX.markerInfo.get(time) : null;
  const tip = document.getElementById('px-tip');
  if (!notes || !notes.length) {
    clearTimeout(PX.showTimer);
    PX.showPending = null;
    if (tip && tip.style.display === 'block') pxScheduleHideTip();
    else pxSetEnlarged(null);
    return;
  }
  pxSetEnlarged(time);                 // 標記立刻放大
  clearTimeout(PX.tipTimer);
  PX.tipTimer = null;
  PX.lastPoint = param.point;
  if (tip && tip.style.display === 'block' && PX.tipShownTime === time) { pxShowTip(time, notes, param.point); return; }
  if (PX.showPending === time) return;  // 已經在倒數
  clearTimeout(PX.showTimer);
  PX.showPending = time;
  PX.showTimer = setTimeout(() => {
    PX.showPending = null;
    const list = PX.markerInfo.get(time);
    if (PX.tipTime === time && list && list.length) pxShowTip(time, list, PX.lastPoint);
  }, PX_TIP_SHOW_DELAY);
}

function pxSetEnlarged(time) {
  if (PX.tipTime === time) return;
  PX.tipTime = time;
  if (PX.series && PX.markerList) {
    PX.series.candle.setMarkers(PX.markerList.map(m => (time && m.time === time ? { ...m, size: 2 } : m)));
  }
  const box = document.getElementById('px-chart');
  if (box) box.style.cursor = time ? 'pointer' : '';
}

function pxShowTip(time, notes, point) {
  const tip = document.getElementById('px-tip');
  const box = document.getElementById('px-chart');
  if (!tip || !box) return;
  clearTimeout(PX.tipTimer);
  PX.tipTimer = null;
  pxSetEnlarged(time);
  if (PX.tipShownTime !== time || tip.style.display !== 'block') {
    PX.tipShownTime = time;
    tip.innerHTML = notes.map((n, k) => `
      <div class="px-tip-item">
        <strong>${escapeHtml(n.text)}</strong>
        ${n.links.length
          ? `<div class="px-tip-links">${n.links.map((l, j) => `<a href="#" data-link="${time}|${k}|${j}">${escapeHtml(l.label)}${l.sameTab ? '' : ' ↗'}</a>`).join('')}</div>`
          : '<span class="px-tip-none">沒有相關連結</span>'}
      </div>`).join('');
    tip.style.display = 'block';
  }
  // 貼著那一根 K 棒的右邊（滑鼠往右一點就進得去）；太靠右時改放左邊，上下不超出圖表
  const ts = PX.chart && PX.chart.timeScale();
  const barX = ts ? ts.timeToCoordinate(time) : null;
  const x0 = barX ?? point.x;
  const w = box.clientWidth, h = box.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
  const x = x0 + 10 + tw > w ? x0 - tw - 10 : x0 + 10;
  const y = Math.min(Math.max(4, point.y - th / 2), h - th - 4);
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function pxScheduleHideTip() {
  if (PX.tipTimer || PX.tipTime === null || PX.tipTime === undefined) return;
  PX.tipTimer = setTimeout(pxHideTip, PX_TIP_HIDE_DELAY);
}

function pxHideTip() {
  clearTimeout(PX.tipTimer);
  clearTimeout(PX.showTimer);
  PX.tipTimer = null;
  PX.showPending = null;
  PX.tipShownTime = null;
  const tip = document.getElementById('px-tip');
  if (tip) tip.style.display = 'none';
  pxSetEnlarged(null);
}

function pxBindTip() {
  const tip = document.getElementById('px-tip');
  if (!tip) return;
  tip.addEventListener('mouseenter', () => { clearTimeout(PX.tipTimer); PX.tipTimer = null; });
  tip.addEventListener('mouseleave', pxScheduleHideTip);
  tip.addEventListener('click', e => {
    const a = e.target.closest('[data-link]');
    if (!a) return;
    e.preventDefault();
    const [time, n, k] = a.dataset.link.split('|');
    const note = (PX.markerInfo.get(time) || [])[Number(n)];
    pxOpenLink(note && note.links[Number(k)]);
  });
}

function pxUpdateLegend(param) {
  const el = document.getElementById('px-legend');
  if (!el || !PX.bars.length) return;
  let i = PX.bars.length - 1;
  const key = param && param.time !== undefined ? pxTimeKey(param.time) : null;
  if (key && PX.barIndex.has(key)) i = PX.barIndex.get(key);
  const b = PX.bars[i];
  const prev = i > 0 ? PX.bars[i - 1].close : null;
  const chg = prev ? (b.close / prev - 1) * 100 : null;
  const dir = pxDir(chg);
  const dateText = b.last !== b.time ? `${b.time.replace(/-/g, '/')}～${b.last.slice(5).replace('-', '/')}` : b.time.replace(/-/g, '/');
  const ma = PX_MA.filter(n => PX.maValues[n] && PX.maValues[n].has(b.time))
    .map(n => `<span style="color:${PX_MA_COLORS[n]}">MA${n} ${pxFmt(PX.maValues[n].get(b.time))}</span>`).join('');
  el.innerHTML = `<b>${dateText}</b><span>開 <b>${pxFmt(b.open)}</b></span><span>高 <b>${pxFmt(b.high)}</b></span>
    <span>低 <b>${pxFmt(b.low)}</b></span><span>收 <b class="${dir}">${pxFmt(b.close)}</b> <span class="${dir}">${pxPct(chg)}</span></span>
    <span>量 <b>${pxFmt(b.volume, 0)}</b> 張</span>${ma}${PX.prefs.adjusted ? '<span>（還原權息）</span>' : ''}`;

}

// ================= C. 長期趨勢 =================
function pxSetLongTab(tab) {
  PX.prefs.longTab = tab;
  pxSavePrefs();
  pxRenderLong();
}

function pxNewLongChart(extra) {
  if (PX.longChart) { PX.longChart.remove(); PX.longChart = null; }
  PX.longChart = LightweightCharts.createChart(document.getElementById('px-long-chart'), pxChartOptions(pxThemeColors(), extra));
  return PX.longChart;
}

function pxRenderLong() {
  document.querySelectorAll('#px-long-card .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === PX.prefs.longTab));
  if (!PX.selected) return;
  const token = ++PX.longToken; // 切換很快時，只畫最後一次的結果
  if (PX.prefs.longTab === 'compare') pxRenderCompare(token);
  else pxRenderPe(token);
}

function pxQuantile(sorted, p) {
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function pxRenderPe(token) {
  const id = PX.selected;
  const controls = document.getElementById('px-long-controls');
  const summary = document.getElementById('px-long-summary');
  const extra = document.getElementById('px-long-extra');
  const note = document.getElementById('px-long-note');
  controls.innerHTML = `<p class="section-hint" style="margin-bottom:10px;">目前顯示：<strong>${id} ${escapeHtml(pxName(id))}</strong>（在上方 K 線區切換股票）</p>`;
  summary.innerHTML = '';
  extra.innerHTML = '';
  note.textContent = '河流線＝這檔股票歷史本益比的分位數 × 當時的近 4 季 EPS。股價越靠近上面的線，代表以它自己過去的標準越貴；本益比只反映歷史區間，不代表合理價。分位數使用 2019 年以來的每週本益比（EPS 為負的期間不計）。';
  if (PX.longChart) { PX.longChart.remove(); PX.longChart = null; }

  if (isEtfId(id)) { pxShowMsg('px-long-msg', 'ETF 沒有本益比，可以改看「報酬率比較」。'); return; }
  if (!pxChartLibReady('px-long-msg')) return;
  pxShowMsg('px-long-msg', '載入中…');
  let data;
  try { [, data] = await Promise.all([pxLoadHistory(id), pxLoadFin(id)]); } catch (err) {
    if (token === PX.longToken) pxShowMsg('px-long-msg', `股價資料無法取得：${escapeHtml(pxErr(err))}`);
    return;
  }
  if (token !== PX.longToken) return;
  if (!data || !data.quarters || data.quarters.length < 8) {
    pxShowMsg('px-long-msg', '需要至少 8 季財報才能畫本益比河流圖，目前無法取得這檔的財報，請稍後再試。');
    return;
  }

  // 近 4 季 EPS，從該季財報公布期限起生效
  const qs = data.quarters;
  const steps = [];
  for (let i = 3; i < qs.length; i++) {
    const eps = qs.slice(i - 3, i + 1).map(q => q.eps);
    const from = pxReportDeadline(qs[i].q);
    if (from && eps.every(v => typeof v === 'number')) steps.push({ from, ttm: eps.reduce((a, b) => a + b, 0), q: qs[i].q });
  }
  steps.sort((a, b) => (a.from < b.from ? -1 : 1));
  // 本益比用實際股價（EPS 沒有經過分割、配息調整）
  const weeks = pxAggregate(pxRowsWithLive(id), 'W');
  const points = [];
  let s = -1;
  for (const w of weeks) {
    while (s + 1 < steps.length && steps[s + 1].from <= w.last) s++;
    if (s >= 0) points.push({ time: w.time, close: w.close, ttm: steps[s].ttm });
  }
  const pes = points.filter(p => p.ttm > 0).map(p => p.close / p.ttm).filter(v => v > 0 && v < 300).sort((a, b) => a - b);
  if (pes.length < 26) { pxShowMsg('px-long-msg', '可計算本益比的期間太短（可能長期虧損或財報不足），無法畫河流圖。'); return; }

  const probs = [0.1, 0.25, 0.5, 0.75, 0.9];
  const mults = probs.map(p => pxQuantile(pes, p));
  const chart = pxNewLongChart();
  mults.forEach((m, k) => {
    const line = chart.addLineSeries({ color: PX_BAND_COLORS[k], lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true, title: `${m.toFixed(1)}倍`, crosshairMarkerVisible: false });
    line.setData(points.filter(p => p.ttm > 0).map(p => ({ time: p.time, value: m * p.ttm })));
  });
  const c = pxThemeColors();
  const price = chart.addLineSeries({ color: c.strong, lineWidth: 2, priceLineVisible: false, title: '股價' });
  price.setData(points.map(p => ({ time: p.time, value: p.close })));
  chart.timeScale().fitContent();
  pxHideMsg('px-long-msg');

  const nowPrice = (PX.quotes[id] && PX.quotes[id].price) || points[points.length - 1].close;
  const ttmNow = steps[steps.length - 1].ttm;
  if (ttmNow <= 0) {
    summary.innerHTML = `<div class="px-long-summary">近 4 季 EPS 合計 ${ttmNow.toFixed(2)} 元（虧損），目前無法計算本益比。</div>`;
    return;
  }
  const peNow = nowPrice / ttmNow;
  const pctBelow = pes.filter(v => v < peNow).length / pes.length * 100;
  const zones = [
    [mults[0], '很便宜', PX_BAND_COLORS[0]], [mults[1], '便宜', PX_BAND_COLORS[1]], [mults[3], '合理', PX_BAND_COLORS[2]],
    [mults[4], '偏貴', PX_BAND_COLORS[3]], [Infinity, '很貴', PX_BAND_COLORS[4]]
  ];
  const zone = zones.find(z => peNow < z[0]);
  summary.innerHTML = `<div class="px-long-summary">
    目前${termHtml('本益比')} <strong>${peNow.toFixed(1)} 倍</strong>（股價 ${pxFmt(nowPrice)} ÷ 近 4 季 EPS ${ttmNow.toFixed(2)} 元，最新財報 ${steps[steps.length - 1].q}），
    過去只有 <strong>${pctBelow.toFixed(0)}%</strong> 的時間本益比比現在低，以它自己的歷史來看屬於
    <span class="px-zone" style="background:${zone[2]}">${zone[1]}</span>。
    <br><span class="px-sub" style="display:inline;">歷史本益比${termInfoButton('分位數')}：10% 分位 ${mults[0].toFixed(1)} 倍、中位數 ${mults[2].toFixed(1)} 倍、90% 分位 ${mults[4].toFixed(1)} 倍</span>
  </div>`;
}

async function pxRenderCompare(token) {
  const controls = document.getElementById('px-long-controls');
  const summary = document.getElementById('px-long-summary');
  const extra = document.getElementById('px-long-extra');
  const note = document.getElementById('px-long-note');
  const ids = pxQuoteIds(); // 包含查詢的那一檔
  const candidates = ids.includes(PX_BENCHMARK) ? ids : [...ids, PX_BENCHMARK];
  let picks = (PX.prefs.compare || []).filter(id => candidates.includes(id));
  if (!picks.length) picks = [...new Set([PX.selected, PX_BENCHMARK])];
  PX.prefs.compare = picks;

  const ranges = [['6M', '6月'], ['1Y', '1年'], ['3Y', '3年'], ['5Y', '5年'], ['ALL', '全部']];
  controls.innerHTML = `
    <div class="px-toolbar">
      <div class="px-seg" role="group" aria-label="比較區間">${ranges.map(([v, t]) => `<button data-v="${v}" class="${PX.prefs.compareRange === v ? 'active' : ''}" onclick="pxSetCompareRange('${v}')">${t}</button>`).join('')}</div>
    </div>
    <div class="px-compare-picks">${candidates.map(id => `<label><input type="checkbox" value="${id}" ${picks.includes(id) ? 'checked' : ''} onchange="pxToggleCompare('${id}', this.checked)">
      ${id} ${escapeHtml(pxName(id) || (id === PX_BENCHMARK ? '元大台灣50' : ''))}${id === PX_BENCHMARK && !ids.includes(id) ? '（大盤參考）' : ''}</label>`).join('')}</div>`;
  summary.innerHTML = '';
  extra.innerHTML = '';
  note.textContent = '使用還原權息股價（配息再投入），比較的是含股利的總報酬。起點統一設為 0%，若某檔上市較晚，起點會往後移到所有股票都有資料的那天。年化報酬只在區間滿 1 年時顯示；最大回撤＝區間內從高點跌到低點的最大跌幅。';
  if (PX.longChart) { PX.longChart.remove(); PX.longChart = null; }
  if (!pxChartLibReady('px-long-msg')) return;
  pxShowMsg('px-long-msg', '載入中…');

  const results = await Promise.allSettled(picks.map(id => pxLoadHistory(id)));
  if (token !== PX.longToken) return;
  const loaded = picks.filter((id, i) => results[i].status === 'fulfilled' && PX.history[id].rows.length);
  const failed = picks.filter(id => !loaded.includes(id));
  if (!loaded.length) { pxShowMsg('px-long-msg', '勾選的股票都無法取得股價資料，請稍後再試。'); return; }

  const series = loaded.map(id => ({ id, bars: pxBuildBars(id, { adjusted: true, period: 'D' }) }));
  const lastDay = series.map(s => s.bars[s.bars.length - 1].time).sort().pop();
  const months = PX_RANGE_MONTHS[PX.prefs.compareRange];
  let start = months ? pxMonthsBefore(lastDay, months) : '0000-00-00';
  series.forEach(s => { if (s.bars[0].time > start) start = s.bars[0].time; });

  const chart = pxNewLongChart({ localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd', priceFormatter: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` } });
  const rowsHtml = [];
  series.forEach((s, k) => {
    const bars = s.bars.filter(b => b.time >= start);
    if (!bars.length) return;
    const base = bars[0].close;
    const color = PX_COMPARE_COLORS[k % PX_COMPARE_COLORS.length];
    const line = chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, title: s.id });
    line.setData(bars.map(b => ({ time: b.time, value: (b.close / base - 1) * 100 })));
    let peak = -Infinity, mdd = 0;
    bars.forEach(b => { peak = Math.max(peak, b.close); mdd = Math.min(mdd, b.close / peak - 1); });
    const total = bars[bars.length - 1].close / base - 1;
    const years = (pxDate(bars[bars.length - 1].time) - pxDate(bars[0].time)) / (365.25 * 86400000);
    const annual = years >= 1 ? Math.pow(1 + total, 1 / years) - 1 : null;
    rowsHtml.push(`<tr><td><span class="px-swatch" style="background:${color}; width:14px; margin-right:6px;"></span>${s.id} ${escapeHtml(pxName(s.id) || (s.id === PX_BENCHMARK ? '元大台灣50' : ''))}</td>
      <td class="num ${pxDir(total)}">${pxPct(total * 100)}</td><td class="num ${pxDir(annual)}">${annual === null ? '—' : pxPct(annual * 100)}</td>
      <td class="num px-down">${pxPct(mdd * 100)}</td></tr>`);
  });
  chart.timeScale().fitContent();
  pxHideMsg('px-long-msg');
  summary.innerHTML = `<p class="section-hint" style="margin-bottom:8px;">比較期間：${start.replace(/-/g, '/')}～${lastDay.replace(/-/g, '/')}</p>`;
  extra.innerHTML = `<div class="table-responsive" style="margin-top:12px;"><table class="px-compare-table">
      <thead><tr><th>股票</th><th class="num">區間報酬</th><th class="num">年化報酬</th><th class="num">最大回撤</th></tr></thead>
      <tbody>${rowsHtml.join('')}</tbody></table></div>
    ${failed.length ? `<p class="px-note">⚠️ 無法取得股價：${failed.join('、')}</p>` : ''}`;
  if (typeof decorateTermHeaders === 'function') decorateTermHeaders(extra); // 區間報酬、年化報酬、最大回撤加上說明
}

function pxSetCompareRange(v) {
  PX.prefs.compareRange = v;
  pxSavePrefs();
  pxRenderLong();
}

function pxToggleCompare(id, on) {
  const set = new Set(PX.prefs.compare || []);
  if (on) {
    if (set.size >= PX_COMPARE_MAX) { showToast(`最多同時比較 ${PX_COMPARE_MAX} 檔`, 'warn'); pxRenderLong(); return; }
    set.add(id);
  } else {
    set.delete(id);
    if (!set.size) { showToast('至少要保留一檔', 'warn'); pxRenderLong(); return; }
  }
  PX.prefs.compare = [...set];
  pxSavePrefs();
  pxRenderLong();
}
