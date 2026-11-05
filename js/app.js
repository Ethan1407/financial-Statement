const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.protocol === 'file:')
    ? 'http://127.0.0.1:5000'
    : 'https://financial-statement-xou2.onrender.com';

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
          : { error: '無法連線到 Python 伺服器！請確認後端已啟動。', status: 'network' };
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

  // ETF 沒有個股燈號，依代號排在個股之後
  const buildSection = (ids, isTracked) => {
      const stocks = analyzeAll(ids);
      const etfs = ids.filter(id => stockDatabase[id] && stockDatabase[id].isEtf).sort((a, b) => a.localeCompare(b));
      return {
          count: stocks.length + etfs.length,
          html: stocks.map(item => stockCardHtml(item, isTracked)).join('') + etfs.map(id => etfCardHtml(id, stockDatabase[id], isTracked)).join('')
      };
  };

  const tracked = buildSection(portfolio, true);
  trackedGrid.innerHTML = tracked.html;
  document.getElementById('tracked-count').textContent = `(${tracked.count})`;
  const trackedEmpty = document.getElementById('tracked-empty');
  trackedEmpty.style.display = tracked.count ? 'none' : 'block';
  trackedEmpty.textContent = seedingDefaults
      ? `正在載入預設自選股（${DEFAULT_PORTFOLIO.join('、')}）…`
      : '尚未加入自選股，請在上方輸入代號 (例: 2330、2317、2887、0050)';

  const others = buildSection(Object.keys(stockDatabase).filter(id => !portfolio.includes(id)), false);
  document.getElementById('others-section').style.display = others.count ? 'block' : 'none';
  document.getElementById('others-count').textContent = `(${others.count})`;
  document.getElementById('others-grid').innerHTML = others.html;
  ['tracked', 'others'].forEach(applySectionState);
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
    portfolio.sort((a, b) => a.localeCompare(b)).forEach(id => {
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
          <div class="card" style="margin-bottom: 16px; border-top: 4px solid var(--${analysis.status})">
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
        <a href="details.html?id=${a.stockId}&tab=${a.rule.tab}" class="alert-item ${lvl}" style="display:block; color:inherit;">
          <div class="flex-between" style="margin-bottom: 4px;">
            <strong>${a.stockId} ${escapeHtml(a.stockName)} - ${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
          </div>
          <p style="font-size: 0.9rem; color: var(--text-light);">${a.detail.text}</p>
        </a>
      `;
    });
  }

  if (!hasAnyAlert) empty.style.display = 'block'; else empty.style.display = 'none';
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
}

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

  setTimeout(() => renderCharts(stockId, analysis.alerts), 0);
  
  if (!skipNews) loadNews(stockId);
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

    try {
        const response = await fetch(`${API_BASE}/api/news/${stockId}`, { signal: newsController.signal });
        if (!response.ok) throw new Error('API 回傳失敗');
        const data = await response.json();
        
        currentNewsData = data;
        renderNews();
    } catch (err) {
        if (err.name === 'AbortError') return;
        listContainer.innerHTML = `
            <div style="text-align:center; color:var(--text-light);">
                <p style="margin-bottom: 12px;">新聞暫時無法取得</p>
                <button class="btn-outline" onclick="loadNews('${stockId}')" style="min-height:40px; padding: 0 24px;">重試</button>
            </div>
        `;
    }
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