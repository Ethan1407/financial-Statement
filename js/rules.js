// ==========================================
// 1. 集中管理的規則設定物件 (RULES_CONFIG)
// ==========================================
const RULES_CONFIG = {
    revenueDecline: { 
        name: "營收連續衰退", 
        level: "red", 
        consecutive: 3, 
        why: (c) => `營收年增率連續 ${c.consecutive} 季為負`, check: (data, config) => { if (data.length < config.consecutive) return null; const recent = data.slice(-config.consecutive); if (recent.every(q => q.revenueYoY < 0)) return { text: `營收年增率連續 ${config.consecutive} 季為負`, qs: recent.map(q=>q.q), tab: 'income' };
            return null;
        }
    },
    lowCurrentRatio: { 
        name: "流動比率過低", 
        level: "red", 
        threshold: 1.0, 
        why: (c) => `流動比率低於 ${c.threshold}`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.currentRatio < config.threshold) return { text: `最新流動比率 ${latest.currentRatio} 低於 ${config.threshold}`, qs: [latest.q], tab: 'balance' }; return null; } }, grossMarginDrop: { name: "毛利率連續下滑", level: "yellow", consecutive: 2, why: (c) => `毛利率連續 ${c.consecutive} 季下滑`,
        check: (data, config) => {
            if (data.length < config.consecutive + 1) return null;
            const recent = data.slice(-(config.consecutive + 1));
            let declining = true;
            for(let i=1; i<recent.length; i++) {
                if (recent[i].grossMargin >= recent[i-1].grossMargin) declining = false;
            }
            if (declining) return { text: `毛利率連續 ${config.consecutive} 季下滑`, qs: recent.slice(1).map(q=>q.q), tab: 'income' }; return null; } }, negativeFreeCF: { name: "自由現金流連續為負", level: "red", consecutive: 2, why: (c) => `自由現金流連續 ${c.consecutive} 季小於 0`,
        check: (data, config) => {
            if (data.length < config.consecutive) return null;
            const recent = data.slice(-config.consecutive);
            if (recent.every(q => q.freeCF < 0)) return { text: `自由現金流連續 ${config.consecutive} 季小於 0`, qs: recent.map(q=>q.q), tab: 'cashflow' }; return null; } }, profitButNoCash: { name: "淨利為正但無現金流入", level: "yellow", why: (c) => `單季淨利大於 0，但營業現金流為負`, check: (data, config) => { const latest = data[data.length - 1]; if (latest.netIncome > 0 && latest.operatingCF < 0) return { text: `最新季淨利為正，但營業現金流為負`, qs: [latest.q], tab: 'cashflow' }; return null; } }, highDebtRatio: { name: "負債比過高", level: "yellow", threshold: 70, why: (c) => `負債比大於 ${c.threshold}%`,
        check: (data, config) => {
            const latest = data[data.length - 1];
            if (latest.debtRatio > config.threshold) return { text: `最新負債比 ${latest.debtRatio}\% 高於 ${config.threshold}%`, qs: [latest.q], tab: 'balance' };
            return null;
        }
    }
};

// ==========================================
// 2. 產業類型與規則覆蓋設定 (TYPE_PROFILES)
// ==========================================
const TYPE_PROFILES = {
    electronics: {
        label: "電子製造/半導體",
        desc: "資本密集，允許自由現金流短期為負(重資本支出屬正常)。",
        overrides: { negativeFreeCF: { disabled: true } }
    },
    cyclical: {
        label: "傳產/景氣循環",
        desc: "景氣波動大，放寬營收衰退(連續 4 季)與負債比門檻(80%)。",
        overrides: { revenueDecline: { consecutive: 4 }, highDebtRatio: { threshold: 80 } }
    },
    growth: {
        label: "成長股",
        desc: "重視營收成長，允許短期虧損與現金流為負(關閉淨利為正但無現金流示警)。",
        overrides: { profitButNoCash: { disabled: true } }
    },
    dividend: {
        label: "高股息/存股型",
        desc: "要求穩定獲利與現金流，對毛利(連續 2 季下滑亮黃燈)與現金流(單季為負直接紅燈)更嚴格。",
        overrides: { 
            grossMarginDrop: { consecutive: 2, level: "yellow" }, 
            profitButNoCash: { level: "red" } 
        }
    },
    general: {
        label: "一般 (預設)",
        desc: "不作任何產業調整，使用標準檢驗門檻。",
        overrides: {}
    }
};

// ==========================================
// 3. 輔助函式與分析核心
// ==========================================
function getDefaultCompanyType(industry) {
    if (!industry) return 'general';
    const ind = industry.toLowerCase();
    if (ind.includes("半導體") || ind.includes("電腦") || ind.includes("電子") || ind.includes("光電") || ind.includes("資訊") || ind.includes("通信")) return 'electronics';
    if (ind.includes("水泥") || ind.includes("食品") || ind.includes("塑膠") || ind.includes("紡織") || ind.includes("電機") || ind.includes("電器") || ind.includes("化學") || ind.includes("玻璃") || ind.includes("造紙") || ind.includes("鋼鐵") || ind.includes("橡膠") || ind.includes("汽車") || ind.includes("建材") || ind.includes("航運") || ind.includes("觀光") || ind.includes("貿易") || ind.includes("油電")) return 'cyclical';
    if (ind.includes("生技") || ind.includes("醫療") || ind.includes("綠能") || ind.includes("數位")) return 'growth';
    if (ind.includes("金融") || ind.includes("保險")) return 'dividend';
    return 'general';
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
    
    // 取得有效類型 (手動覆蓋優先於 API 預設)
    const overrides = JSON.parse(localStorage.getItem('typeOverrides') || '{}');
    const defaultType = getDefaultCompanyType(data.industry);
    const effectiveType = overrides[stockId] || defaultType;
    
    const rules = getEffectiveRules(effectiveType);
    
    let alerts = [];
    let status = 'green';
    
    for (const key of Object.keys(rules)) {
        const ruleConf = rules[key];
        const res = ruleConf.check(data.quarters, ruleConf);
        if (res) {
            alerts.push({ rule: ruleConf, detail: res });
            if (ruleConf.level === 'red') status = 'red';
            else if (status === 'green' && ruleConf.level === 'yellow') status = 'yellow';
        }
    }
    
    return { alerts, status, data, effectiveType };
}