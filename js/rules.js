const RULES = [
  { id: 'R1', level: 'red', name: '營收連續衰退', reason: '代表本業業務持續萎縮，失去成長動能。',
    check: (qs) => {
      const last3 = qs.slice(-3);
      if (last3.length < 3) return null;
      if (last3.every(q => q.revenueYoY < 0)) return { text: `營收已連續 ${last3.length} 季年減`, tab: 'income', qs: last3.map(q=>q.q) };
      return null;
    }
  },
  { id: 'R2', level: 'red', name: '營業現金流連續為負', reason: '公司本業無法產生現金，甚至在失血，可能有流動性風險。',
    check: (qs) => {
      const last2 = qs.slice(-2);
      if (last2.length < 2) return null;
      if (last2.every(q => q.operatingCF < 0)) return { text: `營業現金流連續 ${last2.length} 季為負值`, tab: 'cashflow', qs: last2.map(q=>q.q) };
      return null;
    }
  },
  { id: 'R3', level: 'red', name: '流動比率過低', reason: '流動比率低於 1 代表一年內到期的債務大於可變現資產。',
    check: (qs) => {
      const latest = qs[qs.length - 1];
      if (latest.currentRatio < 1) return { text: `最新一季流動比率僅 ${latest.currentRatio}，低於安全值 1`, tab: 'balance', qs: [latest.q] };
      return null;
    }
  },
  { id: 'R4', level: 'red', name: '獲利與現金流背離', reason: '財報帳面上有賺錢，但卻收不到現金，獲利品質存疑。',
    check: (qs) => {
      const last2 = qs.slice(-2);
      if (last2.length < 2) return null;
      if (last2.every(q => q.netIncome > 0 && q.operatingCF < 0)) return { text: `連續 ${last2.length} 季淨利為正，但營業現金流為負`, tab: 'cashflow', qs: last2.map(q=>q.q) };
      return null;
    }
  },
  { id: 'Y1', level: 'yellow', name: '利潤率連續下滑', reason: '毛利率或營業利益率連續下滑，代表產品競爭力衰退或成本控管出問題。',
    check: (qs) => {
      if (qs.length < 4) return null;
      const q = qs.slice(-4);
      const gmDeclined = (q[3].grossMargin < q[2].grossMargin) && (q[2].grossMargin < q[1].grossMargin) && (q[1].grossMargin < q[0].grossMargin);
      const omDeclined = (q[3].operatingMargin < q[2].operatingMargin) && (q[2].operatingMargin < q[1].operatingMargin) && (q[1].operatingMargin < q[0].operatingMargin);
      if (gmDeclined || omDeclined) return { text: `毛利率或營益率已連續 3 季下滑`, tab: 'income', qs: [q[1].q, q[2].q, q[3].q] };
      return null;
    }
  },
  { id: 'Y2', level: 'yellow', name: '負債比連續上升', reason: '公司借款依賴度持續增加，財務結構轉弱。',
    check: (qs) => {
      if (qs.length < 4) return null;
      const q = qs.slice(-4);
      if ((q[3].debtRatio > q[2].debtRatio) && (q[2].debtRatio > q[1].debtRatio) && (q[1].debtRatio > q[0].debtRatio)) return { text: `負債比已連續 3 季攀升達 ${q[3].debtRatio}%`, tab: 'balance', qs: [q[1].q, q[2].q, q[3].q] };
      return null;
    }
  },
  { id: 'Y3', level: 'yellow', name: '應收帳款天數拉長', reason: '客戶拖欠貨款時間變長，可能是景氣反轉或下游客戶出問題。',
    check: (qs) => {
      if (qs.length < 4) return null;
      const q = qs.slice(-4);
      if ((q[3].arDays > q[2].arDays) && (q[2].arDays > q[1].arDays) && (q[1].arDays > q[0].arDays)) return { text: `應收帳款週轉天數連續 3 季拉長`, tab: 'balance', qs: [q[1].q, q[2].q, q[3].q] };
      return null;
    }
  },
  { id: 'Y4', level: 'yellow', name: '存貨積壓且營收衰退', reason: '存貨賣不出去且營收下滑，未來可能面臨存貨跌價損失。',
    check: (qs) => {
      if (qs.length < 4) return null;
      const q = qs.slice(-4);
      const invInc = (q[3].invDays > q[2].invDays) && (q[2].invDays > q[1].invDays) && (q[1].invDays > q[0].invDays);
      const revDec = (q[3].revenueYoY < q[2].revenueYoY) && (q[2].revenueYoY < q[1].revenueYoY) && (q[1].revenueYoY < q[0].revenueYoY);
      if (invInc && revDec) return { text: `存貨天數連續 3 季拉長，且營收同期下滑`, tab: 'balance', qs: [q[1].q, q[2].q, q[3].q] };
      return null;
    }
  }
];

function analyzeStock(stockId) {
  // 從本地快取資料庫讀取 Python 傳回來的資料，徹底拋棄舊的 data.js
  const stockDatabase = JSON.parse(localStorage.getItem('stock_database') || '{}');
  const data = stockDatabase[stockId];
  if (!data) return null;
  
  let alerts = [];
  let status = 'green';
  
  RULES.forEach(rule => {
    const res = rule.check(data.quarters);
    if (res) {
      alerts.push({ rule: rule, detail: res });
      if (rule.level === 'red') status = 'red';
      else if (status === 'green' && rule.level === 'yellow') status = 'yellow';
    }
  });
  return { alerts, status, data };
}