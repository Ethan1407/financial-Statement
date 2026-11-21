// ==========================================
// 個股詳情：「🧮 獲利品質與財務體質」「💰 配息」「📊 籌碼面」
// - 獲利品質：ROE、杜邦分析、Piotroski F-score、Beneish M-score、Altman Z-score、現金轉換循環（後端 metrics.py 算好附在每一季）
// - 配息：盈餘分配率、自由現金流涵蓋率、連續配息年數、填息天數（填息來自 /api/prices/valuation）
// - 籌碼面：三大法人、融資融券、外資持股（/api/chips），只顯示趨勢，不計入燈號
// ==========================================

const DEX = { chips: {}, chipsCtrl: null, chipsFailed: null, currentId: null };

function dexNum(v, digits = 1, unit = '') {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return `${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}${unit}`;
}
function dexSigned(v, unit = '') {
  if (v === null || v === undefined) return '—';
  const cls = v > 0 ? 'px-up' : (v < 0 ? 'px-down' : '');
  return `<span class="${cls}">${v > 0 ? '+' : ''}${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}${unit}</span>`;
}

// 由 app.js 的 loadDetailView 呼叫
function loadDetailExtras(stockId, analysis, skipNews) {
  DEX.currentId = stockId;
  renderQualityCard(stockId, analysis);
  renderDividendCard(stockId, analysis);
  if (!skipNews || !DEX.chips[stockId]) loadChips(stockId);
}

// ---------------- 獲利品質與財務體質 ----------------
const F_LABELS = {
  roaPositive: 'ROA 為正', cfoPositive: '營業現金流為正', roaUp: 'ROA 比去年同期高', accrual: '營業現金流大於淨利',
  leverageDown: '長期負債比沒有上升', liquidityUp: '流動比率比去年同期高', noIssuance: '沒有現金增資發行新股',
  marginUp: '毛利率比去年同期高', turnoverUp: '資產週轉率比去年同期高'
};

function dexRoeText(q) {
  if (q.roeStatus === 'loss') return '<span class="pf-bad">虧損</span>';
  if (q.roeStatus === 'negEquity') return '<span class="pf-bad">權益為負</span>';
  return dexNum(q.roe, 1, '%');
}

function renderQualityCard(stockId, analysis) {
  const el = document.getElementById('quality-body');
  if (!el || !analysis) return;
  const qs = analysis.data.quarters || [];
  const latest = qs[qs.length - 1];
  if (!latest || latest.roeStatus === undefined) {
    el.innerHTML = '<p class="pf-muted">這份財報資料是舊版本，按右上角「更新」重新查詢後就會顯示 ROE、F-score 等指標。</p>';
    return;
  }
  const isFin = analysis.effectiveType === 'financial';
  const recent = qs.slice(-8).reverse();

  // ROE 與杜邦
  const dupontRows = recent.map(q => `<tr><td>${q.q}</td><td class="num"><strong>${dexRoeText(q)}</strong></td>
    <td class="num">${dexNum(q.netMarginTTM, 1, '%')}</td><td class="num">${dexNum(q.assetTurnover, 2, ' 次')}</td>
    <td class="num">${dexNum(q.equityMultiplier, 2, ' 倍')}</td><td class="num">${dexNum(q.roa, 1, '%')}</td></tr>`).join('');
  let roeRead = '';
  if (latest.roeStatus === 'ok') {
    const lev = latest.equityMultiplier >= 3;
    roeRead = `最新 ROE ${latest.roe}% = 淨利率 ${latest.netMarginTTM}% × 資產週轉 ${latest.assetTurnover} 次 × 權益乘數 ${latest.equityMultiplier} 倍。
      ${isFin ? '金融業以高槓桿經營，權益乘數 10 倍以上屬常態。' : (lev ? '<span class="pf-mid">權益乘數偏高，報酬有一部分來自借錢擴大規模。</span>' : '槓桿不高，報酬主要來自本業。')}`;
  } else if (latest.roeStatus === 'loss') {
    roeRead = '近 4 季合計虧損，ROE 為負，不拿來和其他公司比較。';
  } else if (latest.roeStatus === 'negEquity') {
    roeRead = '<span class="pf-bad">股東權益為負（資不抵債）</span>，ROE 沒有意義。';
  }

  let html = `
    <h4 class="pf-h">① ${termHtml('ROE')} 與${termHtml('杜邦分析')}</h4>
    <p>${roeRead}</p>
    <div class="table-responsive"><table class="pf-table">
      <thead><tr><th>季度</th><th class="num">ROE</th><th class="num">淨利率</th><th class="num">${termHtml('資產週轉率')}</th><th class="num">${termHtml('權益乘數')}</th><th class="num">${termHtml('ROA')}</th></tr></thead>
      <tbody>${dupontRows}</tbody></table></div>
    <p class="pf-muted">都用近 4 季合計淨利、營收，資產與權益取期初、期末平均。</p>`;

  if (isFin) {
    html += '<p class="pf-muted" style="margin-top:12px;">金融業報表結構不同，F-score、M-score、Z-score 與現金轉換循環不適用。</p>';
    el.innerHTML = html;
    return;
  }

  // F-score
  const f = latest.fscore;
  if (f) {
    const items = f.items.map(i => `<li>${i.pass === true ? '<span class="pf-good">✓</span>' : (i.pass === false ? '<span class="pf-bad">✗</span>' : '<span class="pf-muted">—</span>')} ${F_LABELS[i.key]}</li>`).join('');
    const cls = f.score >= 7 ? 'pf-good' : (f.score <= 3 ? 'pf-bad' : 'pf-mid');
    html += `<h4 class="pf-h">② 財務體質（${termHtml('F-score')}）：<span class="${cls}">${f.score} / ${f.n} 分</span>${f.n < 9 ? `<span class="pf-muted">（${9 - f.n} 項資料不足）</span>` : ''}</h4>
      <ul class="dex-checks">${items}</ul>
      <p class="pf-muted">和去年同期比較。燈號在抓壞訊號，F-score 是加分項目，兩者互補；7 分以上體質改善、3 分以下偏弱。原始研究的樣本是低股價淨值比的股票，分數高不代表股價一定會漲。</p>`;
  }

  // 地雷股指標
  const m = latest.mscore;
  const ctx = { market: typeof loadMarketRisk === 'function' ? loadMarketRisk()[stockId] : null, effectiveType: analysis.effectiveType };
  const z = typeof altmanZFor === 'function' ? altmanZFor(latest, ctx) : null;
  const zoneText = { distress: '<span class="pf-bad">危險區</span>', grey: '<span class="pf-mid">灰色地帶</span>', safe: '<span class="pf-good">安全區</span>' };
  html += `<h4 class="pf-h">③ 地雷股指標</h4>
    <ul class="pf-list">
      <li>${termHtml('M-score')}：${m ? `<strong>${m.score}</strong>（${m.score > -1.78 ? '<span class="pf-bad">高於 −1.78，財報可能被美化</span>' : '<span class="pf-good">低於 −1.78</span>'}）` : '<span class="pf-muted">資料不足</span>'}
        ${m ? `<details class="din-details"><summary>8 個變數</summary><p class="pf-muted">${Object.entries(m.components).map(([k, v]) => `${k} ${v}`).join('、')}（1 代表和去年相同；應計項目 TATA 越大越可疑）</p></details>` : ''}</li>
      <li>${termHtml('Z-score')}：${z ? `${z.label} <strong>${z.value}</strong>（${zoneText[z.zone]}；危險 &lt; ${z.distress}、安全 &gt; ${z.safe}）` : '<span class="pf-muted">資料不足</span>'}
        ${z && z.label === "Z''-score" && ['electronics', 'cyclical'].includes(analysis.effectiveType) ? '<span class="pf-muted">（還沒有市值資料，暫用非製造業版本）</span>' : ''}</li>
    </ul>
    <p class="pf-muted">兩個模型都以美國公司建立，只當輔助訊號；Z-score 可和上方「股價與基本面」的違約距離互相印證。</p>`;

  // 現金轉換循環
  const cccRows = recent.map(q => `<tr><td>${q.q}</td><td class="num">${dexNum(q.arDays, 0)}</td><td class="num">${q.invDays ? dexNum(q.invDays, 0) : '—'}</td>
    <td class="num">${dexNum(q.apDays, 0)}</td><td class="num"><strong>${dexNum(q.ccc, 0)}</strong></td></tr>`).join('');
  html += `<h4 class="pf-h">④ ${termHtml('現金轉換循環')}（天）</h4>
    <div class="table-responsive"><table class="pf-table">
      <thead><tr><th>季度</th><th class="num">應收天數</th><th class="num">存貨天數</th><th class="num">${termHtml('應付天數')}</th><th class="num">現金轉換循環</th></tr></thead>
      <tbody>${cccRows}</tbody></table></div>
    <p class="pf-muted">應收 + 存貨 − 應付。和去年同季比較才能避開淡旺季；營建業存貨週期長，數字天生很大。</p>`;
  el.innerHTML = html;
}

// ---------------- 配息 ----------------
function renderDividendCard(stockId, analysis) {
  const el = document.getElementById('dividend-body');
  if (!el || !analysis) return;
  const div = analysis.data.dividends;
  if (!div) {
    el.innerHTML = '<p class="pf-muted">這份財報資料是舊版本，按右上角「更新」重新查詢後就會顯示配息紀錄。</p>';
    return;
  }
  if (!div.years.length) {
    el.innerHTML = '<p class="pf-muted">近年沒有配發股利的紀錄。</p>';
    return;
  }
  const rows = div.years.slice().reverse().map(y => {
    const payout = y.lossPayout ? '<span class="pf-bad">虧損仍配息</span>'
      : (y.payout == null ? '—' : `<span class="${y.payout > 100 ? 'pf-bad' : (y.payout > 80 ? 'pf-mid' : '')}">${y.payout}%</span>`);
    const cover = y.fcfCover == null ? '—' : `<span class="${y.fcfCover < 1 ? 'pf-bad' : 'pf-good'}">${y.fcfCover} 倍</span>`;
    return `<tr><td>${y.year}${y.complete ? '' : `<br><span class="pf-muted">已公布 ${y.periods}/${y.expected} 期</span>`}</td>
      <td class="num">${dexNum(y.cash, 2, ' 元')}</td><td class="num">${y.stock ? dexNum(y.stock, 2, ' 元') : '—'}</td>
      <td class="num">${dexNum(y.eps, 2, ' 元')}</td><td class="num">${payout}</td><td class="num">${cover}</td></tr>`;
  }).join('');

  const fill = (typeof DPF !== 'undefined' && DPF.cache[stockId] && DPF.cache[stockId].dividendFill) || null;
  const fillHtml = fill === null ? '<p class="pf-muted">填息天數載入中（和股價資料一起取得）…</p>'
    : (fill.length ? `<ul class="pf-list">${fill.map(f => `<li>${f.exDate} 除權息：${f.filled
        ? `<span class="${f.days <= 30 ? 'pf-good' : ''}">${f.days} 天填息</span>（${f.fillDate} 收盤回到 ${f.refClose} 元）`
        : `<span class="pf-mid">尚未填息</span>（已 ${f.days} 天，除息前收盤 ${f.refClose} 元）`}</li>`).join('')}</ul>`
      : '<p class="pf-muted">近年沒有除權息紀錄。</p>');

  el.innerHTML = `
    <p>連續配發現金股利 <strong>${div.consecutiveYears}</strong> 年（依盈餘所屬年度計算）。</p>
    <div class="table-responsive"><table class="pf-table">
      <thead><tr><th>盈餘年度</th><th class="num">現金股利</th><th class="num">股票股利</th><th class="num">EPS</th><th class="num">${termHtml('盈餘分配率')}</th><th class="num">自由現金流 ÷ 股利</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h4 class="pf-h">${termHtml('填息')}天數</h4>${fillHtml}
    <p class="pf-muted">盈餘分配率 = 現金股利 ÷ 當年度 EPS；超過 80% 標黃、超過 100% 標紅。「自由現金流 ÷ 股利」小於 1 代表當年度賺到的現金不夠發股利。
      季配息公司要等 4 季都公布才計算整年。存股型公司會把這兩項列入燈號（見規則與說明）。殖利率是否因股價下跌而偏高，請看上方「股價與基本面」。</p>`;
}

// ---------------- 籌碼面 ----------------
async function loadChips(stockId, force) {
  const el = document.getElementById('chips-body');
  if (!el) return;
  if (!force && DEX.chips[stockId]) { renderChips(DEX.chips[stockId]); return; }
  if (DEX.chipsCtrl) DEX.chipsCtrl.abort();
  const ctrl = DEX.chipsCtrl = new AbortController();
  const waiting = typeof isBackendReady === 'function' && !isBackendReady();
  el.innerHTML = `<p class="pf-muted">${waiting ? '等待主機喚醒（約 1 分鐘），醒來後會自動載入籌碼資料…' : '籌碼資料載入中…'}</p>`;
  if (typeof whenBackendReady === 'function') await whenBackendReady();
  if (ctrl.signal.aborted || DEX.currentId !== stockId) return;
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${API_BASE}/api/chips/${encodeURIComponent(stockId)}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(httpErrorReason(res.status, data));
    DEX.chips[stockId] = data;
    DEX.chipsFailed = null;
    if (DEX.currentId === stockId) renderChips(data);
  } catch (err) {
    if (DEX.currentId !== stockId || ctrl !== DEX.chipsCtrl) return;
    DEX.chipsFailed = stockId;
    const reason = err.name === 'AbortError' ? '連線逾時，主機可能正在喚醒' : fetchErrorReason(err);
    el.innerHTML = `<p class="pf-muted">籌碼資料無法取得：${escapeHtml(reason)}
      <button class="btn-outline" style="margin-left:8px;" onclick="loadChips('${stockId}', true)">重試</button></p>`;
  } finally {
    clearTimeout(timer);
  }
}

function renderChips(data) {
  const el = document.getElementById('chips-body');
  if (!el) return;
  const s = data.summary;
  const rows = Object.values(s.net).map(n => `<tr><td>${n.label}</td><td class="num">${dexSigned(n.d5)}</td><td class="num">${dexSigned(n.d20)}</td><td class="num">${dexSigned(n.d60)}</td></tr>`).join('');
  el.innerHTML = `
    <h4 class="pf-h">三大法人買賣超（張）</h4>
    <div class="table-responsive"><table class="pf-table">
      <thead><tr><th>法人</th><th class="num">近 5 日</th><th class="num">近 20 日</th><th class="num">近 60 日</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <ul class="pf-list" style="margin-top:8px;">
      <li>融資餘額 ${dexNum(s.margin.last, 0, ' 張')}（近 20 日 ${dexSigned(s.margin.chg20, ' 張')}）</li>
      <li>融券餘額 ${dexNum(s.short.last, 0, ' 張')}（近 20 日 ${dexSigned(s.short.chg20, ' 張')}）</li>
      <li>外資持股比例 ${dexNum(s.foreignRatio.last, 2, '%')}（近 20 日 ${dexSigned(s.foreignRatio.chg20, ' 個百分點')}）</li>
    </ul>
    <p class="pf-muted">資料到 ${escapeHtml(data.lastDate || '—')}，來源：證交所、櫃買中心（經 FinMind）。籌碼面只反映短期資金動向，不宜單獨判斷，因此不列入燈號與風險分數。
      集保大戶持股比例需要付費資料，目前沒有提供。</p>`;
}

// 股價資料（含填息天數）載入後，重畫配息區塊
window.addEventListener('valuationloaded', e => {
  if (e.detail && e.detail.stockId === DEX.currentId && window.currentAnalysis) renderDividendCard(DEX.currentId, window.currentAnalysis);
});
window.addEventListener('backendready', () => {
  if (DEX.chipsFailed && DEX.chipsFailed === DEX.currentId) loadChips(DEX.currentId, true);
});
