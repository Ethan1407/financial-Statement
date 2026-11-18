// ==========================================
// 1. 產業自動對照表 (INDUSTRY_TO_TYPE)
// ==========================================
const INDUSTRY_TO_TYPE = {
    "半導體業": "electronics", "電子零組件業": "electronics", "電腦及週邊設備業": "electronics", "光電業": "electronics", "通信網路業": "electronics", "其他電子業": "electronics", "電子通路業": "electronics", "資訊服務業": "electronics",
    "鋼鐵工業": "cyclical", "塑膠工業": "cyclical", "水泥工業": "cyclical", "航運業": "cyclical", "化學工業": "cyclical", "造紙工業": "cyclical", "紡織纖維": "cyclical", "橡膠工業": "cyclical", "玻璃陶瓷": "cyclical", "油電燃氣業": "cyclical",
    "生技醫療業": "growth",
    "貿易百貨": "retail", "觀光餐旅": "retail", "觀光事業": "retail",
    "建材營造": "construction",
    "金融保險業": "financial", "金融保險": "financial"
};

// ==========================================
// 2. 雷達圖評分區間設定 (SCORE_CONFIG)
// ==========================================
// 五大構面健康度（雷達圖）。分數 0～100，依 [得 0 分的值, 得 100 分的值] 線性換算，超出範圍截在 0 或 100。
// 設計原則（避免分數虛高）：
// - 損益與現金流用「近 4 季合計」計算，不被單一季的暴增或暴跌左右；資產負債表本來就是時點數字，用最新一季。
// - 門檻設得較嚴，100 分代表在台股中屬於很突出的水準，而不是「及格」。
// - 沒有存貨（存貨天數為 0）代表不適用，不當成週轉最快而給滿分。
const SCORE_CONFIG = {
    baseline: 60,
    window: 4,                                   // 近幾季合計
    profit: { gross: [0, 50], op: [0, 25] },     // 毛利率 50%、營益率 25% 才滿分
    growth: { yoy: [-20, 30] },                  // 年減 20% 為 0 分、持平約 40 分、年增 30% 滿分
    solvency: { debt: [80, 30], current: [1.0, 2.5] },
    cf: { op: [0, 30], free: [0, 20] },          // 營業現金流佔營收 30%、自由現金流佔營收 20% 才滿分
    efficiency: { ar: [120, 30], inv: [180, 30] }
};

// 回傳 { scores: [獲利, 成長, 償債, 現金流, 效率], notes: [每個構面的計算依據] }
function calcHealthBreakdown(quarterData) {
    const empty = { scores: [null, null, null, null, null], notes: ['', '', '', '', ''] };
    if (!quarterData || quarterData.length === 0) return empty;
    const latest = quarterData[quarterData.length - 1];
    const recent = quarterData.slice(-SCORE_CONFIG.window);
    const n = recent.length;
    const ok = v => v != null && !isNaN(v);
    const pct = v => `${Math.round(v * 10) / 10}%`;

    const mapScore = (val, minV, maxV) => {
        if (!ok(val)) return null;
        let p = (val - minV) / (maxV - minV);
        return Math.min(Math.max(p, 0), 1) * 100;
    };
    const avg = (arr) => {
        const valid = arr.filter(v => v != null);
        if (valid.length === 0) return null;
        return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
    };
    // 近 N 季「以營收加權」的比率：Σ(營收 × 比率) ÷ Σ營收，等同用合計數字算比率
    const weighted = (key) => {
        const qs = recent.filter(q => ok(q[key]) && ok(q.revenue) && q.revenue > 0);
        const rev = qs.reduce((a, q) => a + q.revenue, 0);
        return rev > 0 ? qs.reduce((a, q) => a + q.revenue * q[key], 0) / rev : null;
    };
    // 近 N 季合計金額 ÷ 合計營收
    const sumRatio = (key) => {
        const qs = recent.filter(q => ok(q[key]) && ok(q.revenue));
        const rev = qs.reduce((a, q) => a + q.revenue, 0);
        return rev > 0 ? qs.reduce((a, q) => a + q[key], 0) / rev * 100 : null;
    };

    // 獲利力：近 N 季毛利率、營益率
    const gm = weighted('grossMargin');
    const om = weighted('operatingMargin');
    const profitScore = avg([mapScore(gm, ...SCORE_CONFIG.profit.gross), mapScore(om, ...SCORE_CONFIG.profit.op)]);
    const profitNote = [ok(gm) && `毛利率 ${pct(gm)}`, ok(om) && `營益率 ${pct(om)}`].filter(Boolean).join('、');

    // 成長力：有 8 季營收時用「近 4 季合計 vs 前 4 季合計」，否則用近幾季年增率平均
    let yoy = null, growthBasis = '';
    const revs = quarterData.slice(-SCORE_CONFIG.window * 2).map(q => q.revenue);
    if (revs.length === SCORE_CONFIG.window * 2 && revs.every(v => ok(v))) {
        const cur = revs.slice(SCORE_CONFIG.window).reduce((a, b) => a + b, 0);
        const prev = revs.slice(0, SCORE_CONFIG.window).reduce((a, b) => a + b, 0);
        if (prev > 0) { yoy = (cur / prev - 1) * 100; growthBasis = '近 4 季營收合計年增'; }
    }
    if (yoy == null) {
        const ys = recent.map(q => q.revenueYoY).filter(ok);
        if (ys.length) { yoy = ys.reduce((a, b) => a + b, 0) / ys.length; growthBasis = `近 ${ys.length} 季營收年增率平均`; }
    }
    const growthRaw = mapScore(yoy, ...SCORE_CONFIG.growth.yoy);
    const growthScore = growthRaw == null ? null : Math.round(growthRaw);
    const growthNote = ok(yoy) ? `${growthBasis} ${pct(yoy)}` : '';

    // 償債力：最新一季負債比、流動比
    const solvencyScore = avg([mapScore(latest.debtRatio, ...SCORE_CONFIG.solvency.debt), mapScore(latest.currentRatio, ...SCORE_CONFIG.solvency.current)]);
    const solvencyNote = [ok(latest.debtRatio) && `負債比 ${pct(latest.debtRatio)}`, ok(latest.currentRatio) && `流動比 ${latest.currentRatio}`].filter(Boolean).join('、');

    // 現金流品質：近 N 季營業現金流、自由現金流合計 ÷ 營收合計
    const ocf = sumRatio('operatingCF');
    const fcf = sumRatio('freeCF');
    const cfScore = avg([mapScore(ocf, ...SCORE_CONFIG.cf.op), mapScore(fcf, ...SCORE_CONFIG.cf.free)]);
    const cfNote = [ok(ocf) && `營業現金流／營收 ${pct(ocf)}`, ok(fcf) && `自由現金流／營收 ${pct(fcf)}`].filter(Boolean).join('、');

    // 營運效率：近 N 季應收天數、存貨天數平均（存貨天數為 0 代表沒有存貨，不計分）
    const avgOf = (key, filter) => { const v = recent.map(q => q[key]).filter(x => ok(x) && filter(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const ar = avgOf('arDays', () => true);
    const inv = avgOf('invDays', x => x > 0);
    const effScore = avg([mapScore(ar, ...SCORE_CONFIG.efficiency.ar), mapScore(inv, ...SCORE_CONFIG.efficiency.inv)]);
    const effNote = [ok(ar) && `應收 ${Math.round(ar)} 天`, ok(inv) ? `存貨 ${Math.round(inv)} 天` : '無存貨（不計）'].filter(Boolean).join('、');

    const windowNote = `近 ${n} 季`;
    return {
        scores: [profitScore, growthScore, solvencyScore, cfScore, effScore],
        notes: [
            profitNote && `${windowNote}${profitNote}`,
            growthNote,
            solvencyNote && `最新一季${solvencyNote}`,
            cfNote && `${windowNote}${cfNote}`,
            effNote && `${windowNote}平均${effNote}`
        ]
    };
}

function calcHealthScores(quarterData) {
    return calcHealthBreakdown(quarterData).scores;
}

// ==========================================
// 3. 集中管理的規則設定物件 (RULES_CONFIG)
// ==========================================
// 規則依據：帆軟〈財報分析入門〉與 PTT Stock〈財報三表完全解析〉列出的警訊。
// 兩篇文章都強調「沒有跨產業通用的安全值」，因此門檻集中在這裡，並由 TYPE_PROFILES 依企業型態調整。
// metric：白話摘要中要附上的最新數值欄位。
const RISK_WEIGHTS = { red: 25, yellow: 10, max: 100 };

// 去年同一季（如 2026Q2 → 2025Q2），年比較可避開季節性
function sameQuarterLastYear(data, quarter) {
    const prevQ = `${parseInt(quarter.q.slice(0, 4)) - 1}${quarter.q.slice(4)}`;
    return data.find(d => d.q === prevQ);
}

const RULES_CONFIG = {
    // ---------- 損益表 ----------
    revenueDecline: {
        name: "營收連續衰退", level: "red", consecutive: 3, tab: 'income', metric: { key: 'revenueYoY', unit: '%' },
        why: (c) => `營收年增率連續 ${c.consecutive} 季為負`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.revenueYoY == null)) return { status: 'skipped' };
            if (recent.every(q => q.revenueYoY < 0)) return { status: 'alert', text: `營收年增率連續 ${config.consecutive} 季為負`, qs: recent.map(q => q.q) };
            return { status: 'pass' };
        }
    },
    grossMarginDrop: {
        name: "毛利率連續下滑", level: "yellow", consecutive: 3, tab: 'income', metric: { key: 'grossMargin', unit: '%' },
        why: (c) => `毛利率連續 ${c.consecutive} 季低於去年同季（定價能力或競爭力可能轉弱）`,
        check: (data, config) => {
            const recent = data.slice(-config.consecutive);
            if (recent.length < config.consecutive) return { status: 'skipped' };
            const pairs = recent.map(q => [q, sameQuarterLastYear(data, q)]);
            if (pairs.some(([cur, prev]) => !prev || cur.grossMargin == null || prev.grossMargin == null)) return { status: 'skipped' };
            if (pairs.every(([cur, prev]) => cur.grossMargin < prev.grossMargin)) {
                return { status: 'alert', text: `毛利率已連續 ${config.consecutive} 季低於去年同季`, qs: recent.map(q => q.q) };
            }
            return { status: 'pass' };
        }
    },
    grossMarginPlunge: {
        name: "毛利率單季暴跌", level: "yellow", threshold: 3, tab: 'income', metric: { key: 'grossMargin', unit: '%' },
        why: (c) => `單季毛利率比前一季下滑超過 ${c.threshold} 個百分點`,
        check: (data, config) => {
            if (data.length < 2) return { status: 'skipped' };
            const latest = data[data.length - 1];
            const prev = data[data.length - 2];
            if (latest.grossMargin == null || prev.grossMargin == null) return { status: 'skipped' };
            if ((prev.grossMargin - latest.grossMargin) > config.threshold) return { status: 'alert', text: `單季毛利率驟降 ${(prev.grossMargin - latest.grossMargin).toFixed(2)} 個百分點`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },
    marginSqueezeOnGrowth: {
        name: "營收成長但毛利率下滑", level: "yellow", threshold: 2, tab: 'income', metric: { key: 'grossMargin', unit: '%' },
        why: (c) => `營收年增，但毛利率較去年同季下滑超過 ${c.threshold} 個百分點（可能削價搶單、低毛利產品變多）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || latest.revenueYoY == null || latest.grossMargin == null || prev.grossMargin == null) return { status: 'skipped' };
            const drop = prev.grossMargin - latest.grossMargin;
            if (latest.revenueYoY > 0 && drop > config.threshold) {
                return { status: 'alert', text: `營收年增 ${latest.revenueYoY}%，毛利率卻比去年同季少 ${drop.toFixed(2)} 個百分點`, qs: [prev.q, latest.q] };
            }
            return { status: 'pass' };
        }
    },
    revenueUpProfitDown: {
        name: "營收成長但營業利益衰退", level: "yellow", tab: 'income', metric: { key: 'operatingIncome', unit: ' 百萬' },
        why: () => `營收年增，但營業利益比去年同季減少（成本或費用上升速度快於營收）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || latest.revenueYoY == null || latest.operatingIncome == null || prev.operatingIncome == null) return { status: 'skipped' };
            if (latest.revenueYoY > 0 && latest.operatingIncome < prev.operatingIncome) {
                return { status: 'alert', text: `營收年增 ${latest.revenueYoY}%，營業利益卻從 ${prev.operatingIncome} 降到 ${latest.operatingIncome} 百萬`, qs: [prev.q, latest.q] };
            }
            return { status: 'pass' };
        }
    },
    expenseSqueeze: {
        name: "費用侵蝕本業獲利", level: "yellow", threshold: 3, stableBand: 1, tab: 'income', metric: { key: 'operatingMargin', unit: '%' },
        why: (c) => `毛利率與去年同季相差不到 ${c.stableBand} 個百分點，營益率卻下滑超過 ${c.threshold} 個百分點（人事、行銷、管理費用上升）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || [latest.grossMargin, prev.grossMargin, latest.operatingMargin, prev.operatingMargin].some(v => v == null)) return { status: 'skipped' };
            const gmStable = Math.abs(latest.grossMargin - prev.grossMargin) <= config.stableBand;
            const omDrop = prev.operatingMargin - latest.operatingMargin;
            if (gmStable && omDrop > config.threshold) {
                return { status: 'alert', text: `毛利率持平，營益率卻比去年同季少 ${omDrop.toFixed(2)} 個百分點`, qs: [prev.q, latest.q] };
            }
            return { status: 'pass' };
        }
    },
    profitDivergence: {
        name: "本業與獲利背離", level: "yellow", tab: 'income', metric: { key: 'nonOperatingIncome', unit: ' 百萬' },
        why: () => `淨利比去年同季成長，營業利益卻衰退（獲利可能靠業外收入，不宜當常態）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || [latest.netIncome, prev.netIncome, latest.operatingIncome, prev.operatingIncome].some(v => v == null)) return { status: 'skipped' };
            if (latest.netIncome > prev.netIncome && latest.operatingIncome < prev.operatingIncome) {
                return { status: 'alert', text: `淨利較去年同期成長，但本業營業利益衰退`, qs: [prev.q, latest.q] };
            }
            return { status: 'pass' };
        }
    },

    // ---------- 資產負債表 ----------
    lowCurrentRatio: {
        name: "流動比率過低", level: "red", threshold: 1.0, tab: 'balance', metric: { key: 'currentRatio', unit: '' },
        why: (c) => `流動比率低於 ${c.threshold}（短期資產不足以支應短期負債）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.currentRatio == null) return { status: 'skipped' };
            if (latest.currentRatio < config.threshold) return { status: 'alert', text: `最新流動比率 ${latest.currentRatio} 低於 ${config.threshold}`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },
    lowQuickRatio: {
        name: "速動比率偏低", level: "yellow", threshold: 0.8, tab: 'balance', metric: { key: 'quickRatio', unit: '' },
        why: (c) => `速動比率低於 ${c.threshold}`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.quickRatio == null) return { status: 'skipped' };
            if (latest.quickRatio < config.threshold) return { status: 'alert', text: `最新速動比率 ${latest.quickRatio} 低於 ${config.threshold}`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },
    highDebtRatio: {
        name: "負債比過高", level: "yellow", threshold: 70, tab: 'balance', metric: { key: 'debtRatio', unit: '%' },
        why: (c) => `負債比大於 ${c.threshold}%`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.debtRatio == null) return { status: 'skipped' };
            if (latest.debtRatio > config.threshold) return { status: 'alert', text: `最新負債比 ${latest.debtRatio}% 高於 ${config.threshold}%`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },
    debtRising: {
        name: "負債比持續攀升", level: "yellow", consecutive: 3, minIncrease: 3, tab: 'balance', metric: { key: 'debtRatio', unit: '%' },
        why: (c) => `負債比連續 ${c.consecutive} 季上升，且累計增加超過 ${c.minIncrease} 個百分點`,
        check: (data, config) => {
            if (data.length < config.consecutive + 1) return { status: 'skipped' };
            const recent = data.slice(-(config.consecutive + 1));
            if (recent.some(q => q.debtRatio == null)) return { status: 'skipped' };
            const rising = recent.every((q, i) => i === 0 || q.debtRatio > recent[i - 1].debtRatio);
            const increase = recent[recent.length - 1].debtRatio - recent[0].debtRatio;
            if (rising && increase > config.minIncrease) {
                return { status: 'alert', text: `負債比連續 ${config.consecutive} 季上升，累計增加 ${increase.toFixed(2)} 個百分點`, qs: recent.slice(1).map(q => q.q) };
            }
            return { status: 'pass' };
        }
    },
    receivableBuildup: {
        name: "應收帳款增加快於營收", level: "yellow", threshold: 20, tab: 'balance', metric: { key: 'arDays', unit: ' 天' },
        why: (c) => `應收帳款天數比去年同季增加超過 ${c.threshold}%（收款變慢或放寬收款條件）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || latest.arDays == null || !(prev.arDays > 0)) return { status: 'skipped' };
            const change = (latest.arDays - prev.arDays) / prev.arDays * 100;
            if (change > config.threshold) return { status: 'alert', text: `應收帳款天數 ${prev.arDays} → ${latest.arDays} 天，比去年同季增加 ${change.toFixed(0)}%`, qs: [prev.q, latest.q] };
            return { status: 'pass' };
        }
    },
    inventoryBuildup: {
        name: "存貨增加快於銷貨", level: "yellow", threshold: 20, tab: 'balance', metric: { key: 'invDays', unit: ' 天' },
        why: (c) => `存貨天數比去年同季增加超過 ${c.threshold}%（可能備貨過多或需求轉弱）`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            const prev = sameQuarterLastYear(data, latest);
            if (!prev || latest.invDays == null || !(prev.invDays > 0)) return { status: 'skipped' };
            const change = (latest.invDays - prev.invDays) / prev.invDays * 100;
            if (change > config.threshold) return { status: 'alert', text: `存貨天數 ${prev.invDays} → ${latest.invDays} 天，比去年同季增加 ${change.toFixed(0)}%`, qs: [prev.q, latest.q] };
            return { status: 'pass' };
        }
    },
    lowInterestCoverage: {
        name: "利息保障倍數偏低", level: "dynamic", yellowBelow: 3, redBelow: 1.5, tab: 'balance', metric: { key: 'interestCoverage', unit: ' 倍' },
        why: (c) => `低於 ${c.yellowBelow} 倍為黃燈，低於 ${c.redBelow} 倍為紅燈`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.interestCoverage == null) return { status: 'skipped' };
            if (latest.interestCoverage < config.redBelow) return { status: 'alert', level: 'red', text: `最新倍數 ${latest.interestCoverage} 低於 ${config.redBelow}`, qs: [latest.q] };
            if (latest.interestCoverage < config.yellowBelow) return { status: 'alert', level: 'yellow', text: `最新倍數 ${latest.interestCoverage} 低於 ${config.yellowBelow}`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },

    // ---------- 現金流量表 ----------
    cashFlowQuality: {
        name: "獲利含金量不足", level: "yellow", periods: 8, threshold: 1.0, tab: 'cashflow', metric: { key: 'operatingCF', unit: ' 百萬' },
        why: (c) => `近 ${c.periods} 季營業現金流合計低於稅後淨利的 ${c.threshold} 倍（獲利沒有轉成現金）`,
        check: (data, config) => {
            if (data.length < config.periods) return { status: 'skipped' };
            const recent = data.slice(-config.periods);
            if (recent.some(q => q.operatingCF == null || q.netIncome == null)) return { status: 'skipped' };
            const netIncome = recent.reduce((sum, q) => sum + q.netIncome, 0);
            if (netIncome <= 0) return { status: 'skipped' };  // 虧損時比值沒有意義
            const ratio = recent.reduce((sum, q) => sum + q.operatingCF, 0) / netIncome;
            if (ratio < config.threshold) return { status: 'alert', text: `近 ${config.periods} 季營業現金流 ÷ 稅後淨利 = ${ratio.toFixed(2)}，低於 ${config.threshold}`, qs: recent.map(q => q.q) };
            return { status: 'pass' };
        }
    },
    profitButNoCash: {
        name: "淨利為正但無現金流入", level: "yellow", tab: 'cashflow', metric: { key: 'operatingCF', unit: ' 百萬' },
        why: () => `單季淨利大於 0，但營業現金流為負`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.netIncome == null || latest.operatingCF == null) return { status: 'skipped' };
            if (latest.netIncome > 0 && latest.operatingCF < 0) return { status: 'alert', text: `最新季淨利為正，但營業現金流為負`, qs: [latest.q] };
            return { status: 'pass' };
        }
    },
    negativeOperatingCF: {
        name: "營業現金流連續為負", level: "red", consecutive: 3, tab: 'cashflow', metric: { key: 'operatingCF', unit: ' 百萬' },
        why: (c) => `營業現金流連續 ${c.consecutive} 季為負（偶爾一季為負可能是季節因素，連續多季才是警訊）`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.operatingCF == null)) return { status: 'skipped' };
            if (recent.every(q => q.operatingCF < 0)) return { status: 'alert', text: `營業現金流連續 ${config.consecutive} 季為負`, qs: recent.map(q => q.q) };
            return { status: 'pass' };
        }
    },
    negativeFreeCF: {
        name: "自由現金流連續為負", level: "yellow", consecutive: 3, tab: 'cashflow', metric: { key: 'freeCF', unit: ' 百萬' },
        why: (c) => `自由現金流連續 ${c.consecutive} 季小於 0`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.freeCF == null)) return { status: 'skipped' };
            if (recent.every(q => q.freeCF < 0)) return { status: 'alert', text: `連續 ${config.consecutive} 季小於 0`, qs: recent.map(q => q.q) };
            return { status: 'pass' };
        }
    },
    financingSupportedCash: {
        name: "靠融資撐現金", level: "red", tab: 'cashflow', metric: { key: 'financingCF', unit: ' 百萬' },
        why: () => `營業現金流為負、期末現金比前一季增加，且融資現金流為正`,
        check: (data, config) => {
            if (data.length < 2) return { status: 'skipped' };
            const latest = data[data.length - 1];
            const prev = data[data.length - 2];
            if (latest.operatingCF == null || latest.cashEnd == null || prev.cashEnd == null || latest.financingCF == null) return { status: 'skipped' };
            if (latest.operatingCF < 0 && latest.cashEnd > prev.cashEnd && latest.financingCF > 0) {
                return { status: 'alert', text: `本業流失現金，靠融資活動才維持現金池成長`, qs: [latest.q] };
            }
            return { status: 'pass' };
        }
    }
};

// ==========================================
// 4. 產業類型與規則覆蓋設定 (TYPE_PROFILES)
// ==========================================
// overrides：{ 規則代號: { disabled: true } } 停用；或覆蓋門檻、燈號（level）等設定
const TYPE_PROFILES = {
    general: {
        label: "一般 (預設)", desc: "不作任何產業調整，使用標準檢驗門檻。", overrides: {}
    },
    electronics: {
        label: "電子製造/半導體",
        desc: "資本支出大、擴產與備貨期營運資金需求高，自由現金流為負、營業現金流略低於淨利屬常態；景氣循環明顯，存貨天數波動較大。",
        overrides: { negativeFreeCF: { disabled: true }, inventoryBuildup: { threshold: 30 }, cashFlowQuality: { threshold: 0.8 } }
    },
    cyclical: {
        label: "傳產/景氣循環",
        desc: "營收與毛利率隨原物料、運價等景氣循環大幅波動，放寬營收衰退、毛利率與負債比門檻。",
        overrides: {
            revenueDecline: { consecutive: 4 }, highDebtRatio: { threshold: 80 }, grossMarginDrop: { consecutive: 4 },
            marginSqueezeOnGrowth: { threshold: 4 }, inventoryBuildup: { threshold: 30 }
        }
    },
    growth: {
        label: "成長股",
        desc: "重視營收成長，投入研發與擴張時常見虧損、現金流為負與費用上升，關閉相關示警。",
        overrides: {
            profitButNoCash: { disabled: true }, negativeFreeCF: { disabled: true }, cashFlowQuality: { disabled: true },
            revenueUpProfitDown: { disabled: true }, expenseSqueeze: { disabled: true }
        }
    },
    dividend: {
        label: "高股息/存股型",
        desc: "股利需要穩定的獲利與現金，對毛利率、獲利含金量與負債更嚴格。",
        overrides: {
            grossMarginDrop: { consecutive: 2 }, profitButNoCash: { level: "red" },
            cashFlowQuality: { level: "red" }, debtRising: { consecutive: 2 }
        }
    },
    retail: {
        label: "零售/通路/服務",
        desc: "現金回收快、常以應付帳款周轉，流動與速動比率偏低屬常態；存貨週轉是經營重點，存貨示警更嚴格。",
        overrides: { lowCurrentRatio: { threshold: 0.8 }, lowQuickRatio: { disabled: true }, inventoryBuildup: { threshold: 15 } }
    },
    construction: {
        label: "營建",
        desc: "土地與在建工程使存貨週期長，多靠借款與預收款，營業現金流隨完工認列大幅波動，放寬負債與現金流示警。",
        overrides: {
            highDebtRatio: { threshold: 80 }, revenueDecline: { consecutive: 4 }, lowQuickRatio: { disabled: true },
            inventoryBuildup: { disabled: true }, receivableBuildup: { disabled: true }, negativeOperatingCF: { disabled: true },
            cashFlowQuality: { disabled: true }, profitButNoCash: { disabled: true }, negativeFreeCF: { disabled: true },
            financingSupportedCash: { disabled: true }
        }
    },
    financial: {
        label: "金融業",
        desc: "金融業報表結構不同（以利差與手續費為主、高槓桿屬常態），毛利、流動比率、存貨與現金流指標不適用，僅檢查營收與本業獲利趨勢。",
        overrides: {
            lowCurrentRatio: { disabled: true }, lowQuickRatio: { disabled: true }, highDebtRatio: { disabled: true }, debtRising: { disabled: true },
            grossMarginDrop: { disabled: true }, grossMarginPlunge: { disabled: true }, marginSqueezeOnGrowth: { disabled: true },
            expenseSqueeze: { disabled: true }, profitDivergence: { disabled: true }, lowInterestCoverage: { disabled: true },
            receivableBuildup: { disabled: true }, inventoryBuildup: { disabled: true },
            cashFlowQuality: { disabled: true }, profitButNoCash: { disabled: true }, negativeOperatingCF: { disabled: true },
            negativeFreeCF: { disabled: true }, financingSupportedCash: { disabled: true }
        }
    }
};

// ==========================================
// 5. 白話文摘要產生器 (generateSummary)
// ==========================================
function generateSummary(alerts, skipped, status, quarters) {
    if (!quarters || quarters.length === 0) return { detail: '資料異常。', short: '無資料' };
    const latest = quarters[quarters.length - 1];

    let statusText = status === 'red' ? '整體狀況需注意，存在警戒訊號。' : (status === 'yellow' ? '整體狀況尚可，但有需留意事項。' : '整體財報表現健康，無重大異常。');

    let pros = [];
    let yoyCount = 0;
    for(let i = quarters.length - 1; i >= 0; i--) {
        if (quarters[i].revenueYoY > 0) yoyCount++;
        else break;
    }
    if (yoyCount >= 2) pros.push(`營收連續 ${yoyCount} 季成長`);
    else if (latest.revenueYoY > 0) pros.push(`最新營收年增 ${latest.revenueYoY}%`);

    if (latest.operatingCF > 0 && latest.freeCF > 0) pros.push('營業與自由現金流皆為正');
    else if (latest.operatingCF > 0) pros.push('維持正向營業現金流');

    if (latest.grossMargin != null && latest.grossMargin > 20) pros.push(`毛利率達 ${latest.grossMargin}%`);
    if (latest.debtRatio != null && latest.debtRatio < 50) pros.push(`負債比 ${latest.debtRatio}% 體質穩健`);

    let prosSelected = pros.slice(0, 2);
    let prosText = prosSelected.length > 0 ? `優點包含：${prosSelected.join('，且')}。` : '';

    let concernsText = '';
    if (alerts.length > 0) {
        const alertDetails = alerts.map(a => {
            const m = a.rule.metric;
            const val = m && latest[m.key] != null ? `(最新 ${latest[m.key]}${m.unit})` : '';
            return `${a.rule.name}${val}`;
        });
        concernsText = `疑慮方面：觸發了「${alertDetails.join('、')}」。`;
    }

    let missingText = skipped && skipped.length > 0 ? '部分指標資料不足，未納入判斷。' : '';
    let ending = '以上為依財報數據自動產生的整理，不構成投資建議。';

    let detail = `${statusText} ${prosText} ${concernsText} ${missingText} ${ending}`.trim();
    // 卡片摘要：有警訊時列出最嚴重的警訊（紅燈優先），沒有警訊才列優點，避免紅燈公司卻只看到優點
    const label = status === 'green' ? '健康' : (status === 'red' ? '警戒' : '注意');
    let short;
    if (alerts.length > 0) {
        const lvl = a => a.detail && a.detail.level || a.rule.level;
        const worst = alerts.slice().sort((a, b) => (lvl(b) === 'red') - (lvl(a) === 'red')).slice(0, 2).map(a => a.rule.name);
        short = `${label}｜${worst.join('、')}${alerts.length > worst.length ? ` 等 ${alerts.length} 項警訊` : ''}`;
    } else {
        short = `${label}｜${prosSelected.length > 0 ? prosSelected[0] : '無特別亮點'}｜無警訊`;
    }

    return { detail, short };
}

// ==========================================
// 6. 輔助函式與分析核心
// ==========================================
// FinMind 同一公司常有多個產業別（如 ["電子工業", "電子零組件業"]），取第一個有對照的細分類，沒有則取第一個
function pickIndustry(industries) {
    const list = (industries || []).filter(Boolean);
    return list.find(ind => INDUSTRY_TO_TYPE[ind]) || list[0] || '';
}

// 財報資料的產業清單（舊資料沒有 industryAll 時退回 industry）
function getIndustries(data) {
    return data.industryAll && data.industryAll.length ? data.industryAll : [data.industry];
}

function getDefaultCompanyType(industries, isFinancial) {
    if (isFinancial) return 'financial';
    return INDUSTRY_TO_TYPE[pickIndustry(industries)] || 'general';
}

function getEffectiveRules(type) {
    const profile = TYPE_PROFILES[type] || TYPE_PROFILES['general'];
    const effective = {};
    for (const [key, baseConfig] of Object.entries(RULES_CONFIG)) {
        const override = profile.overrides[key] || {};
        if (override.disabled) continue;
        effective[key] = { ...baseConfig, ...override };
    }
    return effective;
}

// 動態計算歷史 8 季每一季當下的風險分數 (不可用未來資料)
function calcHistoricalRiskScores(quarters, effectiveType) {
    let scores = [];
    const rules = getEffectiveRules(effectiveType);
    for(let i = 0; i < quarters.length; i++) {
        let slice = quarters.slice(0, i + 1); // 切出「該季以前」的資料
        let score = 0;
        for (const key of Object.keys(rules)) {
            const ruleConf = rules[key];
            const res = ruleConf.check(slice, ruleConf);
            if (res && res.status === 'alert') {
                const lvl = res.level || ruleConf.level;
                score += (lvl === 'red' ? RISK_WEIGHTS.red : RISK_WEIGHTS.yellow);
            }
        }
        scores.push(Math.min(score, RISK_WEIGHTS.max));
    }
    return scores;
}

function analyzeStock(stockId) {
    const stockDatabase = loadStockDatabase();
    return analyzeData(stockId, stockDatabase[stockId]);
}

// 對任一份財報資料做規則檢查（ETF 成分股的財報來自後端，不在 localStorage）
function analyzeData(stockId, data) {
    if (!data || data.isEtf || !data.quarters || data.quarters.length === 0) return null;
    
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    const defaultType = getDefaultCompanyType(getIndustries(data), data.isFinancial);
    const effectiveType = overrides[stockId] || defaultType;
    
    const rules = getEffectiveRules(effectiveType);
    
    let alerts = [];
    let skipped = [];
    let status = 'green';
    let riskScore = 0;
    
    for (const key of Object.keys(rules)) {
        const ruleConf = rules[key];
        const res = ruleConf.check(data.quarters, ruleConf);
        if (res && res.status === 'alert') {
            alerts.push({ rule: ruleConf, detail: res });
            const lvl = res.level || ruleConf.level;
            
            riskScore += (lvl === 'red' ? RISK_WEIGHTS.red : RISK_WEIGHTS.yellow);
            if (lvl === 'red') status = 'red';
            else if (status === 'green' && lvl === 'yellow') status = 'yellow';
        } else if (res && res.status === 'skipped') {
            skipped.push(ruleConf);
        }
    }
    riskScore = Math.min(riskScore, RISK_WEIGHTS.max);
    
    const summary = generateSummary(alerts, skipped, status, data.quarters);
    const histRiskScores = calcHistoricalRiskScores(data.quarters, effectiveType);
    
    return { alerts, skipped, status, riskScore, histRiskScores, data, effectiveType, summary };
}