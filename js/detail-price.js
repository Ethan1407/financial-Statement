// ==========================================
// 個股詳情「💹 股價與基本面」：把股價和財報放在一起看
// 依據（專業投資人常用的做法）：
// 1. 估值和自己的歷史比：CFA Institute 估值教材，本益比、股價淨值比、殖利率可與公司自己的歷史中位數或同業比較
// 2. PEG：Peter Lynch《One Up on Wall Street》，合理價位的公司本益比約等於盈餘成長率；
//    本益比是成長率的一半很有吸引力、兩倍則非常負面
// 3. 股價是否反映獲利：Bernard & Thomas (1989, 1990) 發現股價常在財報公布後一段時間才逐步反映（近年研究認為效果變弱）
// 4. 動能：Jegadeesh & Titman (1993) 過去 3～12 個月表現好的股票之後傾向延續；George & Hwang (2004) 52 週高點
// 5. 價值＋動能並用：Asness, Moskowitz & Pedersen (2013) "Value and Momentum Everywhere"，兩者一起看比單看一種好
// 資料：後端 /api/prices/valuation/<代號>（證交所每日本益比／股價淨值比／殖利率、還原權息日 K）、
//       股價規則的結果（rules.js，資料來自 /api/prices/risk）
// 本區塊只提供分析，不另外計分；計入燈號與風險分數的只有 rules.js 的 5 條股價規則
// ==========================================

const DPF = { cache: {}, controller: null, currentId: null, riskState: {} };
const DPF_LOW_PCT = 20;   // 歷史位置五等分：最低一級（≤20%）、最高一級（≥80%），系統設定值
const DPF_HIGH_PCT = 80;

function dpfPct(v, digits = 1) {
  return v === null || v === undefined || isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;
}
function dpfDir(v) { return !v ? 'px-flat' : (v > 0 ? 'px-up' : 'px-down'); }

async function loadPriceFundamentals(stockId, analysis) {
  const body = document.getElementById('pf-body');
  if (!body) return;
  DPF.currentId = stockId;
  const more = document.getElementById('pf-more');
  if (more) more.href = `prices.html?id=${encodeURIComponent(stockId)}`;
  dpfEnsureRisk(stockId);
  if (DPF.cache[stockId]) { dpfRender(stockId, analysis, DPF.cache[stockId]); return; }

  if (DPF.controller) DPF.controller.abort();
  DPF.controller = new AbortController();
  const timer = setTimeout(() => DPF.controller.abort(), 90000);
  body.innerHTML = '<p style="color:var(--text-light);">股價資料載入中…（第一次查詢這檔需要幾秒）</p>';
  try {
    const res = await fetch(`${API_BASE}/api/prices/valuation/${encodeURIComponent(stockId)}`, { signal: DPF.controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(httpErrorReason(res.status, data));
    DPF.cache[stockId] = data;
    if (DPF.currentId === stockId) dpfRender(stockId, analysis, data);
  } catch (err) {
    if (DPF.currentId !== stockId) return;
    const reason = err.name === 'AbortError' ? '連線逾時，主機可能正在喚醒' : fetchErrorReason(err);
    body.innerHTML = `<p style="color:var(--text-light);">股價資料無法取得：${escapeHtml(reason)}
      <button class="btn-outline" style="margin-left:8px;" onclick="delete DPF.cache['${stockId}']; loadPriceFundamentals('${stockId}', window.currentAnalysis)">重試</button></p>`;
  } finally {
    clearTimeout(timer);
  }
}

// 這一檔還沒有股價規則資料時，不等背景同步，立刻單獨要這一檔（1～2 秒）；拿到後重畫燈號與本區塊
async function dpfEnsureRisk(stockId, retry = false) {
  if (typeof loadMarketRisk !== 'function' || loadMarketRisk()[stockId]) return;
  const state = DPF.riskState[stockId];
  if (!retry && state && (state.loading || state.error)) return; // 正在抓，或失敗過（等使用者按重試）
  DPF.riskState[stockId] = { loading: true };
  if (retry) dpfRerender(stockId);
  try {
    const body = await fetchMarketRisk([stockId], 60000);
    if (!loadMarketRisk()[stockId]) {
      // 後端對這檔回報錯誤（例如查無股價）：記為失敗，避免重畫後又重抓造成無限循環
      const r = body.risk && body.risk[stockId];
      throw new Error((r && r.error) || '後端沒有回傳這檔的資料');
    }
    DPF.riskState[stockId] = {};
    if (DPF.currentId === stockId) loadDetailView(stockId, true);
  } catch (err) {
    DPF.riskState[stockId] = { error: err.message };
    dpfRerender(stockId);
  }
}

function dpfRerender(stockId) {
  if (DPF.currentId === stockId && DPF.cache[stockId] && window.currentAnalysis) dpfRender(stockId, window.currentAnalysis, DPF.cache[stockId]);
}

// 近 4 季 EPS 合計相對前 4 季的成長率（需要 8 季財報）
function dpfEpsGrowth(quarters) {
  const qs = quarters || [];
  if (qs.length < 8) return null;
  const sum = arr => arr.reduce((a, q) => a + q.eps, 0);
  const last = qs.slice(-4), prev = qs.slice(-8, -4);
  if ([...last, ...prev].some(q => typeof q.eps !== 'number')) return null;
  const cur = sum(last), before = sum(prev);
  return { cur, before, growth: before > 0 ? cur / before - 1 : null };
}

// 目前數值在近 5 年的位置（0 = 歷史最低，100 = 歷史最高）
function dpfBar(pct) {
  if (pct === null || pct === undefined) return '';
  return `<div class="pf-bar" title="近 5 年中有 ${pct}% 的日子比現在低"><span style="left:${pct}%"></span></div>`;
}

function dpfValuationRow(label, term, m, unit, cheapWhenHigh) {
  if (!m || m.current === null || m.current === undefined) {
    const why = label === '本益比' ? '近 4 季虧損，證交所不計算本益比' : '沒有資料';
    return `<tr><td>${termHtml(term, label)}</td><td colspan="3" class="pf-muted">${why}</td></tr>`;
  }
  const p = m.percentile;
  let verdict = '在自己近 5 年的中段', cls = 'pf-mid';
  const high = p >= DPF_HIGH_PCT, low = p <= DPF_LOW_PCT;
  if (high || low) {
    const cheap = cheapWhenHigh ? high : low;
    verdict = `${high ? '接近近 5 年高檔' : '接近近 5 年低檔'}（${cheap ? '偏便宜' : '偏貴'}）`;
    cls = cheap ? 'pf-good' : 'pf-bad';
  }
  return `<tr>
    <td>${termHtml(term, label)}</td>
    <td class="num"><strong>${m.current}${unit}</strong></td>
    <td class="num">${m.median ?? '—'}${unit}</td>
    <td>${dpfBar(p)}<span class="${cls}">${verdict}</span> <span class="pf-muted">（比 ${p}% 的日子高）</span></td>
  </tr>`;
}

function dpfPegHtml(per, eg) {
  if (!eg) return '<p class="pf-muted">PEG：需要至少 8 季財報才能計算成長率。</p>';
  if (!per) return '<p class="pf-muted">PEG：目前沒有本益比（虧損），不適用。</p>';
  if (eg.growth === null || eg.growth <= 0) {
    return `<p>${termHtml('PEG')}：近 4 季 EPS ${eg.cur.toFixed(2)} 元，比前 4 季（${eg.before.toFixed(2)} 元）${eg.growth === null ? '無法比較' : '衰退'}，PEG 只適用於獲利成長的公司。</p>`;
  }
  const g = eg.growth * 100;
  const peg = per / g;
  let verdict, cls;
  if (peg <= 0.5) { verdict = '本益比不到成長率的一半，Lynch 認為非常有吸引力'; cls = 'pf-good'; }
  else if (peg < 1) { verdict = '本益比低於成長率，Lynch 認為價格合理偏便宜'; cls = 'pf-good'; }
  else if (peg < 2) { verdict = '本益比高於成長率，價格已反映成長'; cls = 'pf-mid'; }
  else { verdict = '本益比是成長率的兩倍以上，Lynch 認為非常不利'; cls = 'pf-bad'; }
  return `<p>${termHtml('PEG')} <strong>${peg.toFixed(2)}</strong>（本益比 ${per} ÷ 近 4 季 EPS 成長 ${g.toFixed(1)}%）：<span class="${cls}">${verdict}</span>。
    <span class="pf-muted">成長率用近 4 季對前 4 季，一年的成長可能不代表長期。</span></p>`;
}

// 股價和獲利是否同步（近 4 季 EPS 成長 vs 近 12 個月股價報酬）
function dpfSyncHtml(eg, mom) {
  if (!eg || eg.growth === null || !mom || mom.ret12 === null || mom.ret12 === undefined) {
    return '<p class="pf-muted">資料不足（需要 8 季財報與 1 年股價）。</p>';
  }
  const up = eg.growth > 0, priceUp = mom.ret12 > 0;
  const facts = `近 4 季 EPS ${dpfPct(eg.growth)}、近 12 個月股價 ${dpfPct(mom.ret12)}（含股利）`;
  const text = up && priceUp ? '<span class="pf-good">獲利和股價同步成長</span>，股價有獲利支撐。'
    : up && !priceUp ? '<span class="pf-mid">獲利成長，股價卻下跌</span>：市場可能在擔心未來（例如景氣、產業前景），也可能還沒反映。研究發現股價常在財報公布後一段時間才逐步反映獲利變化，但近年這個現象已變弱，建議搭配新聞與法說會確認原因。'
    : !up && priceUp ? '<span class="pf-bad">獲利衰退，股價卻上漲</span>：股價靠市場對未來的期待支撐，若之後獲利沒有回升，估值修正的風險較高。'
    : '<span class="pf-bad">獲利和股價同步下滑</span>，基本面轉弱已反映在股價上。';
  return `<p>${facts}：${text}</p>`;
}

function dpfMomentumHtml(mom, bench) {
  if (!mom) return '<p class="pf-muted">股價資料未滿一年，無法計算。</p>';
  const rel = mom.mom12_1 !== null && bench && bench.mom12_1 !== null ? mom.mom12_1 - bench.mom12_1 : null;
  const relText = rel === null ? '' : `，${rel >= 0 ? '強於' : '弱於'}大盤（0050 ${dpfPct(bench.mom12_1)}）${Math.abs(rel * 100).toFixed(1)} 個百分點`;
  return `<ul class="pf-list">
    <li>${termHtml('動能')}：過去 12 個月（不含最近 1 個月）股價 <strong class="${dpfDir(mom.mom12_1)}">${dpfPct(mom.mom12_1)}</strong>${relText}。</li>
    <li>距離 52 週最高點 <strong class="${dpfDir(mom.fromHigh52)}">${dpfPct(mom.fromHigh52)}</strong>${mom.fromHigh52 > -0.05 ? '，接近一年來的高點' : ''}。</li>
    <li>近 1 年${termHtml('最大回撤')} <strong class="px-down">${dpfPct(mom.maxDrawdown1y)}</strong>（大盤 ${bench ? dpfPct(bench.maxDrawdown1y) : '—'}）。</li>
  </ul>`;
}

// 股價規則（計入燈號）：每條一張小卡，顯示「目前數值 vs 門檻」與結果
function dpfRiskHtml(stockId, analysis) {
  if (typeof RULES_CONFIG === 'undefined' || !analysis) return '';
  const market = typeof loadMarketRisk === 'function' ? loadMarketRisk()[stockId] : null;
  const state = DPF.riskState[stockId] || {};
  if (!market) {
    if (state.error) {
      return `<p class="pf-muted">股價規則資料無法取得：${escapeHtml(state.error)}
        <button class="btn-outline" style="margin-left:8px;" onclick="dpfEnsureRisk('${stockId}', true)">重試</button></p>`;
    }
    return '<p class="pf-muted">股價規則資料讀取中…</p>';
  }
  const alertByName = new Map(analysis.alerts.filter(a => a.rule.market).map(a => [a.rule.name, a]));
  const flagsText = types => {
    const hits = (market.flags || []).filter(f => types.includes(f.type));
    return hits.length ? hits.map(f => f.text).join('；') : (market.flagsComplete ? '目前不在名單上' : '名單暫時無法取得');
  };
  const pct = v => `${(v * 100).toFixed(1)}%`;
  const items = [
    ['officialAltered', flagsText(['altered']), '列入名單即紅燈'],
    ['officialWarning', flagsText(['notice', 'punish']), '因股價下跌被列入 → 黃燈'],
    ['priceUnderperform', market.exret3m != null ? `每月平均 ${dpfPct(market.exret3m)}（相對 0050）` : null, '≤ −11.5% → 黃燈'],
    ['priceVolatility', market.sigma3m != null ? `近 3 個月年化 ${pct(market.sigma3m)}` : null, '≥ 106.1% → 黃燈'],
    ['distanceToDefault', analysis.effectiveType === 'financial' ? null : (market.dd != null ? `${market.dd}` : null), '< 1 黃燈、< 0 紅燈',
      analysis.effectiveType === 'financial' ? '金融業不適用' : market.ddNote]
  ];
  const rows = items.map(([key, value, threshold, naReason]) => {
    const rule = RULES_CONFIG[key];
    const a = alertByName.get(rule.name);
    let cls = 'ok', chip = '✓ 正常';
    if (a) {
      const red = (a.detail.level || a.rule.level) === 'red';
      cls = red ? 'bad' : 'warn';
      chip = red ? '紅燈' : '黃燈';
    } else if (value === null || value === undefined) {
      cls = 'na';
      chip = '不適用';
    }
    const shown = a ? a.detail.text : (value ?? naReason ?? '資料不足');
    return `<tr>
      <td class="pf-risk-status"><span class="pf-chip ${cls}">${chip}</span></td>
      <td class="pf-risk-name">${escapeHtml(rule.name)}</td>
      <td>${escapeHtml(shown)}<div class="pf-risk-th-m">門檻：${escapeHtml(threshold)}</div></td>
      <td class="pf-risk-th">${escapeHtml(threshold)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-responsive" style="margin-top:0;"><table class="pf-risk-table">
      <thead><tr><th>結果</th><th>規則</th><th>目前數值</th><th class="pf-risk-th">門檻</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="pf-muted" style="margin-top:8px;">這 5 條規則會計入燈號與風險分數，門檻依據見<a href="rules.html">規則與說明</a>。名詞：${termHtml('波動度')}、${termHtml('違約距離')}</p>`;
}

// 價值＋動能的綜合判讀（Asness, Moskowitz & Pedersen 2013）
function dpfVerdictHtml(val, mom, bench) {
  if (!val || !mom) return '';
  // 估值位置：本益比、股價淨值比的歷史百分位，殖利率反過來（殖利率越高越便宜），取平均
  const parts = [val.per && val.per.percentile, val.pbr && val.pbr.percentile, val.yield && val.yield.percentile != null ? 100 - val.yield.percentile : null]
    .filter(v => v !== null && v !== undefined);
  if (!parts.length || mom.mom12_1 === null || !bench || bench.mom12_1 === null) return '';
  const v = parts.reduce((a, b) => a + b, 0) / parts.length;
  // 三項平均落在近 5 年最低或最高 30% 才判為偏便宜／偏貴（系統設定值，避免單一指標拉動就下結論）
  const valueSide = v <= 30 ? 'cheap' : (v >= 70 ? 'rich' : 'mid');
  const strong = mom.mom12_1 >= bench.mom12_1;
  const map = {
    'cheap-true': ['pf-good', '估值偏低、股價趨勢也強於大盤：價值與動能同時有利。'],
    'cheap-false': ['pf-mid', '估值偏低，但股價趨勢弱於大盤：便宜可能有原因（市場預期基本面轉差），請搭配上方財報警訊確認，避免「價值陷阱」。'],
    'rich-true': ['pf-mid', '估值偏高，但股價趨勢強於大盤：市場給予較高期待，追價前留意估值。'],
    'rich-false': ['pf-bad', '估值偏高、股價趨勢也弱於大盤：價值與動能都不利。'],
    'mid-true': ['pf-mid', '估值在自己的歷史中段，股價趨勢強於大盤。'],
    'mid-false': ['pf-mid', '估值在自己的歷史中段，股價趨勢弱於大盤。']
  };
  const [cls, text] = map[`${valueSide}-${strong}`];
  return `<div class="pf-verdict"><strong>綜合判讀</strong>（估值位置約在近 5 年的 ${Math.round(v)}%，${strong ? '強' : '弱'}於大盤）：<span class="${cls}">${text}</span>
    <span class="pf-muted">研究發現「便宜」和「股價趨勢」一起看比單看一種可靠，但這只是統計傾向，不代表個股一定如此。</span></div>`;
}

function dpfRender(stockId, analysis, data) {
  const body = document.getElementById('pf-body');
  const foot = document.getElementById('pf-foot');
  if (!body) return;
  const val = data.valuation;
  const mom = data.momentum && data.momentum.stock;
  const bench = data.momentum && data.momentum.benchmark;
  const eg = dpfEpsGrowth(analysis && analysis.data && analysis.data.quarters);

  const valuationHtml = val ? `
    <div class="table-responsive" style="margin-top:0;"><table class="pf-table">
      <thead><tr><th>指標</th><th class="num">目前</th><th class="num">近 5 年中位數</th><th>在自己歷史中的位置</th></tr></thead>
      <tbody>
        ${dpfValuationRow('本益比', '本益比', val.per, ' 倍', false)}
        ${dpfValuationRow('股價淨值比', '股價淨值比', val.pbr, ' 倍', false)}
        ${dpfValuationRow('殖利率', '殖利率', val.yield, '%', true)}
      </tbody></table></div>
    ${dpfPegHtml(val.per && val.per.current, eg)}` : `<p class="pf-muted">估值資料無法取得${data.valuationError ? `（${escapeHtml(data.valuationError)}）` : ''}。</p>`;

  body.innerHTML = `
    ${dpfVerdictHtml(val, mom, bench)}
    <h4 class="pf-h">① 估值：和自己的歷史比</h4>${valuationHtml}
    <h4 class="pf-h">② 股價有沒有跟上獲利</h4>${dpfSyncHtml(eg, mom)}
    <h4 class="pf-h">③ 股價趨勢</h4>${dpfMomentumHtml(mom, bench)}
    <h4 class="pf-h">④ 股價風險（計入燈號）</h4>${dpfRiskHtml(stockId, analysis)}`;
  if (foot) {
    foot.innerHTML = `本益比、股價淨值比、殖利率為證交所每日公布的數值（資料日 ${escapeHtml(val ? val.date : '—')}，經 FinMind 取得），「偏貴／偏便宜」是和這家公司自己近 5 年比較，
      單項位置在最低或最高 20%、綜合判讀三項平均在最低或最高 30% 才標示（系統設定值）；不同產業的合理水準不同，不能拿來跨產業比較。股價報酬為還原權息，大盤以 0050 代替。
      依據：CFA Institute 估值教材、Peter Lynch《One Up on Wall Street》、Bernard &amp; Thomas (1989)、Jegadeesh &amp; Titman (1993)、George &amp; Hwang (2004)、
      <a href="https://www.aqr.com/Insights/Research/Journal-Article/Value-and-Momentum-Everywhere" target="_blank" rel="noopener noreferrer">Asness, Moskowitz &amp; Pedersen (2013)</a>。僅供參考，不構成投資建議。`;
  }
}

// 切換主題、更改公司類型等重畫個股頁時，股價規則結果可能改變：用快取直接重畫，不重抓
window.addEventListener('themechange', () => {
  if (DPF.currentId && DPF.cache[DPF.currentId] && window.currentAnalysis) dpfRender(DPF.currentId, window.currentAnalysis, DPF.cache[DPF.currentId]);
});
