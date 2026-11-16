// ==========================================
// ETF 專用邏輯模組
// ==========================================
let etfFetchController = null;
let currentEtfId = null;
let currentEtfHoldings = [];
let etfExpanded = false;
let etfSortBy = 'weight';
let etfBatchRunning = false;

// --- 抓取 ETF 成分股並存入瀏覽器（含成分股風險摘要）。回傳 { result } 或 { error } ---
async function requestEtf(id, refresh = false) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(`${API_BASE}/api/etf/${id}${refresh ? '?refresh=1' : ''}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) return { error: result.error || 'ETF 取得失敗' };

        const holdings = enrichEtfHoldings(result.holdings || []);
        const stockDatabase = loadStockDatabase();
        stockDatabase[id] = {
            isEtf: true,
            name: result.name,
            etfId: result.etfId,
            asOf: result.asOf,
            count: result.count,
            top3: holdings.slice(0, 3).map(h => ({ name: h.name, weight: h.weight })),
            fetchedAt: result.fetchedAt,
            risk: etfRiskSnapshot(computeEtfRisk(holdings))
        };
        if (!saveStockDatabase(stockDatabase)) return { error: '瀏覽器儲存空間已滿，請先刪除部分「其他已查詢股票」。' };
        return { result };
    } catch (err) {
        return { error: err.name === 'AbortError' ? '請求逾時：雲端伺服器可能正在喚醒中，請稍後重試！' : networkErrorReason() };
    } finally {
        clearTimeout(timeoutId);
    }
}

// --- 按鈕觸發的新增／更新 ETF；addToPortfolio 為 true 時同時加入自選股 ---
async function syncEtf(id, addToPortfolio) {
    const isUpdating = !!loadStockDatabase()[id];
    const { result, error } = await requestEtf(id, isUpdating);
    if (error) {
        alert(error);
        return false;
    }
    const added = addToPortfolio && !portfolio.includes(id);
    if (added) {
        portfolio.push(id);
        savePortfolio();
    }
    alert(isUpdating ? `✅ ${id} 成分股更新完成！${added ? '\n已加入自選股。' : ''}` : `✅ 成功新增 ETF: ${id} ${result.name}`);
    return true;
}

// --- 首頁 ETF 卡片：已查詢成分股權重達門檻才顯示風險狀態與細項 ---
function etfCardHtml(id, data, isTracked) {
    const risk = data.risk;
    const assessed = risk && risk.coverage >= ETF_RISK_CONFIG.minCoverage;
    const top3Text = escapeHtml(data.top3 && data.top3.length > 0
        ? `前三大：${data.top3.map(h => `${h.name} ${h.weight}%`).join('、')}`
        : '無成分股資訊');
    const row = (label, value) => `<div style="display:flex; justify-content:space-between; gap:8px;"><span>${label}</span> <strong style="color:var(--text); text-align:right;">${value}</strong></div>`;

    let riskHtml;
    if (assessed) {
        const lw = risk.lightWeights;
        const rules = risk.rules.length
            ? risk.rules.map(r => `${r.name} ${r.weight.toFixed(1)}%`).join('、')
            : '無';
        riskHtml = `
            <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed var(--border);">
              ${row('燈號權重:', `<span style="color:var(--red)">紅 ${lw.red.toFixed(1)}%</span>・<span style="color:var(--yellow)">黃 ${lw.yellow.toFixed(1)}%</span>・<span style="color:var(--green)">綠 ${lw.green.toFixed(1)}%</span>`)}
              ${row('加權風險分數:', risk.weightedRisk == null ? '--' : risk.weightedRisk.toFixed(1))}
              ${row('持股集中度:', `${risk.hhiLabel}（最大 ${risk.top1.toFixed(1)}%）`)}
              ${row('主要警訊曝險:', escapeHtml(rules))}
              <div style="margin-top:4px;">已查詢 ${risk.queriedCount} / ${risk.count} 檔（權重 ${risk.coverage.toFixed(1)}%）</div>
            </div>`;
    } else {
        riskHtml = `
            <div style="font-size: 0.85rem; color: var(--text-light); margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed var(--border);">
              已查詢成分股權重 ${(risk ? risk.coverage : 0).toFixed(1)}%，達 ${ETF_RISK_CONFIG.minCoverage}% 後顯示風險狀態（可在「查看成分股」中查詢）
            </div>`;
    }

    return `
        <div class="card" style="border-top: 4px solid ${assessed ? `var(--${risk.level})` : 'var(--text-light)'};">
            <div class="flex-between" style="margin-bottom: 12px;">
              <h3 style="margin:0; display:flex; align-items:center; gap:8px;">
                ${id} ${escapeHtml(data.name)}
                <span style="font-size:0.75rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">ETF</span>
              </h3>
              ${assessed
                  ? `<span class="status-indicator"><span class="dot ${risk.level}"></span> ${risk.verdict}</span>`
                  : `<span class="status-indicator" style="color:var(--text-light);"><span class="dot" style="background:var(--text-light)"></span> 未評估</span>`}
            </div>
            <div style="font-size: 0.9rem; color: var(--text-light); margin-bottom: 12px;">
              <div style="margin-bottom:4px;">成分股 <strong>${escapeHtml(data.count)}</strong> 檔・資料日期 ${escapeHtml(data.asOf)}</div>
              <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${top3Text}">${top3Text}</div>
            </div>
            ${riskHtml}
            ${cardFooterHtml(id, data.fetchedAt, isTracked, '查看成分股')}
        </div>`;
}

// --- 詳情頁：渲染 ETF 視圖 ---
async function renderEtfView(etfId) {
    const container = document.getElementById('etf-view');
    currentEtfId = etfId;
    container.innerHTML = `
      <div class="flex-between" style="margin-bottom: 16px;">
        <h2 style="margin:0; display:flex; align-items:center; gap:8px;">
          ${etfId} <span id="etf-view-name"></span>
          <span style="font-size:1rem; padding:2px 6px; background:var(--primary); color:#fff; border-radius:4px; font-weight:normal;">ETF</span>
        </h2>
        <div style="font-size:0.9rem; color:var(--text-light);">資料日期 <span id="etf-view-asof"></span></div>
      </div>
      <div class="card" style="margin-bottom:16px;">
         <div class="grid-3" style="margin-top:0;">
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">成分股總數</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-count">--</div>
            </div>
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">前十大合計佔比</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-top10">--%</div>
            </div>
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">非股票部位（期貨、現金）</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-other">--%</div>
            </div>
         </div>
         <div id="etf-view-warnings" style="margin-top:16px; display:none; color:var(--yellow); font-size:0.9rem;"></div>
      </div>

      <div class="card" style="margin-bottom:16px;">
         <div class="flex-between" style="margin-bottom:8px; flex-wrap:wrap; gap:8px;">
            <h3 style="margin:0;">成分股財報風險</h3>
            <span class="status-indicator"><span class="dot" id="etf-risk-dot"></span><span id="etf-risk-verdict">--</span></span>
         </div>
         <p id="etf-risk-verdict-desc" style="color:var(--text-light); font-size:0.9rem; margin-bottom:16px;"></p>

         <h4 style="margin:0 0 8px 0;">燈號權重曝險</h4>
         <div class="etf-stack-bar" id="etf-light-bar"></div>
         <div id="etf-light-legend" style="display:flex; gap:16px; flex-wrap:wrap; font-size:0.85rem; margin-top:8px;"></div>

         <div class="grid-3" style="margin-top:20px;">
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">已查詢財報</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-coverage">--</div>
               <div style="color:var(--text-light); font-size:0.85rem;" id="etf-view-coverage-weight"></div>
            </div>
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">加權平均風險分數</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-risk">--</div>
               <div style="color:var(--text-light); font-size:0.85rem;">僅計入已查詢的公司，滿分 100</div>
            </div>
            <div>
               <div style="color:var(--text-light); font-size:0.9rem;">持股集中度</div>
               <div style="font-size:1.5rem; font-weight:bold; color:var(--text);" id="etf-view-concentration">--</div>
               <div style="color:var(--text-light); font-size:0.85rem;" id="etf-view-concentration-sub"></div>
            </div>
         </div>

         <h4 style="margin:24px 0 8px 0;">各項警訊曝險（觸發警訊的公司合計權重）</h4>
         <div id="etf-rule-exposure"></div>

         <h4 style="margin:24px 0 8px 0;">加權五大構面健康度</h4>
         <div id="etf-dimension-scores"></div>

         <h4 style="margin:24px 0 8px 0;">產業類型分布（依權重）</h4>
         <div id="etf-view-types"></div>
         <p style="margin-top:12px; color:var(--text-light); font-size:0.85rem;">點選下方尚未查詢的成分股，即可查詢財報（不會加入自選股）。財報風險不包含價格波動、折溢價等市場風險。</p>
      </div>
            <div class="card">
         <div class="flex-between" style="margin-bottom:16px;">
            <h3 style="margin:0;">成分股清單</h3>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
               <button class="btn-outline" id="etf-query-all-btn" onclick="toggleQueryAllHoldings()">查詢全部財報</button>
               <select id="etf-sort" style="padding:4px 8px; font-size:0.9rem;" onchange="changeEtfSort(this.value)">
                   <option value="weight">依權重排序</option>
                   <option value="id">依代號排序</option>
                   <option value="risk">依風險分數排序</option>
               </select>
            </div>
         </div>
         <div id="etf-query-progress" class="card-updated" style="display:none; margin-bottom:12px;"></div>
         <div id="etf-list-container">
            <p style="text-align:center; color:var(--text-light);">資料載入中…</p>
         </div>
         <div id="etf-more-container" style="text-align:center; margin-top:16px; display:none;">
            <button class="btn-outline" id="etf-more-btn" style="width:100%; max-width:300px; min-height:40px;" onclick="toggleEtfExpand()">顯示更多</button>
         </div>
      </div>
      <div style="text-align:center; margin-top:24px; color:var(--text-light); font-size:0.8rem;">
         成分股與權重以投信公告為準，資料日期見上方，不構成投資建議。
      </div>
    `;

    if (etfFetchController) etfFetchController.abort();
    etfFetchController = new AbortController();
    
    let etfData = null;
    let fetchError = null;

    try {
        const timeoutId = setTimeout(() => etfFetchController.abort(), 60000);
        const res = await fetch(`${API_BASE}/api/etf/${etfId}`, { signal: etfFetchController.signal });
        clearTimeout(timeoutId);
        
        if (res.ok) {
            etfData = await res.json();
        } else {
            fetchError = '伺服器錯誤';
        }
    } catch (e) {
        if (e.name !== 'AbortError') fetchError = '連線失敗';
    }

    if (!etfData) {
        // 失敗時，拿 localStorage 舊資料墊檔
        const stockDatabase = loadStockDatabase();
        const oldData = stockDatabase[etfId];
        if (oldData) {
             etfData = {
                 name: oldData.name,
                 asOf: oldData.asOf,
                 count: oldData.count,
                 top10Weight: '--',
                 otherWeight: '--',
                 stale: true,
                 holdings: [] // 舊快取沒存完整 holdings
             };
        } else {
            document.getElementById('etf-list-container').innerHTML = `
                <div style="text-align:center; color:var(--text-light);">
                    <p style="margin-bottom:12px;">資料暫時無法取得 (${fetchError})</p>
                    <button class="btn-outline" onclick="renderEtfView('${etfId}')" style="min-height:40px; padding:0 24px;">重試</button>
                </div>
            `;
            return;
        }
    }

    // 填充資料
    document.getElementById('etf-view-name').textContent = etfData.name;
    document.getElementById('etf-view-asof').textContent = etfData.asOf;
    document.getElementById('etf-view-count').textContent = etfData.count;
    document.getElementById('etf-view-top10').textContent = etfData.top10Weight + '%';
    document.getElementById('etf-view-other').textContent = etfData.otherWeight + '%';
    
    const warnDiv = document.getElementById('etf-view-warnings');
    let msgs = etfData.warnings || [];
    if (etfData.stale) msgs.push('無法連線至伺服器，目前顯示的是上次的資料。');
    if (msgs.length > 0) {
        warnDiv.style.display = 'block';
        warnDiv.innerHTML = msgs.map(m => `<div>⚠️ ${escapeHtml(m)}</div>`).join('');
    }

    currentEtfHoldings = etfData.holdings || [];
    etfExpanded = false;
    etfSortBy = 'weight';
    refreshEtfHoldings();
}

// 成分股財報有變動（剛查詢完）時，重新計算風險、重畫摘要與清單，並更新首頁卡片用的風險摘要
function refreshEtfHoldings() {
    currentEtfHoldings = enrichEtfHoldings(currentEtfHoldings);
    const risk = computeEtfRisk(currentEtfHoldings);
    renderEtfRiskSummary(risk);
    drawEtfHoldings();
    updateQueryAllButton();

    const stockDatabase = loadStockDatabase();
    if (currentEtfHoldings.length && stockDatabase[currentEtfId] && stockDatabase[currentEtfId].isEtf) {
        stockDatabase[currentEtfId].risk = etfRiskSnapshot(risk);
        saveStockDatabase(stockDatabase);
    }
}

function updateQueryAllButton() {
    const btn = document.getElementById('etf-query-all-btn');
    const pending = currentEtfHoldings.filter(h => !h.analysis).length;
    btn.textContent = etfBatchRunning ? '停止查詢' : (pending ? `查詢全部財報（${pending} 檔未查詢）` : '成分股皆已查詢');
    btn.disabled = !etfBatchRunning && pending === 0;
}

function setEtfProgress(text) {
    const el = document.getElementById('etf-query-progress');
    el.style.display = text ? 'block' : 'none';
    el.textContent = text;
}

// 依權重由大到小，逐檔查詢尚未查詢的成分股財報（不加入自選股）；執行中再按一次即停止
async function toggleQueryAllHoldings() {
    if (etfBatchRunning) {
        etfBatchRunning = false;
        return;
    }
    const pending = currentEtfHoldings.filter(h => !h.analysis).sort((a, b) => b.weight - a.weight).map(h => h.stockId);
    if (pending.length === 0) return;
    if (!confirm(`將依權重依序查詢 ${pending.length} 檔成分股的財報（不會加入自選股），每檔約需數秒，可隨時按「停止查詢」。確定開始？`)) return;

    etfBatchRunning = true;
    updateQueryAllButton();
    const failed = [];
    let stopReason = '';

    for (let i = 0; i < pending.length && etfBatchRunning; i++) {
        setEtfProgress(`查詢中 ${i + 1} / ${pending.length}：${pending[i]}`);
        let res = await requestStock(pending[i]);
        if (res.status === 429 && res.error.includes('頻繁')) {
            setEtfProgress('請求過於頻繁，等待 60 秒後繼續…');
            await new Promise(resolve => setTimeout(resolve, 60000));
            res = await requestStock(pending[i]);
        }
        if (res.error) {
            // 額度用完、儲存空間滿、伺服器連不上時繼續也沒用，直接停止；其他（如查無財報）記錄後略過
            if (res.status === 429 || typeof res.status === 'string') {
                stopReason = res.error;
                break;
            }
            failed.push(pending[i]);
        }
        refreshEtfHoldings();
    }

    const stoppedByUser = !etfBatchRunning;
    etfBatchRunning = false;
    refreshEtfHoldings();
    const parts = [stopReason ? `已停止：${stopReason}` : (stoppedByUser ? '已手動停止' : '查詢完成')];
    if (failed.length) parts.push(`${failed.length} 檔查無財報：${failed.join('、')}`);
    setEtfProgress(parts.join('；'));
}

// 為成分股補上公司類型與風險分析：優先用本機剛查詢的財報，其次用後端 Supabase 已存的財報
function enrichEtfHoldings(holdings) {
    const stockDatabase = loadStockDatabase();
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    return holdings.map(h => {
        const analysis = analyzeData(h.stockId, stockDatabase[h.stockId]) || analyzeData(h.stockId, h.financials);
        const typeKey = analysis ? analysis.effectiveType : (overrides[h.stockId] || getDefaultCompanyType(h.industries, false));
        const industry = pickIndustry(analysis ? getIndustries(analysis.data) : h.industries);
        return { ...h, typeKey, industry, analysis };
    });
}

// ETF 整體判斷門檻（權重 %）
const ETF_RISK_CONFIG = {
    minCoverage: 80,   // 已查詢權重低於此值，結論標示為資料不足
    redExposure: 20,   // 紅燈公司權重達此值 → 警戒
    warnExposure: 30,  // 紅燈＋黃燈公司權重達此值 → 注意
    hhi: { moderate: 1500, high: 2500 }  // HHI 集中度分級
};

const LIGHT_LABELS = { red: '紅燈', yellow: '黃燈', green: '綠燈', none: '未查詢' };
const LIGHT_COLORS = { red: 'var(--red)', yellow: 'var(--yellow)', green: 'var(--green)', none: 'var(--border)' };

function barRow(label, value, maxValue, valueText, color = 'var(--primary)') {
    const width = maxValue > 0 ? Math.max(0, Math.min(100, value / maxValue * 100)) : 0;
    return `
        <div class="etf-bar-row">
          <span>${label}</span>
          <div class="etf-holding-bar-bg" style="margin-top:0;"><div class="etf-holding-bar-fill" style="width:${width}%; background:${color};"></div></div>
          <span style="text-align:right; font-weight:bold;">${valueText}</span>
        </div>`;
}

function emptyHint(text) {
    return `<p style="color:var(--text-light); font-size:0.9rem;">${text}</p>`;
}

// 計算 ETF 成分股財報風險（ETF 頁摘要與首頁卡片共用）
function computeEtfRisk(holdings) {
    const queried = holdings.filter(h => h.analysis);
    const sumWeight = list => list.reduce((sum, h) => sum + h.weight, 0);
    const totalWeight = sumWeight(holdings);
    const queriedWeight = sumWeight(queried);
    const coverage = totalWeight > 0 ? queriedWeight / totalWeight * 100 : 0;

    const lightWeights = { red: 0, yellow: 0, green: 0, none: totalWeight - queriedWeight };
    queried.forEach(h => { lightWeights[h.analysis.status] += h.weight; });

    let verdict, level, desc;
    if (coverage < ETF_RISK_CONFIG.minCoverage) {
        verdict = '資料不足'; level = null;
        desc = `已查詢的成分股僅佔權重 ${coverage.toFixed(1)}%（低於 ${ETF_RISK_CONFIG.minCoverage}%），以下數據僅供參考。可點選下方「未查詢」的成分股補齊財報。`;
    } else if (lightWeights.red >= ETF_RISK_CONFIG.redExposure) {
        verdict = '警戒'; level = 'red';
        desc = `有 ${lightWeights.red.toFixed(2)}% 的權重落在紅燈公司（門檻 ${ETF_RISK_CONFIG.redExposure}%）。`;
    } else if (lightWeights.red + lightWeights.yellow >= ETF_RISK_CONFIG.warnExposure) {
        verdict = '注意'; level = 'yellow';
        desc = `紅燈與黃燈公司合計佔權重 ${(lightWeights.red + lightWeights.yellow).toFixed(2)}%（門檻 ${ETF_RISK_CONFIG.warnExposure}%）。`;
    } else {
        verdict = '正常'; level = 'green';
        desc = `紅燈公司佔 ${lightWeights.red.toFixed(2)}%、黃燈公司佔 ${lightWeights.yellow.toFixed(2)}%，皆低於門檻。`;
    }

    // 集中度：前 1 / 前 5 大權重與 HHI（權重以 % 計，0～10000）
    const sortedWeights = holdings.map(h => h.weight).sort((a, b) => b - a);
    const hhi = Math.round(sortedWeights.reduce((sum, w) => sum + w * w, 0));
    const hhiLabel = hhi >= ETF_RISK_CONFIG.hhi.high ? '高度集中' : (hhi >= ETF_RISK_CONFIG.hhi.moderate ? '中度集中' : '分散');

    // 各項警訊曝險：觸發該警訊的公司合計權重
    const ruleMap = {};
    queried.forEach(h => {
        h.analysis.alerts.forEach(a => {
            const item = ruleMap[a.rule.name] || (ruleMap[a.rule.name] = { name: a.rule.name, weight: 0, red: false, stocks: [] });
            item.weight += h.weight;
            item.red = item.red || (a.detail.level || a.rule.level) === 'red';
            item.stocks.push(h.name);
        });
    });

    // 加權五大構面健康度（金融業不適用，不計入）
    const dimNames = ['獲利力', '成長力', '償債力', '現金流品質', '營運效率'];
    const dimTotals = dimNames.map(() => ({ score: 0, weight: 0 }));
    queried.filter(h => h.analysis.effectiveType !== 'financial').forEach(h => {
        calcHealthScores(h.analysis.data.quarters).forEach((score, i) => {
            if (score == null) return;
            dimTotals[i].score += score * h.weight;
            dimTotals[i].weight += h.weight;
        });
    });

    const typeWeights = {};
    holdings.forEach(h => { typeWeights[h.typeKey] = (typeWeights[h.typeKey] || 0) + h.weight; });

    return {
        count: holdings.length,
        queriedCount: queried.length,
        totalWeight,
        coverage,
        lightWeights,
        weightedRisk: queriedWeight > 0 ? queried.reduce((sum, h) => sum + h.weight * h.analysis.riskScore, 0) / queriedWeight : null,
        verdict, level, desc,
        hhi, hhiLabel,
        top1: sortedWeights[0] || 0,
        top5: sortedWeights.slice(0, 5).reduce((a, b) => a + b, 0),
        rules: Object.values(ruleMap).sort((a, b) => b.weight - a.weight),
        dimensions: dimNames.map((name, i) => ({ name, score: dimTotals[i].weight > 0 ? dimTotals[i].score / dimTotals[i].weight : null })),
        types: Object.entries(typeWeights).map(([type, weight]) => ({ type, weight })).sort((a, b) => b.weight - a.weight)
    };
}

// 存進瀏覽器給首頁卡片用的精簡版
function etfRiskSnapshot(risk) {
    return {
        coverage: risk.coverage, queriedCount: risk.queriedCount, count: risk.count,
        verdict: risk.verdict, level: risk.level, lightWeights: risk.lightWeights,
        weightedRisk: risk.weightedRisk, hhiLabel: risk.hhiLabel, top1: risk.top1,
        rules: risk.rules.slice(0, 3).map(({ name, weight }) => ({ name, weight }))
    };
}

function renderEtfRiskSummary(risk) {
    const { lightWeights, totalWeight } = risk;
    document.getElementById('etf-light-bar').innerHTML = Object.entries(lightWeights)
        .filter(([, w]) => w > 0)
        .map(([lvl, w]) => `<div style="width:${w / totalWeight * 100}%; background:${LIGHT_COLORS[lvl]};" title="${LIGHT_LABELS[lvl]} ${w.toFixed(2)}%"></div>`).join('');
    document.getElementById('etf-light-legend').innerHTML = Object.entries(lightWeights)
        .map(([lvl, w]) => `<span style="display:inline-flex; align-items:center; gap:6px;"><span class="dot" style="background:${LIGHT_COLORS[lvl]}; box-shadow:none;"></span>${LIGHT_LABELS[lvl]} <strong>${w.toFixed(2)}%</strong></span>`).join('');

    const dot = document.getElementById('etf-risk-dot');
    dot.className = risk.level ? `dot ${risk.level}` : 'dot';
    dot.style.background = risk.level ? '' : 'var(--text-light)';
    document.getElementById('etf-risk-verdict').textContent = risk.verdict;
    document.getElementById('etf-risk-verdict-desc').textContent = risk.desc;

    document.getElementById('etf-view-coverage').textContent = `${risk.queriedCount} / ${risk.count} 檔`;
    document.getElementById('etf-view-coverage-weight').textContent = `佔成分股權重 ${risk.coverage.toFixed(1)}%`;
    document.getElementById('etf-view-risk').textContent = risk.weightedRisk == null ? '--' : risk.weightedRisk.toFixed(1);

    document.getElementById('etf-view-concentration').textContent = risk.count ? risk.hhiLabel : '--';
    document.getElementById('etf-view-concentration-sub').textContent = risk.count
        ? `最大持股 ${risk.top1.toFixed(2)}%・前五大 ${risk.top5.toFixed(2)}%・HHI ${risk.hhi}`
        : '';

    document.getElementById('etf-rule-exposure').innerHTML = risk.rules.length === 0
        ? emptyHint(risk.queriedCount ? '已查詢的成分股皆未觸發警訊。' : '尚無已查詢的成分股。')
        : risk.rules.map(item =>
            barRow(item.name, item.weight, 100, `${item.weight.toFixed(2)}%`, item.red ? 'var(--red)' : 'var(--yellow)') +
            `<div style="color:var(--text-light); font-size:0.8rem; margin:-2px 0 10px 0;">${escapeHtml(item.stocks.join('、'))}</div>`
          ).join('');

    document.getElementById('etf-dimension-scores').innerHTML = risk.dimensions.some(d => d.score != null)
        ? risk.dimensions.map(d => {
            if (d.score == null) return barRow(d.name, 0, 100, '資料不足');
            const color = d.score < 40 ? 'var(--red)' : (d.score > 70 ? 'var(--green)' : 'var(--primary)');
            return barRow(d.name, d.score, 100, `${d.score.toFixed(0)} 分`, color);
          }).join('')
        : emptyHint('尚無可計算的成分股（金融業不適用）。');

    const maxTypeWeight = Math.max(...risk.types.map(t => t.weight), 1);
    document.getElementById('etf-view-types').innerHTML = risk.types
        .map(t => barRow(TYPE_PROFILES[t.type].label, t.weight, maxTypeWeight, `${t.weight.toFixed(2)}%`)).join('');
}

function changeEtfSort(val) {
    etfSortBy = val;
    drawEtfHoldings();
}

function toggleEtfExpand() {
    etfExpanded = !etfExpanded;
    drawEtfHoldings();
}

function drawEtfHoldings() {
    const container = document.getElementById('etf-list-container');
    const moreContainer = document.getElementById('etf-more-container');
    const moreBtn = document.getElementById('etf-more-btn');
    container.innerHTML = '';
    
    if (currentEtfHoldings.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-light);">無成分股資料</p>';
        moreContainer.style.display = 'none';
        return;
    }

    let items = [...currentEtfHoldings];
    if (etfSortBy === 'id') {
        items.sort((a, b) => a.stockId.localeCompare(b.stockId));
    } else if (etfSortBy === 'risk') {
        // 已查詢的依風險高到低，未查詢的排在後面
        const riskOf = h => h.analysis ? h.analysis.riskScore : -1;
        items.sort((a, b) => riskOf(b) - riskOf(a) || b.weight - a.weight);
    } else {
        items.sort((a, b) => b.weight - a.weight);
    }

    const maxVisible = 10;
    const isOverLimit = items.length > maxVisible;
    const displayItems = (isOverLimit && !etfExpanded) ? items.slice(0, maxVisible) : items;
    
    let maxWeight = Math.max(...items.map(i => i.weight));
    if (maxWeight <= 0) maxWeight = 100;

    displayItems.forEach((h, index) => {
        const row = document.createElement('a');
        row.className = 'etf-holding-row';
        
        // 驗證代號，合法才給連結
        if (/^[0-9]{4,6}$/.test(h.stockId)) {
             row.href = `details.html?id=${h.stockId}&from=${currentEtfId}`;
        }
        
        const rankDiv = document.createElement('div');
        rankDiv.style.color = 'var(--text-light)';
        rankDiv.textContent = `#${index + 1}`;
        
        const idDiv = document.createElement('div');
        idDiv.style.fontWeight = 'bold';
        idDiv.textContent = h.stockId;
        
        const nameDiv = document.createElement('div');
        nameDiv.style.minWidth = '0';
        const nameText = document.createElement('div');
        nameText.textContent = h.name;
        const typeText = document.createElement('div');
        typeText.style.cssText = 'font-size:0.8rem; color:var(--text-light); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        typeText.textContent = [h.industry, TYPE_PROFILES[h.typeKey].label].filter(Boolean).join(' · ');
        nameDiv.appendChild(nameText);
        nameDiv.appendChild(typeText);
        
        const wContainer = document.createElement('div');
        wContainer.style.textAlign = 'right';
        const wText = document.createElement('div');
        wText.style.fontWeight = 'bold';
        wText.textContent = `${h.weight}%`;
        const barBg = document.createElement('div');
        barBg.className = 'etf-holding-bar-bg';
        const barFill = document.createElement('div');
        barFill.className = 'etf-holding-bar-fill';
        barFill.style.width = `${(h.weight / maxWeight) * 100}%`;
        barBg.appendChild(barFill);
        wContainer.appendChild(wText);
        wContainer.appendChild(barBg);
        
        row.appendChild(rankDiv);
        row.appendChild(idDiv);
        row.appendChild(nameDiv);
        row.appendChild(wContainer);
        row.appendChild(createRiskCell(h));
        
        container.appendChild(row);
    });

    if (isOverLimit) {
        moreContainer.style.display = 'block';
        if (etfExpanded) {
            moreBtn.textContent = '收合';
        } else {
            moreBtn.textContent = `顯示更多（還有 ${items.length - maxVisible} 檔）`;
        }
    } else {
        moreContainer.style.display = 'none';
    }
}


// 已查詢：燈號＋風險分數；未查詢：「查詢」按鈕，只查財報不加入自選股
function createRiskCell(holding) {
    const cell = document.createElement('div');
    cell.className = 'etf-holding-risk';
    const analysis = holding.analysis;
    if (!analysis) {
        const btn = document.createElement('button');
        btn.className = 'btn-outline';
        btn.style.cssText = 'padding:4px 10px; font-size:0.8rem;';
        btn.textContent = '查詢';
        btn.onclick = async (event) => {
            event.preventDefault();  // 按鈕在連結列裡，避免觸發換頁
            event.stopPropagation();
            btn.disabled = true;
            btn.textContent = '查詢中…';
            const { error } = await requestStock(holding.stockId);
            if (error) alert(`${holding.stockId}：${error}`);
            refreshEtfHoldings();
        };
        cell.appendChild(btn);
        return cell;
    }
    const dot = document.createElement('span');
    dot.className = `dot ${analysis.status}`;
    const score = document.createElement('span');
    score.textContent = `風險 ${analysis.riskScore}`;
    cell.title = `${analysis.alerts.length} 項警訊`;
    cell.appendChild(dot);
    cell.appendChild(score);
    return cell;
}

// --- 詳情頁：預覽模式 (不在自選股的一般股票) ---
async function startPreviewMode(stockId, fromEtfId) {
    // fromEtfId 來自網址參數，會被拼進 HTML 與 onclick，不合格式一律丟棄
    const fromPortfolio = fromEtfId === 'portfolio';
    const fromRec = fromEtfId === 'rec';
    if (!isEtfId(fromEtfId)) fromEtfId = '';
    const banner = document.getElementById('preview-banner');
    const content = document.getElementById('detail-content');
    const listView = document.getElementById('detail-list-view');
    const etfView = document.getElementById('etf-view');
    const stockDatabase = loadStockDatabase();
    
    listView.style.display = 'none';
    etfView.style.display = 'none';
    
    banner.style.display = 'block';
    banner.className = 'card';
    banner.style.borderTop = '4px solid var(--primary)';
    
    let backLink = '';
    if (fromEtfId) {
        backLink = `<a href="details.html?id=${fromEtfId}" style="margin-right:16px;">← 返回 ${fromEtfId} 成分股</a>`;
    } else if (fromPortfolio) {
        backLink = `<a href="portfolio.html" style="margin-right:16px;">← 返回投資組合健檢</a>`;
    } else if (fromRec) {
        backLink = `<a href="#" onclick="history.back(); return false;" style="margin-right:16px;">← 返回上一頁</a>`;
    }
    
    banner.innerHTML = `
       <div class="flex-between" style="flex-wrap:wrap; gap:12px;">
          <div>
            <h3 style="margin:0 0 4px 0;">預覽模式</h3>
            <p style="margin:0; font-size:0.9rem; color:var(--text-light);">此股票尚未加入你的自選股</p>
          </div>
          <div style="display:flex; align-items:center;">
            ${backLink}
            <button class="btn-primary" onclick="addPreviewToPortfolio('${stockId}')" style="min-height:40px;">加入自選股</button>
          </div>
       </div>
    `;

    // 建立獨立的 loading/error 容器，避免破壞 detail-content
    let statusDiv = document.getElementById('preview-status-div');
    if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.id = 'preview-status-div';
        content.parentNode.insertBefore(statusDiv, content);
    }
    statusDiv.style.display = 'none';
    content.style.display = 'none';

    if (!stockDatabase[stockId]) {
        statusDiv.style.display = 'block';
        statusDiv.innerHTML = '<div class="card"><p style="text-align:center; padding:40px; color:var(--text-light);">資料載入中…</p></div>';

        const { error } = await requestStock(stockId);
        if (error) {
            statusDiv.innerHTML = `
                <div class="card" style="text-align:center; padding:40px;">
                    <p style="margin-bottom:12px; color:var(--red);">${escapeHtml(error)}</p>
                    <button class="btn-outline" onclick="startPreviewMode('${stockId}', '${fromEtfId}')">重試</button>
                </div>`;
            return;
        }
        statusDiv.style.display = 'none';
    }

    if (!analyzeStock(stockId)) {
        statusDiv.style.display = 'block';
        statusDiv.innerHTML = '<div class="card"><p style="text-align:center; padding:40px; color:var(--text-light);">此股票暫無財報資料</p></div>';
        return;
    }
    
    // 資料就緒，渲染圖表
    loadDetailView(stockId);
    switchDetailTab('income');
}

function addPreviewToPortfolio(stockId) {
    if (!portfolio.includes(stockId)) {
        portfolio.push(stockId);
        savePortfolio();
    }
    updateDetailSelect();
    document.getElementById('preview-banner').style.display = 'none';
    alert('✅ 已成功加入自選股');
}