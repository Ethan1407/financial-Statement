const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
    ? 'http://127.0.0.1:5000'
    : 'https://ethan-stock-api.onrender.com';

let portfolio = JSON.parse(localStorage.getItem('stock_portfolio') || '[]');
let currentCharts = {};

document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('app_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  setActiveNav();
});

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
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

function savePortfolio() { localStorage.setItem('stock_portfolio', JSON.stringify(portfolio)); }
function initPortfolio() { renderPortfolio(); }

async function addStock() {
  const input = document.getElementById('stock-input');
  const id = input.value.trim();
  const btn = input.nextElementSibling; 
  if (!id) return;

  let stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
  if (portfolio.includes(id) && stockDatabase[id]) {
      alert('此股票已在自選清單中！'); input.value = ''; return;
  }

  const originalText = btn.innerText;
  btn.innerText = '爬取中...'; btn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/api/stock/${id}`);
    const result = await response.json();
    if (!response.ok) { alert(result.error || '爬取失敗，請確認代號正確'); return; }

    stockDatabase[id] = result;
    localStorage.setItem('stock_database', JSON.stringify(stockDatabase));

    if (!portfolio.includes(id)) { portfolio.push(id); savePortfolio(); }
    renderPortfolio();
    if (typeof updateDetailSelect === 'function') updateDetailSelect();
  } catch (err) {
    alert('無法連線到 Python 伺服器！');
  } finally {
    btn.innerText = originalText; btn.disabled = false; input.value = '';
  }
}

function removeStock(id) {
  if (confirm(`確定移除 ${id}？`)) { 
      portfolio = portfolio.filter(item => item !== id); 
      savePortfolio(); renderPortfolio(); 
  }
}

function overrideCompanyType(stockId, newType) {
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    overrides[stockId] = newType;
    localStorage.setItem('typeOverrides', JSON.stringify(overrides));
    loadDetailView(stockId);
}

function renderPortfolio() {
  const grid = document.getElementById('portfolio-grid');
  const empty = document.getElementById('portfolio-empty');
  if (!grid) return; 
  
  if (portfolio.length === 0) { grid.style.display = 'none'; empty.style.display = 'block'; return; }
  grid.style.display = 'grid'; empty.style.display = 'none';
  grid.innerHTML = '';
  
  let list = portfolio.map(id => ({ id, ...analyzeStock(id) })).filter(item => item.data);
  const sortBy = document.getElementById('sort-select').value;
  if (sortBy === 'severity') {
    const score = { 'red': 3, 'yellow': 2, 'green': 1 };
    list.sort((a, b) => score[b.status] - score[a.status] || a.id.localeCompare(b.id));
  } else { list.sort((a, b) => a.id.localeCompare(b.id)); }

  list.forEach(item => {
    const latest = item.data.quarters[item.data.quarters.length - 1];
    let statusText = item.status === 'red' ? '警戒' : (item.status === 'yellow' ? '注意' : '正常');
    const typeLabel = TYPE_PROFILES[item.effectiveType] ? TYPE_PROFILES[item.effectiveType].label : '一般';
    const isFin = item.effectiveType === 'financial';
    
    const fmt = (val, inapp, suf) => {
        if(isFin && inapp) return '不適用';
        if(val === null || val === undefined) return '—';
        return val + suf;
    };
    
    let riskColor = item.riskScore > 30 ? 'var(--red)' : (item.riskScore > 0 ? 'var(--yellow)' : 'var(--green)');

    grid.innerHTML += `
      <div class="card" style="border-top: 4px solid var(--${item.status}); position: relative;">
        <div class="flex-between" style="margin-bottom: 12px;">
          <h3 style="margin:0; display:flex; align-items:center; gap:8px;">
            ${item.id} ${item.data.name} 
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
        <div class="flex-between">
          <a href="details.html?id=${item.id}" class="btn-primary" style="flex:1; margin-right: 8px; text-align:center;">查看詳情</a>
          <button class="btn-outline" style="color: var(--red); border-color: var(--red);" onclick="removeStock('${item.id}')">移除</button>
        </div>
      </div>
    `;
  });
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
            <a href="details.html?id=${id}&tab=${a.detail.tab}" class="alert-item ${lvl}" style="display:block; color:inherit; margin-top: 8px;">
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
              <span>${id} ${analysis.data.name}</span><span class="badge ${analysis.status}">${analysis.alerts.length} 項警訊</span>
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
        <a href="details.html?id=${a.stockId}&tab=${a.detail.tab}" class="alert-item ${lvl}" style="display:block; color:inherit;">
          <div class="flex-between" style="margin-bottom: 4px;">
            <strong>${a.stockId} ${a.stockName} - ${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
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
  
  if (stockId && portfolio.includes(stockId)) {
    document.getElementById('detail-stock-select').value = stockId;
    loadDetailView(stockId);
    switchDetailTab(targetTab);
  } else {
    document.getElementById('detail-content').style.display = 'none';
    const listView = document.getElementById('detail-list-view');
    if(listView) listView.style.display = 'block';
    renderDetailStockList();
  }
}

function renderDetailStockList() {
  const listContainer = document.getElementById('detail-stock-list');
  const emptyMsg = document.getElementById('detail-list-empty');
  if (portfolio.length === 0) { listContainer.style.display = 'none'; emptyMsg.style.display = 'block'; return; }
  listContainer.style.display = 'grid'; emptyMsg.style.display = 'none'; listContainer.innerHTML = '';
  
  const stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
  portfolio.sort((a,b) => a.localeCompare(b)).forEach(id => {
    const data = stockDatabase[id];
    if (data) {
      const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
      const effType = overrides[id] || (INDUSTRY_TO_TYPE[data.industry] || (data.isFinancial ? 'financial' : 'general'));
      const typeLabel = TYPE_PROFILES[effType] ? TYPE_PROFILES[effType].label : '一般';
      
      listContainer.innerHTML += `
        <div class="card" style="cursor: pointer; transition: 0.2s;" onclick="changeDetailStock('${id}')" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
          <h3 style="margin: 0 0 8px 0; display:flex; align-items:center; gap:8px;">${id} ${data.name}
            <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">${typeLabel}</span>
          </h3>
          <p style="color: var(--text-light); font-size: 0.9rem;">產業: ${data.industry}</p>
          <p style="color: var(--primary); font-size: 0.9rem; margin-top: 12px; font-weight: bold;">查看圖表與數據 →</p>
        </div>
      `;
    }
  });
}

function updateDetailSelect() {
  const sel = document.getElementById('detail-stock-select');
  if(!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">請選擇股票...</option>';
  const stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
  portfolio.sort((a,b) => a.localeCompare(b)).forEach(id => { 
      if(stockDatabase[id]) sel.innerHTML += `<option value="${id}">${id} ${stockDatabase[id].name}</option>`; 
  });
  if(portfolio.includes(currentVal)) sel.value = currentVal;
}

function changeDetailStock(id) {
  if (id) window.location.href = `details.html?id=${id}`;
  else window.location.href = `details.html`;
}

function switchDetailTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.querySelector(`[onclick="switchDetailTab('${tabId}')"]`).classList.add('active');
  document.getElementById(`tab-${tabId}`).classList.add('active');
}

// 產生本季 vs 上季比較邏輯
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
        if (cur[m.key] === null || prev[m.key] === null) return;
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

function loadDetailView(stockId) {
  const analysis = analyzeStock(stockId);
  if(!analysis) return;
  window.currentStockId = stockId;
  window.currentAlerts = analysis.alerts;
  window.currentAnalysis = analysis;
  
  const listView = document.getElementById('detail-list-view');
  if(listView) listView.style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';
  
  document.getElementById('detail-name').innerText = `${stockId} ${analysis.data.name}`;
  document.getElementById('detail-industry').innerText = `產業: ${analysis.data.industry}`;
  document.getElementById('detail-dot').className = `dot ${analysis.status}`;
  document.getElementById('detail-status-text').innerText = analysis.status === 'red' ? '警戒狀態' : (analysis.status === 'yellow' ? '注意狀態' : '正常健康');
  
  document.getElementById('company-type-select').value = analysis.effectiveType;
  document.getElementById('company-type-desc').innerText = TYPE_PROFILES[analysis.effectiveType].desc;

  document.getElementById('detail-plain-summary').innerHTML = `
    <div style="background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 12px;">
      <h4 style="margin:0 0 8px 0;">💬 AI 財報白話解析</h4>
      <p style="margin:0; color: var(--text-light); line-height: 1.5; font-size: 0.95rem;">${analysis.summary.detail}</p>
    </div>
  `;

  document.getElementById('detail-qoq').innerHTML = generateQoQ(analysis.data.quarters, analysis.effectiveType === 'financial');

  let alertsSumHtml = '';
  if (analysis.alerts.length === 0) { alertsSumHtml = '<span style="color:var(--green)">✓ 財報表現良好，未觸發任何警訊。</span>'; } 
  else { alertsSumHtml = analysis.alerts.map(a => `<div style="margin-top:4px;">⚠️ <strong>${a.rule.name}</strong>: ${a.detail.text}</div>`).join(''); }
  
  if (analysis.skipped && analysis.skipped.length > 0) {
      const skippedNames = analysis.skipped.map(r => r.name).join('、');
      alertsSumHtml += `<div style="margin-top:12px; color:var(--text-light); font-size:0.85rem; border-top: 1px dashed var(--border); padding-top: 8px;">
        ℹ️ <strong>資料完整度提示：</strong>本檔有 ${analysis.skipped.length} 項規則因資料不足未判斷 (${skippedNames})
      </div>`;
  }
  document.getElementById('detail-alerts-summary').innerHTML = alertsSumHtml;

  const tbodyIncome = document.querySelector('#table-income tbody');
  const tbodyBalance = document.querySelector('#table-balance tbody');
  const tbodyCashflow = document.querySelector('#table-cashflow tbody');
  tbodyIncome.innerHTML = ''; tbodyBalance.innerHTML = ''; tbodyCashflow.innerHTML = '';

  const isFin = analysis.effectiveType === 'financial';
  const fmt = (val, inapplicable=false, suffix='') => {
      if (isFin && inapplicable) return '不適用';
      if (val === null || val === undefined) return '—';
      return val + suffix;
  };

  [...analysis.data.quarters].reverse().forEach(q => {
    tbodyIncome.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.revenue)}</td><td>${fmt(q.revenueYoY, false, '%')}</td><td>${fmt(q.grossMargin, true, '%')}</td><td>${fmt(q.operatingIncome)}</td><td>${fmt(q.operatingMargin, false, '%')}</td><td>${fmt(q.nonOperatingIncome)}</td><td>${fmt(q.netIncome)}</td><td>${fmt(q.eps)}</td></tr>`;
    tbodyBalance.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.debtRatio, false, '%')}</td><td>${fmt(q.currentRatio, true)}</td><td>${fmt(q.quickRatio, true)}</td><td>${fmt(q.interestCoverage, true)}</td><td>${fmt(q.arDays, true)}</td><td>${fmt(q.invDays, true)}</td></tr>`;
    tbodyCashflow.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.operatingCF)}</td><td>${fmt(q.financingCF)}</td><td>${fmt(q.freeCF, true)}</td><td>${fmt(q.cashEnd)}</td></tr>`;
  });

  renderCharts(stockId, analysis.alerts);
}

function renderCharts(stockId, alerts = []) {
  const analysis = window.currentAnalysis;
  const data = analysis.data.quarters;
  const labels = data.map(q => q.q);
  const style = getComputedStyle(document.body);
  const textColor = style.getPropertyValue('--text').trim();
  const gridColor = style.getPropertyValue('--border').trim();
  
  // ==================== 1. 處理雷達圖 ====================
  const radarContainer = document.getElementById('radar-container');
  const radarMsg = document.getElementById('radar-financial-msg');
  const scoreList = document.getElementById('radar-score-list');
  
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
                  if(s) { for(let i=0; i<5; i++) { if(s[i] !== null) { total[i] += s[i]; counts[i]++; } } }
              }
          });
          for(let i=0; i<5; i++) { peerScores[i] = counts[i] > 0 ? Math.round(total[i]/counts[i]) : null; }
          peerLabel = '同類型自選股平均';
      }

      let slHtml = `<h4 style="margin-bottom:12px; border-bottom:1px solid var(--border); padding-bottom:8px;">五大構面健康度</h4>`;
      dims.forEach((d, i) => {
          let sVal = myScores[i] === null ? '資料不足' : `${myScores[i]} 分`;
          let color = myScores[i] === null ? 'var(--text-light)' : (myScores[i] < 40 ? 'var(--red)' : (myScores[i] > 70 ? 'var(--green)' : 'var(--text)'));
          slHtml += `<div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <span>${d}</span> <strong style="color:${color}">${sVal}</strong>
          </div>`;
      });
      slHtml += `<p style="font-size:0.8rem; color:var(--text-light); margin-top:16px;">*分數僅為相對參考，並非投資評等</p>`;
      scoreList.innerHTML = slHtml;

      if(currentCharts['chart-radar']) currentCharts['chart-radar'].destroy();
      const ctxRadar = document.getElementById('chart-radar').getContext('2d');
      Chart.defaults.color = textColor;
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

  // ==================== 2. 處理下方傳統折線/長條圖 ====================
  const commonOptions = {
    responsive: true, maintainAspectRatio: false, spanGaps: false,
    scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } },
    plugins: { legend: { labels: { color: textColor } } }
  };

  const getPointColors = (defaultColor) => {
    return labels.map(qLabel => {
      let pointColor = defaultColor, radius = 3;
      alerts.forEach(a => { if(a.detail.qs.includes(qLabel)) { pointColor = (a.detail.level || a.rule.level) === 'red' ? '#ef4444' : '#f59e0b'; radius = 6; } });
      return { bg: pointColor, r: radius };
    });
  };

  const createChart = (canvasId, type, datasets, yAxisOptions = {}) => {
    if (!document.getElementById(canvasId)) return;
    if (currentCharts[canvasId]) currentCharts[canvasId].destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    const opts = JSON.parse(JSON.stringify(commonOptions));
    Object.assign(opts.scales, yAxisOptions);
    currentCharts[canvasId] = new Chart(ctx, { type, data: { labels, datasets }, options: opts });
  };

  // 損益表
  createChart('chart-revenue', 'bar', [
    { label: '營收 (百萬)', data: data.map(q=>q.revenue), backgroundColor: 'rgba(59, 130, 246, 0.5)', yAxisID: 'y' },
    { label: '年增率 (%)', data: data.map(q=>q.revenueYoY), type: 'line', borderColor: '#f59e0b', yAxisID: 'y1', pointBackgroundColor: getPointColors('#f59e0b').map(p=>p.bg), pointRadius: getPointColors('').map(p=>p.r) }
  ], { y1: { position: 'right', grid: { drawOnChartArea: false } } });

  // 資產負債表1：負債與流動比
  createChart('chart-balance', 'line', [
    { label: '負債比 (%)', data: data.map(q=>q.debtRatio), borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, yAxisID: 'y' },
    { label: '流動比', data: data.map(q=>q.currentRatio), borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true, yAxisID: 'y1' }
  ], { y: { min: 0, max: 100 }, y1: { position: 'right', grid: { drawOnChartArea: false }, min: 0 } });
  
  // 資產負債表2：利息保障與速動比 (新增)
  createChart('chart-balance-2', 'line', [
    { label: '利息保障倍數', data: data.map(q=>q.interestCoverage), borderColor: '#a855f7', backgroundColor: 'rgba(168, 85, 247, 0.1)', fill: true, yAxisID: 'y' },
    { label: '危險門檻 (3倍)', data: data.map(()=>3), borderColor: '#ef4444', borderDash: [5,5], pointRadius: 0, yAxisID: 'y' },
    { label: '速動比率', data: data.map(q=>q.quickRatio), borderColor: '#0ea5e9', backgroundColor: 'rgba(14, 165, 233, 0.1)', fill: true, yAxisID: 'y1' }
  ], { y: { min: 0 }, y1: { position: 'right', grid: { drawOnChartArea: false }, min: 0 } });

  // 現金流量表 (新增融資現金流)
  createChart('chart-cf', 'bar', [
    { label: '營業現金流 (百萬)', data: data.map(q=>q.operatingCF), backgroundColor: 'rgba(16, 185, 129, 0.7)' },
    { label: '融資現金流 (百萬)', data: data.map(q=>q.financingCF), backgroundColor: 'rgba(168, 85, 247, 0.7)' },
    { label: '自由現金流 (百萬)', data: data.map(q=>q.freeCF), backgroundColor: 'rgba(59, 130, 246, 0.7)' }
  ]);
  
  // 風險分數趨勢 (新增)
  createChart('chart-risk', 'line', [
    { label: '歷史風險分數 (最高 100)', data: analysis.histRiskScores, borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, tension: 0.3 }
  ], { y: { min: 0, max: 100 } });
}