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
// 2. 集中管理的規則設定物件 (RULES_CONFIG)
// ==========================================
const RULES_CONFIG = {
    revenueDecline: { 
        name: "營收連續衰退", level: "red", consecutive: 3, why: (c) => `營收年增率連續 ${c.consecutive} 季為負`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.revenueYoY === null)) return { status: 'skipped' };
            if (recent.every(q => q.revenueYoY < 0)) return { status: 'alert', text: `營收年增率連續 ${config.consecutive} 季為負`, qs: recent.map(q=>q.q), tab: 'income' };
            return { status: 'pass' };
        }
    },
    lowCurrentRatio: { 
        name: "流動比率過低", level: "red", threshold: 1.0, why: (c) => `流動比率低於 ${c.threshold}`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.currentRatio === null) return { status: 'skipped' };
            if (latest.currentRatio < config.threshold) return { status: 'alert', text: `最新流動比率 ${latest.currentRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    },
    grossMarginDrop: { 
        name: "毛利率連續下滑", level: "yellow", consecutive: 2, why: (c) => `毛利率連續 ${c.consecutive} 季下滑`,
        check: (data, config) => {
            if (data.length < config.consecutive + 1) return { status: 'skipped' };
            const recent = data.slice(-(config.consecutive + 1));
            if (recent.some(q => q.grossMargin === null)) return { status: 'skipped' };
            let declining = true;
            for(let i=1; i<recent.length; i++) {
                if (recent[i].grossMargin >= recent[i-1].grossMargin) declining = false;
            }
            if (declining) return { status: 'alert', text: `毛利率連續 ${config.consecutive} 季下滑`, qs: recent.slice(1).map(q=>q.q), tab: 'income' };
            return { status: 'pass' };
        }
    },
    negativeFreeCF: { 
        name: "自由現金流連續為負", level: "red", consecutive: 2, why: (c) => `自由現金流連續 ${c.consecutive} 季小於 0`,
        check: (data, config) => {
            if (data.length < config.consecutive) return { status: 'skipped' };
            const recent = data.slice(-config.consecutive);
            if (recent.some(q => q.freeCF === null)) return { status: 'skipped' };
            if (recent.every(q => q.freeCF < 0)) return { status: 'alert', text: `自由現金流連續 ${config.consecutive} 季小於 0`, qs: recent.map(q=>q.q), tab: 'cashflow' };
            return { status: 'pass' };
        }
    },
    profitButNoCash: { 
        name: "淨利為正但無現金流入", level: "yellow", why: (c) => `單季淨利大於 0，但營業現金流為負`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.netIncome === null || latest.operatingCF === null) return { status: 'skipped' };
            if (latest.netIncome > 0 && latest.operatingCF < 0) return { status: 'alert', text: `最新季淨利為正，但營業現金流為負`, qs: [latest.q], tab: 'cashflow' };
            return { status: 'pass' };
        }
    },
    highDebtRatio: { 
        name: "負債比過高", level: "yellow", threshold: 70, why: (c) => `負債比大於 ${c.threshold}%`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.debtRatio === null) return { status: 'skipped' };
            if (latest.debtRatio > config.threshold) return { status: 'alert', text: `最新負債比 ${latest.debtRatio}% 高於 ${config.threshold}%`, qs: [latest.q], tab: 'balance' };
            return { status: 'pass' };
        }
    }
};

// ==========================================
// 3. 產業類型與規則覆蓋設定 (TYPE_PROFILES)
// ==========================================
const TYPE_PROFILES = {
    electronics: {
        label: "電子製造/半導體", desc: "資本密集，允許自由現金流短期為負(重資本支出屬正常)。",
        overrides: { negativeFreeCF: { disabled: true } }
    },
    cyclical: {
        label: "傳產/景氣循環", desc: "景氣波動大，放寬營收衰退(連續 4 季)與負債比門檻(80%)。",
        overrides: { revenueDecline: { consecutive: 4 }, highDebtRatio: { threshold: 80 } }
    },
    growth: {
        label: "成長股", desc: "重視營收成長，允許短期虧損與現金流為負(關閉淨利為正但無現金流示警)。",
        overrides: { profitButNoCash: { disabled: true } }
    },
    dividend: {
        label: "高股息/存股型", desc: "要求穩定獲利與現金流，對毛利(連續 2 季下滑)與現金流(單季為負)更嚴格。",
        overrides: { grossMarginDrop: { consecutive: 2, level: "yellow" }, profitButNoCash: { level: "red" } }
    },
    financial: {
        label: "金融業", desc: "金融業報表結構不同，流動比率、毛利、存貨等指標不適用，目前僅檢查營收趨勢與獲利趨勢。",
        overrides: { lowCurrentRatio: { disabled: true }, grossMarginDrop: { disabled: true }, negativeFreeCF: { disabled: true }, profitButNoCash: { disabled: true }, highDebtRatio: { disabled: true } }
    },
    general: {
        label: "一般 (預設)", desc: "不作任何產業調整，使用標準檢驗門檻。",
        overrides: {}
    }
};

// ==========================================
// 4. 輔助函式與分析核心
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
    
    for (const key of Object.keys(rules)) {
        const ruleConf = rules[key];
        const res = ruleConf.check(data.quarters, ruleConf);
        if (res && res.status === 'alert') {
            alerts.push({ rule: ruleConf, detail: res });
            if (ruleConf.level === 'red') status = 'red';
            else if (status === 'green' && ruleConf.level === 'yellow') status = 'yellow';
        } else if (res && res.status === 'skipped') {
            skipped.push(ruleConf);
        }
    }
    
    return { alerts, skipped, status, data, effectiveType };
}