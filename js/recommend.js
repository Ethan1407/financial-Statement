// ==========================================
// 🔍 階段五：同類型公司推薦
// - 興趣輪廓只在瀏覽器計算（讀取 localStorage 的查詢紀錄），送到後端的只有「產業名稱」。
// - 只依產業類別找相似公司，不依燈號或財務表現排序，不構成投資建議。
// - 點擊與「有幫助／沒幫助」只回報匿名的事件類型與位置（首頁／個股頁），不含股票代號。
// ==========================================
const REC_SETTING_KEY = 'rec_enabled';
const REC_HOME_GROUPS = 3;      // 首頁最多列出幾個產業
const REC_PER_GROUP = 3;        // 每個產業列出幾家
const REC_DETAIL_COUNT = 10;    // 個股頁列出幾家
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

const REC_DISCLAIMER = '僅依產業類別列出相似公司，供延伸研究；不依財務表現排序，不代表推薦買賣，也不構成投資建議。';

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
function recCardHtml(item, placement, note) {
  const inds = (item.industries || []).filter(Boolean);
  const ind = inds[0] || '—';
  const state = item.hasData ? 'ready' : (item.preparing ? 'preparing' : 'none');
  const stateText = { ready: '已有資料', preparing: '資料準備中', none: '尚未載入' }[state];
  const speed = {
    ready: '⚡ 財報已在資料庫，點進去可立即查看',
    preparing: '⏳ 系統正在背景準備財報，稍後即可立即查看',
    none: '📥 首次查看需向資料來源載入財報（約數秒）'
  }[state];
  const reason = note || `與你研究的「${ind}」同產業`;
  return `
    <div class="card rec-card" data-state="${state}">
      <div class="flex-between rec-card-head">
        <h3>${escapeHtml(item.id)} ${escapeHtml(item.name || '')}</h3>
        <span class="rec-state ${state}"><span class="dot"></span>${stateText}</span>
      </div>
      <div class="rec-rows">
        <div><span>產業類別：</span><strong>${escapeHtml(inds.join('、') || '—')}</strong></div>
        <div><span>推薦原因：</span><strong>${escapeHtml(reason)}</strong></div>
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
      html = (groups || []).map(g => {
        const items = g.items.filter(i => !profile.seen.has(i.id)).slice(0, REC_PER_GROUP);
        if (!items.length) return '';
        return `<div class="rec-group"><h4>${escapeHtml(g.industry)} <span class="section-count">同類型共 ${g.total} 家</span></h4>
          <div class="rec-grid">${items.map(i => recCardHtml(i, 'home')).join('')}</div></div>`;
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
      reasonEl.textContent = '你還沒有查詢紀錄，以下是其他使用者最近查詢過的公司。';
      const res = await fetch(`${API_BASE}/api/recommend/popular?limit=9`, { signal });
      if (!res.ok) throw new Error(httpErrorReason(res.status, await res.json().catch(() => ({}))));
      const { items } = await res.json();
      html = items && items.length
        ? `<div class="rec-grid">${items.map(i => recCardHtml(i, 'home')).join('')}</div>`
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
    const seen = new Set(Object.keys(loadStockDatabase()));
    // 還沒查過的排前面
    const ordered = [...data.items.filter(i => !seen.has(i.id)), ...data.items.filter(i => seen.has(i.id))].slice(0, REC_DETAIL_COUNT);
    reasonEl.textContent = `同屬「${data.industries.join('、')}」的 ${data.total} 家公司中，列出 ${ordered.length} 家（優先列出你還沒查過、且已有資料的公司）。`;
    listEl.innerHTML = `<div class="rec-grid">${ordered.map(i => recCardHtml(i, 'detail', seen.has(i.id) ? '你查詢過' : '')).join('')}</div>`;
    footerEl.innerHTML = `${recFeedbackHtml('detail')}
      <p class="rec-disclaimer">${REC_DISCLAIMER} <button class="btn-link" onclick="setRecEnabled(false)">關閉推薦</button></p>`;
    recImpressionOnce('detail', stockId);
  } catch (err) {
    if (err.name === 'AbortError') return;
    listEl.innerHTML = `<p class="section-hint">同類型公司無法載入：${escapeHtml(fetchErrorReason(err))} <button class="btn-outline" onclick="loadDetailPeers('${stockId}')">重試</button></p>`;
  }
}
