// ==========================================
// 投資組合綜合健檢：把 ETF 拆解成底層成分股後與個股持倉加總
// ==========================================
// 計算方式（矩陣乘法）：
//   持倉市值向量 v（每一檔持倉 = 股數 × 收盤價）
//   權重矩陣 W（列 = 持倉、欄 = 底層個股；個股持倉自己那一格是 100%，ETF 持倉是成分股權重）
//   底層個股曝險 = vᵀ · W，再除以總市值得到真實持股比例

const XRAY_STORAGE_KEY = 'xray_positions';
const XRAY_EXAMPLE = [
    { id: '0050', shares: 2000 },
    { id: '00878', shares: 10000 },
    { id: '00929', shares: 10000 },
    { id: '2330', shares: 100 }
];
const XRAY_ID_RE = /^[0-9]{4,6}[A-Z]?$/;
const XRAY_MAX_POSITIONS = 30;

// 判斷門檻（皆為佔總市值 %）
const XRAY_THRESHOLDS = {
    singleStock: 15,   // 單一個股
    top5: 50,          // 前五大個股合計
    industry: 40,      // 單一產業
    etfOverlap: 30,    // 兩檔 ETF 成分重疊度
    hhi: { moderate: 1500, high: 2500 }
};

// 分類色盤（依持倉輸入順序固定配色，最多 8 色，其餘併入「其他持倉」）
const XRAY_PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
};
const XRAY_MAX_SERIES = 8;
const XRAY_TOP_N = 15;

let xrayResult = null;
let xrayCharts = {};
let xrayShowAll = false;
let xrayRunning = false;

// ================= 輸入區 =================
function loadXrayPositions() {
    try {
        const saved = JSON.parse(localStorage.getItem(XRAY_STORAGE_KEY));
        if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) { /* 資料損毀時當作沒存過 */ }
    return [];
}

function renderXrayInputs(positions) {
    const rows = positions.length ? positions : [{ id: '', shares: '' }];
    document.getElementById('xray-rows').innerHTML = rows.map(p => `
        <div class="xray-row">
          <input type="text" class="xray-id" placeholder="代號 (例: 0050)" maxlength="7" value="${escapeHtml(p.id)}">
          <input type="number" class="xray-shares" placeholder="股數" min="0" step="1" value="${escapeHtml(p.shares)}">
          <button class="btn-outline xray-remove" onclick="removeXrayRow(this)" title="移除這一列" aria-label="移除這一列">✕</button>
        </div>`).join('');
}

function currentInputRows() {
    return [...document.querySelectorAll('#xray-rows .xray-row')].map(row => ({
        id: row.querySelector('.xray-id').value.trim().toUpperCase(),
        shares: row.querySelector('.xray-shares').value.trim()
    }));
}

function addXrayRow() {
    const rows = currentInputRows();
    if (rows.length >= XRAY_MAX_POSITIONS) return showToast(`最多 ${XRAY_MAX_POSITIONS} 檔持倉`, 'warn');
    rows.push({ id: '', shares: '' });
    renderXrayInputs(rows);
    const inputs = document.querySelectorAll('#xray-rows .xray-id');
    inputs[inputs.length - 1].focus();
}

function removeXrayRow(btn) {
    btn.closest('.xray-row').remove();
    if (!document.querySelector('#xray-rows .xray-row')) renderXrayInputs([]);
}

function loadXrayExample() {
    renderXrayInputs(XRAY_EXAMPLE);
    runXray();
}

// 讀取並驗證輸入；同代號自動合併股數
function readXrayInputs() {
    const merged = new Map();  // 用 Map 保留輸入順序（一般物件會把 2330 這類數字鍵排到最前面，顏色就會跟著跑掉）
    const errors = [];
    currentInputRows().forEach(({ id, shares }) => {
        if (!id && !shares) return;
        const n = Number(shares);
        if (!XRAY_ID_RE.test(id)) return errors.push(`「${id || '（空白）'}」不是有效的股票或 ETF 代號`);
        if (!Number.isFinite(n) || n <= 0) return errors.push(`${id} 的股數必須大於 0`);
        merged.set(id, (merged.get(id) || 0) + Math.floor(n));
    });
    const positions = [...merged].map(([id, shares]) => ({ id, shares }));
    if (!positions.length && !errors.length) errors.push('請至少輸入一檔持倉');
    if (positions.length > XRAY_MAX_POSITIONS) errors.push(`最多 ${XRAY_MAX_POSITIONS} 檔持倉`);
    return { positions, errors };
}

// ================= 我的組合（快捷導入，僅存於本機瀏覽器） =================
const XRAY_PRESETS_KEY = 'xray_presets';
const XRAY_MAX_PRESETS = 20;

function loadXrayPresets() {
    try {
        const list = JSON.parse(localStorage.getItem(XRAY_PRESETS_KEY));
        return Array.isArray(list) ? list.filter(p => p && p.name && Array.isArray(p.positions)) : [];
    } catch (e) {
        return [];
    }
}

function storeXrayPresets(list) {
    try {
        localStorage.setItem(XRAY_PRESETS_KEY, JSON.stringify(list));
        return true;
    } catch (e) {
        showToast('瀏覽器儲存空間已滿，無法儲存組合', 'error');
        return false;
    }
}

function renderXrayPresets() {
    const list = loadXrayPresets();
    document.getElementById('xray-preset-list').innerHTML = list.length
        ? list.map((p, i) => `
            <span class="xray-preset">
              <button class="xray-preset-load" onclick="applyXrayPreset(${i})" title="${escapeHtml(p.positions.map(x => `${x.id} ${x.shares.toLocaleString('zh-TW')} 股`).join('、'))}">${escapeHtml(p.name)}</button>
              <button class="xray-preset-del" onclick="deleteXrayPreset(${i})" title="刪除此組合" aria-label="刪除組合 ${escapeHtml(p.name)}">✕</button>
            </span>`).join('')
        : '<span class="section-hint" style="font-size:0.85rem;">尚未儲存任何組合</span>';
}

async function saveXrayPreset() {
    const { positions, errors } = readXrayInputs();
    if (errors.length) return setXrayStatus(errors.map(escapeHtml).join('<br>'), true);

    const name = ((await showPrompt('為這個組合取個名字（例如：主帳戶、存股組合）', { maxLength: 20, okText: '儲存' })) || '').trim().slice(0, 20);
    if (!name) return;

    const list = loadXrayPresets();
    const existing = list.findIndex(p => p.name === name);
    if (existing >= 0) {
        if (!await showConfirm(`已有名為「${name}」的組合，要覆蓋嗎？`, { okText: '覆蓋' })) return;
        list[existing] = { name, positions, savedAt: new Date().toISOString() };
    } else {
        if (list.length >= XRAY_MAX_PRESETS) return showToast(`最多儲存 ${XRAY_MAX_PRESETS} 個組合，請先刪除不用的組合`, 'warn');
        list.push({ name, positions, savedAt: new Date().toISOString() });
    }
    if (storeXrayPresets(list)) {
        renderXrayPresets();
        setXrayStatus(`已儲存組合「${escapeHtml(name)}」`);
    }
}

function applyXrayPreset(index) {
    const preset = loadXrayPresets()[index];
    if (!preset) return;
    // 只載入到輸入框，讓使用者確認或修改股數後再自行按「開始健檢」
    renderXrayInputs(preset.positions);
    setXrayStatus(`已載入組合「${escapeHtml(preset.name)}」，確認股數後請按「開始健檢」`);
    const firstShares = document.querySelector('#xray-rows .xray-shares');
    if (firstShares) firstShares.focus();
}

async function deleteXrayPreset(index) {
    const list = loadXrayPresets();
    if (!list[index] || !await showConfirm(`確定刪除組合「${list[index].name}」？`, { okText: '刪除', danger: true })) return;
    list.splice(index, 1);
    storeXrayPresets(list);
    renderXrayPresets();
}

function setXrayStatus(html, isError = false) {
    const el = document.getElementById('xray-status');
    el.style.display = html ? 'block' : 'none';
    el.style.color = isError ? 'var(--red)' : 'var(--text-light)';
    el.innerHTML = html;
}

// ================= 取得資料 =================
async function fetchXrayJson(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!data) {
            // 回應不是 JSON（例如舊版後端沒有這個 API，回傳 404 網頁）
            return { error: response.status === 404 ? '伺服器找不到此功能（HTTP 404），後端可能尚未部署新版' : `伺服器回應異常（HTTP ${response.status}）` };
        }
        return response.ok ? { data } : { error: data.error || `HTTP ${response.status}` };
    } catch (err) {
        return { error: err.name === 'AbortError' ? '請求逾時：雲端伺服器可能正在喚醒中，請稍後重試' : '無法連線到伺服器' };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runXray() {
    if (xrayRunning) return;
    const { positions, errors } = readXrayInputs();
    if (errors.length) return setXrayStatus(errors.map(escapeHtml).join('<br>'), true);

    localStorage.setItem(XRAY_STORAGE_KEY, JSON.stringify(positions));
    renderXrayInputs(positions);

    xrayRunning = true;
    const btn = document.getElementById('xray-run');
    btn.disabled = true;
    btn.textContent = '計算中…';
    setXrayStatus('正在取得收盤價與 ETF 成分股…（雲端伺服器喚醒可能需要數十秒）');

    try {
        const etfIds = positions.map(p => p.id).filter(isEtfId);
        const [quotesRes, ...etfResults] = await Promise.all([
            fetchXrayJson(`${API_BASE}/api/quotes?ids=${positions.map(p => p.id).join(',')}`),
            ...etfIds.map(id => fetchXrayJson(`${API_BASE}/api/etf/${id}`))
        ]);
        if (quotesRes.error) return setXrayStatus(`收盤價取得失敗：${escapeHtml(quotesRes.error)}`, true);

        const etfMap = {};
        etfIds.forEach((id, i) => { etfMap[id] = etfResults[i]; });

        xrayResult = computeXray(positions, quotesRes.data.quotes || {}, etfMap);
        if (!xrayResult.total) return setXrayStatus('所有持倉都查無收盤價，無法計算', true);

        setXrayStatus('');
        xrayShowAll = false;
        renderXrayResult();
    } finally {
        xrayRunning = false;
        btn.disabled = false;
        btn.textContent = '開始健檢';
    }
}

// ================= 核心計算 =================
function computeXray(positions, quotes, etfMap) {
    const sources = [];      // 每一檔持倉
    const stocks = {};       // 底層個股：{ value, bySource: { 持倉代號: 金額 } }
    const etfWeights = {};   // 各 ETF 的成分股權重（%），算重疊度用
    const issues = [];
    let nonStockValue = 0;   // ETF 內的現金、期貨等非股票部位
    let unresolvedValue = 0; // 無法取得成分股的 ETF（債券、期貨型等）

    const addExposure = (sourceId, stockId, name, industries, amount) => {
        const s = stocks[stockId] || (stocks[stockId] = { stockId, name, industries: [], value: 0, bySource: {} });
        s.value += amount;
        s.bySource[sourceId] = (s.bySource[sourceId] || 0) + amount;
        if (!s.industries.length && industries && industries.length) s.industries = industries;
    };

    positions.forEach(p => {
        const quote = quotes[p.id];
        if (!quote) {
            issues.push(`${p.id}：查無收盤價（可能已下市或代號錯誤），未納入計算`);
            return;
        }
        const value = p.shares * quote.price;
        const src = { id: p.id, name: quote.name, shares: p.shares, price: quote.price, date: quote.date, value, isEtf: isEtfId(p.id), status: 'direct' };
        sources.push(src);

        if (!src.isEtf) {
            addExposure(p.id, p.id, quote.name, quote.industries, value);
            return;
        }

        const etf = etfMap[p.id];
        if (!etf || etf.error) {
            src.status = 'unresolved';
            unresolvedValue += value;
            issues.push(`${p.id} ${quote.name}：${etf && etf.error ? etf.error : '成分股取得失敗'}，整筆列為「無法拆解」`);
            return;
        }

        const holdings = etf.data.holdings || [];
        const sumWeight = holdings.reduce((sum, h) => sum + h.weight, 0);
        const scale = sumWeight > 100 ? 100 / sumWeight : 1;  // 權重加總超過 100% 時等比例縮回
        etfWeights[p.id] = {};
        holdings.forEach(h => {
            const w = h.weight * scale;
            etfWeights[p.id][h.stockId] = w;
            addExposure(p.id, h.stockId, h.name, h.industries, value * w / 100);
        });
        src.status = 'resolved';
        src.holdingCount = holdings.length;
        src.asOf = etf.data.asOf;
        src.nonStock = value * Math.max(0, 100 - sumWeight * scale) / 100;
        nonStockValue += src.nonStock;
        (etf.data.warnings || []).forEach(w => issues.push(`${p.id}：${w}`));
    });

    const total = sources.reduce((sum, s) => sum + s.value, 0);
    const pct = v => total > 0 ? v / total * 100 : 0;
    sources.forEach(s => { s.weight = pct(s.value); });

    const stockList = Object.values(stocks).map(s => ({
        ...s,
        weight: pct(s.value),
        industry: pickIndustry(s.industries) || '未分類',
        sourceCount: Object.keys(s.bySource).length
    })).sort((a, b) => b.value - a.value);

    // 產業曝險
    const industryMap = {};
    stockList.forEach(s => { industryMap[s.industry] = (industryMap[s.industry] || 0) + s.value; });
    const industries = Object.entries(industryMap).map(([name, value]) => ({ name, value, weight: pct(value) }));
    if (nonStockValue > 0.5) industries.push({ name: '非股票部位（現金、期貨）', value: nonStockValue, weight: pct(nonStockValue), muted: true });
    if (unresolvedValue > 0) industries.push({ name: '無法拆解的 ETF', value: unresolvedValue, weight: pct(unresolvedValue), muted: true });
    industries.sort((a, b) => b.value - a.value);

    // 集中度：以股票部位為 100% 計算 HHI，有效持股數 = 10000 / HHI
    const stockTotal = stockList.reduce((sum, s) => sum + s.value, 0);
    const hhi = stockTotal > 0 ? Math.round(stockList.reduce((sum, s) => sum + (s.value / stockTotal * 100) ** 2, 0)) : 0;
    const overlapping = stockList.filter(s => s.sourceCount >= 2);

    // ETF 兩兩重疊度：Σ min(權重A, 權重B)
    const etfIds = Object.keys(etfWeights);
    const overlapMatrix = etfIds.map(a => etfIds.map(b => {
        if (a === b) return 100;
        let sum = 0;
        for (const [sid, w] of Object.entries(etfWeights[a])) {
            if (etfWeights[b][sid] != null) sum += Math.min(w, etfWeights[b][sid]);
        }
        return sum;
    }));

    return {
        total, sources, stocks: stockList, industries, issues,
        nonStockValue, unresolvedValue,
        hhi,
        hhiLabel: hhi >= XRAY_THRESHOLDS.hhi.high ? '高度集中' : (hhi >= XRAY_THRESHOLDS.hhi.moderate ? '中度集中' : '分散'),
        effectiveCount: hhi > 0 ? 10000 / hhi : 0,
        top5: stockList.slice(0, 5).reduce((sum, s) => sum + s.weight, 0),
        overlapping,
        overlapWeight: overlapping.reduce((sum, s) => sum + s.weight, 0),
        etfIds, overlapMatrix,
        priceDate: sources.map(s => s.date).filter(Boolean).sort().pop() || ''
    };
}

function buildXrayInsights(r) {
    const items = [];
    const top = r.stocks[0];
    const fmtPct = v => `${v.toFixed(1)}%`;

    if (top && top.weight >= XRAY_THRESHOLDS.singleStock) {
        items.push({ level: 'red', title: `單一個股曝險過高：${top.name} 佔 ${fmtPct(top.weight)}`,
            text: `門檻 ${XRAY_THRESHOLDS.singleStock}%。` + (top.sourceCount >= 2 ? `這個部位分散在 ${top.sourceCount} 檔持倉中，單看任何一檔都不明顯。` : '') });
    }
    if (r.top5 >= XRAY_THRESHOLDS.top5) {
        items.push({ level: 'yellow', title: `前五大個股合計 ${fmtPct(r.top5)}`, text: `超過 ${XRAY_THRESHOLDS.top5}%，資產表現高度取決於少數公司。` });
    }
    const topIndustry = r.industries.find(i => !i.muted);
    if (topIndustry && topIndustry.weight >= XRAY_THRESHOLDS.industry) {
        items.push({ level: 'yellow', title: `產業集中：${topIndustry.name} 佔 ${fmtPct(topIndustry.weight)}`, text: `超過 ${XRAY_THRESHOLDS.industry}%，容易受單一產業景氣循環影響。` });
    }
    r.etfIds.forEach((a, i) => r.etfIds.forEach((b, j) => {
        if (j <= i) return;
        const ov = r.overlapMatrix[i][j];
        if (ov >= XRAY_THRESHOLDS.etfOverlap) {
            items.push({ level: 'yellow', title: `${a} 與 ${b} 成分重疊 ${fmtPct(ov)}`, text: '兩檔 ETF 持有大量相同股票，同時持有的分散效果有限。' });
        }
    }));
    const multi = r.overlapping.filter(s => s.sourceCount >= 3).slice(0, 3);
    if (multi.length) {
        items.push({ level: 'yellow', title: '重複持有的個股',
            text: multi.map(s => `${s.name} 出現在 ${s.sourceCount} 檔持倉（合計 ${fmtPct(s.weight)}）`).join('；') });
    }
    if (!items.length) {
        items.push({ level: 'green', title: '沒有明顯的集中風險', text: `最大個股 ${top ? fmtPct(top.weight) : '--'}、前五大 ${fmtPct(r.top5)}，皆在門檻內。` });
    }
    return items;
}

// ================= 畫面 =================
function xrayThemeColors() {
    const style = getComputedStyle(document.body);
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
        text: style.getPropertyValue('--text').trim(),
        muted: style.getPropertyValue('--text-light').trim(),
        grid: style.getPropertyValue('--border').trim(),
        surface: style.getPropertyValue('--card-bg').trim(),
        palette: XRAY_PALETTE[isDark ? 'dark' : 'light']
    };
}

// 持倉 → 顏色：依輸入順序固定，第 9 檔起併入「其他持倉」
function xraySeries(sources, colors) {
    const series = sources.slice(0, XRAY_MAX_SERIES).map((s, i) => ({ ids: [s.id], label: `${s.id} ${s.name}`, color: colors.palette[i] }));
    if (sources.length > XRAY_MAX_SERIES) {
        series.push({ ids: sources.slice(XRAY_MAX_SERIES).map(s => s.id), label: '其他持倉', color: colors.muted });
    }
    return series;
}

const fmtMoney = v => Math.round(v).toLocaleString('zh-TW');

function statTile(label, value, sub = '') {
    return `
      <div class="xray-stat">
        <div class="xray-stat-label">${label}</div>
        <div class="xray-stat-value">${value}</div>
        ${sub ? `<div class="xray-stat-sub">${sub}</div>` : ''}
      </div>`;
}

function renderXrayResult() {
    const r = xrayResult;
    const colors = xrayThemeColors();
    const series = xraySeries(r.sources, colors);
    const top = r.stocks[0];
    const resolvedCount = r.sources.filter(s => s.status !== 'unresolved').length;

    document.getElementById('xray-result').style.display = 'block';
    document.getElementById('xray-price-date').textContent = r.priceDate ? `收盤價日期 ${r.priceDate}` : '';

    document.getElementById('xray-stats').innerHTML = [
        statTile('投資組合總市值', `${fmtMoney(r.total)} 元`, `${r.sources.length} 檔持倉`),
        statTile('底層實際持有', `${r.stocks.length} 檔個股`, r.etfIds.length ? `由 ${r.etfIds.length} 檔 ETF 拆解而來` : ''),
        statTile('最大單一曝險', top ? `${top.weight.toFixed(1)}%` : '--', top ? escapeHtml(`${top.stockId} ${top.name}`) : ''),
        statTile('前五大個股合計', `${r.top5.toFixed(1)}%`),
        statTile(termHtml('有效持股數'), r.effectiveCount ? `${r.effectiveCount.toFixed(1)} 檔` : '--',
            `集中度：${r.hhiLabel}（${termHtml('HHI', `HHI ${r.hhi}`)}）`),
        statTile('重複持有的個股', `${r.overlapping.length} 檔`, `合計佔 ${r.overlapWeight.toFixed(1)}%`)
    ].join('');

    document.getElementById('xray-insights').innerHTML = buildXrayInsights(r).map(item => `
        <div class="alert-item ${item.level === 'green' ? '' : item.level}" style="cursor:default; ${item.level === 'green' ? 'border-left-color:var(--green);' : ''}">
          <strong>${item.level === 'red' ? '🔴 警戒' : item.level === 'yellow' ? '🟡 注意' : '🟢 良好'}｜${escapeHtml(item.title)}</strong>
          <p style="font-size:0.9rem; color:var(--text-light); margin-top:4px;">${escapeHtml(item.text)}</p>
        </div>`).join('');

    const issuesEl = document.getElementById('xray-issues');
    issuesEl.style.display = r.issues.length ? 'block' : 'none';
    issuesEl.innerHTML = r.issues.map(t => `<div>⚠️ ${escapeHtml(t)}</div>`).join('');

    renderXraySources(r, series);
    renderXrayStockChart(r, series, colors);
    renderXrayIndustries(r);
    renderXrayOverlap(r);
    renderXrayStockTable(r, series);
}

function renderXraySources(r, series) {
    const colorOf = id => (series.find(s => s.ids.includes(id)) || {}).color;
    const statusText = s => s.status === 'direct' ? '個股'
        : s.status === 'resolved' ? `ETF・${s.holdingCount} 檔成分股${s.nonStock > 0.5 ? `・非股票 ${(s.nonStock / s.value * 100).toFixed(1)}%` : ''}`
        : '<span style="color:var(--yellow)">無法拆解</span>';
    document.getElementById('xray-sources-body').innerHTML = r.sources.map(s => `
        <tr>
          <td><span class="dot" style="background:${colorOf(s.id)}; width:10px; height:10px; margin-right:6px;"></span>${s.id}</td>
          <td>${escapeHtml(s.name)}</td>
          <td style="text-align:right;">${s.shares.toLocaleString('zh-TW')}</td>
          <td style="text-align:right;">${s.price}</td>
          <td style="text-align:right;">${fmtMoney(s.value)}</td>
          <td style="text-align:right;"><strong>${s.weight.toFixed(1)}%</strong></td>
          <td style="color:var(--text-light); font-size:0.85rem;">${statusText(s)}</td>
        </tr>`).join('');
}

function renderXrayStockChart(r, series, colors) {
    const canvas = document.getElementById('xray-stock-chart');
    if (xrayCharts.stocks) xrayCharts.stocks.destroy();
    const topStocks = r.stocks.slice(0, XRAY_TOP_N);
    canvas.parentElement.style.height = `${Math.max(240, topStocks.length * 30 + 80)}px`;

    const datasets = series.map(sr => ({
        label: sr.label,
        data: topStocks.map(s => sr.ids.reduce((sum, id) => sum + (s.bySource[id] || 0), 0) / r.total * 100),
        backgroundColor: sr.color,
        borderColor: colors.surface,
        borderWidth: { right: 2 },
        borderSkipped: false,
        barPercentage: 0.7,
        categoryPercentage: 0.9
    })).filter(ds => ds.data.some(v => v > 0));

    xrayCharts.stocks = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: topStocks.map(s => `${s.stockId} ${s.name}`), datasets },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', axis: 'y', intersect: false },
            scales: {
                x: { stacked: true, ticks: { color: colors.muted, callback: v => `${v}%` }, grid: { color: colors.grid }, border: { display: false } },
                y: { stacked: true, ticks: { color: colors.text }, grid: { display: false } }
            },
            plugins: {
                legend: { position: 'top', align: 'start', labels: { color: colors.text, boxWidth: 12, boxHeight: 12 } },
                tooltip: {
                    filter: item => item.raw > 0,
                    callbacks: {
                        label: item => ` ${item.dataset.label}：${item.raw.toFixed(2)}%`,
                        footer: items => items.length ? `合計 ${topStocks[items[0].dataIndex].weight.toFixed(2)}%（${fmtMoney(topStocks[items[0].dataIndex].value)} 元）` : ''
                    }
                }
            }
        }
    });
}

function renderXrayIndustries(r) {
    const list = r.industries.filter(i => !i.muted);
    const shown = list.slice(0, 12);
    const rest = list.slice(12).reduce((sum, i) => sum + i.weight, 0);
    const muted = r.industries.filter(i => i.muted);
    const maxW = Math.max(...r.industries.map(i => i.weight), 1);
    document.getElementById('xray-industries').innerHTML =
        shown.map(i => barRow(escapeHtml(i.name), i.weight, maxW, `${i.weight.toFixed(1)}%`,
            i.weight >= XRAY_THRESHOLDS.industry ? 'var(--yellow)' : 'var(--primary)')).join('') +
        (rest > 0 ? barRow('其他產業', rest, maxW, `${rest.toFixed(1)}%`, 'var(--text-light)') : '') +
        muted.map(i => barRow(escapeHtml(i.name), i.weight, maxW, `${i.weight.toFixed(1)}%`, 'var(--text-light)')).join('');
}

function renderXrayOverlap(r) {
    const card = document.getElementById('xray-overlap-card');
    if (r.etfIds.length < 2) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const nameOf = id => (r.sources.find(s => s.id === id) || {}).name || '';
    const head = `<tr><th></th>${r.etfIds.map(id => `<th style="text-align:center;" title="${escapeHtml(nameOf(id))}">${id}</th>`).join('')}</tr>`;
    const body = r.etfIds.map((a, i) => `
        <tr>
          <th title="${escapeHtml(nameOf(a))}">${a} <span style="font-size:0.8rem;">${escapeHtml(nameOf(a))}</span></th>
          ${r.overlapMatrix[i].map((v, j) => i === j
              ? '<td style="text-align:center; color:var(--text-light);">—</td>'
              : `<td style="text-align:center; background:rgba(59,130,246,${(Math.min(v, 100) / 100 * 0.75).toFixed(2)}); ${v >= 50 ? 'color:#fff;' : ''}${v >= XRAY_THRESHOLDS.etfOverlap ? 'font-weight:bold;' : ''}">${v.toFixed(1)}%</td>`).join('')}
        </tr>`).join('');
    document.getElementById('xray-overlap').innerHTML = `<table class="xray-matrix">${head}${body}</table>`;
}

function renderXrayStockTable(r, series) {
    const colorOf = id => (series.find(s => s.ids.includes(id)) || {}).color;
    const list = xrayShowAll ? r.stocks : r.stocks.slice(0, 30);
    document.getElementById('xray-stock-body').innerHTML = list.map((s, i) => {
        const chips = Object.entries(s.bySource).sort((a, b) => b[1] - a[1]).map(([id, v]) =>
            `<span class="xray-chip"><span class="dot" style="background:${colorOf(id)}; width:8px; height:8px;"></span>${id} ${(v / r.total * 100).toFixed(2)}%</span>`).join('');
        const link = /^[0-9]{4,6}$/.test(s.stockId) && !isEtfId(s.stockId)
            ? `<a href="details.html?id=${s.stockId}&from=portfolio">${s.stockId}</a>` : s.stockId;
        return `
          <tr>
            <td style="color:var(--text-light);">${i + 1}</td>
            <td>${link} ${escapeHtml(s.name)}</td>
            <td style="color:var(--text-light);">${escapeHtml(s.industry)}</td>
            <td style="text-align:right;"><strong>${s.weight.toFixed(2)}%</strong></td>
            <td style="text-align:right;">${fmtMoney(s.value)}</td>
            <td>${chips}</td>
          </tr>`;
    }).join('');
    const btn = document.getElementById('xray-stock-toggle');
    btn.style.display = r.stocks.length > 30 ? 'inline-block' : 'none';
    btn.textContent = xrayShowAll ? '收合' : `顯示全部 ${r.stocks.length} 檔`;
}

function toggleXrayStocks() {
    xrayShowAll = !xrayShowAll;
    renderXrayStockTable(xrayResult, xraySeries(xrayResult.sources, xrayThemeColors()));
}

function initPortfolioXray() {
    const saved = loadXrayPositions();
    renderXrayInputs(saved);
    renderXrayPresets();
    document.getElementById('xray-rows').addEventListener('keypress', e => {
        if (e.key === 'Enter') runXray();
    });
    // 切換深淺色時重畫（圖表顏色是畫的當下讀取的）
    window.addEventListener('themechange', () => { if (xrayResult) renderXrayResult(); });
    if (saved.length) runXray();
}
