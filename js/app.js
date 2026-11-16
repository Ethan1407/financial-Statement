const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.protocol === 'file:')
    ? 'http://127.0.0.1:5000'
    : 'https://financial-statement-xou2.onrender.com';
const IS_LOCAL_API = API_BASE.includes('127.0.0.1');

// ================= 錯誤原因：把連線／HTTP 錯誤翻成使用者看得懂的說明 =================
// fetch 本身失敗（TypeError: Failed to fetch）代表根本連不到後端
function networkErrorReason() {
  return IS_LOCAL_API
    ? `連不到本機後端（${API_BASE}）：請先在專案資料夾執行「python server.py」啟動後端`
    : '連不到後端主機：主機可能正在從睡眠中喚醒（約 1 分鐘），或你的網路中斷';
}
function httpErrorReason(status, body) {
  if (status === 429) return '請求太頻繁，伺服器暫時限制（每分鐘 30 次），請稍候約 1 分鐘再試';
  if (body && body.error) return body.error;
  if (status === 404) return '後端找不到這個功能（後端可能還是舊版本，尚未部署更新）';
  if (status >= 500) return `後端發生錯誤（HTTP ${status}），請稍後再試`;
  return `伺服器回應 HTTP ${status}`;
}
function fetchErrorReason(err) {
  return err instanceof TypeError ? networkErrorReason() : (err && err.message) || '未知錯誤';
}

// 第一次造訪（這個瀏覽器從未存過自選股）時預設加入的自選股
const DEFAULT_PORTFOLIO = ['2330', '0050'];
const isFirstVisit = localStorage.getItem('stock_portfolio') === null;
let portfolio = isFirstVisit ? [...DEFAULT_PORTFOLIO] : JSON.parse(localStorage.getItem('stock_portfolio'));
let seedingDefaults = isFirstVisit;
let currentCharts = {};
let newsController = null;
let currentNewsData = null;
let currentNewsFilter = 'all';
let newsExpanded = false;

// 立即套用主題（不能等 DOMContentLoaded），否則 initDetails() 先畫的圖表會讀到 HTML 預設的深色變數
document.documentElement.setAttribute('data-theme', localStorage.getItem('app_theme') || 'dark');

document.addEventListener('DOMContentLoaded', () => {
  setActiveNav();
  if (isFirstVisit) seedDefaultPortfolio();
  checkBackendAwake();
});

// ================= 後端喚醒偵測 =================
// Render 免費方案閒置 15 分鐘後會睡眠，下一個請求要等約 1 分鐘主機才會醒。
// 打開網頁時先呼叫輕量的 /api/ping：醒著的主機通常 1 秒內回應；超過 WAKE_HINT_DELAY 還沒回應，
// 就判斷主機在睡眠，顯示提示並倒數已等待秒數，主機回應後自動收起。
const WAKE_HINT_DELAY = 2500;     // 超過這個時間沒回應，視為正在喚醒
const WAKE_GIVE_UP_MS = 150000;   // 等超過 2.5 分鐘仍沒回應，改顯示連線失敗
const WAKE_RETRY_MS = 4000;       // 喚醒期間 Render 可能回 502/503 或連線中斷，隔幾秒再試
const WAKE_STARTED_KEY = 'backend_wake_started_at'; // 喚醒開始時間，切換頁面後接續計時

function readWakeStartedAt() {
  try {
    const t = Number(localStorage.getItem(WAKE_STARTED_KEY));
    return t && Date.now() - t < WAKE_GIVE_UP_MS ? t : 0;
  } catch { return 0; }
}
function writeWakeStartedAt(t) {
  try { t ? localStorage.setItem(WAKE_STARTED_KEY, String(t)) : localStorage.removeItem(WAKE_STARTED_KEY); } catch {}
}

function checkBackendAwake() {
  if (backendCheckRunning) return;
  backendCheckRunning = true;
  // 切換頁面時，上一頁的計時會隨頁面一起消失，但 Render 的開機並不會中斷。
  // 若上一頁已在喚醒中，沿用當時的開始時間繼續計時，並立刻顯示提示。
  const resumedAt = readWakeStartedAt();
  const startedAt = resumedAt || Date.now();
  let banner = null;
  let tickTimer = null;
  let finished = false;

  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
  const setBanner = (state, html) => {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'wake-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      const header = document.querySelector('header');
      if (header) header.insertAdjacentElement('afterend', banner);
      else document.body.prepend(banner);
    }
    banner.dataset.state = state;
    banner.innerHTML = html;
  };
  const renderWaking = () => {
    setBanner('waking',
      `<span class="wake-spinner" aria-hidden="true"></span>
       <span>後端主機正在從睡眠中喚醒，<strong>約需 1 分鐘</strong>，資料會在主機啟動後自動載入，請稍候…
       <span class="wake-elapsed">（已等待 ${elapsedSec()} 秒）</span></span>`);
    setServerStatus('waking', `喚醒中 ${elapsedSec()} 秒`, '主機正在從睡眠中啟動，約需 1 分鐘');
  };

  setServerStatus('checking', '檢查中', '正在確認後端主機狀態');
  const hintTimer = setTimeout(() => {
    if (finished) return;
    writeWakeStartedAt(startedAt);
    renderWaking();
    tickTimer = setInterval(renderWaking, 1000);
  }, resumedAt ? 0 : WAKE_HINT_DELAY);

  const finish = (ok, latencyMs) => {
    finished = true;
    backendCheckRunning = false;
    writeWakeStartedAt(0);
    clearTimeout(hintTimer);
    clearInterval(tickTimer);
    if (ok) {
      backendLastOkAt = Date.now();
      setServerStatus('online', '運作中', banner
        ? `主機已啟動（喚醒花了 ${elapsedSec()} 秒）`
        : `主機運作中，回應時間 ${latencyMs} ms`);
    } else {
      setServerStatus('offline', '無法連線', networkErrorReason());
    }
    if (ok) {
      if (!banner) return; // 主機本來就醒著，不顯示橫幅
      setBanner('ready', `✅ 主機已啟動（花了 ${elapsedSec()} 秒），可以正常使用了。`);
      setTimeout(() => banner.remove(), 3000);
    } else {
      setBanner('error', `⚠️ ${escapeHtml(networkErrorReason())}。頁面上的資料會無法載入，${IS_LOCAL_API ? '啟動後' : '稍後'}點右上角「主機」狀態可重新檢查。`);
    }
  };

  const attempt = async () => {
    const remaining = WAKE_GIVE_UP_MS - (Date.now() - startedAt);
    if (remaining <= 0) return finish(false);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remaining);
    const sentAt = performance.now();
    try {
      const res = await fetch(`${API_BASE}/api/ping`, { cache: 'no-store', signal: controller.signal });
      if (res.ok) return finish(true, Math.round(performance.now() - sentAt));
    } catch (err) {
      if (err.name === 'AbortError') return finish(false);
      // 本機後端不會睡眠，連不上就是沒啟動，不必等
      if (IS_LOCAL_API) return finish(false);
    } finally {
      clearTimeout(timeoutId);
    }
    setTimeout(attempt, WAKE_RETRY_MS);
  };
  attempt();
}

// ================= 頂部橫幅右側的主機狀態 =================
let backendCheckRunning = false;
let backendLastOkAt = 0;
const BACKEND_RECHECK_MS = 10 * 60 * 1000; // 分頁離開超過 10 分鐘再回來時重新確認（Render 閒置 15 分鐘會睡眠）

function setServerStatus(state, text, title) {
  let el = document.getElementById('server-status');
  if (!el) {
    const toggle = document.querySelector('header .theme-toggle');
    if (!toggle) return;
    // 把狀態與主題切換按鈕包在一起，維持導覽列原本的左、中、右三欄排列
    const group = document.createElement('div');
    group.className = 'header-right';
    toggle.replaceWith(group);
    el = document.createElement('button');
    el.id = 'server-status';
    el.type = 'button';
    el.className = 'server-status';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="server-status-dot" aria-hidden="true"></span><span class="server-status-label">主機：</span><span class="server-status-text"></span>';
    el.addEventListener('click', () => { if (el.dataset.state !== 'waking' && el.dataset.state !== 'checking') checkBackendAwake(); });
    group.append(el, toggle);
  }
  el.dataset.state = state;
  el.querySelector('.server-status-text').textContent = text;
  el.title = title + (state === 'online' || state === 'offline' ? '（點一下重新檢查）' : '');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && backendLastOkAt && Date.now() - backendLastOkAt > BACKEND_RECHECK_MS) checkBackendAwake();
});

function isEtfId(id) { return /^00\d{2,4}[A-Za-z]?$/.test(id || ''); }

// 抓取預設自選股的資料；全部成功才存檔，失敗的話下次造訪會再試一次
async function seedDefaultPortfolio() {
  const results = await Promise.all(DEFAULT_PORTFOLIO.map(id => isEtfId(id) ? requestEtf(id) : requestStock(id)));
  if (results.every(r => !r.error)) savePortfolio();
  seedingDefaults = false;
  rerenderCurrentPage();
}

// 資料在背景載入完成後，重畫目前頁面上的自選股相關區塊
function rerenderCurrentPage() {
  if (document.getElementById('tracked-grid')) renderStockOverview();
  if (document.getElementById('alerts-list')) renderAlerts();
  if (document.getElementById('detail-stock-select')) {
      updateDetailSelect();
      if (document.getElementById('detail-list-view').style.display !== 'none') renderDetailStockList();
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
  window.dispatchEvent(new Event('themechange'));
  if (typeof renderCharts === 'function' && window.currentStockId) {
    renderCharts(window.currentStockId, window.currentAlerts);
  }
}

function setActiveNav() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(link => {
    if (path.includes(link.getAttribute('href'))) link.classList.add('active');
    else link.classList.remove('active');
  });
}

// 外部資料（股名、產業、錯誤訊息）塞進 innerHTML 前必須跳脫，避免 XSS
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function savePortfolio() { localStorage.setItem('stock_portfolio', JSON.stringify(portfolio)); }
function loadStockDatabase() { return JSON.parse(localStorage.getItem('stock_database') || '{}'); }

// 寫入失敗（瀏覽器儲存空間已滿）時回傳 false
function saveStockDatabase(db) {
  try {
      localStorage.setItem('stock_database', JSON.stringify(db));
      return true;
  } catch (err) {
      return false;
  }
}

// 向後端查詢個股財報並存入瀏覽器。回傳 { result } 或 { error, status }
async function requestStock(id, refresh = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 秒等待雲端伺服器喚醒
  try {
      const response = await fetch(`${API_BASE}/api/stock/${id}${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) return { error: result.error || '查詢失敗，請確認代號正確', status: response.status };

      const stockDatabase = loadStockDatabase();
      stockDatabase[id] = result;
      if (!saveStockDatabase(stockDatabase)) {
          return { error: '瀏覽器儲存空間已滿，請先刪除部分「其他已查詢股票」。', status: 'storage' };
      }
      return { result };
  } catch (err) {
      return err.name === 'AbortError'
          ? { error: '請求逾時：雲端伺服器可能正在喚醒中，請再試一次！', status: 'timeout' }
          : { error: networkErrorReason(), status: 'network' };
  } finally {
      clearTimeout(timeoutId);
  }
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d)) return '—';
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function addStock() {
  const input = document.getElementById('stock-input');
  const id = input.value.trim();
  if (!id) return;
  await syncStock(id, input.nextElementSibling, true);
  input.value = '';
}

// 查詢或更新財報。已有資料時檢查是否有新財報；addToPortfolio 為 true 時同時加入自選股
async function syncStock(id, btn, addToPortfolio = false) {
  const stockDatabase = loadStockDatabase();
  const isUpdating = !!stockDatabase[id] && !stockDatabase[id].isEtf;
  const originalText = btn.innerText;
  btn.innerText = stockDatabase[id] ? '檢查中...' : '爬取中...';
  btn.disabled = true;

  try {
      if (isEtfId(id)) {
          if (await syncEtf(id, addToPortfolio)) {
              renderStockOverview();
              updateDetailSelect();
          }
          return;
      }

      const oldQuarter = isUpdating ? stockDatabase[id].latestCompleteQuarter : null;
      const { result, error } = await requestStock(id, isUpdating);
      if (error) {
          alert(error);
          return;
      }

      const added = addToPortfolio && !portfolio.includes(id);
      if (added) {
          portfolio.push(id);
          savePortfolio();
      }

      if (isUpdating) {
          const newQuarter = result.latestCompleteQuarter;
          let msg;
          if (result.meta && result.meta.stale) msg = `⚠️ ${id} 暫時無法連線 FinMind，目前顯示的是上次的資料 (${newQuarter})。`;
          else if (oldQuarter && newQuarter > oldQuarter) msg = `🎉 ${id} 已更新到最新一季財報 (${newQuarter})！`;
          else msg = `✅ ${id} 財報已是最新 (${newQuarter})，尚無新財報公布。`;
          alert(added ? `${msg}\n已加入自選股。` : msg);
      }

      renderStockOverview();
      updateDetailSelect();
      fetch(`${API_BASE}/api/monthly/${id}${isUpdating ? '?refresh=1' : ''}`).catch(() => console.log('月營收更新略過'));
  } finally {
      btn.innerText = originalText;
      btn.disabled = false;
  }
}

function trackStock(id) {
  if (!portfolio.includes(id)) {
      portfolio.push(id);
      savePortfolio();
  }
  renderStockOverview();
}

// 移出自選股：資料保留，移到「其他已查詢股票」
function removeStock(id) {
  if (!confirm(`確定將 ${id} 移出自選股？\n資料會保留在「其他已查詢股票」。`)) return;
  portfolio = portfolio.filter(item => item !== id);
  savePortfolio();
  renderStockOverview();
}

function deleteStockData(id) {
  if (!confirm(`確定刪除 ${id} 的查詢紀錄？`)) return;
  const stockDatabase = loadStockDatabase();
  delete stockDatabase[id];
  saveStockDatabase(stockDatabase);
  renderStockOverview();
}

// 支援 skipNews 避免切換標準時重抓新聞
function overrideCompanyType(stockId, newType) {
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    overrides[stockId] = newType;
    localStorage.setItem('typeOverrides', JSON.stringify(overrides));
    loadDetailView(stockId, true);
}

// 卡片底部：上次更新時間＋更新按鈕，以及查看／自選股操作（個股與 ETF 卡片共用）
function cardFooterHtml(id, updatedAt, isTracked, detailLabel) {
  const actions = isTracked
    ? `<button class="btn-outline" style="color: var(--red); border-color: var(--red);" onclick="removeStock('${id}')">移除</button>`
    : `<button class="btn-outline" style="margin-right: 8px;" onclick="trackStock('${id}')">加入自選</button>
       <button class="btn-outline" style="color: var(--red); border-color: var(--red);" onclick="deleteStockData('${id}')">刪除</button>`;
  return `
    <div class="flex-between" style="margin-bottom: 8px; gap: 8px;">
      <span class="card-updated">上次更新：${formatDateTime(updatedAt)}</span>
      <button class="btn-outline" style="color: var(--green); border-color: var(--green);" onclick="syncStock('${id}', this)">更新</button>
    </div>
    <div class="flex-between">
      <a href="details.html?id=${id}" class="btn-primary" style="flex:1; margin-right: 8px; text-align:center;">${detailLabel}</a>
      ${actions}
    </div>`;
}

function stockCardHtml(item, isTracked) {
  const latest = item.data.quarters[item.data.quarters.length - 1];
  const statusText = item.status === 'red' ? '警戒' : (item.status === 'yellow' ? '注意' : '正常');
  const typeLabel = TYPE_PROFILES[item.effectiveType] ? TYPE_PROFILES[item.effectiveType].label : '一般';
  const isFin = item.effectiveType === 'financial';
  const fmt = (val, inapp, suf) => {
      if (isFin && inapp) return '不適用';
      if (val == null) return '—';
      return val + suf;
  };
  const riskColor = item.riskScore > 30 ? 'var(--red)' : (item.riskScore > 0 ? 'var(--yellow)' : 'var(--green)');

  return `
    <div class="card" style="border-top: 4px solid var(--${item.status}); position: relative;">
      <div class="flex-between" style="margin-bottom: 12px;">
        <h3 style="margin:0; display:flex; align-items:center; gap:8px;">
          ${item.id} ${escapeHtml(item.data.name)}
          <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">${typeLabel}</span>
        </h3>
        <span class="status-indicator"><span class="dot ${item.status}"></span> ${statusText}</span>
      </div>
      <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 16px;">
        <div style="display:flex; justify-content:space-between;"><span>最新營收年增:</span> <strong style="color:var(--text)">${fmt(latest.revenueYoY, false, '%')}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>毛利率:</span> <strong style="color:var(--text)">${fmt(latest.grossMargin, true, '%')}</strong></div>
        <div style="display:flex; justify-content:space-between;"><span>負債比:</span> <strong style="color:var(--text)">${fmt(latest.debtRatio, false, '%')}</strong></div>
      </div>
      <div class="flex-between" style="margin-bottom: 12px; font-size: 0.85rem; padding-bottom:12px; border-bottom:1px dashed var(--border);">
          <span>觸發警訊數：<strong>${item.alerts.length}</strong> 項</span>
          <span class="badge" style="background:${riskColor}; color:#fff;">風險分數: ${item.riskScore}</span>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 16px;">
          📝 ${item.summary.short}
      </div>
      ${cardFooterHtml(item.id, item.data.meta && item.data.meta.checkedAt, isTracked, '查看詳情')}
    </div>
  `;
}

// 首頁：自選股，以及其他查詢過財報但未加入自選股的公司
function renderStockOverview() {
  const trackedGrid = document.getElementById('tracked-grid');
  if (!trackedGrid) return;

  const stockDatabase = loadStockDatabase();
  const sortBy = document.getElementById('sort-select').value;
  const severity = { red: 3, yellow: 2, green: 1 };
  const analyzeAll = ids => {
      const list = ids.map(id => ({ id, ...analyzeData(id, stockDatabase[id]) })).filter(item => item.data);
      if (sortBy === 'severity') list.sort((a, b) => severity[b.status] - severity[a.status] || a.id.localeCompare(b.id));
      else list.sort((a, b) => a.id.localeCompare(b.id));
      return list;
  };

  // ETF 沒有個股燈號，依代號排序
  const buildSection = (ids, isTracked) => {
      const stocks = analyzeAll(ids);
      const etfs = ids.filter(id => stockDatabase[id] && stockDatabase[id].isEtf).sort((a, b) => a.localeCompare(b));
      return {
          stockCount: stocks.length, etfCount: etfs.length, count: stocks.length + etfs.length,
          stockHtml: stocks.map(item => stockCardHtml(item, isTracked)).join(''),
          etfHtml: etfs.map(id => etfCardHtml(id, stockDatabase[id], isTracked)).join('')
      };
  };

  // 自選股：個股與 ETF 分成兩個區塊
  const tracked = buildSection(portfolio, true);
  trackedGrid.innerHTML = tracked.stockHtml;
  document.getElementById('tracked-count').textContent = `(${tracked.stockCount})`;
  const trackedEmpty = document.getElementById('tracked-empty');
  trackedEmpty.style.display = tracked.stockCount ? 'none' : 'block';
  trackedEmpty.textContent = seedingDefaults
      ? `正在載入預設自選股（${DEFAULT_PORTFOLIO.join('、')}）…`
      : (tracked.etfCount ? '尚未加入個股，請在上方輸入代號 (例: 2330、2317、2887)' : '尚未加入自選股，請在上方輸入代號 (例: 2330、2317、2887、0050)');
  document.getElementById('etf-section').style.display = tracked.etfCount ? 'block' : 'none';
  document.getElementById('etf-count').textContent = `(${tracked.etfCount})`;
  document.getElementById('etf-grid').innerHTML = tracked.etfHtml;

  // 其他已查詢：個股在前、ETF 在後
  const others = buildSection(Object.keys(stockDatabase).filter(id => !portfolio.includes(id)), false);
  document.getElementById('others-section').style.display = others.count ? 'block' : 'none';
  document.getElementById('others-count').textContent = `(${others.count})`;
  document.getElementById('others-grid').innerHTML = others.stockHtml + others.etfHtml;
  ['tracked', 'etf', 'others'].forEach(applySectionState);
  updateHomeToc({ tracked: tracked.stockCount, etf: tracked.etfCount, others: others.count });
  if (typeof renderHomeRecommendations === 'function') renderHomeRecommendations();
}

// 首頁區塊的展開／收合狀態（記在瀏覽器，下次打開維持）
function loadCollapsedSections() {
  try { return JSON.parse(localStorage.getItem('collapsed_sections') || '[]'); }
  catch (err) { return []; }
}

function applySectionState(name) {
  const collapsed = loadCollapsedSections().includes(name);
  const toggle = document.getElementById(`${name}-toggle`);
  document.getElementById(`${name}-body`).style.display = collapsed ? 'none' : 'block';
  toggle.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
}

function toggleSection(name) {
  const collapsed = loadCollapsedSections();
  const next = collapsed.includes(name) ? collapsed.filter(n => n !== name) : [...collapsed, name];
  try { localStorage.setItem('collapsed_sections', JSON.stringify(next)); } catch (err) { /* 無法儲存時只影響這次瀏覽 */ }
  applySectionState(name);
}

function initAlerts() { renderAlerts(); }

function renderAlerts() {
  const container = document.getElementById('alerts-list');
  const empty = document.getElementById('alerts-empty');
  if (!container) return;
  const mode = document.getElementById('alert-filter').value;
  container.innerHTML = '';
  let hasAnyAlert = false;

  if (mode === 'group') {
    sortByTocOrder([...portfolio].sort((a, b) => a.localeCompare(b)), ALERTS_ORDER_KEY).forEach(id => {
      const analysis = analyzeStock(id);
      if (analysis && analysis.alerts && analysis.alerts.length > 0) {
        hasAnyAlert = true;
        let compAlerts = analysis.alerts.slice().sort((a, b) => (a.detail.level || a.rule.level) === 'red' ? -1 : 1);
        let alertsHtml = compAlerts.map(a => {
          const lvl = a.detail.level || a.rule.level;
          const badgeClass = lvl === 'red' ? 'red' : 'yellow';
          const badgeText = lvl === 'red' ? '紅燈' : '黃燈';
          return `
            <a href="details.html?id=${id}&tab=${a.rule.tab}" class="alert-item ${lvl}" style="display:block; color:inherit; margin-top: 8px;">
              <div class="flex-between" style="margin-bottom: 4px;">
                <strong>${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
              </div>
              <p style="font-size: 0.9rem; color: var(--text-light);">${a.detail.text}</p>
            </a>
          `;
        }).join('');

        container.innerHTML += `
          <div class="card" data-stock-id="${id}" style="margin-bottom: 16px; border-top: 4px solid var(--${analysis.status})">
            <h3 style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span>${id} ${escapeHtml(analysis.data.name)}</span><span class="badge ${analysis.status}">${analysis.alerts.length} 項警訊</span>
            </h3>
            ${alertsHtml}
          </div>
        `;
      }
    });
  } else {
    let allAlerts = [];
    portfolio.forEach(id => {
      const analysis = analyzeStock(id);
      if(analysis && analysis.alerts) {
        analysis.alerts.forEach(a => { allAlerts.push({ stockId: id, stockName: analysis.data.name, ...a }); });
      }
    });
    if (mode === 'red' || mode === 'yellow') allAlerts = allAlerts.filter(a => (a.detail.level || a.rule.level) === mode);
    allAlerts.sort((a, b) => {
      const aLvl = a.detail.level || a.rule.level;
      const bLvl = b.detail.level || b.rule.level;
      if(aLvl === bLvl) return a.stockId.localeCompare(b.stockId);
      return aLvl === 'red' ? -1 : 1;
    });
    if (allAlerts.length > 0) hasAnyAlert = true;
    allAlerts.forEach(a => {
      const lvl = a.detail.level || a.rule.level;
      const badgeClass = lvl === 'red' ? 'red' : 'yellow';
      const badgeText = lvl === 'red' ? '紅燈' : '黃燈';
      container.innerHTML += `
        <a href="details.html?id=${a.stockId}&tab=${a.rule.tab}" class="alert-item ${lvl}" data-stock-id="${a.stockId}" style="display:block; color:inherit;">
          <div class="flex-between" style="margin-bottom: 4px;">
            <strong>${a.stockId} ${escapeHtml(a.stockName)} - ${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
          </div>
          <p style="font-size: 0.9rem; color: var(--text-light);">${a.detail.text}</p>
        </a>
      `;
    });
  }

  empty.style.display = hasAnyAlert ? 'none' : 'block';
  if (!hasAnyAlert) empty.innerHTML = alertsEmptyMessage(mode);
  renderAlertsToc();
}

// 沒有警訊時，區分「真的通過檢驗」與「根本沒有可檢驗的股票」，避免誤以為沒有風險
function alertsEmptyMessage(mode) {
  const checkedCount = portfolio.filter(id => analyzeStock(id)).length;
  if (seedingDefaults) return '<p>正在載入預設自選股…</p>';
  if (portfolio.length === 0) {
    return `<p style="margin-bottom:12px;">尚未加入任何股票，因此沒有可檢驗的財報。</p>
            <a href="index.html" class="btn-link-primary">前往新增股票</a>`;
  }
  if (checkedCount === 0) {
    return `<p style="margin-bottom:12px;">自選股中沒有可檢驗財報的個股（ETF 不適用個股財報警訊，或資料尚未載入）。</p>
            <a href="index.html" class="btn-link-primary">前往新增個股</a>`;
  }
  if (mode === 'red' || mode === 'yellow') {
    return `<p>沒有符合篩選條件（${mode === 'red' ? '紅燈' : '黃燈'}）的警訊。</p>`;
  }
  return `<p>已檢驗自選股中的 ${checkedCount} 檔個股，皆未觸發警訊 🎉</p>`;
}

function initDetails() {
    updateDetailSelect();
    const urlParams = new URLSearchParams(window.location.search);
    const stockId = urlParams.get('id');
    const targetTab = urlParams.get('tab') || 'income';
    const from = urlParams.get('from');
    const stockDatabase = loadStockDatabase();

    if (stockId) {
        if (stockDatabase[stockId] && stockDatabase[stockId].isEtf) {
            // 1. 查詢過的 ETF（不論是否在自選股）
            if (portfolio.includes(stockId)) document.getElementById('detail-stock-select').value = stockId;
            const listView = document.getElementById('detail-list-view');
            if(listView) listView.style.display = 'none';
            const contentObj = document.getElementById('detail-content');
            if(contentObj) contentObj.style.display = 'none';
            const etfView = document.getElementById('etf-view');
            if(etfView) etfView.style.display = 'block';
            if (typeof renderEtfView === 'function') renderEtfView(stockId);
        } else if (portfolio.includes(stockId)) {
            // 2. 自選股中的一般股票
            document.getElementById('detail-stock-select').value = stockId;
            loadDetailView(stockId);
            switchDetailTab(targetTab);
        } else if (/^[0-9]{4,6}$/.test(stockId) && (from || stockDatabase[stockId])) {
            // 3. 預覽模式 (成分股)
            if (typeof startPreviewMode === 'function') startPreviewMode(stockId, from);
        } else {
           // 4. 其他
           showDetailList();
        }
    } else {
        showDetailList();
    }
}

function showDetailList() {
    const contentObj = document.getElementById('detail-content');
    if (contentObj) contentObj.style.display = 'none';
    const etfView = document.getElementById('etf-view');
    if (etfView) etfView.style.display = 'none';
    const listView = document.getElementById('detail-list-view');
    if(listView) listView.style.display = 'block';
    renderDetailStockList();
}

// 自選股依代號排序並分成個股與 ETF（沒有資料的略過）
function splitPortfolio() {
  const stockDatabase = loadStockDatabase();
  const ids = [...portfolio].filter(id => stockDatabase[id]).sort((a, b) => a.localeCompare(b));
  return {
    stockDatabase,
    stocks: ids.filter(id => !stockDatabase[id].isEtf),
    etfs: ids.filter(id => stockDatabase[id].isEtf)
  };
}

function detailListCardHtml(id, name, label, info, linkText) {
  return `
    <div class="card" style="cursor: pointer; transition: 0.2s;" onclick="changeDetailStock('${id}')" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
      <h3 style="margin: 0 0 8px 0; display:flex; align-items:center; gap:8px;">${id} ${escapeHtml(name)}
        <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">${label}</span>
      </h3>
      <p style="color: var(--text-light); font-size: 0.9rem;">${info}</p>
      <p style="color: var(--primary); font-size: 0.9rem; margin-top: 12px; font-weight: bold;">${linkText} →</p>
    </div>`;
}

function renderDetailStockList() {
  const emptyMsg = document.getElementById('detail-list-empty');
  if (!emptyMsg) return;

  const { stockDatabase, stocks, etfs } = splitPortfolio();
  const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');

  document.getElementById('detail-stock-list').innerHTML = stocks.map(id => {
      const data = stockDatabase[id];
      const effType = overrides[id] || getDefaultCompanyType(getIndustries(data), data.isFinancial);
      return detailListCardHtml(id, data.name, TYPE_PROFILES[effType].label, `產業: ${escapeHtml(pickIndustry(getIndustries(data)))}`, '查看圖表與數據');
  }).join('');
  document.getElementById('detail-etf-list').innerHTML = etfs.map(id => {
      const data = stockDatabase[id];
      return detailListCardHtml(id, data.name, 'ETF', `成分股 ${escapeHtml(data.count || 0)} 檔`, '查看成分股');
  }).join('');

  document.getElementById('detail-stock-count').textContent = `(${stocks.length})`;
  document.getElementById('detail-etf-count').textContent = `(${etfs.length})`;
  document.getElementById('detail-stock-section').style.display = stocks.length ? 'block' : 'none';
  document.getElementById('detail-etf-section').style.display = etfs.length ? 'block' : 'none';
  emptyMsg.style.display = stocks.length || etfs.length ? 'none' : 'block';
}

function updateDetailSelect() {
  const sel = document.getElementById('detail-stock-select');
  if (!sel) return;
  const currentVal = sel.value;
  const { stockDatabase, stocks, etfs } = splitPortfolio();
  const options = ids => ids.map(id => `<option value="${id}">${id} ${escapeHtml(stockDatabase[id].name)}</option>`).join('');
  sel.innerHTML = '<option value="">請選擇股票...</option>'
      + (stocks.length ? `<optgroup label="個股">${options(stocks)}</optgroup>` : '')
      + (etfs.length ? `<optgroup label="ETF">${options(etfs)}</optgroup>` : '');
  if (portfolio.includes(currentVal)) sel.value = currentVal;
}

function changeDetailStock(id) {
  if (id) window.location.href = `details.html?id=${id}`;
  else window.location.href = `details.html`;
}

function switchDetailTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  
  const targetBtn = document.querySelector(`[onclick="switchDetailTab('${tabId}')"]`);
  const targetTab = document.getElementById(`tab-${tabId}`);
  if(targetBtn) targetBtn.classList.add('active');
  if(targetTab) targetTab.classList.add('active');
  document.querySelectorAll('.page-toc a[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === tabId));
}

// ================= 左側區塊導覽（個股詳情、警訊總覽共用） =================
// 寬螢幕時固定在左側；窄螢幕（≤ 960px）時變成黏在導覽列下方、可橫向捲動的一列。
const TOC_COMPACT_QUERY = window.matchMedia('(max-width: 960px)');

function tocStickyOffset() {
  const header = document.querySelector('header');
  let offset = header ? header.getBoundingClientRect().height : 0;
  const toc = document.querySelector('.page-toc');
  if (toc && TOC_COMPACT_QUERY.matches) offset += toc.getBoundingClientRect().height;
  return offset + 12;
}

function scrollToWithOffset(el) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = el.getBoundingClientRect().top + window.scrollY - tocStickyOffset();
  window.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
}

// 讓 CSS 知道導覽列高度（導覽列在手機上會換行，高度不固定）
function syncHeaderHeightVar() {
  const header = document.querySelector('header');
  if (!header) return;
  const sync = () => document.documentElement.style.setProperty('--header-h', `${header.getBoundingClientRect().height}px`);
  sync();
  if ('ResizeObserver' in window) new ResizeObserver(sync).observe(header);
  else window.addEventListener('resize', sync);
}

/**
 * 設定左側導覽：點擊跳轉＋捲動時標示目前位置。
 * - getMarkers()：回傳頁面上的位置標記 [{ key, el }]（依頁面順序），每次捲動時重新取得，內容重畫也不受影響
 * - resolveTarget(link)：回傳點擊後要跳到的元素；回傳 null 時照連結原本的 href 前往
 * 導覽中的連結以 data-key 對應標記的 key。
 */
function setupPageToc(toc, { getMarkers, resolveTarget }) {
  syncHeaderHeightVar();

  toc.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-key]');
    if (!link) return;
    const target = resolveTarget(link);
    if (!target) return;
    e.preventDefault();
    scrollToWithOffset(target);
    target.classList.remove('toc-flash');
    void target.offsetWidth; // 重新觸發動畫
    target.classList.add('toc-flash');
  });

  let ticking = false;
  const update = () => {
    ticking = false;
    const markers = getMarkers().filter(m => m.el.offsetParent !== null);
    if (!markers.length) {
      toc.querySelectorAll('a[data-key].active').forEach(a => a.classList.remove('active'));
      return;
    }
    const line = tocStickyOffset() + 40;
    let current = markers[0];
    for (const m of markers) if (m.el.getBoundingClientRect().top <= line) current = m;
    // 捲到頁面最底時，最後一個區塊可能永遠到不了判斷線，直接標示最後一個
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = markers[markers.length - 1];
    toc.querySelectorAll('a[data-key]:not([data-tab])').forEach(a => {
      const isActive = a.dataset.key === current.key;
      a.classList.toggle('active', isActive);
      if (isActive && TOC_COMPACT_QUERY.matches) {
        // 窄螢幕：把目前的項目橫向捲進可視範圍（不用 scrollIntoView，避免連帶垂直捲動）
        const left = a.offsetLeft - (toc.clientWidth - a.offsetWidth) / 2;
        toc.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
      } else if (isActive) {
        // 寬螢幕：導覽本身太長而出現捲軸時，讓目前項目保持在導覽可見範圍內
        const aTop = a.offsetTop, aBottom = aTop + a.offsetHeight;
        if (aTop < toc.scrollTop || aBottom > toc.scrollTop + toc.clientHeight) toc.scrollTop = aTop - toc.clientHeight / 2;
      }
    });
  };
  const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
  return { refresh: schedule };
}

// ================= 導覽「編輯」：使用者自訂排列順序（只存在這台裝置的瀏覽器） =================
function loadTocOrder(storageKey) {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}
function saveTocOrder(storageKey, keys) {
  try { keys ? localStorage.setItem(storageKey, JSON.stringify(keys)) : localStorage.removeItem(storageKey); } catch {}
}
// 依使用者存的順序排序；沒出現在順序裡的（例如新加入的公司）維持原本相對順序排在後面
function sortByTocOrder(list, storageKey, getKey = x => x) {
  const order = loadTocOrder(storageKey);
  if (!order) return list;
  const pos = new Map(order.map((k, i) => [k, i]));
  const rank = x => (pos.has(getKey(x)) ? pos.get(getKey(x)) : Infinity);
  return [...list].sort((a, b) => rank(a) - rank(b));
}
const liKey = li => { const a = li.querySelector(':scope > a[data-key]'); return a ? a.dataset.key : null; };
// 依 keys 重新排列 parent 底下對應的子元素（只動這些元素，其他元素位置不變）
function reorderChildren(keys, getEl) {
  const els = keys.map(getEl).filter(Boolean);
  if (els.length < 2) return;
  const parent = els[0].parentNode;
  const first = [...parent.children].find(c => els.includes(c));
  const anchor = document.createComment('order');
  parent.insertBefore(anchor, first);
  els.forEach(el => parent.insertBefore(el, anchor));
  anchor.remove();
}

/**
 * 在導覽標題加上「編輯」按鈕。編輯模式下可拖曳或用 ▲▼ 調整 listEl 底下各項目的順序。
 * - onChange(keys)：順序改變後呼叫（keys 為 null 代表恢復預設）
 */
function setupTocEditor(toc, { storageKey, listEl, onChange }) {
  const title = toc.querySelector('.page-toc-title');
  if (!title) return { refresh() {} };
  let editing = false;
  let dragging = null;

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'toc-edit-btn';
  editBtn.textContent = '✎ 編輯';
  editBtn.title = '自訂排列順序（只存在這台裝置）';
  title.appendChild(editBtn);

  const bar = document.createElement('div');
  bar.className = 'toc-edit-bar';
  bar.innerHTML = `<p>拖曳或按 ▲▼ 調整順序，會自動儲存在這台裝置的瀏覽器。</p>
    <div><button type="button" class="btn-outline toc-edit-reset">恢復預設</button>
    <button type="button" class="btn-primary toc-edit-done">完成</button></div>`;
  title.insertAdjacentElement('afterend', bar);

  const items = () => [...listEl.children].filter(li => liKey(li));
  const visible = li => li.style.display !== 'none';
  const commit = () => {
    const keys = items().map(liKey);
    saveTocOrder(storageKey, keys);
    onChange(keys);
  };
  const refresh = () => {
    toc.classList.toggle('editing', editing);
    editBtn.textContent = editing ? '完成' : '✎ 編輯';
    editBtn.setAttribute('aria-pressed', String(editing));
    items().forEach(li => {
      li.draggable = editing;
      let ctl = li.querySelector(':scope > .toc-move');
      if (editing && !ctl) {
        ctl = document.createElement('span');
        ctl.className = 'toc-move';
        ctl.innerHTML = '<button type="button" class="toc-move-up" title="往前移" aria-label="往前移">▲</button><button type="button" class="toc-move-down" title="往後移" aria-label="往後移">▼</button>';
        li.appendChild(ctl);
      } else if (!editing && ctl) {
        ctl.remove();
      }
    });
  };
  const setEditing = (on) => { editing = on; refresh(); };

  editBtn.addEventListener('click', () => setEditing(!editing));
  bar.querySelector('.toc-edit-done').addEventListener('click', () => setEditing(false));
  bar.querySelector('.toc-edit-reset').addEventListener('click', () => {
    saveTocOrder(storageKey, null);
    onChange(null);
    refresh();
  });

  // 編輯中點連結不跳轉（capture 階段攔下，導覽本身的點擊處理就不會執行）
  toc.addEventListener('click', (e) => {
    if (!editing) return;
    const move = e.target.closest('.toc-move-up, .toc-move-down');
    if (move) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const li = move.closest('li');
      const up = move.classList.contains('toc-move-up');
      let sib = up ? li.previousElementSibling : li.nextElementSibling;
      while (sib && !visible(sib)) sib = up ? sib.previousElementSibling : sib.nextElementSibling;
      if (!sib) return;
      const key = liKey(li);
      listEl.insertBefore(li, up ? sib : sib.nextElementSibling);
      commit();
      // 清單可能被重畫（警訊總覽），依代號找回同一項讓鍵盤焦點留在原處
      const now = [...listEl.children].find(x => liKey(x) === key);
      const again = now && now.querySelector(up ? '.toc-move-up' : '.toc-move-down');
      if (again) again.focus();
      return;
    }
    if (e.target.closest('a[data-key]')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li');
    if (!editing || !li || li.parentElement !== listEl) return;
    dragging = li;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', liKey(li)); } catch {}
  });
  listEl.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const over = e.target.closest('li');
    if (!over || over === dragging || over.parentElement !== listEl) return;
    const rect = over.getBoundingClientRect();
    const after = TOC_COMPACT_QUERY.matches
      ? e.clientX > rect.left + rect.width / 2
      : e.clientY > rect.top + rect.height / 2;
    listEl.insertBefore(dragging, after ? over.nextElementSibling : over);
  });
  listEl.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
    commit();
  });

  return { refresh, isEditing: () => editing };
}

// 區塊型頁面（個股詳情、已查詢股票）：導覽順序＝頁面區塊順序
function setupSectionOrderEditor(toc, storageKey) {
  const listEl = toc.querySelector(':scope > ul');
  const defaultKeys = [...listEl.children].map(liKey).filter(Boolean);
  const apply = (keys) => {
    const order = keys || defaultKeys;
    const full = [...order.filter(k => defaultKeys.includes(k)), ...defaultKeys.filter(k => !order.includes(k))];
    reorderChildren(full, k => [...listEl.children].find(li => liKey(li) === k));
    reorderChildren(full, k => document.getElementById(k));
  };
  const saved = loadTocOrder(storageKey);
  if (saved) apply(saved);
  return setupTocEditor(toc, { storageKey, listEl, onChange: apply });
}
// 依目前導覽順序（＝頁面順序）取得區塊標記
function sectionMarkers(toc) {
  return [...toc.querySelectorAll(':scope > ul > li > a[data-key]')]
    .map(a => ({ key: a.dataset.key, el: document.getElementById(a.dataset.key) })).filter(m => m.el);
}

// 個股詳情：固定的區塊清單（財務報表底下的子項目會順便切換分頁）
function initDetailToc() {
  const toc = document.getElementById('detail-toc');
  if (!toc) return;
  setupSectionOrderEditor(toc, 'toc_order_details');
  setupPageToc(toc, {
    getMarkers: () => sectionMarkers(toc),
    resolveTarget: (link) => {
      if (link.dataset.tab) switchDetailTab(link.dataset.tab);
      return document.getElementById(link.dataset.key);
    }
  });
  const activeTab = document.querySelector('.tab-btn.active');
  const m = activeTab && (activeTab.getAttribute('onclick') || '').match(/switchDetailTab\('(\w+)'\)/);
  if (m) toc.querySelectorAll('a[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === m[1]));
}

// 警訊總覽：列出所有自選公司，點擊跳到該公司的警訊
let alertsTocCtl = null;
let alertsTocEditor = null;
const ALERTS_ORDER_KEY = 'toc_order_alerts';
function initAlertsToc() {
  const toc = document.getElementById('alerts-toc');
  if (!toc || alertsTocCtl) return;
  alertsTocEditor = setupTocEditor(toc, {
    storageKey: ALERTS_ORDER_KEY,
    listEl: document.getElementById('alerts-toc-list'),
    onChange: () => renderAlerts()   // 依新順序重畫公司清單與「依公司分組」的卡片
  });
  alertsTocCtl = setupPageToc(toc, {
    getMarkers: () => {
      // 依公司分組時每家公司一張卡片；其他模式下同一家公司的警訊分散各處，只取每家第一筆
      const seen = new Set();
      return [...document.querySelectorAll('#alerts-list [data-stock-id]')]
        .filter(el => !seen.has(el.dataset.stockId) && seen.add(el.dataset.stockId))
        .map(el => ({ key: el.dataset.stockId, el }));
    },
    resolveTarget: (link) => {
      const id = link.dataset.key;
      const find = () => document.querySelector(`#alerts-list [data-stock-id="${id}"]`);
      let target = find();
      // 目前的篩選（例如僅顯示紅燈）看不到這家公司的警訊時，切回「依公司分組」再跳
      if (!target && Number(link.dataset.count) > 0) {
        document.getElementById('alert-filter').value = 'group';
        renderAlerts();
        target = find();
      }
      return target; // 沒有任何警訊的公司回傳 null，直接前往個股詳情
    }
  });
}

function renderAlertsToc() {
  const listEl = document.getElementById('alerts-toc-list');
  if (!listEl) return;
  const companies = sortByTocOrder([...portfolio].sort((a, b) => a.localeCompare(b)), ALERTS_ORDER_KEY)
    .map(id => ({ id, analysis: analyzeStock(id) }))
    .filter(c => c.analysis);
  document.getElementById('alerts-toc-count').textContent = companies.length ? `（${companies.length} 家）` : '';
  if (!companies.length) {
    listEl.innerHTML = '<li class="page-toc-empty">尚無自選公司</li>';
  } else {
    listEl.innerHTML = companies.map(({ id, analysis }) => {
      const count = analysis.alerts.length;
      const status = count ? analysis.status : 'green';
      return `<li><a href="details.html?id=${id}" data-key="${id}" data-count="${count}" title="${count ? `跳到 ${id} 的警訊` : `${id} 沒有警訊，前往個股詳情`}">
        <span class="dot ${status}"></span>
        <span class="page-toc-label">${id} ${escapeHtml(analysis.data.name)}</span>
        <span class="page-toc-count ${count ? status : 'none'}">${count || '✓'}</span>
      </a></li>`;
    }).join('');
  }
  initAlertsToc();
  if (alertsTocEditor) alertsTocEditor.refresh();
  if (alertsTocCtl) alertsTocCtl.refresh();
}

// 已查詢股票：自選股、ETF、其他已查詢、推薦。點擊收合中的區塊會先展開再跳過去
let homeTocCtl = null;
function updateHomeToc(counts) {
  const toc = document.getElementById('home-toc');
  if (!toc) return;
  Object.entries(counts).forEach(([name, n]) => {
    const numEl = document.getElementById(`toc-${name}-count`);
    if (numEl) numEl.textContent = n;
    const link = toc.querySelector(`a[data-key="${name}-section"]`);
    // ETF、其他已查詢沒有內容時區塊會隱藏，導覽也一起隱藏
    if (link && name !== 'tracked') link.parentElement.style.display = n ? '' : 'none';
  });
  if (!homeTocCtl) {
    setupSectionOrderEditor(toc, 'toc_order_home');
    homeTocCtl = setupPageToc(toc, {
      getMarkers: () => sectionMarkers(toc),
      resolveTarget: (link) => {
        const name = link.dataset.key.replace(/-section$/, '');
        if (loadCollapsedSections().includes(name)) toggleSection(name);
        return document.getElementById(link.dataset.key);
      }
    });
  } else {
    homeTocCtl.refresh();
  }
}

document.addEventListener('DOMContentLoaded', initDetailToc);

function generateQoQ(quarters, isFin) {
    if (quarters.length < 2) return '<p style="color:var(--text-light); font-size:0.9rem;">資料不足以比較</p>';
    const cur = quarters[quarters.length-1];
    const prev = quarters[quarters.length-2];

    const metrics = [
        { key: 'revenue', name: '營收', type: 'pct', inv: false },
        { key: 'operatingIncome', name: '營業利益', type: 'pct', inv: false },
        { key: 'netIncome', name: '淨利', type: 'pct', inv: false },
        { key: 'grossMargin', name: '毛利率', type: 'pp', inv: false },
        { key: 'operatingMargin', name: '營益率', type: 'pp', inv: false },
        { key: 'debtRatio', name: '負債比', type: 'pp', inv: true },
        { key: 'currentRatio', name: '流動比率', type: 'diff', inv: false },
        { key: 'quickRatio', name: '速動比率', type: 'diff', inv: false },
        { key: 'interestCoverage', name: '利息保障倍數', type: 'diff', inv: false },
        { key: 'arDays', name: '應收天數', type: 'diff', inv: true },
        { key: 'invDays', name: '存貨天數', type: 'diff', inv: true },
        { key: 'operatingCF', name: '營業現金流', type: 'pct', inv: false },
        { key: 'freeCF', name: '自由現金流', type: 'pct', inv: false }
    ];

    let results = [];
    metrics.forEach(m => {
        if (isFin && ['grossMargin', 'currentRatio', 'quickRatio', 'arDays', 'invDays', 'interestCoverage', 'freeCF'].includes(m.key)) return;
        if (cur[m.key] == null || prev[m.key] == null) return;
        
        let diff = 0;
        let txt = '';
        if (m.type === 'pp') {
            diff = cur[m.key] - prev[m.key];
            txt = `${diff > 0 ? '+' : ''}${diff.toFixed(2)} pp`;
        } else if (m.type === 'diff') {
            diff = cur[m.key] - prev[m.key];
            txt = `${diff > 0 ? '+' : ''}${diff.toFixed(2)}`;
        } else if (m.type === 'pct') {
            if (prev[m.key] === 0) return;
            diff = (cur[m.key] - prev[m.key]) / Math.abs(prev[m.key]) * 100;
            txt = `${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`;
        }
        let impact = m.inv ? -diff : diff;
        results.push({ ...m, curVal: cur[m.key], prevVal: prev[m.key], diff, impact, txt });
    });

    results.sort((a, b) => b.impact - a.impact);
    let improved = results.filter(r => r.impact > 0.05).slice(0, 3);
    let worsened = results.filter(r => r.impact < -0.05).slice(-3).reverse();

    const renderItems = (items, colorClass) => {
        if (items.length === 0) return `<p style="color:var(--text-light); font-size:0.9rem;">無明顯變動</p>`;
        return items.map(item => `
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:0.9rem;">
                <span>${item.name}</span>
                <span>${item.prevVal} ➔ ${item.curVal} <span class="${colorClass}">${item.impact > 0 ? '▲' : '▼'} ${item.txt}</span></span>
            </div>
        `).join('');
    };

    return `
        <div style="display:flex; gap:16px; margin-top:16px;">
            <div style="flex:1; background:var(--bg); padding:12px; border-radius:6px; border:1px solid var(--border);">
                <h4 style="margin:0 0 12px 0; color:var(--green);">🟢 變好最多</h4>
                ${renderItems(improved, 'green')}
            </div>
            <div style="flex:1; background:var(--bg); padding:12px; border-radius:6px; border:1px solid var(--border);">
                <h4 style="margin:0 0 12px 0; color:var(--red);">🔴 變差最多</h4>
                ${renderItems(worsened, 'red')}
            </div>
        </div>
    `;
}

// 支援 skipNews 選項
function loadDetailView(stockId, skipNews = false) {
  const analysis = analyzeStock(stockId);
  if(!analysis) return;
  window.currentStockId = stockId;
  window.currentAlerts = analysis.alerts;
  window.currentAnalysis = analysis;
  
  const listView = document.getElementById('detail-list-view');
  if(listView) listView.style.display = 'none';
  const contentObj = document.getElementById('detail-content');
  if(contentObj) contentObj.style.display = 'block';
  
  if (document.getElementById('detail-name')) {
      document.getElementById('detail-name').innerText = `${stockId} ${analysis.data.name}`;
      document.getElementById('detail-industry').innerText = `產業: ${pickIndustry(getIndustries(analysis.data))}`;
      document.getElementById('detail-dot').className = `dot ${analysis.status}`;
      document.getElementById('detail-status-text').innerText = analysis.status === 'red' ? '警戒狀態' : (analysis.status === 'yellow' ? '注意狀態' : '正常健康');
      const typeSelect = document.getElementById('company-type-select');
      typeSelect.innerHTML = Object.entries(TYPE_PROFILES).map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('');
      typeSelect.value = analysis.effectiveType;
      document.getElementById('company-type-desc').innerText = TYPE_PROFILES[analysis.effectiveType].desc;
  }

  const plainSummaryEl = document.getElementById('detail-plain-summary');
  if (plainSummaryEl) {
      plainSummaryEl.innerHTML = `
        <div style="background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 12px;">
          <h4 style="margin:0 0 8px 0;">💬 AI 財報白話解析</h4>
          <p style="margin:0; color: var(--text-light); line-height: 1.5; font-size: 0.95rem;">${analysis.summary.detail}</p>
        </div>
      `;
  }

  const qoqEl = document.getElementById('detail-qoq');
  if (qoqEl) {
      qoqEl.innerHTML = generateQoQ(analysis.data.quarters, analysis.effectiveType === 'financial');
  }

  const alertsSumEl = document.getElementById('detail-alerts-summary');
  if (alertsSumEl) {
      let alertsSumHtml = '';
      if (analysis.alerts.length === 0) { alertsSumHtml = '<span style="color:var(--green)">✓ 財報表現良好，未觸發任何警訊。</span>'; } 
      else { alertsSumHtml = analysis.alerts.map(a => `<div style="margin-top:4px;">⚠️ <strong>${a.rule.name}</strong>: ${a.detail.text}</div>`).join(''); }
      
      if (analysis.skipped && analysis.skipped.length > 0) {
          const skippedNames = analysis.skipped.map(r => r.name).join('、');
          alertsSumHtml += `<div style="margin-top:12px; color:var(--text-light); font-size:0.85rem; border-top: 1px dashed var(--border); padding-top: 8px;">
            ℹ️ <strong>資料完整度提示：</strong>本檔有 ${analysis.skipped.length} 項規則因資料不足未判斷 (${skippedNames})
          </div>`;
      }
      const meta = analysis.data.meta || {};
      if (meta.source === 'finmind-direct') {
          alertsSumHtml += `<div style="margin-top:8px; color:var(--yellow); font-size:0.85rem;">ℹ️ 資料庫暫時無法連線，這份資料是直接向 FinMind 抓取的（未使用快取）。</div>`;
      }
      alertsSumEl.innerHTML = alertsSumHtml;
  }

  const tbodyIncome = document.querySelector('#table-income tbody');
  const tbodyBalance = document.querySelector('#table-balance tbody');
  const tbodyCashflow = document.querySelector('#table-cashflow tbody');
  if (tbodyIncome) tbodyIncome.innerHTML = '';
  if (tbodyBalance) tbodyBalance.innerHTML = '';
  if (tbodyCashflow) tbodyCashflow.innerHTML = '';

  const isFin = analysis.effectiveType === 'financial';
  const fmt = (val, inapplicable=false, suffix='') => {
      if (isFin && inapplicable) return '不適用';
      if (val == null) return '—';
      return val + suffix;
  };

  [...analysis.data.quarters].reverse().forEach(q => {
    if (tbodyIncome) tbodyIncome.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.revenue)}</td><td>${fmt(q.revenueYoY, false, '%')}</td><td>${fmt(q.grossMargin, true, '%')}</td><td>${fmt(q.operatingIncome)}</td><td>${fmt(q.operatingMargin, false, '%')}</td><td>${fmt(q.nonOperatingIncome)}</td><td>${fmt(q.netIncome)}</td><td>${fmt(q.eps)}</td></tr>`;
    if (tbodyBalance) tbodyBalance.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.debtRatio, false, '%')}</td><td>${fmt(q.currentRatio, true)}</td><td>${fmt(q.quickRatio, true)}</td><td>${fmt(q.interestCoverage, true)}</td><td>${fmt(q.arDays, true)}</td><td>${fmt(q.invDays, true)}</td></tr>`;
    if (tbodyCashflow) tbodyCashflow.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.operatingCF)}</td><td>${fmt(q.financingCF)}</td><td>${fmt(q.freeCF, true)}</td><td>${fmt(q.cashEnd)}</td></tr>`;
  });

  renderOfficialLinks(stockId);
  setTimeout(() => renderCharts(stockId, analysis.alerts), 0);
  loadMonthly(stockId);

  if (!skipNews) {
      loadNews(stockId);
      loadConferences(stockId);
      if (typeof loadDetailPeers === 'function') loadDetailPeers(stockId);
  }
}

// ==========================================
// 🎤 法人說明會（領先指標）：後端每天整批同步一次，這裡只讀取
// ==========================================
const CONF_PREVIEW_COUNT = 4;
let confController = null;
let currentConfData = null;
let confExpanded = false;

async function loadConferences(stockId) {
  const listEl = document.getElementById('conf-list');
  if (!listEl) return;
  if (confController) confController.abort();
  confController = new AbortController();
  currentConfData = null;
  confExpanded = false;
  listEl.innerHTML = '<p style="color:var(--text-light);">法說會資料載入中…</p>';
  document.getElementById('conf-meta').textContent = '';
  document.getElementById('conf-more-container').style.display = 'none';

  try {
      const response = await fetch(`${API_BASE}/api/conferences/${encodeURIComponent(stockId)}`, { signal: confController.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(httpErrorReason(response.status, data));
      currentConfData = data;
      renderConferences();
  } catch (err) {
      if (err.name === 'AbortError') return;
      listEl.innerHTML = `<p style="color:var(--text-light);">法說會資料無法取得：${escapeHtml(fetchErrorReason(err))} <button class="btn-outline" style="margin-left:8px;" onclick="loadConferences('${stockId}')">重試</button></p>`;
  }
}

function toggleConfExpand() {
  confExpanded = !confExpanded;
  renderConferences();
}

// 觀測站的簡報下載是送出表單（POST），不是一般網址。由使用者的瀏覽器送出與觀測站頁面相同的表單，
// 在新分頁開啟官方檔案；本站不經手、也不保存檔案。
const MOPS_FILE_RE = /^[A-Za-z0-9_-]+\.(pdf|pptx?|PDF|PPTX?)$/;
function openMopsSlide(fileName) {
  if (!MOPS_FILE_RE.test(fileName)) return;
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = 'https://mopsov.twse.com.tw/server-java/FileDownLoad';
  form.target = '_blank';
  const fields = { step: '9', filePath: '/home/html/nas/STR/', fileName, functionName: 't100sb02_1' };
  Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function safeHttpUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : null;
}

function confItemHtml(item, isUpcoming) {
  const links = (item.links || []).map(l => {
      const url = safeHttpUrl(l.url);
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)} ↗</a>` : '';
  }).join('');
  const slideLink = (file, label) => file && MOPS_FILE_RE.test(file)
      ? `<a href="#" onclick="openMopsSlide('${file}'); return false;" title="${escapeHtml(file)}">${label} ↗</a>` : '';
  const files = [slideLink(item.fileZh, '中文簡報'), slideLink(item.fileEn, '英文簡報')].filter(Boolean).join('');
  return `
    <div class="conf-item${isUpcoming ? ' upcoming' : ''}">
      <div class="conf-head">
        ${isUpcoming ? '<span class="badge" style="background:var(--primary);">即將舉行</span>' : ''}
        <span class="conf-date">${escapeHtml(item.dateText || item.date)} ${escapeHtml(item.time || '')}</span>
        <span class="conf-place">${escapeHtml(item.place || '')}</span>
      </div>
      <div class="conf-summary">${escapeHtml(item.summary || '')}</div>
      ${item.note ? `<div class="conf-place" style="margin-top:4px;">備註：${escapeHtml(item.note)}</div>` : ''}
      <div class="conf-links">
        ${files}
        ${links}
      </div>
    </div>`;
}

function renderConferences() {
  const listEl = document.getElementById('conf-list');
  const metaEl = document.getElementById('conf-meta');
  const moreContainer = document.getElementById('conf-more-container');
  const data = currentConfData;
  if (!listEl || !data) return;

  const coverage = data.coverage ? `收錄 ${data.coverage.from} ～ ${data.coverage.to}` : '';
  const synced = data.lastSuccessAt ? `更新於 ${formatDateTime(data.lastSuccessAt)}` : '';
  metaEl.textContent = [coverage, synced].filter(Boolean).join('｜');

  const items = data.items || [];
  if (!items.length) {
      moreContainer.style.display = 'none';
      const reason = data.status === 'blocked' || data.status === 'error'
          ? '法說會資料來源暫時無法連線，系統會自動稍後再試。'
          : (data.status === 'never' ? '法說會資料首次同步中，請稍後再回來看看。' : '收錄期間內沒有這家公司的法說會紀錄。');
      listEl.innerHTML = `<p style="color:var(--text-light);">${reason}可以直接到 <a href="${escapeHtml(data.sourceUrl || 'https://mopsov.twse.com.tw/mops/web/t100sb02_1')}" target="_blank" rel="noopener noreferrer">公開資訊觀測站</a> 查詢。</p>`;
      return;
  }

  // 依台灣日期判斷是否尚未舉行（多日活動以結束日為準）
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const isUpcoming = item => (item.endDate || item.date) >= today;
  const upcoming = items.filter(isUpcoming).reverse();  // 最近的排前面
  const past = items.filter(item => !isUpcoming(item));
  const ordered = [...upcoming, ...past];
  const shown = confExpanded ? ordered : ordered.slice(0, Math.max(CONF_PREVIEW_COUNT, upcoming.length));

  listEl.innerHTML = shown.map(item => confItemHtml(item, isUpcoming(item))).join('');
  moreContainer.style.display = ordered.length > shown.length || confExpanded ? 'block' : 'none';
  document.getElementById('conf-more-btn').textContent = confExpanded ? '收合' : `顯示全部 ${ordered.length} 場`;
}

// ==========================================
// 🔗 官方資料連結（只放連結，不下載、不保存檔案）
// ==========================================
function renderOfficialLinks(stockId) {
  const el = document.getElementById('official-links');
  if (!el) return;
  const id = encodeURIComponent(stockId);
  const roc = new Date().getFullYear() - 1911;  // 民國年
  // 證交所「電子資料查詢作業」：可直接帶入代號，上市、上櫃都適用
  const docUrl = (year, mtype) => `https://doc.twse.com.tw/server-java/t57sb01?step=1&colorchg=1&co_id=${id}&year=${year}&mtype=${mtype}`;
  const links = [
    { title: `股東會年報（${roc} 年）`, desc: `今年股東會資料，含 ${roc - 1} 年度年報、議事手冊`, url: docUrl(roc, 'F') },
    { title: `股東會年報（${roc - 1} 年）`, desc: `去年股東會資料，含 ${roc - 2} 年度年報`, url: docUrl(roc - 1, 'F') },
    { title: `財務報告書（${roc} 年）`, desc: '會計師查核／核閱的完整財報 PDF', url: docUrl(roc, 'A') },
    { title: `財務報告書（${roc - 1} 年）`, desc: '去年各季與年度財報 PDF', url: docUrl(roc - 1, 'A') },
    { title: '法人說明會', desc: `公開資訊觀測站法說會一覽表，請輸入代號 ${stockId} 查詢`, url: 'https://mopsov.twse.com.tw/mops/web/t100sb02_1' },
    { title: '重大訊息', desc: `公開資訊觀測站重大訊息，請輸入代號 ${stockId} 查詢`, url: 'https://mopsov.twse.com.tw/mops/web/t05st01' }
  ];
  el.innerHTML = links.map(l => `
    <a class="link-item" href="${l.url}" target="_blank" rel="noopener noreferrer">
      <strong>${escapeHtml(l.title)} ↗</strong>
      <span>${escapeHtml(l.desc)}</span>
    </a>`).join('');
}

// ==========================================
// 📅 月營收（只放記憶體，不寫入 localStorage，避免占用瀏覽器空間）
// ==========================================
const monthlyCache = {};
let monthlyController = null;

async function loadMonthly(stockId) {
  const statusEl = document.getElementById('monthly-status');
  const bodyEl = document.getElementById('monthly-body');
  if (!statusEl || !bodyEl) return;

  if (monthlyCache[stockId]) {
      renderMonthly(stockId);
      return;
  }

  if (monthlyController) monthlyController.abort();
  monthlyController = new AbortController();
  bodyEl.style.display = 'none';
  statusEl.innerHTML = '月營收載入中…';

  try {
      const response = await fetch(`${API_BASE}/api/monthly/${encodeURIComponent(stockId)}?months=24`, { signal: monthlyController.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(httpErrorReason(response.status, data));
      monthlyCache[stockId] = data;
      if (window.currentStockId === stockId) renderMonthly(stockId);
  } catch (err) {
      if (err.name === 'AbortError') return;
      statusEl.innerHTML = `月營收無法取得：${escapeHtml(fetchErrorReason(err))} <button class="btn-outline" style="margin-left:8px;" onclick="loadMonthly('${stockId}')">重試</button>`;
  }
}

function renderMonthly(stockId) {
  const statusEl = document.getElementById('monthly-status');
  const bodyEl = document.getElementById('monthly-body');
  const data = monthlyCache[stockId];
  const months = (data && data.months) || [];
  if (!months.length) {
      bodyEl.style.display = 'none';
      statusEl.textContent = '此公司目前沒有月營收資料。';
      return;
  }

  const meta = data.meta || {};
  const stale = meta.stale ? '（暫時無法連線 FinMind，顯示上次的資料）'
      : (meta.source === 'finmind-direct' ? '（資料庫暫時無法連線，直接向 FinMind 抓取）' : '');
  statusEl.textContent = `最新月份：${data.latestMonth || months[months.length - 1].ym}${stale}`;
  bodyEl.style.display = 'block';

  const pctCell = val => {
      if (val == null) return '<td>—</td>';
      const color = val > 0 ? 'var(--green)' : (val < 0 ? 'var(--red)' : 'var(--text)');
      return `<td style="color:${color}">${val > 0 ? '+' : ''}${val}%</td>`;
  };
  document.querySelector('#table-monthly tbody').innerHTML = [...months].reverse().map(m =>
      `<tr><td>${escapeHtml(m.ym)}</td><td>${m.revenue == null ? '—' : Number(m.revenue).toLocaleString()}</td>${pctCell(m.mom)}${pctCell(m.yoy)}${pctCell(m.cumYoY)}</tr>`
  ).join('');

  renderMonthlyChart(stockId);
}

function renderMonthlyChart(stockId) {
  const canvas = document.getElementById('chart-monthly');
  const data = monthlyCache[stockId];
  if (!canvas || !data || !data.months || !data.months.length) return;
  const months = data.months;
  const style = getComputedStyle(document.body);
  const textColor = style.getPropertyValue('--text').trim() || '#e5e7eb';
  const gridColor = style.getPropertyValue('--border').trim() || '#374151';

  if (currentCharts['chart-monthly']) currentCharts['chart-monthly'].destroy();
  currentCharts['chart-monthly'] = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
          labels: months.map(m => m.ym),
          datasets: [
              // order 較小的畫在上層，讓折線不被半透明長條蓋住
              { label: '月營收 (百萬)', data: months.map(m => m.revenue), backgroundColor: 'rgba(59, 130, 246, 0.5)', yAxisID: 'y', order: 2 },
              { label: '年增率 (%)', data: months.map(m => m.yoy), type: 'line', borderColor: '#f59e0b', backgroundColor: '#f59e0b', yAxisID: 'y1', order: 1 }
          ]
      },
      options: {
          responsive: true, maintainAspectRatio: false, spanGaps: false,
          scales: {
              x: { ticks: { color: textColor }, grid: { color: gridColor } },
              y: { ticks: { color: textColor }, grid: { color: gridColor } },
              y1: { position: 'right', ticks: { color: textColor }, grid: { drawOnChartArea: false } }
          },
          plugins: { legend: { labels: { color: textColor } } }
      }
  });
}

function renderCharts(stockId, alerts = []) {
  const analysis = window.currentAnalysis;
  if (!analysis) return;
  const data = analysis.data.quarters;
  const labels = data.map(q => q.q);
  const style = getComputedStyle(document.body);
  const textColor = style.getPropertyValue('--text').trim() || '#e5e7eb';
  const gridColor = style.getPropertyValue('--border').trim() || '#374151';
  // 全域預設也跟著主題走，避免未指定顏色的軸（如右側 y1）沿用前一個主題的顏色
  Chart.defaults.color = textColor;
  Chart.defaults.borderColor = gridColor;

  const radarContainer = document.getElementById('radar-container');
  const radarMsg = document.getElementById('radar-financial-msg');
  const scoreList = document.getElementById('radar-score-list');
  const radarCanvas = document.getElementById('chart-radar');
  
  if (radarContainer && radarMsg && scoreList && radarCanvas) {
      if (analysis.effectiveType === 'financial') {
          radarContainer.style.display = 'none';
          radarMsg.style.display = 'block';
          radarMsg.innerText = "金融業報表結構不同，暫不提供雷達圖";
      } else {
          radarContainer.style.display = 'flex';
          radarMsg.style.display = 'none';
          
          const myScores = calcHealthScores(data);
          const dims = ['獲利力', '成長力', '償債力', '現金流品質', '營運效率'];
          
          let peerScores = [SCORE_CONFIG.baseline, SCORE_CONFIG.baseline, SCORE_CONFIG.baseline, SCORE_CONFIG.baseline, SCORE_CONFIG.baseline];
          let peerLabel = '參考基準線';
          
          let peers = portfolio.filter(id => {
              let pAnal = analyzeStock(id);
              return pAnal && pAnal.effectiveType === analysis.effectiveType;
          });
          
          if (peers.length >= 2) {
              let total = [0,0,0,0,0], counts = [0,0,0,0,0];
              peers.forEach(id => {
                  let pAnal = analyzeStock(id);
                  if(pAnal.effectiveType !== 'financial') {
                      let s = calcHealthScores(pAnal.data.quarters);
                      if(s) { for(let i=0; i<5; i++) { if(s[i] != null) { total[i] += s[i]; counts[i]++; } } }
                  }
              });
              for(let i=0; i<5; i++) { peerScores[i] = counts[i] > 0 ? Math.round(total[i]/counts[i]) : null; }
              peerLabel = '同類型自選股平均';
          }

          let slHtml = `<h4 style="margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px;">五大構面健康度</h4>`;
          dims.forEach((d, i) => {
              let sVal = myScores[i] == null ? '資料不足' : `${myScores[i]} 分`;
              let color = myScores[i] == null ? 'var(--text-light)' : (myScores[i] < 40 ? 'var(--red)' : (myScores[i] > 70 ? 'var(--green)' : 'var(--text)'));
              slHtml += `<div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                  <span>${d}</span> <strong style="color:${color}">${sVal}</strong>
              </div>`;
          });
          slHtml += `<p style="font-size:0.8rem; color:var(--text-light); margin-top:16px;">*分數僅為相對參考，並非投資評等</p>`;
          scoreList.innerHTML = slHtml;

          if(currentCharts['chart-radar']) currentCharts['chart-radar'].destroy();
          const ctxRadar = radarCanvas.getContext('2d');
          currentCharts['chart-radar'] = new Chart(ctxRadar, {
              type: 'radar',
              data: {
                  labels: dims,
                  datasets: [
                      { label: '本公司分數', data: myScores, backgroundColor: 'rgba(59, 130, 246, 0.4)', borderColor: '#3b82f6', pointBackgroundColor: '#3b82f6', borderWidth: 2 },
                      { label: peerLabel, data: peerScores, backgroundColor: 'rgba(156, 163, 175, 0.1)', borderColor: '#9ca3af', borderDash: [5, 5], pointBackgroundColor: '#9ca3af', borderWidth: 1 }
                  ]
              },
              options: {
                  responsive: true, maintainAspectRatio: false, spanGaps: false,
                  scales: { r: { min: 0, max: 100, angleLines: { color: gridColor }, grid: { color: gridColor }, pointLabels: { color: textColor, font: { size: 13 } } } },
                  plugins: { legend: { position: 'bottom', labels: { color: textColor } } }
              }
          });
      }
  }

  const commonOptions = {
    responsive: true, maintainAspectRatio: false, spanGaps: false,
    scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } },
    plugins: { legend: { labels: { color: textColor } } }
  };

  const getPointColors = (defaultColor) => {
    return labels.map(qLabel => {
      let pointColor = defaultColor, radius = 3;
      alerts.forEach(a => { if(a.detail.qs && a.detail.qs.includes(qLabel)) { pointColor = (a.detail.level || a.rule.level) === 'red' ? '#ef4444' : '#f59e0b'; radius = 6; } });
      return { bg: pointColor, r: radius };
    });
  };

  const createChart = (canvasId, type, datasets, yAxisOptions = {}) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return; 
    if (currentCharts[canvasId]) currentCharts[canvasId].destroy();
    const ctx = canvas.getContext('2d');
    const opts = JSON.parse(JSON.stringify(commonOptions));
    // 合併軸設定時保留文字顏色，避免覆蓋掉 ticks 顏色
    Object.entries(yAxisOptions).forEach(([axis, axisOpts]) => {
      opts.scales[axis] = { ...(opts.scales[axis] || {}), ...axisOpts };
      opts.scales[axis].ticks = { color: textColor, ...(axisOpts.ticks || {}) };
    });
    currentCharts[canvasId] = new Chart(ctx, { type, data: { labels, datasets }, options: opts });
  };

  createChart('chart-revenue', 'bar', [
    { label: '營收 (百萬)', data: data.map(q=>q.revenue), backgroundColor: 'rgba(59, 130, 246, 0.5)', yAxisID: 'y' },
    { label: '年增率 (%)', data: data.map(q=>q.revenueYoY), type: 'line', borderColor: '#f59e0b', yAxisID: 'y1', pointBackgroundColor: getPointColors('#f59e0b').map(p=>p.bg), pointRadius: getPointColors('').map(p=>p.r) }
  ], { y1: { position: 'right', grid: { drawOnChartArea: false } } });

  createChart('chart-balance', 'line', [
    { label: '負債比 (%)', data: data.map(q=>q.debtRatio), borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, yAxisID: 'y' },
    { label: '流動比', data: data.map(q=>q.currentRatio), borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, yAxisID: 'y1' }
  ], { y: { min: 0, max: 100 }, y1: { position: 'right', grid: { drawOnChartArea: false }, min: 0 } });
  
  createChart('chart-balance-2', 'line', [
    { label: '利息保障倍數', data: data.map(q=>q.interestCoverage), borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.1)', fill: true, yAxisID: 'y' },
    { label: '危險門檻 (3倍)', data: data.map(()=>3), borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, yAxisID: 'y' },
    { label: '速動比率', data: data.map(q=>q.quickRatio), borderColor: '#0ea5e9', backgroundColor: 'rgba(14, 165, 233, 0.1)', fill: true, yAxisID: 'y1' }
  ], { y: { min: 0 }, y1: { position: 'right', grid: { drawOnChartArea: false }, min: 0 } });

  createChart('chart-cf', 'bar', [
    { label: '營業現金流 (百萬)', data: data.map(q=>q.operatingCF), backgroundColor: 'rgba(16, 185, 129, 0.7)' },
    { label: '融資現金流 (百萬)', data: data.map(q=>q.financingCF), backgroundColor: 'rgba(168, 85, 247, 0.7)' },
    { label: '自由現金流 (百萬)', data: data.map(q=>q.freeCF), backgroundColor: 'rgba(59, 130, 246, 0.7)' }
  ]);
  
  createChart('chart-risk', 'line', [
    { label: '歷史風險分數 (最高 100)', data: analysis.histRiskScores, borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, tension: 0.3 }
  ], { y: { min: 0, max: 100 } });

  // 切換主題時月營收圖也要跟著重畫
  renderMonthlyChart(stockId);
}

// ==========================================
// 📰 個股新聞模組
// ==========================================
async function loadNews(stockId) {
    const listContainer = document.getElementById('news-list');
    const msgContainer = document.getElementById('news-messages');
    const statsContainer = document.getElementById('news-stats');
    const moreContainer = document.getElementById('news-more-container');
    if (!listContainer) return;

    if (newsController) newsController.abort();
    newsController = new AbortController();

    currentNewsData = null;
    currentNewsFilter = 'all';
    newsExpanded = false;
    listContainer.innerHTML = '<p style="color:var(--text-light); text-align:center;">新聞載入中…</p>';
    msgContainer.innerHTML = '';
    statsContainer.innerHTML = '';
    moreContainer.style.display = 'none';
    document.querySelectorAll('.news-filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.news-filter-btn[onclick="setNewsFilter(\'all\')"]').classList.add('active');
    document.getElementById('news-updated-time').textContent = '';

    // 新聞來源（Google / Bing / Yahoo）偶爾會暫時失敗，主機喚醒中或請求太頻繁（429）時也會失敗，
    // 所以先自動重試幾次，全部失敗才顯示錯誤與重試按鈕
    const signal = newsController.signal;
    let lastError = '新聞暫時無法取得';
    for (let attempt = 0; attempt <= NEWS_RETRY_DELAYS.length; attempt++) {
        if (attempt > 0) {
            listContainer.innerHTML = `<p style="color:var(--text-light); text-align:center;">新聞載入中…（上次失敗：${escapeHtml(lastError)}；第 ${attempt} 次重試）</p>`;
            try { await abortableSleep(NEWS_RETRY_DELAYS[attempt - 1], signal); } catch { return; }
        }
        try {
            const response = await fetch(`${API_BASE}/api/news/${stockId}`, { signal });
            if (response.ok) {
                currentNewsData = await response.json();
                renderNews();
                return;
            }
            const body = await response.json().catch(() => ({}));
            lastError = httpErrorReason(response.status, body);
            if (response.status === 400) break; // 代號錯誤，重試也沒用
        } catch (err) {
            if (err.name === 'AbortError') return;
            lastError = networkErrorReason();
            if (IS_LOCAL_API) break; // 本機後端沒啟動，重試也沒用
        }
    }
    listContainer.innerHTML = `
        <div style="text-align:center; color:var(--text-light);">
            <p style="margin-bottom: 12px;">新聞無法取得：${escapeHtml(lastError)}</p>
            <button class="btn-outline" onclick="loadNews('${stockId}')" style="min-height:40px; padding: 0 24px;">重試</button>
        </div>
    `;
}

const NEWS_RETRY_DELAYS = [3000, 8000, 15000];

function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
}

function getRelativeTime(isoStr) {
    const dt = new Date(isoStr);
    const diffMs = Date.now() - dt.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${Math.max(1, diffMins)} 分鐘前`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs} 小時前`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays} 天前`;
}

function setNewsFilter(filterType) {
    if (currentNewsFilter === filterType) return;
    currentNewsFilter = filterType;
    newsExpanded = false;
    
    document.querySelectorAll('.news-filter-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('onclick').includes(`'${filterType}'`));
    });
    renderNews();
}

function toggleNewsExpand() {
    newsExpanded = !newsExpanded;
    renderNews();
}

function renderNews() {
    const listContainer = document.getElementById('news-list');
    const msgContainer = document.getElementById('news-messages');
    const statsContainer = document.getElementById('news-stats');
    const moreContainer = document.getElementById('news-more-container');
    const moreBtn = document.getElementById('news-more-btn');
    if (!currentNewsData || !listContainer) return;

    if (currentNewsData.fetchedAt) {
        document.getElementById('news-updated-time').textContent = `更新於 ${formatDateTime(currentNewsData.fetchedAt)}`;
    }
    
    statsContainer.innerHTML = `
        <span class="badge green">利多 ${currentNewsData.counts.positive || 0}</span>
        <span class="badge red">利空 ${currentNewsData.counts.negative || 0}</span>
        <span class="badge gray">中立 ${currentNewsData.counts.neutral || 0}</span>
    `;

    let msgs = [];
    if (currentNewsData.insufficient) msgs.push("找到的新聞少於 10 則，僅顯示現有結果");
    if (currentNewsData.stale) msgs.push("目前顯示的是舊資料");
    msgContainer.textContent = msgs.length > 0 ? msgs.join(' · ') : '';

    let items = currentNewsData.items || [];
    if (currentNewsFilter !== 'all') {
        items = items.filter(item => item.sentiment === currentNewsFilter);
    }

    listContainer.innerHTML = '';
    
    if (items.length === 0) {
        listContainer.innerHTML = '<p style="color:var(--text-light); text-align:center; padding: 16px 0;">近期沒有找到相關新聞</p>';
        moreContainer.style.display = 'none';
        return;
    }

    const maxVisible = 5;
    const isOverLimit = items.length > maxVisible;
    const displayItems = (isOverLimit && !newsExpanded) ? items.slice(0, maxVisible) : items;

    displayItems.forEach(item => {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; gap: 12px; align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid var(--border);';

        const dot = document.createElement('div');
        dot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 6px;';
        if (item.sentiment === 'positive') dot.style.backgroundColor = '#10b981';
        else if (item.sentiment === 'negative') dot.style.backgroundColor = '#ef4444';
        else dot.style.backgroundColor = '#9ca3af';

        const content = document.createElement('div');
        content.style.cssText = 'flex: 1; min-width: 0;';

        const titleDiv = document.createElement('div');
        titleDiv.style.cssText = 'font-size: 1rem; margin-bottom: 6px; line-height: 1.4;';
        
        const urlStr = item.url || ""; 
        if (/^https?:\/\//i.test(urlStr)) {
            const a = document.createElement('a');
            a.textContent = item.title;
            a.href = urlStr;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.style.color = 'inherit';
            a.style.textDecoration = 'none';
            a.onmouseover = () => a.style.color = 'var(--primary)';
            a.onmouseout = () => a.style.color = 'inherit';
            titleDiv.appendChild(a);
        } else {
            titleDiv.textContent = item.title;
        }

        const metaDiv = document.createElement('div');
        metaDiv.style.cssText = 'font-size: 0.8rem; color: var(--text-light); line-height: 1.4;';
        
        const metaParts = [];
        if (item.source) metaParts.push(item.source);
        if (item.publishedAt) metaParts.push(getRelativeTime(item.publishedAt));
        if (item.hits && item.hits.length > 0) metaParts.push(`依據：${item.hits.join('、')}`);
        
        metaDiv.textContent = metaParts.join(' · ');

        content.appendChild(titleDiv);
        content.appendChild(metaDiv);
        wrapper.appendChild(dot);
        wrapper.appendChild(content);
        listContainer.appendChild(wrapper);
    });

    if (isOverLimit) {
        moreContainer.style.display = 'block';
        if (newsExpanded) {
            moreBtn.textContent = '收合';
        } else {
            const hiddenCount = items.length - maxVisible;
            moreBtn.textContent = `顯示更多（還有 ${hiddenCount} 則）`;
        }
    } else {
        moreContainer.style.display = 'none';
    }
}