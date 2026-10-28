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
    const response = await fetch(`https://ethan-stock-api.onrender.com/api/stock/${id}`);
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
    const typeLabel = TYPE_PROFILES[item.effectiveType].label;
    
    grid.innerHTML += `
      <div class="card" style="border-top: 4px solid var(--${item.status})">
        <div class="flex-between" style="margin-bottom: 12px;">
          <h3 style="margin:0; display:flex; align-items:center; gap:8px;">
            ${item.id} ${item.data.name} 
            <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">${typeLabel}</span>
          </h3>
          <span class="status-indicator"><span class="dot ${item.status}"></span> ${statusText}</span>
        </div>
        <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 16px;">
          <div style="display:flex; justify-content:space-between;"><span>最新營收年增:</span> <strong style="color:var(--text)">${latest.revenueYoY}%</strong></div>
          <div style="display:flex; justify-content:space-between;"><span>毛利率:</span> <strong style="color:var(--text)">${latest.grossMargin}%</strong></div>
          <div style="display:flex; justify-content:space-between;"><span>負債比:</span> <strong style="color:var(--text)">${latest.debtRatio}%</strong></div>
        </div>
        <div style="margin-bottom: 16px; font-size: 0.85rem;">觸發警訊數：<strong>${item.alerts.length}</strong> 項</div>
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
        let compAlerts = analysis.alerts.slice().sort((a, b) => a.rule.level === 'red' ? -1 : 1);
        let alertsHtml = compAlerts.map(a => {
          const badgeClass = a.rule.level === 'red' ? 'red' : 'yellow';
          const badgeText = a.rule.level === 'red' ? '紅燈' : '黃燈';
          return `
            <a href="details.html?id=${id}&tab=${a.detail.tab}" class="alert-item ${a.rule.level}" style="display:block; color:inherit; margin-top: 8px;">
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
    if (mode === 'red' || mode === 'yellow') allAlerts = allAlerts.filter(a => a.rule.level === mode);
    allAlerts.sort((a, b) => {
      if(a.rule.level === b.rule.level) return a.stockId.localeCompare(b.stockId);
      return a.rule.level === 'red' ? -1 : 1;
    });
    if (allAlerts.length > 0) hasAnyAlert = true;
    allAlerts.forEach(a => {
      const badgeClass = a.rule.level === 'red' ? 'red' : 'yellow';
      const badgeText = a.rule.level === 'red' ? '紅燈' : '黃燈';
      container.innerHTML += `
        <a href="details.html?id=${a.stockId}&tab=${a.detail.tab}" class="alert-item ${a.rule.level}" style="display:block; color:inherit;">
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
      listContainer.innerHTML += `
        <div class="card" style="cursor: pointer; transition: 0.2s;" onclick="changeDetailStock('${id}')" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
          <h3 style="margin: 0 0 8px 0;">${id} ${data.name}</h3>
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

function loadDetailView(stockId) {
  const analysis = analyzeStock(stockId);
  if(!analysis) return;
  window.currentStockId = stockId;
  window.currentAlerts = analysis.alerts;
  
  const listView = document.getElementById('detail-list-view');
  if(listView) listView.style.display = 'none';
  document.getElementById('detail-content').style.display = 'block';
  
  document.getElementById('detail-name').innerText = `${stockId} ${analysis.data.name}`;
  document.getElementById('detail-industry').innerText = `產業: ${analysis.data.industry}`;
  document.getElementById('detail-dot').className = `dot ${analysis.status}`;
  document.getElementById('detail-status-text').innerText = analysis.status === 'red' ? '警戒狀態' : (analysis.status === 'yellow' ? '注意狀態' : '正常健康');
  
  // 更新類型下拉選單與描述
  document.getElementById('company-type-select').value = analysis.effectiveType;
  document.getElementById('company-type-desc').innerText = TYPE_PROFILES[analysis.effectiveType].desc;

  const alertsSum = document.getElementById('detail-alerts-summary');
  if (analysis.alerts.length === 0) { alertsSum.innerHTML = '<span style="color:var(--green)">✓ 財報表現良好，未觸發任何警訊。</span>'; } 
  else { alertsSum.innerHTML = analysis.alerts.map(a => `<div style="margin-top:4px;">⚠️ <strong>${a.rule.name}</strong>: ${a.detail.text}</div>`).join(''); }

  const tbodyIncome = document.querySelector('#table-income tbody');
  const tbodyBalance = document.querySelector('#table-balance tbody');
  const tbodyCashflow = document.querySelector('#table-cashflow tbody');
  
  tbodyIncome.innerHTML = ''; tbodyBalance.innerHTML = ''; tbodyCashflow.innerHTML = '';

  [...analysis.data.quarters].reverse().forEach(q => {
    tbodyIncome.innerHTML += `<tr><td>${q.q}</td><td>${q.revenue}</td><td>${q.revenueYoY}%</td><td>${q.grossMargin}%</td><td>${q.operatingMargin}%</td><td>${q.netIncome}</td><td>${q.eps}</td></tr>`;
    tbodyBalance.innerHTML += `<tr><td>${q.q}</td><td>${q.debtRatio}%</td><td>${q.currentRatio}</td><td>${q.arDays}</td><td>${q.invDays}</td></tr>`;
    tbodyCashflow.innerHTML += `<tr><td>${q.q}</td><td>${q.operatingCF}</td><td>${q.freeCF}</td></tr>`;
  });

  renderCharts(stockId, analysis.alerts);
}

function renderCharts(stockId, alerts = []) {
  const stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
  const data = stockDatabase[stockId].quarters;
  const labels = data.map(q => q.q);
  const style = getComputedStyle(document.body);
  const textColor = style.getPropertyValue('--text').trim();
  const gridColor = style.getPropertyValue('--border').trim();
  
  const commonOptions = {
    responsive: true, maintainAspectRatio: false,
    scales: { x: { ticks: { color: textColor }, grid: { color: gridColor } }, y: { ticks: { color: textColor }, grid: { color: gridColor } } },
    plugins: { legend: { labels: { color: textColor } } }
  };

  const getPointColors = (defaultColor) => {
    return labels.map(qLabel => {
      let pointColor = defaultColor, radius = 3;
      alerts.forEach(a => { if(a.detail.qs.includes(qLabel)) { pointColor = a.rule.level === 'red' ? '#ef4444' : '#f59e0b'; radius = 6; } });
      return { bg: pointColor, r: radius };
    });
  };

  const createChart = (canvasId, type, datasets, yAxisOptions = {}) => {
    if(currentCharts[canvasId]) currentCharts[canvasId].destroy();
    const ctx = document.getElementById(canvasId).getContext('2d');
    const opts = JSON.parse(JSON.stringify(commonOptions));
    Object.assign(opts.scales, yAxisOptions);
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

  createChart('chart-cf', 'bar', [
    { label: '營業現金流 (百萬)', data: data.map(q=>q.operatingCF), backgroundColor: 'rgba(16, 185, 129, 0.7)' },
    { label: '自由現金流 (百萬)', data: data.map(q=>q.freeCF), backgroundColor: 'rgba(59, 130, 246, 0.7)' }
  ]);
}