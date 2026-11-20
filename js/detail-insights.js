// ==========================================
// 個股詳情：「🏭 產業關鍵指標與同業比較」與「🧭 領先指標與驗證」
// 分析主軸：落後指標（財報）避開雷區 → 放進產業脈絡 → 領先指標提早看到變化 → 驗證領先指標是否真的反映在之後的財報
// 資料：後端 /api/industry/<代號>、/api/leading/<代號>（insights.py）
// 本區塊不計入燈號與風險分數；訊號只代表「需要留意的變化」，不是買賣建議
// ==========================================

const DIN = { industry: {}, leading: {}, ctrl: { industry: null, leading: null }, currentId: null, failed: {} };

function dinNum(v, unit = '') {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 1 })}${unit}`;
}

function dinLoading(el, what) {
  const waiting = typeof isBackendReady === 'function' && !isBackendReady();
  el.innerHTML = `<p class="pf-muted">${waiting ? `等待主機喚醒（約 1 分鐘），醒來後會自動載入${what}…` : `${what}載入中…`}</p>`;
}

async function dinFetch(kind, stockId, url, el, what, render) {
  if (DIN.ctrl[kind]) DIN.ctrl[kind].abort();
  const ctrl = DIN.ctrl[kind] = new AbortController();
  dinLoading(el, what);
  if (typeof whenBackendReady === 'function') await whenBackendReady();
  if (ctrl.signal.aborted || DIN.currentId !== stockId) return null;
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(httpErrorReason(res.status, data));
    delete DIN.failed[kind];
    return data;
  } catch (err) {
    if (DIN.currentId !== stockId || ctrl !== DIN.ctrl[kind]) return null;
    DIN.failed[kind] = stockId;
    const reason = err.name === 'AbortError' ? '連線逾時，主機可能正在喚醒' : fetchErrorReason(err);
    el.innerHTML = `<p class="pf-muted">${what}無法取得：${escapeHtml(reason)}
      <button class="btn-outline" style="margin-left:8px;" onclick="${render}('${stockId}', true)">重試</button></p>`;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 由 app.js 的 loadDetailView 呼叫
function loadInsights(stockId, analysis) {
  DIN.currentId = stockId;
  loadIndustryCompare(stockId, false, analysis);
  loadLeadingSignals(stockId, false);
}

// ---------------- 產業關鍵指標與同業比較 ----------------
async function loadIndustryCompare(stockId, force, analysis) {
  const el = document.getElementById('industry-body');
  if (!el) return;
  analysis = analysis || window.currentAnalysis;
  if (!analysis) return;
  const type = analysis.effectiveType || 'general';
  const industry = typeof pickIndustry === 'function' ? pickIndustry(getIndustries(analysis.data)) : '';
  const key = `${stockId}|${type}|${industry}`;
  if (!force && DIN.industry[key]) { renderIndustryCompare(DIN.industry[key], type); return; }
  const url = `${API_BASE}/api/industry/${encodeURIComponent(stockId)}?type=${encodeURIComponent(type)}&industry=${encodeURIComponent(industry)}`;
  const data = await dinFetch('industry', stockId, url, el, '同業比較', 'loadIndustryCompare');
  if (!data) return;
  DIN.industry[key] = data;
  if (DIN.currentId === stockId) renderIndustryCompare(data, type);
}

function dinRankCell(k) {
  if (k.value === null) return '<span class="pf-muted">資料不足</span>';
  if (k.n <= 1 || k.rank === null) return '<span class="pf-muted">沒有同業可比</span>';
  const text = `第 ${k.rank} / ${k.n} 名`;
  if (k.better === 'info') return `${text} <span class="pf-muted">（由高到低，高低沒有好壞）</span>`;
  const p = k.percentile;
  const cls = p >= 67 ? 'pf-good' : (p <= 33 ? 'pf-bad' : 'pf-mid');
  const word = p >= 67 ? '同業前段' : (p <= 33 ? '同業後段' : '同業中段');
  return `<span class="${cls}">${text}・${word}</span>`;
}

function renderIndustryCompare(data, type) {
  const el = document.getElementById('industry-body');
  const foot = document.getElementById('industry-foot');
  if (!el) return;
  const typeLabel = (TYPE_PROFILES[type] || TYPE_PROFILES.general).label;
  const rows = data.kpis.map(k => {
    const dir = k.better === 'high' ? '越高越好' : (k.better === 'low' ? '越低越好' : '高低沒有好壞');
    const best = k.best && k.n > 1 ? `${escapeHtml(k.best.name || k.best.id)} ${dinNum(k.best.value, k.unit)}` : '—';
    return `<tr>
      <td>${escapeHtml(k.label)}<br><span class="pf-muted">${dir}</span></td>
      <td class="num"><strong>${dinNum(k.value, k.unit)}</strong></td>
      <td class="num">${k.n > 1 ? dinNum(k.median, k.unit) : '—'}</td>
      <td>${dinRankCell(k)}</td>
      <td class="din-best">${best}</td>
    </tr>`;
  }).join('');

  const few = data.peerCount < 3;
  const peers = data.peers.length
    ? `<details class="din-details"><summary>比較對象（${data.peerCount} 家）</summary><p class="pf-muted">${data.peers.map(p => `${escapeHtml(p.id)} ${escapeHtml(p.name)}`).join('、')}${data.peerCount > data.peers.length ? ' …' : ''}</p></details>`
    : '';

  el.innerHTML = `
    <p class="din-focus"><strong>${escapeHtml(typeLabel)}看什麼：</strong>${escapeHtml(data.focus)}</p>
    <div class="table-responsive"><table class="pf-table din-table">
      <thead><tr><th>關鍵指標</th><th class="num">本公司</th><th class="num">同業中位數</th><th>同業排名</th><th class="din-best">同業最佳</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${few ? `<p class="pf-muted" style="margin-top:8px;">${data.dbAvailable ? '資料庫裡的同產業公司還不多，排名參考性有限；查詢更多同產業公司後會自動納入比較（每 6 小時更新一次）。' : '資料庫未連線，無法比較同業。'}</p>` : ''}
    ${peers}`;
  if (foot) {
    foot.innerHTML = `同業：產業別「${escapeHtml(data.industry || '—')}」中、資料庫已有財報的 ${data.peerCount} 家公司${data.industryTotal ? `（同產業共 ${data.industryTotal} 家）` : ''}。
      公司類型依「目前判定類型」決定要看哪些指標，可在上方總覽更改。資料品質有疑慮的季度（資產負債不平、利潤率超出 ±100% 等）不納入計算。
      排名只代表相對位置，不代表好壞判決，也不構成投資建議。`;
  }
}

// ---------------- 領先指標與驗證 ----------------
async function loadLeadingSignals(stockId, force) {
  const el = document.getElementById('leading-body');
  if (!el) return;
  if (!force && DIN.leading[stockId]) { renderLeadingSignals(DIN.leading[stockId]); return; }
  const data = await dinFetch('leading', stockId, `${API_BASE}/api/leading/${encodeURIComponent(stockId)}`, el, '領先指標', 'loadLeadingSignals');
  if (!data) return;
  DIN.leading[stockId] = data;
  if (DIN.currentId === stockId) renderLeadingSignals(data);
}

function dinDirBadge(meta) {
  return meta.direction === 'positive'
    ? '<span class="din-badge din-pos">留意改善</span>'
    : '<span class="din-badge din-neg">留意轉弱</span>';
}

// 一行回測摘要：命中率 vs. 沒有訊號時的基準
function dinStatLine(label, st) {
  if (!st || !st.events) return `${label}：歷史上沒有出現過`;
  if (!st.evaluated) return `${label}：出現 ${st.events} 次，之後的財報還沒公布，無法驗證`;
  const lift = st.baseRate !== null ? st.hitRate - st.baseRate : null;
  const cls = lift === null ? '' : (lift >= 10 ? 'pf-good' : (lift <= -10 ? 'pf-bad' : 'pf-mid'));
  const verdict = lift === null ? '' : (lift >= 10 ? '比基準準' : (lift <= -10 ? '比基準差' : '和基準差不多'));
  return `${label}：可驗證 ${st.evaluated} 次、應驗 ${st.hits} 次（<strong>${st.hitRate}%</strong>），沒有訊號時的基準 ${st.baseRate ?? '—'}%
    ${verdict ? `<span class="${cls}">・${verdict}</span>` : ''}${st.smallSample ? ' <span class="pf-muted">（樣本少於 5 次，僅供參考）</span>' : ''}`;
}

function renderLeadingSignals(data) {
  const el = document.getElementById('leading-body');
  const foot = document.getElementById('leading-foot');
  if (!el) return;
  const meta = data.meta;
  const agg = data.industryBacktest;
  const periodText = (key, p) => meta[key].freq === 'month' ? `${p} 月營收` : `${p} 財報`;

  const active = data.active.length ? data.active.map(a => {
    const m = meta[a.key];
    return `<li class="din-signal">
      <div class="din-signal-head">${dinDirBadge(m)} <strong>${escapeHtml(m.name)}</strong>
        ${a.isNew ? '<span class="data-tag leading">本期新出現</span>' : ''}
        <span class="pf-muted">${periodText(a.key, a.period)}（${a.availableDate} 公布）</span></div>
      <div>${escapeHtml(a.detail)}</div>
      <div class="pf-muted">${escapeHtml(m.why)}</div>
      <div class="din-stat">驗證方式：${escapeHtml(m.test)}<br>
        ${dinStatLine('這家公司過去', data.backtest[a.key])}
        ${agg ? `<br>${dinStatLine(`同產業 ${agg.stocks} 家合計`, agg.byKey[a.key])}` : ''}</div>
    </li>`;
  }).join('') : '<li class="pf-muted">最新一期資料沒有偵測到領先訊號。</li>';

  const tableRows = (data.order || Object.keys(meta)).filter(key => meta[key]).map(key => {
    const m = meta[key];
    const own = data.backtest[key];
    const ind = agg ? agg.byKey[key] : null;
    const cell = st => !st || !st.evaluated ? `<span class="pf-muted">${st && st.events ? `出現 ${st.events} 次，待驗證` : '未出現'}</span>`
      : `${st.hits}/${st.evaluated}（${st.hitRate}%）<span class="pf-muted">・基準 ${st.baseRate ?? '—'}%</span>`;
    const lead = (ind && ind.avgLeadMonths) || own.avgLeadMonths;
    return `<tr>
      <td>${escapeHtml(m.name)}<br>${dinDirBadge(m)}</td>
      <td>${cell(own)}</td>
      ${agg ? `<td>${cell(ind)}</td>` : ''}
      <td class="num">${lead ? `${lead} 個月` : '—'}</td>
    </tr>`;
  }).join('');

  const statusText = e => {
    if (e.status === 'pending') return `<span class="pf-muted">待驗證：等 ${e.waitFor} 財報（約 ${e.waitDate} 前公布）</span>`;
    const ev = e.eval;
    const change = `訊號前 ${ev.before}，訊號後 ${ev.after}`;
    return e.status === 'hit' ? `<span class="pf-good">已應驗</span> <span class="pf-muted">${change}</span>`
      : `<span class="pf-bad">未應驗</span> <span class="pf-muted">${change}</span>`;
  };
  const log = data.log.length ? `<ul class="din-log">${data.log.map(e => {
    const m = meta[e.key];
    return `<li><span class="pf-muted">${e.firstSeen} 首次看到</span>・${escapeHtml(m.name)}（${periodText(e.key, e.period)}）・${statusText(e)}</li>`;
  }).join('')}</ul>` : '<p class="pf-muted">還沒有紀錄。從現在開始，每次看到新的訊號都會連同日期存下來，之後用公布的財報驗證。</p>';

  el.innerHTML = `
    <h4 class="pf-h">目前的訊號 <span class="pf-muted">（資料到 ${data.asOf.month || '—'} 月營收、${data.asOf.quarter || '—'} 財報）</span></h4>
    <ul class="din-signals">${active}</ul>

    <h4 class="pf-h">各訊號的歷史驗證</h4>
    <div class="table-responsive"><table class="pf-table din-table">
      <thead><tr><th>訊號</th><th>這家公司（應驗/可驗證）</th>${agg ? `<th>同產業 ${agg.stocks} 家合計</th>` : ''}<th class="num">平均提前</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
    <p class="pf-muted" style="margin-top:6px;">「基準」是沒有訊號時，之後的財報也朝同一方向變化的比例。命中率要明顯高於基準，訊號才有參考價值。
      「平均提前」是訊號公布到可以驗證的最後一份財報公布之間的月數。</p>

    <h4 class="pf-h">訊號紀錄 <span class="pf-muted">（按首次看到的日期保存${data.logStored ? '' : '；資料庫未連線，重新啟動後會消失'}）</span></h4>
    ${log}`;
  if (foot) {
    foot.innerHTML = `回測用每個時間點「當時已公布」的資料判斷訊號，不使用未來資料；但歷史財報是目前的版本，若公司重編過財報，和當時看到的數字可能略有不同，
      因此另外保存「首次看到」的紀錄做真正的事後驗證。領先指標先從結構化資料（月營收、合約負債、存貨、資本支出）做起，
      新聞全文與影音等非結構化資料，等這些訊號驗證有效後再加入。訊號只代表需要留意的變化，不是買賣建議，也不構成投資建議。`;
  }
}

// 主機（重新）醒來後：補抓先前失敗的資料
window.addEventListener('backendready', () => {
  const id = DIN.currentId;
  if (!id) return;
  if (DIN.failed.industry === id) loadIndustryCompare(id, true);
  if (DIN.failed.leading === id) loadLeadingSignals(id, true);
});
