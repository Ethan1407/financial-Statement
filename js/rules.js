// ==========================================
// 1. 產業自動對照表 (INDUSTRY_TO_TYPE)
// ==========================================
const INDUSTRY_TO_TYPE = {
    "半導體業": "electronics", "電子零組件業": "electronics", "電腦及週邊設備業": "electronics", "光電業": "electronics", "通信網路業": "electronics", "其他電子業": "electronics", "電子通路業": "electronics", "資訊服務業": "electronics",
    "鋼鐵工業": "cyclical", "塑膠工業": "cyclical", "水泥工業": "cyclical", "航運業": "cyclical", "化學工業": "cyclical", "造紙工業": "cyclical", "紡織纖維": "cyclical", "橡膠工業": "cyclical", "玻璃陶瓷": "cyclical", "油電燃氣業": "cyclical",
    "生技醫療業": "growth",
    "金融保險業": "financial"
};

// ==========================================
// 2. 雷達圖評分區間設定 (SCORE_CONFIG)
// ==========================================
const SCORE_CONFIG = {
    baseline: 60,
    profit: { gross: [0, 40], op: [0, 20] },
    growth: { yoy: [0, 30] },
    solvency: { debt: [80, 30], current: [0.8, 2.0] },
    cf: { op: [0, 20], free: [0, 10] },
    efficiency: { ar: [150, 30], inv: [150, 30] }
};

function calcHealthScores(quarterData) {
    if (!quarterData || quarterData.length === 0) return [null, null, null, null, null];
    const latest = quarterData[quarterData.length - 1];

    const mapScore = (val, minV, maxV) => {
        if (val === null || val === undefined) return null;
        let p = (val - minV) / (maxV - minV);
        if (p < 0) p = 0;
        if (p > 1) p = 1;
        return p * 100;
    };

    const avg = (arr) => {
        let valid = arr.filter(v => v !== null);
        if (valid.length === 0) return null;
        return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
    };

    let p_gross = mapScore(latest.grossMargin, SCORE_CONFIG.profit.gross[0], SCORE_CONFIG.profit.gross[1]);
    let p_op = mapScore(latest.operatingMargin, SCORE_CONFIG.profit.op[0], SCORE_CONFIG.profit.op[1]);
    let profitScore = avg([p_gross, p_op]);

    let growthScore = mapScore(latest.revenueYoY, SCORE_CONFIG.growth.yoy[0], SCORE_CONFIG.growth.yoy[1]);
    if (growthScore !== null) growthScore = Math.round(growthScore);

    let s_debt = mapScore(latest.debtRatio, SCORE_CONFIG.solvency.debt[0], SCORE_CONFIG.solvency.debt[1]);
    let s_current = mapScore(latest.currentRatio, SCORE_CONFIG.solvency.current[0], SCORE_CONFIG.solvency.current[1]);
    let solvencyScore = avg([s_debt, s_current]);

    let cf_op = (latest.revenue > 0 && latest.operatingCF !== null) ? mapScore(latest.operatingCF / latest.revenue * 100, SCORE_CONFIG.cf.op[0], SCORE_CONFIG.cf.op[1]) : null;
    let cf_free = (latest.revenue > 0 && latest.freeCF !== null) ? mapScore(latest.freeCF / latest.revenue * 100, SCORE_CONFIG.cf.free[0], SCORE_CONFIG.cf.free[1]) : null;
    let cfScore = avg([cf_op, cf_free]);

    let e_ar = mapScore(latest.arDays, SCORE_CONFIG.efficiency.ar[0], SCORE_CONFIG.efficiency.ar[1]);
    let e_inv = mapScore(latest.invDays, SCORE_CONFIG.efficiency.inv[0], SCORE_CONFIG.efficiency.inv[1]);
    let effScore = avg([e_ar, e_inv]);

    return [profitScore, growthScore, solvencyScore, cfScore, effScore];
}

// ==========================================
// 3. 集中管理的規則設定物件 (RULES_CONFIG)
// ==========================================
const RISK_WEIGHTS = { red: 25, yellow: 10, max: 100 };

const RULES_CONFIG = {
    revenueDecline: { 
        name: "營收連續衰退", level: "red", consecutive: 3, why: (c) => `營收年增率連續 ${c.consecutive} 季為負`, check: (data, config) => { if (data.length < config.consecutive) return { status: 'skipped' }; const recent = data.slice(-config.consecutive); if (recent.some(q => q.revenueYoY === null)) return { status: 'skipped' }; if (recent.every(q => q.revenueYoY < 0)) return { status: 'alert', text: `營收年增率連續 ${config.consecutive} 季為負`, qs: recent.map(q=>q.q), tab: 'income' };
            return { status: 'pass' };
        }
    },
    lowCurrentRatio: { 
        name: "流動比率過低", level: "red", threshold: 1.0, why: (c) => `流動比率低於 ${c.threshold}`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.currentRatio === null) return { status: 'skipped' }; if (latest.currentRatio < config.threshold) return { status: 'alert', text: `最新流動比率 ${latest.currentRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' }; return { status: 'pass' }; } }, lowQuickRatio: { name: "速動比率偏低", level: "yellow", threshold: 0.8, why: (c) => `速動比率低於 ${c.threshold}`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.quickRatio === null) return { status: 'skipped' };
            if (latest.quickRatio < config.threshold) return { status: 'alert', text: `最新速動比率 ${latest.quickRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    highDebtRatio: { 
        name: "負債比過高", level: "yellow", threshold: 70, why: (c) => `負債比大於 ${c.threshold}\%`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.debtRatio === null) return { status: 'skipped' }; if (latest.debtRatio > config.threshold) return { status: 'alert', text: `最新負債比 ${latest.debtRatio}% 高於 ${config.threshold}\%`, qs: [latest.q], tab: 'balance' }; return { status: 'pass' }; } }, grossMarginDrop: { name: "毛利率連續下滑", level: "yellow", consecutive: 2, why: (c) => `毛利率連續 ${c.consecutive} 季下滑`,
        check: (data, config) => {
            if (data.length < config.consecutive + 1) return { status: 'skipped' };
            const recent = data.slice(-(config.consecutive + 1));
            if (recent.some(q => q.grossMargin === null)) return { status: 'skipped' };
            let declining = true;
            for(let i=1; i<recent.length; i++) {
                if (recent[i].grossMargin >= recent[i-1].grossMargin) declining = false;
            }
            if (declining) return { status: 'alert', text: `毛利率連續 ${config.consecutive} 季下滑`, qs: recent.slice(1).map(q=>q.q), tab: 'income' }; return { status: 'pass' }; } }, grossMarginPlunge: { name: "毛利率單季暴跌", level: "yellow", threshold: 3, why: (c) => `單季比前一季下滑超過 ${c.threshold} 個百分點`,
        check: (data, config) => {
            if (data.length < 2) return { status: 'skipped' };
            const latest = data[data.length - 1];
            const prev = data[data.length - 2];
            if (latest.grossMargin === null || prev.grossMargin === null) return { status: 'skipped' };
            if ((prev.grossMargin - latest.grossMargin) > config.threshold) return { status: 'alert', text: `單季毛利率驟降 ${Math.abs(latest.grossMargin - prev.grossMargin).toFixed(2)} 個百分點`, qs: [latest.q], tab: 'income' }; return { status: 'pass' }; } }, profitDivergence: { name: "本業與獲利背離", level: "yellow", why: () => `淨利年增但營業利益年減 (用4季前同期比較)`, check: (data, config) => { const latest = data[data.length - 1]; let year = parseInt(latest.q.slice(0,4)); let qNum = latest.q.slice(5); let prevYearQ = `${year-1}Q${qNum}`; let prevYearData = data.find(d => d.q === prevYearQ);  if (!prevYearData \vert{}\vert{} latest.netIncome === null \vert{}\vert{} prevYearData.netIncome === null \vert{}\vert{} latest.operatingIncome === null \vert{}\vert{} prevYearData.operatingIncome === null) return { status: 'skipped' };  if (latest.netIncome > prevYearData.netIncome && latest.operatingIncome < prevYearData.operatingIncome) { return { status: 'alert', text: `淨利較去年同期成長，但本業營業利益衰退`, qs: [latest.q, prevYearQ], tab: 'income' }; } return { status: 'pass' }; } }, lowInterestCoverage: { name: "利息保障倍數偏低", level: "dynamic", why: () => `低於 3 黃燈，低於 1.5 紅燈`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.interestCoverage === null) return { status: 'skipped' }; if (latest.interestCoverage < 1.5) return { status: 'alert', level: 'red', text: `最新倍數 ${latest.interestCoverage} 低於 1.5`, qs: [latest.q], tab: 'balance' };
            if (latest.interestCoverage < 3) return { status: 'alert', level: 'yellow', text: `最新倍數 ${latest.interestCoverage} 低於 3`, qs: [latest.q], tab: 'balance' }; return { status: 'pass' }; } }, negativeFreeCF: { name: "自由現金流連續為負", level: "yellow", consecutive: 3, why: (c) => `連續 ${c.consecutive} 季小於 0`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.freeCF === null)) return { status: 'skipped' };
            if (recent.every(q => q.freeCF < 0)) return { status: 'alert', text: `連續 ${config.consecutive} 季小於 0`, qs: recent.map(q=>q.q), tab: 'cashflow' }; return { status: 'pass' }; } }, profitButNoCash: { name: "淨利為正但無現金流入", level: "yellow", why: (c) => `單季淨利大於 0，但營業現金流為負`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.netIncome === null \vert{}\vert{} latest.operatingCF === null) return { status: 'skipped' }; if (latest.netIncome > 0 && latest.operatingCF < 0) return { status: 'alert', text: `最新季淨利為正，但營業現金流為負`, qs: [latest.q], tab: 'cashflow' }; return { status: 'pass' }; } }, financingSupportedCash: { name: "靠融資撐現金", level: "red", why: () => `營業現金流為負、期末現金較前一季增加、且融資現金流為正`, check: (data, config) => { if (data.length < 2) return { status: 'skipped' }; const latest = data[data.length - 1]; const prev = data[data.length - 2]; if (latest.operatingCF === null \vert{}\vert{} latest.cashEnd === null \vert{}\vert{} prev.cashEnd === null \vert{}\vert{} latest.financingCF === null) return { status: 'skipped' };  if (latest.operatingCF < 0 && latest.cashEnd > prev.cashEnd && latest.financingCF > 0) { return { status: 'alert', text: `本業流失現金，靠融資活動才維持現金池成長`, qs: [latest.q], tab: 'cashflow' }; } return { status: 'pass' }; } } };  // ========================================== // 4. 產業類型與規則覆蓋設定 (TYPE_PROFILES) // ========================================== const TYPE_PROFILES = { electronics: { label: "電子製造/半導體", desc: "資本密集，允許自由現金流短期為負(不單獨示警)。", overrides: { negativeFreeCF: { disabled: true } } }, cyclical: { label: "傳產/景氣循環", desc: "景氣波動大，放寬營收衰退(連續 4 季)與負債比門檻(80\%)。", overrides: { revenueDecline: { consecutive: 4 }, highDebtRatio: { threshold: 80 } } }, growth: { label: "成長股", desc: "重視營收成長，允許短期虧損與現金流為負(關閉部分現金流示警)。", overrides: { profitButNoCash: { disabled: true }, negativeFreeCF: { disabled: true } } }, dividend: { label: "高股息/存股型", desc: "要求穩定獲利與現金流，對毛利與現金流品質更嚴格。", overrides: { grossMarginDrop: { consecutive: 2, level: "yellow" }, profitButNoCash: { level: "red" } } }, financial: { label: "金融業", desc: "金融業報表結構不同，流動比率、毛利、存貨等指標不適用，目前僅檢查營收趨勢與獲利趨勢。", overrides: { lowCurrentRatio: { disabled: true }, lowQuickRatio: { disabled: true }, highDebtRatio: { disabled: true }, grossMarginDrop: { disabled: true }, grossMarginPlunge: { disabled: true }, profitDivergence: { disabled: true }, lowInterestCoverage: { disabled: true }, negativeFreeCF: { disabled: true }, profitButNoCash: { disabled: true }, financingSupportedCash: { disabled: true } } }, general: { label: "一般 (預設)", desc: "不作任何產業調整，使用標準檢驗門檻。", overrides: {} } };  // ========================================== // 5. 白話文摘要產生器 (generateSummary) // ========================================== function generateSummary(alerts, skipped, status, quarters) { if (!quarters \vert{}\vert{} quarters.length === 0) return { detail: '資料異常。', short: '無資料' }; const latest = quarters[quarters.length - 1];  let statusText = status === 'red' ? '整體狀況需注意，存在警戒訊號。' : (status === 'yellow' ? '整體狀況尚可，但有需留意事項。' : '整體財報表現健康，無重大異常。');  let pros = []; let yoyCount = 0; for(let i = quarters.length - 1; i >= 0; i--) { if (quarters[i].revenueYoY > 0) yoyCount++; else break; } if (yoyCount >= 2) pros.push(`營收連續 ${yoyCount} 季成長`);
    else if (latest.revenueYoY > 0) pros.push(`最新營收年增 ${latest.revenueYoY}\%`);  if (latest.operatingCF > 0 && latest.freeCF > 0) pros.push('營業與自由現金流皆為正'); else if (latest.operatingCF > 0) pros.push('維持正向營業現金流');  if (latest.grossMargin !== null && latest.grossMargin > 20) pros.push(`毛利率達 ${latest.grossMargin}%`);
    if (latest.debtRatio !== null && latest.debtRatio < 50) pros.push(`負債比 ${latest.debtRatio}\% 體質穩健`);  let prosSelected = pros.slice(0, 2); let prosText = prosSelected.length > 0 ? `優點包含：${prosSelected.join('，且')}。` : '';

    let concernsText = '';
    if (alerts.length > 0) {
        let alertDetails = alerts.map(a => {
            let n = a.rule.name;
            let val = '';
            if (n.includes('營收') && latest.revenueYoY !== null) val = `(最新 ${latest.revenueYoY}\%)`; else if (n.includes('毛利') && latest.grossMargin !== null) val = `(最新 ${latest.grossMargin}%)`;
            else if (n.includes('流動比') && latest.currentRatio !== null) val = `(最新 ${latest.currentRatio})`; else if (n.includes('速動比') && latest.quickRatio !== null) val = `(最新 ${latest.quickRatio})`;
            else if (n.includes('負債') && latest.debtRatio !== null) val = `(最新 ${latest.debtRatio}\%)`; else if (n.includes('利息') && latest.interestCoverage !== null) val = `(最新 ${latest.interestCoverage})`;
            else if (n.includes('現金流') && latest.operatingCF !== null) val = `(最新營現 ${latest.operatingCF})`; return `${n}${val}`; }); concernsText = `疑慮方面：觸發了「${alertDetails.join('、')}」。`;
    }

    let missingText = skipped && skipped.length > 0 ? '部分指標資料不足，未納入判斷。' : '';
    let ending = '以上為依財報數據自動產生的整理，不構成投資建議。';
    
    let detail = `${statusText}${prosText} ${concernsText}${missingText} ${ending}`.trim(); let shortPros = prosSelected.length > 0 ? prosSelected[0] : '無特別亮點'; let shortAlerts = alerts.length > 0 ? `${alerts.length}項警訊` : '無警訊';
    let short = `${status==='green'?'健康':(status==='red'?'警戒':'注意')}｜${shortPros}｜${shortAlerts}`;  return { detail, short }; }  // ========================================== // 6. 輔助函式與分析核心 // ========================================== function getDefaultCompanyType(industry, isFinancial) { if (isFinancial) return 'financial'; if (!industry) return 'general'; return INDUSTRY_TO_TYPE[industry] \vert{}\vert{} 'general'; }  function getEffectiveRules(type) { const profile = TYPE_PROFILES[type] \vert{}\vert{} TYPE_PROFILES['general']; const effective = {}; for (const [key, baseConfig] of Object.entries(RULES_CONFIG)) { const override = profile.overrides[key] \vert{}\vert{} {}; if (override.disabled) continue; effective[key] = { ...baseConfig, ...override }; } return effective; }  // 用於計算 8 季的風險分數趨勢，確保不使用未來資料 function calcHistoricalRiskScores(quarters, effectiveType) { let scores = []; const rules = getEffectiveRules(effectiveType); for(let i = 0; i < quarters.length; i++) { let slice = quarters.slice(0, i + 1); let score = 0; for (const key of Object.keys(rules)) { const ruleConf = rules[key]; const res = ruleConf.check(slice, ruleConf); if (res && res.status === 'alert') { const lvl = res.level \vert{}\vert{} ruleConf.level; score += (lvl === 'red' ? RISK_WEIGHTS.red : RISK_WEIGHTS.yellow); } } scores.push(Math.min(score, RISK_WEIGHTS.max)); } return scores; }  function analyzeStock(stockId) { const stockDatabase = JSON.parse(localStorage.getItem('stock_database') \vert{}\vert{} '{}'); const data = stockDatabase[stockId]; if (!data \vert{}\vert{} !data.quarters \vert{}\vert{} data.quarters.length === 0) return null;  const overrides = JSON.parse(localStorage.getItem('typeOverrides') \vert{}\vert{} '{}'); const defaultType = getDefaultCompanyType(data.industry, data.isFinancial); const effectiveType = overrides[stockId] \vert{}\vert{} defaultType;  const rules = getEffectiveRules(effectiveType);  let alerts = []; let skipped = []; let status = 'green'; let riskScore = 0;  for (const key of Object.keys(rules)) { const ruleConf = rules[key]; const res = ruleConf.check(data.quarters, ruleConf); if (res && res.status === 'alert') { alerts.push({ rule: ruleConf, detail: res }); const lvl = res.level \vert{}\vert{} ruleConf.level;  riskScore += (lvl === 'red' ? RISK_WEIGHTS.red : RISK_WEIGHTS.yellow); if (lvl === 'red') status = 'red'; else if (status === 'green' && lvl === 'yellow') status = 'yellow'; } else if (res && res.status === 'skipped') { skipped.push(ruleConf); } } riskScore = Math.min(riskScore, RISK_WEIGHTS.max);  const summary = generateSummary(alerts, skipped, status, data.quarters); const histRiskScores = calcHistoricalRiskScores(data.quarters, effectiveType);  return { alerts, skipped, status, riskScore, histRiskScores, data, effectiveType, summary }; } ```  ### 2. 完整 `js/app.js` 加入本季 vs 上季比較區塊生成邏輯 (`generateQoQ`)，並擴增了 Chart.js 繪圖項目。  ```javascript const API_BASE = (window.location.hostname === '127.0.0.1' \vert{}\vert{} window.location.hostname === 'localhost') ? 'http://127.0.0.1:5000' : 'https://ethan-stock-api.onrender.com';  let portfolio = JSON.parse(localStorage.getItem('stock_portfolio') \vert{}\vert{} '[]'); let currentCharts = {};  document.addEventListener('DOMContentLoaded', () => { const savedTheme = localStorage.getItem('app_theme') \vert{}\vert{} 'dark'; document.documentElement.setAttribute('data-theme', savedTheme); setActiveNav(); });  function toggleTheme() { const current = document.documentElement.getAttribute('data-theme'); const next = current === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('app_theme', next); if (typeof renderCharts === 'function' && window.currentStockId) { renderCharts(window.currentStockId, window.currentAlerts); } }  function setActiveNav() { const path = window.location.pathname; document.querySelectorAll('.nav-links a').forEach(link => { if (path.includes(link.getAttribute('href'))) link.classList.add('active'); else link.classList.remove('active'); }); }  function savePortfolio() { localStorage.setItem('stock_portfolio', JSON.stringify(portfolio)); } function initPortfolio() { renderPortfolio(); }  async function addStock() { const input = document.getElementById('stock-input'); const id = input.value.trim(); const btn = input.nextElementSibling; if (!id) return;  let stockDatabase = JSON.parse(localStorage.getItem('stock_database') \vert{}\vert{} '{}'); if (portfolio.includes(id) && stockDatabase[id]) { alert('此股票已在自選清單中！'); input.value = ''; return; }  const originalText = btn.innerText; btn.innerText = '爬取中...'; btn.disabled = true;  try { const response = await fetch(`${API_BASE}/api/stock/${id}`); const result = await response.json(); if (!response.ok) { alert(result.error \vert{}\vert{} '爬取失敗，請確認代號正確'); return; }  stockDatabase[id] = result; localStorage.setItem('stock_database', JSON.stringify(stockDatabase));  if (!portfolio.includes(id)) { portfolio.push(id); savePortfolio(); } renderPortfolio(); if (typeof updateDetailSelect === 'function') updateDetailSelect(); } catch (err) { alert('無法連線到 Python 伺服器！'); } finally { btn.innerText = originalText; btn.disabled = false; input.value = ''; } }  function removeStock(id) { if (confirm(`確定移除 ${id}？`)) { 
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
      <div class="card" style="border-top: 4px solid var(--\${item.status}); position: relative;">
        <div class="flex-between" style="margin-bottom: 12px;">
          <h3 style="margin:0; display:flex; align-items:center; gap:8px;">
            ${item.id}${item.data.name} 
            <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">\${typeLabel}</span>
          </h3>
          <span class="status-indicator"><span class="dot ${item.status}"></span> ${statusText}</span>
        </div>
        <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 16px;">
          <div style="display:flex; justify-content:space-between;"><span>最新營收年增:</span> <strong style="color:var(--text)">\${fmt(latest.revenueYoY, false, '%')}</strong></div>
          <div style="display:flex; justify-content:space-between;"><span>毛利率:</span> <strong style="color:var(--text)">\${fmt(latest.grossMargin, true, '%')}</strong></div>
          <div style="display:flex; justify-content:space-between;"><span>負債比:</span> <strong style="color:var(--text)">\${fmt(latest.debtRatio, false, '%')}</strong></div>
        </div>
        <div class="flex-between" style="margin-bottom: 12px; font-size: 0.85rem; padding-bottom:12px; border-bottom:1px dashed var(--border);">
            <span>觸發警訊數：<strong>\${item.alerts.length}</strong> 項</span>
            <span class="badge" style="background:${riskColor}; color:#fff;">風險分數: ${item.riskScore}</span>
        </div>
        <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 16px;">
            📝 \${item.summary.short}
        </div>
        <div class="flex-between">
          <a href="details.html?id=\${item.id}" class="btn-primary" style="flex:1; margin-right: 8px; text-align:center;">查看詳情</a>
          <button class="btn-outline" style="color: var(--red); border-color: var(--red);" onclick="removeStock('\${item.id}')">移除</button>
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
            <a href="details.html?id=\${id}&tab=${a.detail.tab}" class="alert-item ${lvl}" style="display:block; color:inherit; margin-top: 8px;">
              <div class="flex-between" style="margin-bottom: 4px;">
                <strong>\${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
              </div>
              <p style="font-size: 0.9rem; color: var(--text-light);">\${a.detail.text}</p>
            </a>
          `;
        }).join('');

        container.innerHTML += `
          <div class="card" style="margin-bottom: 16px; border-top: 4px solid var(--\${analysis.status})">
            <h3 style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span>${id}${analysis.data.name}</span><span class="badge ${analysis.status}">${analysis.alerts.length} 項警訊</span>
            </h3>
            \${alertsHtml}
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
        <a href="details.html?id=\${a.stockId}&tab=${a.detail.tab}" class="alert-item ${lvl}" style="display:block; color:inherit;">
          <div class="flex-between" style="margin-bottom: 4px;">
            <strong>\${a.stockId} ${a.stockName} -${a.rule.name}</strong><span class="badge ${badgeClass}">${badgeText}</span>
          </div>
          <p style="font-size: 0.9rem; color: var(--text-light);">\${a.detail.text}</p>
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
        <div class="card" style="cursor: pointer; transition: 0.2s;" onclick="changeDetailStock('\${id}')" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
          <h3 style="margin: 0 0 8px 0; display:flex; align-items:center; gap:8px;">${id}${data.name}
            <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">\${typeLabel}</span>
          </h3>
          <p style="color: var(--text-light); font-size: 0.9rem;">產業: \${data.industry}</p>
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
      if(stockDatabase[id]) sel.innerHTML += `<option value="${id}">${id} ${stockDatabase[id].name}</option>`; }); if(portfolio.includes(currentVal)) sel.value = currentVal; }  function changeDetailStock(id) { if (id) window.location.href = `details.html?id=${id}`;
  else window.location.href = `details.html`;
}

function switchDetailTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.querySelector(`[onclick="switchDetailTab('${tabId}')"]`).classList.add('active'); document.getElementById(`tab-${tabId}`).classList.add('active');
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
                <span>\${item.name}</span>
                <span>${item.prevVal} ➔${item.curVal} <span class="\${colorClass}">${item.impact > 0 ? '▲' : '▼'}${item.txt}</span></span>
            </div>
        `).join('');
    };

    return `
        <div style="display:flex; gap:16px; margin-top:16px;">
            <div style="flex:1; background:var(--bg); padding:12px; border-radius:6px; border:1px solid var(--border);">
                <h4 style="margin:0 0 12px 0; color:var(--green);">🟢 變好最多</h4>
                \${renderItems(improved, 'green')}
            </div>
            <div style="flex:1; background:var(--bg); padding:12px; border-radius:6px; border:1px solid var(--border);">
                <h4 style="margin:0 0 12px 0; color:var(--red);">🔴 變差最多</h4>
                \${renderItems(worsened, 'red')}
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
  
  document.getElementById('detail-name').innerText = `${stockId}${analysis.data.name}`;
  document.getElementById('detail-industry').innerText = `產業: ${analysis.data.industry}`; document.getElementById('detail-dot').className = `dot ${analysis.status}`;
  document.getElementById('detail-status-text').innerText = analysis.status === 'red' ? '警戒狀態' : (analysis.status === 'yellow' ? '注意狀態' : '正常健康');
  
  document.getElementById('company-type-select').value = analysis.effectiveType;
  document.getElementById('company-type-desc').innerText = TYPE_PROFILES[analysis.effectiveType].desc;

  document.getElementById('detail-plain-summary').innerHTML = `
    <div style="background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 12px;">
      <h4 style="margin:0 0 8px 0;">💬 AI 財報白話解析</h4>
      <p style="margin:0; color: var(--text-light); line-height: 1.5; font-size: 0.95rem;">\${analysis.summary.detail}</p>
    </div>
  `;

  document.getElementById('detail-qoq').innerHTML = generateQoQ(analysis.data.quarters, analysis.effectiveType === 'financial');

  let alertsSumHtml = '';
  if (analysis.alerts.length === 0) { alertsSumHtml = '<span style="color:var(--green)">✓ 財報表現良好，未觸發任何警訊。</span>'; } 
  else { alertsSumHtml = analysis.alerts.map(a => `<div style="margin-top:4px;">⚠️ <strong>${a.rule.name}</strong>:${a.detail.text}</div>`).join(''); }
  
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
    tbodyIncome.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.revenue)}</td><td>${fmt(q.revenueYoY, false, '\%')}</td><td>${fmt(q.grossMargin, true, '%')}</td><td>${fmt(q.operatingIncome)}</td><td>${fmt(q.operatingMargin, false, '%')}</td><td>${fmt(q.nonOperatingIncome)}</td><td>${fmt(q.netIncome)}</td><td>${fmt(q.eps)}</td></tr>`; tbodyBalance.innerHTML += `<tr><td>${q.q}</td><td>${fmt(q.debtRatio, false, '\%')}</td><td>${fmt(q.currentRatio, true)}</td><td>${fmt(q.quickRatio, true)}</td><td>${fmt(q.interestCoverage, true)}</td><td>${fmt(q.arDays, true)}</td><td>${fmt(q.