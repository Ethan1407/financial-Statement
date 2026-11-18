// ==========================================
// 🔍 階段五：同類型公司推薦
// - 興趣輪廓只在瀏覽器計算（讀取 localStorage 的查詢紀錄），送到後端的只有「產業名稱」。
// - 依產業類別與你的查詢紀錄（同產業查過哪些公司、查過的 ETF 是否持有）找相似公司，不依燈號或財務表現排序，不構成投資建議。
// - 點擊與「有幫助／沒幫助」只回報匿名的事件類型與位置（首頁／個股頁），不含股票代號。
// ==========================================
const REC_SETTING_KEY = 'rec_enabled';
const REC_HOME_GROUPS = 3;      // 首頁最多列出幾個產業
const REC_PER_GROUP = 3;        // 每個產業列出幾家
const REC_DETAIL_COUNT = 6;     // 個股頁列出幾家
const REC_BROAD_INDUSTRIES = new Set(['電子工業', '其他', '所有證券', 'ETF', '上櫃ETF', '創新板股票', '創新版股票']);

function recEnabled() {
  try { return localStorage.getItem(REC_SETTING_KEY) !== 'off'; } catch (err) { return true; }
}

function setRecEnabled(on) {
  try { localStorage.setItem(REC_SETTING_KEY, on ? 'on' : 'off'); } catch (err) { /* 無法儲存時只影響這次瀏覽 */ }
  if (document.getElementById('rec-section')) renderHomeRecommendations();
  if (document.getElementById('peers-card') && window.currentStockId) loadDetailPeers(window.currentStockId);
}

// 匿名事件：用 sendBeacon 送出 text/plain，離開頁面也送得出去，且不觸發跨網域預檢
function recSendEvent(event, placement) {
  try {
    const body = new Blob([JSON.stringify({ event, placement })], { type: 'text/plain' });
    const url = `${API_BASE}/api/recommend/event`;
    if (!(navigator.sendBeacon && navigator.sendBeacon(url, body))) {
      fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch (err) { /* 統計失敗不影響使用 */ }
}

// 同一個分頁、同一個位置只記一次曝光
function recImpressionOnce(placement, key) {
  const storageKey = `rec_imp_${placement}_${key}`;
  try {
    if (sessionStorage.getItem(storageKey)) return;
    sessionStorage.setItem(storageKey, '1');
  } catch (err) { /* sessionStorage 不可用時照常記錄 */ }
  recSendEvent('impression', placement);
}

function recFeedback(placement, helpful, btn) {
  recSendEvent(helpful ? 'helpful' : 'unhelpful', placement);
  try { sessionStorage.setItem(`rec_fb_${placement}`, '1'); } catch (err) {}
  const box = btn.closest('.rec-feedback');
  if (box) box.innerHTML = '<span>謝謝你的回饋！</span>';
}

function recFeedbackHtml(placement) {
  let done = false;
  try { done = !!sessionStorage.getItem(`rec_fb_${placement}`); } catch (err) {}
  if (done) return '<div class="rec-feedback"><span>謝謝你的回饋！</span></div>';
  return `<div class="rec-feedback">這些公司對你的研究有幫助嗎？
    <button class="btn-outline" onclick="recFeedback('${placement}', true, this)">👍 有幫助</button>
    <button class="btn-outline" onclick="recFeedback('${placement}', false, this)">👎 沒幫助</button></div>`;
}

const REC_DISCLAIMER = '依產業類別與你的查詢紀錄列出相似公司，供延伸研究；不依財務表現排序，不代表推薦買賣，也不構成投資建議。';

// 產業名稱正規化，規則與後端 recommend.py 的 normalize_industry 相同，前後端的產業名稱才對得上
const REC_EXCLUDED = new Set(['電子工業', '其他', '所有證券', '大盤', 'Index', 'ETF', 'ETN', '上櫃ETF', '上櫃指數股票型基金(ETF)',
  '指數投資證券(ETN)', '存託憑證', '受益證券', '創新板股票', '創新版股票']);
const REC_ALIASES = { '金融業': '金融保險', '觀光事業': '觀光餐旅', '化學生技醫療': '生技醫療' };
function recNormIndustry(name) {
  name = String(name || '').trim();
  if (!name || REC_EXCLUDED.has(name)) return null;
  name = REC_ALIASES[name] || name;
  return name.replace(/[類業]$/, '') || null;
}

// 推薦原因要用到的查詢紀錄：每個產業你查過哪些公司、查過的 ETF 持有哪些公司（全部在瀏覽器計算）
function buildRecContext() {
  const db = loadStockDatabase();
  const byIndustry = {};   // 產業 → [{ id, name, tracked }]
  const etfs = [];         // [{ id, holdings: { 股票代號: 權重 } }]
  Object.entries(db).forEach(([id, data]) => {
    if (!data) return;
    if (data.isEtf) { if (data.holdings) etfs.push({ id, holdings: data.holdings }); return; }
    const entry = { id, name: data.name || id, tracked: portfolio.includes(id) };
    new Set(getIndustries(data).map(recNormIndustry).filter(Boolean)).forEach(ind => {
      (byIndustry[ind] = byIndustry[ind] || []).push(entry);
    });
  });
  // 自選股排前面，列名字時優先提到
  Object.values(byIndustry).forEach(list => list.sort((a, b) => (b.tracked - a.tracked) || a.id.localeCompare(b.id)));
  etfs.sort((a, b) => (portfolio.includes(b.id) - portfolio.includes(a.id)) || a.id.localeCompare(b.id));
  return { db, byIndustry, etfs };
}

const recNames = (list, max = 2) => list.slice(0, max).map(s => s.name).join('、') + (list.length > max ? ` 等 ${list.length} 家` : '');

// 依你的查詢紀錄找出這家公司和你的交集，回傳 { reasons: [最多 3 條], score }。
// anchor：個股頁目前看的公司，會先說明和它的關係，其他交集不再重複提到它。
function recReasons(item, ctx, anchor) {
  const reasons = [];
  let score = 0;
  const inds = [...new Set((item.industries || []).map(recNormIndustry).filter(Boolean))];

  if (anchor) {
    const common = inds.filter(i => anchor.industries.includes(i));
    if (common.length) reasons.push(`和 ${anchor.name} 同屬「${common.join('」「')}」`);
  }

  // 查過的 ETF 也持有這家公司
  const etf = ctx.etfs.find(e => e.holdings[item.id] != null);
  if (etf) { reasons.push(`你查詢的 ${etf.id} 也持有（權重 ${etf.holdings[item.id]}%）`); score += 3; }

  // 你研究過的產業：同時屬於好幾個，或同產業已查過哪些公司
  const exclude = new Set([item.id, anchor && anchor.id]);
  const matched = inds.map(ind => ({ ind, stocks: (ctx.byIndustry[ind] || []).filter(s => !exclude.has(s.id)) }))
    .filter(m => m.stocks.length)
    .sort((a, b) => b.stocks.length - a.stocks.length);
  if (matched.length >= 2) {
    reasons.push(`同時屬於你研究的「${matched.slice(0, 3).map(m => m.ind).join('」「')}」`);
    score += 2 * matched.length;
  }
  if (matched.length) {
    const top = matched[0];
    const tracked = top.stocks.filter(s => s.tracked);
    reasons.push(tracked.length
      ? `和你的自選股 ${recNames(tracked)} 同屬「${top.ind}」`
      : `你查過同屬「${top.ind}」的 ${recNames(top.stocks)}`);
    score += 1 + Math.min(top.stocks.length, 3) * 0.5 + (tracked.length ? 1 : 0);
  }

  return { reasons: reasons.slice(0, 3), score };
}

// 依交集多寡重新排序（同分時維持後端原本的順序）
function recRank(items, ctx, anchor) {
  return items.map((item, idx) => ({ item, idx, ...recReasons(item, ctx, anchor) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
}

// 興趣輪廓：依查詢過的個股統計主要產業比重（自選股權重 2、其他已查詢 1）
function buildInterestProfile() {
  const db = loadStockDatabase();
  const weights = {};
  const etfs = [];
  let stockCount = 0;
  let total = 0;
  Object.entries(db).forEach(([id, data]) => {
    if (!data) return;
    if (data.isEtf) { etfs.push(id); return; }
    stockCount++;
    const industry = pickIndustry(getIndustries(data).filter(i => i && !REC_BROAD_INDUSTRIES.has(i)));
    if (!industry) return;
    const w = portfolio.includes(id) ? 2 : 1;
    weights[industry] = (weights[industry] || 0) + w;
    total += w;
  });
  const industries = Object.entries(weights)
    .map(([name, weight]) => ({ name, weight, share: total ? Math.round(weight / total * 100) : 0 }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  // ETF 依自選優先，其次代號
  etfs.sort((a, b) => (portfolio.includes(b) - portfolio.includes(a)) || a.localeCompare(b));
  return { industries, etfs, stockCount, seen: new Set(Object.keys(db)) };
}

// 推薦卡片：和上方個股卡片同樣的尺寸與版面（標題列、資料列、虛線分隔、底部按鈕），沒有財報資料時也一樣大
function recCardHtml(item, placement, reasons) {
  const inds = (item.industries || []).filter(Boolean);
  const state = item.hasData ? 'ready' : (item.preparing ? 'preparing' : 'none');
  // 「已備妥」是系統預先抓好的（背景預先載入或其他人查過），不代表你查過
  const stateText = { ready: '可立即查看', preparing: '準備中', none: '需載入' }[state];
  const speed = {
    ready: '⚡ 系統已預先備妥財報，點進去不用等待',
    preparing: '⏳ 系統正在背景準備財報，稍後點進去就不用等待',
    none: '📥 第一次查看需向資料來源載入財報（約數秒）'
  }[state];
  const list = (Array.isArray(reasons) ? reasons : [reasons]).filter(Boolean);
  if (!list.length) list.push(`與你研究的「${inds[0] || '—'}」同產業`);
  return `
    <div class="card rec-card" data-state="${state}">
      <div class="flex-between rec-card-head">
        <h3>${escapeHtml(item.id)} ${escapeHtml(item.name || '')}</h3>
        <span class="rec-state ${state}"><span class="dot"></span>${stateText}</span>
      </div>
      <div class="rec-rows">
        <div><span>產業類別：</span><strong>${escapeHtml(inds.join('、') || '—')}</strong></div>
        <div><span>推薦原因：</span><ul class="rec-reasons">${list.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>
      </div>
      <p class="rec-speed">${speed}</p>
      <div class="rec-card-foot">
        <a class="btn-link-primary" href="details.html?id=${encodeURIComponent(item.id)}&from=rec" onclick="recSendEvent('click', '${placement}')">查看詳情</a>
      </div>
    </div>`;
}

// ---------------- 首頁 ----------------
let recHomeController = null;

async function renderHomeRecommendations() {
  const section = document.getElementById('rec-section');
  if (!section) return;
  const reasonEl = document.getElementById('rec-reason');
  const contentEl = document.getElementById('rec-content');
  const footerEl = document.getElementById('rec-footer');
  applySectionState('rec');

  if (!recEnabled()) {
    reasonEl.textContent = '';
    contentEl.innerHTML = '<p class="section-hint">已關閉同類型公司推薦。 <button class="btn-outline" onclick="setRecEnabled(true)">開啟</button></p>';
    footerEl.innerHTML = '';
    return;
  }

  if (recHomeController) recHomeController.abort();
  recHomeController = new AbortController();
  const signal = recHomeController.signal;
  const profile = buildInterestProfile();
  contentEl.innerHTML = '<p class="section-hint">推薦載入中…</p>';

  try {
    let html = '';
    if (profile.industries.length) {
      const top = profile.industries.slice(0, REC_HOME_GROUPS);
      reasonEl.textContent = `依你查詢過的 ${profile.stockCount} 檔個股，最常研究的類型是：`
        + top.map(i => `${i.name} ${i.share}%`).join('、') + '（只在你的瀏覽器計算）';
      const params = new URLSearchParams({ names: top.map(i => i.name).join(','), limit: '30' });
      const res = await fetch(`${API_BASE}/api/recommend/industries?${params}`, { signal });
      if (!res.ok) throw new Error(httpErrorReason(res.status, await res.json().catch(() => ({}))));
      const { groups } = await res.json();
      const ctx = buildRecContext();
      const shown = new Set();   // 同一家公司屬於多個產業時只出現一次
      html = (groups || []).map(g => {
        const ranked = recRank(g.items.filter(i => !profile.seen.has(i.id) && !shown.has(i.id)), ctx).slice(0, REC_PER_GROUP);
        if (!ranked.length) return '';
        ranked.forEach(r => shown.add(r.item.id));
        return `<div class="rec-group"><h4>${escapeHtml(g.industry)} <span class="section-count">同類型共 ${g.total} 家</span></h4>
          <div class="rec-grid">${ranked.map(r => recCardHtml(r.item, 'home', r.reasons)).join('')}</div></div>`;
      }).join('');
      if (!html) html = '<p class="section-hint">這些類型的公司你都查過了，可以試試其他產業。</p>';
    } else if (profile.etfs.length) {
      // 冷啟動 1：還沒查過個股，但查過 ETF → 從成分股開始
      const etfId = profile.etfs[0];
      reasonEl.textContent = `你還沒有查詢個股，先從你查詢過的 ${etfId} 成分股開始（依持股權重）。`;
      const res = await fetch(`${API_BASE}/api/etf/${encodeURIComponent(etfId)}`, { signal });
      if (!res.ok) throw new Error(httpErrorReason(res.status, await res.json().catch(() => ({}))));
      const data = await res.json();
      const items = (data.holdings || [])
        .filter(h => h.stockId && !profile.seen.has(h.stockId))
        .slice(0, REC_HOME_GROUPS * REC_PER_GROUP)
        .map(h => ({ id: h.stockId, name: h.name, industries: h.industries, hasData: !!h.financials, weight: h.weight }));
      html = items.length
        ? `<div class="rec-grid">${items.map(i => recCardHtml(i, 'home', `${etfId} 持股 ${i.weight}%`)).join('')}</div>`
        : '<p class="section-hint">這檔 ETF 的主要成分股你都查過了。</p>';
    } else {
      // 冷啟動 2：沒有任何查詢紀錄 → 其他使用者最近查詢的公司
      reasonEl.textContent = '你還沒有查詢紀錄，以下是網站最近更新過財報的公司。';
      const res = await fetch(`${API_BASE}/api/recommend/popular?limit=9`, { signal });
      if (!res.ok) throw new Error(httpErrorReason(res.status, await res.json().catch(() => ({}))));
      const { items } = await res.json();
      html = items && items.length
        ? `<div class="rec-grid">${items.map(i => recCardHtml(i, 'home', '網站最近更新過這家公司的財報')).join('')}</div>`
        : '<p class="section-hint">目前還沒有可推薦的公司。</p>';
    }
    contentEl.innerHTML = html;
    footerEl.innerHTML = `${recFeedbackHtml('home')}
      <p class="rec-disclaimer">${REC_DISCLAIMER} <button class="btn-link" onclick="setRecEnabled(false)">關閉推薦</button></p>`;
    if (contentEl.querySelector('.rec-card')) recImpressionOnce('home', 'page');
  } catch (err) {
    if (err.name === 'AbortError') return;
    contentEl.innerHTML = `<p class="section-hint">推薦無法載入：${escapeHtml(fetchErrorReason(err))} <button class="btn-outline" onclick="renderHomeRecommendations()">重試</button></p>`;
    footerEl.innerHTML = '';
  }
}

// ---------------- 個股頁 ----------------
let recPeersController = null;

async function loadDetailPeers(stockId) {
  const card = document.getElementById('peers-card');
  if (!card) return;
  const listEl = document.getElementById('peers-list');
  const reasonEl = document.getElementById('peers-reason');
  const footerEl = document.getElementById('peers-footer');

  if (!recEnabled()) {
    reasonEl.textContent = '';
    listEl.innerHTML = '<p class="section-hint">已關閉同類型公司推薦。 <button class="btn-outline" onclick="setRecEnabled(true)">開啟</button></p>';
    footerEl.innerHTML = '';
    return;
  }

  if (recPeersController) recPeersController.abort();
  recPeersController = new AbortController();
  listEl.innerHTML = '<p class="section-hint">同類型公司載入中…</p>';
  reasonEl.textContent = '';
  footerEl.innerHTML = '';

  try {
    const res = await fetch(`${API_BASE}/api/recommend/peers/${encodeURIComponent(stockId)}?limit=30`, { signal: recPeersController.signal });
    if (!res.ok) throw new Error(httpErrorReason(res.status, await res.json().catch(() => ({}))));
    const data = await res.json();
    if (!data.items || !data.items.length) {
      listEl.innerHTML = '<p class="section-hint">找不到同產業的上市櫃公司。</p>';
      return;
    }
    const ctx = buildRecContext();
    const seen = new Set(Object.keys(ctx.db));
    const self = ctx.db[stockId];
    const anchor = { id: stockId, name: (self && self.name) || stockId, industries: data.industries || [] };
    // 還沒查過的排前面，各自再依和你查詢紀錄的交集多寡排序
    const ordered = [...recRank(data.items.filter(i => !seen.has(i.id)), ctx, anchor),
                     ...recRank(data.items.filter(i => seen.has(i.id)), ctx, anchor)].slice(0, REC_DETAIL_COUNT);
    reasonEl.textContent = `同屬「${data.industries.join('、')}」的 ${data.total} 家公司中，列出 ${ordered.length} 家（優先列出你還沒查過、和你查詢紀錄交集較多的公司）。`;
    listEl.innerHTML = `<div class="rec-grid">${ordered.map(r =>
      recCardHtml(r.item, 'detail', seen.has(r.item.id) ? ['你查詢過', ...r.reasons].slice(0, 3) : r.reasons)).join('')}</div>`;
    footerEl.innerHTML = `${recFeedbackHtml('detail')}
      <p class="rec-disclaimer">${REC_DISCLAIMER} <button class="btn-link" onclick="setRecEnabled(false)">關閉推薦</button></p>`;
    recImpressionOnce('detail', stockId);
  } catch (err) {
    if (err.name === 'AbortError') return;
    listEl.innerHTML = `<p class="section-hint">同類型公司無法載入：${escapeHtml(fetchErrorReason(err))} <button class="btn-outline" onclick="loadDetailPeers('${stockId}')">重試</button></p>`;
  }
}
