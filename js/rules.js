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

    // 加入 isNaN 防呆保護
    const mapScore = (val, minV, maxV) => {
        if (val == null || isNaN(val)) return null;
        let p = (val - minV) / (maxV - minV);
        if (p < 0) p = 0;
        if (p > 1) p = 1;
        return p * 100;
    };

    const avg = (arr) => {
        let valid = arr.filter(v => v != null);
        if (valid.length === 0) return null;
        return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
    };

    let p_gross = mapScore(latest.grossMargin, SCORE_CONFIG.profit.gross[0], SCORE_CONFIG.profit.gross[1]);
    let p_op = mapScore(latest.operatingMargin, SCORE_CONFIG.profit.op[0], SCORE_CONFIG.profit.op[1]);
    let profitScore = avg([p_gross, p_op]);

    let growthScore = mapScore(latest.revenueYoY, SCORE_CONFIG.growth.yoy[0], SCORE_CONFIG.growth.yoy[1]);
    if (growthScore != null) growthScore = Math.round(growthScore);

    let s_debt = mapScore(latest.debtRatio, SCORE_CONFIG.solvency.debt[0], SCORE_CONFIG.solvency.debt[1]);
    let s_current = mapScore(latest.currentRatio, SCORE_CONFIG.solvency.current[0], SCORE_CONFIG.solvency.current[1]);
    let solvencyScore = avg([s_debt, s_current]);

    let cf_op = (latest.revenue > 0 && latest.operatingCF != null) ? mapScore(latest.operatingCF / latest.revenue * 100, SCORE_CONFIG.cf.op[0], SCORE_CONFIG.cf.op[1]) : null;
    let cf_free = (latest.revenue > 0 && latest.freeCF != null) ? mapScore(latest.freeCF / latest.revenue * 100, SCORE_CONFIG.cf.free[0], SCORE_CONFIG.cf.free[1]) : null;
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
        name: "營收連續衰退", level: "red", consecutive: 3, why: (c) => `營收年增率連續 ${c.consecutive} 季為負`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.revenueYoY == null)) return { status: 'skipped' };
            if (recent.every(q => q.revenueYoY < 0)) return { status: 'alert', text: `營收年增率連續 ${config.consecutive} 季為負`, qs: recent.map(q=>q.q), tab: 'income' };
            return { status: 'pass' };
        }
    },
    lowCurrentRatio: { 
        name: "流動比率過低", level: "red", threshold: 1.0, why: (c) => `流動比率低於 ${c.threshold}`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.currentRatio == null) return { status: 'skipped' };
            if (latest.currentRatio < config.threshold) return { status: 'alert', text: `最新流動比率 ${latest.currentRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    lowQuickRatio: {
        name: "速動比率偏低", level: "yellow", threshold: 0.8, why: (c) => `速動比率低於 ${c.threshold}`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.quickRatio == null) return { status: 'skipped' };
            if (latest.quickRatio < config.threshold) return { status: 'alert', text: `最新速動比率 ${latest.quickRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    highDebtRatio: { 
        name: "負債比過高", level: "yellow", threshold: 70, why: (c) => `負債比大於 ${c.threshold}%`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.debtRatio == null) return { status: 'skipped' };
            if (latest.debtRatio > config.threshold) return { status: 'alert', text: `最新負債比 ${latest.debtRatio}% 高於 ${config.threshold}%`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    grossMarginDrop: { 
        name: "毛利率連續下滑", level: "yellow", consecutive: 2, why: (c) => `毛利率連續 ${c.consecutive} 季下滑`,
        check: (data, config) => {
            if (data.length < config.consecutive + 1) return { status: 'skipped' };
            const recent = data.slice(-(config.consecutive + 1));
            if (recent.some(q => q.grossMargin == null)) return { status: 'skipped' };
            let declining = true;
            for(let i=1; i<recent.length; i++) {
                if (recent[i].grossMargin >= recent[i-1].grossMargin) declining = false;
            }
            if (declining) return { status: 'alert', text: `毛利率連續 ${config.consecutive} 季下滑`, qs: recent.slice(1).map(q=>q.q), tab: 'income' };
            return { status: 'pass' };
        }
    },
    grossMarginPlunge: {
        name: "毛利率單季暴跌", level: "yellow", threshold: 3, why: (c) => `單季比前一季下滑超過 ${c.threshold} 個百分點`,
        check: (data, config) => {
            if (data.length < 2) return { status: 'skipped' };
            const latest = data[data.length - 1];
            const prev = data[data.length - 2];
            if (latest.grossMargin == null || prev.grossMargin == null) return { status: 'skipped' };
            if ((prev.grossMargin - latest.grossMargin) > config.threshold) return { status: 'alert', text: `單季毛利率驟降 ${Math.abs(latest.grossMargin - prev.grossMargin).toFixed(2)} 個百分點`, qs: [latest.q], tab: 'income' };
            return { status: 'pass' };
        }
    },
    profitDivergence: {
        name: "本業與獲利背離", level: "yellow", why: () => `淨利年增但營業利益年減 (用4季前同期比較)`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            let year = parseInt(latest.q.slice(0,4));
            let qNum = latest.q.slice(5);
            let prevYearQ = `${year-1}Q${qNum}`;
            let prevYearData = data.find(d => d.q === prevYearQ);
            
            if (!prevYearData || latest.netIncome == null || prevYearData.netIncome == null || latest.operatingIncome == null || prevYearData.operatingIncome == null) return { status: 'skipped' };
            
            if (latest.netIncome > prevYearData.netIncome && latest.operatingIncome < prevYearData.operatingIncome) {
                return { status: 'alert', text: `淨利較去年同期成長，但本業營業利益衰退`, qs: [latest.q, prevYearQ], tab: 'income' };
            }
            return { status: 'pass' };
        }
    },
    lowInterestCoverage: {
        name: "利息保障倍數偏低", level: "dynamic", why: () => `低於 3 黃燈，低於 1.5 紅燈`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.interestCoverage == null) return { status: 'skipped' };
            if (latest.interestCoverage < 1.5) return { status: 'alert', level: 'red', text: `最新倍數 ${latest.interestCoverage} 低於 1.5`, qs: [latest.q], tab: 'balance' };
            if (latest.interestCoverage < 3) return { status: 'alert', level: 'yellow', text: `最新倍數 ${latest.interestCoverage} 低於 3`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    negativeFreeCF: { 
        name: "自由現金流連續為負", level: "yellow", consecutive: 3, why: (c) => `連續 ${c.consecutive} 季小於 0`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.freeCF == null)) return { status: 'skipped' };
            if (recent.every(q => q.freeCF < 0)) return { status: 'alert', text: `連續 ${config.consecutive} 季小於 0`, qs: recent.map(q=>q.q), tab: 'cashflow' };
            return { status: 'pass' };
        }
    },
    profitButNoCash: { 
        name: "淨利為正但無現金流入", level: "yellow", why: (c) => `單季淨利大於 0，但營業現金流為負`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.netIncome == null || latest.operatingCF == null) return { status: 'skipped' };
            if (latest.netIncome > 0 && latest.operatingCF < 0) return { status: 'alert', text: `最新季淨利為正，但營業現金流為負`, qs: [latest.q], tab: 'cashflow' };
            return { status: 'pass' };
        }
    },
    financingSupportedCash: {
        name: "靠融資撐現金", level: "red", why: () => `營業現金流為負、期末現金較前一季增加、且融資現金流為正`,
        check: (data, config) => {
            if (data.length < 2) return { status: 'skipped' };
            const latest = data[data.length - 1];
            const prev = data[data.length - 2];
            if (latest.operatingCF == null || latest.cashEnd == null || prev.cashEnd == null || latest.financingCF == null) return { status: 'skipped' };
            
            if (latest.operatingCF < 0 && latest.cashEnd > prev.cashEnd && latest.financingCF > 0) {
                return { status: 'alert', text: `本業流失現金，靠融資活動才維持現金池成長`, qs: [latest.q], tab: 'cashflow' };
            }
            return { status: 'pass' };
        }
    }
};

// ==========================================
// 4. 產業類型與規則覆蓋設定 (TYPE_PROFILES)
// ==========================================
const TYPE_PROFILES = {
    electronics: {
        label: "電子製造/半導體", desc: "資本密集，允許自由現金流短期為負(不單獨示警)。",
        overrides: { negativeFreeCF: { disabled: true } }
    },
    cyclical: {
        label: "傳產/景氣循環", desc: "景氣波動大，放寬營收衰退(連續 4 季)與負債比門檻(80%)。",
        overrides: { revenueDecline: { consecutive: 4 }, highDebtRatio: { threshold: 80 } }
    },
    growth: {
        label: "成長股", desc: "重視營收成長，允許短期虧損與現金流為負(關閉部分現金流示警)。",
        overrides: { profitButNoCash: { disabled: true }, negativeFreeCF: { disabled: true } }
    },
    dividend: {
        label: "高股息/存股型", desc: "要求穩定獲利與現金流，對毛利與現金流品質更嚴格。",
        overrides: { grossMarginDrop: { consecutive: 2, level: "yellow" }, profitButNoCash: { level: "red" } }
    },
    financial: {
        label: "金融業", desc: "金融業報表結構不同，流動比率、毛利、存貨等指標不適用，目前僅檢查營收趨勢與獲利趨勢。",
        overrides: { 
            lowCurrentRatio: { disabled: true }, lowQuickRatio: { disabled: true }, highDebtRatio: { disabled: true },
            grossMarginDrop: { disabled: true }, grossMarginPlunge: { disabled: true }, profitDivergence: { disabled: true },
            lowInterestCoverage: { disabled: true }, negativeFreeCF: { disabled: true }, profitButNoCash: { disabled: true }, financingSupportedCash: { disabled: true } 
        }
    },
    general: {
        label: "一般 (預設)", desc: "不作任何產業調整，使用標準檢驗門檻。", overrides: {}
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
        let alertDetails = alerts.map(a => {
            let n = a.rule.name;
            let val = '';
            if (n.includes('營收') && latest.revenueYoY != null) val = `(最新 ${latest.revenueYoY}%)`;
            else if (n.includes('毛利') && latest.grossMargin != null) val = `(最新 ${latest.grossMargin}%)`;
            else if (n.includes('流動比') && latest.currentRatio != null) val = `(最新 ${latest.currentRatio})`;
            else if (n.includes('速動比') && latest.quickRatio != null) val = `(最新 ${latest.quickRatio})`;
            else if (n.includes('負債') && latest.debtRatio != null) val = `(最新 ${latest.debtRatio}%)`;
            else if (n.includes('利息') && latest.interestCoverage != null) val = `(最新 ${latest.interestCoverage})`;
            else if (n.includes('現金流') && latest.operatingCF != null) val = `(最新營現 ${latest.operatingCF})`;
            return `${n}${val}`;
        });
        concernsText = `疑慮方面：觸發了「${alertDetails.join('、')}」。`;
    }

    let missingText = skipped && skipped.length > 0 ? '部分指標資料不足，未納入判斷。' : '';
    let ending = '以上為依財報數據自動產生的整理，不構成投資建議。';
    
    let detail = `${statusText} ${prosText} ${concernsText} ${missingText} ${ending}`.trim();
    let shortPros = prosSelected.length > 0 ? prosSelected[0] : '無特別亮點';
    let shortAlerts = alerts.length > 0 ? `${alerts.length}項警訊` : '無警訊';
    let short = `${status==='green'?'健康':(status==='red'?'警戒':'注意')}｜${shortPros}｜${shortAlerts}`;

    return { detail, short };
}

// ==========================================
// 6. 輔助函式與分析核心
// ==========================================
function getDefaultCompanyType(industry, isFinancial) {
    if (isFinancial) return 'financial';
    if (!industry) return 'general';
    return INDUSTRY_TO_TYPE[industry] || 'general';
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

function calcHistoricalRiskScores(quarters, effectiveType) {
    let scores = [];
    const rules = getEffectiveRules(effectiveType);
    for(let i = 0; i < quarters.length; i++) {
        let slice = quarters.slice(0, i + 1);
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
    const stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
    const data = stockDatabase[stockId];
    if (!data || !data.quarters || data.quarters.length === 0) return null;
    
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    const defaultType = getDefaultCompanyType(data.industry, data.isFinancial);
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