import os
import requests
import json
import time
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

# ================= 載入環境變數 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(current_dir, '.env')
load_dotenv(dotenv_path=env_path, override=True)

FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")
if not FINMIND_TOKEN:
    raise ValueError("找不到 API Token！請檢查 .env")

# ================= 初始化伺服器與快取 =================
app = Flask(__name__)
CORS(app) 

START_DATE = "2019-01-01"
CACHE_DIR = os.path.join(current_dir, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)
memory_cache = {}
CACHE_TTL = 6 * 3600  # 6 小時 (秒)

# ================= 輔助函式 =================
def fetch_finmind_data(dataset, stock_id):
    url = "https://api.finmindtrade.com/api/v4/data"
    payload = {"dataset": dataset, "data_id": stock_id, "start_date": START_DATE, "token": FINMIND_TOKEN}
    try:
        resp = requests.get(url, params=payload, timeout=15)
        if resp.status_code != 200:
            return None, f"FinMind 連線錯誤 (HTTP {resp.status_code})"
        
        data = resp.json()
        if data.get("msg") != "success":
            return None, data.get("msg", "FinMind 額度可能已用完，或 API 發生錯誤")
            
        return data.get("data", []), None
    except Exception as e:
        return None, f"網路連線異常: {str(e)}"

def get_val(row_dict, keys, default=None):
    if not row_dict:
        return default
        
    normalized_row = {}
    for k, v in row_dict.items():
        clean_k = str(k).lower().replace(" ", "").replace("（", "(").replace("）", ")")
        normalized_row[clean_k] = v
        
    for k in keys:
        clean_k = str(k).lower().replace(" ", "").replace("（", "(").replace("）", ")")
        if clean_k in normalized_row:
            try:
                return float(normalized_row[clean_k])
            except (ValueError, TypeError):
                pass
    return default

def scale_val(val, factor=1000000):
    return val / factor if val is not None else None

def safe_div(n, d, mult=1):
    if n is not None and d is not None and d != 0:
        return (n / d) * mult
    return None

def safe_round(val, decimals=0):
    if val is not None:
        return round(val, decimals)
    return None

def get_single_q_cf(cf_by_q, q_str, keys):
    """現金流解累計演算法：本季累計 - 前一季累計"""
    current_ytd = get_val(cf_by_q.get(q_str, {}), keys)
    if current_ytd is None:
        return None
        
    year = int(q_str[:4])
    q_num = int(q_str[-1])
    
    if q_num == 1:
        return current_ytd
        
    prev_q_str = f"{year}Q{q_num - 1}"
    prev_ytd = get_val(cf_by_q.get(prev_q_str, {}), keys)
    
    if prev_ytd is None:
        return None
        
    return current_ytd - prev_ytd

# ================= 核心分析函式 =================
def process_financials(stock_id):
    info_data, err = fetch_finmind_data("TaiwanStockInfo", stock_id)
    name = f"代號 {stock_id}"
    industry = "未分類產業"
    is_financial = False
    
    if info_data:
        name = info_data[0].get("stock_name", name)
        industry = info_data[0].get("industry_category", industry)
        
    fin_keywords = ["金融", "保險", "證券", "銀行"]
    if any(kw in industry for kw in fin_keywords):
        is_financial = True

    income_raw, err1 = fetch_finmind_data("TaiwanStockFinancialStatements", stock_id)
    bs_raw, err2 = fetch_finmind_data("TaiwanStockBalanceSheet", stock_id)
    cf_raw, err3 = fetch_finmind_data("TaiwanStockCashFlowsStatement", stock_id)
    
    if err1: return None, err1, 502
    if not income_raw: return None, f"找不到代號 {stock_id} 的損益表資料", 404

    income_by_q = {}
    bs_by_q = {}
    cf_by_q = {}
    
    def populate_dict(raw_data, target_dict):
        if not raw_data: return
        for item in raw_data:
            date_obj = datetime.strptime(item["date"], "%Y-%m-%d")
            q_str = f"{date_obj.year}Q{((date_obj.month-1)//3) + 1}"
            if q_str not in target_dict:
                target_dict[q_str] = {}
            target_dict[q_str][item["type"]] = item["value"]
            if "origin_name" in item:
                target_dict[q_str][item["origin_name"]] = item["value"]

    populate_dict(income_raw, income_by_q)
    populate_dict(bs_raw, bs_by_q)
    populate_dict(cf_raw, cf_by_q)
    
    quarters_data = []
    
    for q_str in sorted(income_by_q.keys()):
        inc_row = income_by_q[q_str]
        bs_row = bs_by_q.get(q_str, {})
        cf_row = cf_by_q.get(q_str, {})
        
        # 為了部分會跨表出現的項目，準備合併字典
        merged_row = {**inc_row, **bs_row, **cf_row}
        
        # --- 損益表與混合指標 ---
        revenue = scale_val(get_val(inc_row, ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]))
        cogs = scale_val(get_val(inc_row, ["CostOfGoodsSold", "營業成本", "營業成本合計"]))
        gross_profit = scale_val(get_val(inc_row, ["GrossProfit", "營業毛利", "營業毛利(毛損)"]))
        
        operating_income = scale_val(get_val(inc_row, ["OperatingIncome", "營業利益", "營業利益(損失)", "稅前淨利", "繼續營業單位稅前損益", "PreTaxIncome"]))
        non_operating_income = scale_val(get_val(inc_row, ["TotalNonoperatingIncomeAndExpense", "營業外收入及支出"]))
        net_income = scale_val(get_val(inc_row, ["IncomeAfterTaxes", "IncomeAfterTax", "NetIncome", "本期淨利", "本期淨利(淨損)", "本期稅後淨利", "本期稅後淨利(淨損)"]))
        eps = get_val(inc_row, ["EPS", "基本每股盈餘", "基本每股盈餘(元)"])
        
        interest_expense = scale_val(get_val(merged_row, ["InterestExpense", "利息費用", "FinanceCosts", "財務成本", "PayTheInterest", "支付之利息"]))
        
        if gross_profit is None and revenue is not None and cogs is not None:
            gross_profit = revenue - cogs

        # --- 資產負債表指標 ---
        total_assets = get_val(bs_row, ["TotalAssets", "資產總計", "資產總額"])
        total_equity = get_val(bs_row, ["TotalEquity", "Equity", "權益總計", "權益總額", "權益", "母公司業主權益", "權益總計(淨值)"])
        total_liabilities = get_val(bs_row, ["TotalLiabilities", "Liabilities", "負債總計", "負債總額", "負債", "負債總"])
        
        if total_liabilities is None and total_assets is not None and total_equity is not None:
            total_liabilities = total_assets - total_equity
            
        current_assets = get_val(bs_row, ["CurrentAssets", "流動資產", "流動資產合計"])
        current_liabilities = get_val(bs_row, ["CurrentLiabilities", "流動負債", "流動負債合計"])
        ar = scale_val(get_val(bs_row, ["AccountsReceivableNet", "AccountsReceivable", "應收帳款淨額", "應收帳款", "應收款項淨額"]))
        inv = scale_val(get_val(bs_row, ["Inventories", "Inventory", "存貨", "存貨淨額"]))
        
        cash_end = scale_val(get_val(merged_row, ["CashBalancesEndOfPeriod", "期末現金及約當現金餘額", "期末現金及約當現金", "CashAndCashEquivalents", "現金及約當現金"]))

        # --- 現金流量表指標 (單季處理) ---
        op_cf_keys = ["NetCashFlowsFromOperatingActivities", "NetCashInflowFromOperatingActivities", "CashFlowsFromOperatingActivities", "營業活動之淨現金流入", "營業活動之淨現金流入(流出)", "營業活動之現金流量－淨額"]
        capex_keys = ["PropertyAndPlantAndEquipment", "取得不動產、廠房及設備", "取得不動產、廠房及設備(增加)減少"]
        fin_cf_keys = ["CashFlowsProvidedFromFinancingActivities", "籌資活動之淨現金流入（流出）", "籌資活動之淨現金流入", "融資活動之淨現金流入(流出)", "融資活動之淨現金流入"]
        
        operating_cf = scale_val(get_single_q_cf(cf_by_q, q_str, op_cf_keys))
        capex = scale_val(get_single_q_cf(cf_by_q, q_str, capex_keys))
        financing_cf = scale_val(get_single_q_cf(cf_by_q, q_str, fin_cf_keys))
        
        free_cf = None
        if operating_cf is not None and capex is not None:
            free_cf = operating_cf - abs(capex)
        
        # --- 衍生指標計算 ---
        current_year, quarter_num = int(q_str[:4]), q_str[4:]
        last_year_q_str = f"{current_year - 1}{quarter_num}"
        last_year_rev = scale_val(get_val(income_by_q.get(last_year_q_str, {}), ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]))
        
        revenue_yoy = safe_div((revenue - last_year_rev) if (revenue is not None and last_year_rev is not None) else None, last_year_rev, 100)
        
        grossMargin = safe_div(gross_profit, revenue, 100)
        operatingMargin = safe_div(operating_income, revenue, 100)
        debtRatio = safe_div(total_liabilities, total_assets, 100)
        currentRatio = safe_div(current_assets, current_liabilities)
        arDays = safe_div((ar * 90) if ar is not None else None, revenue)
        invDays = safe_div((inv * 90) if inv is not None else None, cogs)
        
        interestCoverage = safe_div(operating_income, abs(interest_expense) if interest_expense is not None else None)
        
        quickRatio = None
        if current_assets is not None and current_liabilities is not None and current_liabilities != 0:
            quickRatio = (current_assets - (inv if inv is not None else 0)) / current_liabilities
        
        # --- 金融股強制覆蓋 ---
        if is_financial:
            grossMargin = None
            currentRatio = None
            arDays = None
            invDays = None
            free_cf = None
            quickRatio = None
            interestCoverage = None
            
        quarters_data.append({
            "q": q_str,
            "revenue": safe_round(revenue, 0),
            "revenueYoY": safe_round(revenue_yoy, 2),
            "grossMargin": safe_round(grossMargin, 2),
            "operatingIncome": safe_round(operating_income, 0),
            "operatingMargin": safe_round(operatingMargin, 2),
            "nonOperatingIncome": safe_round(non_operating_income, 0),
            "netIncome": safe_round(net_income, 0),
            "eps": safe_round(eps, 2),
            "interestCoverage": safe_round(interestCoverage, 2),
            "debtRatio": safe_round(debtRatio, 2),
            "currentRatio": safe_round(currentRatio, 2),
            "quickRatio": safe_round(quickRatio, 2),
            "arDays": safe_round(arDays, 0), 
            "invDays": safe_round(invDays, 0), 
            "operatingCF": safe_round(operating_cf, 0), 
            "financingCF": safe_round(financing_cf, 0),
            "freeCF": safe_round(free_cf, 0),
            "cashEnd": safe_round(cash_end, 0)
        })

    final_quarters = quarters_data[-8:]
    latest_quarter = final_quarters[-1]["q"] if final_quarters else None

    result = {
        "name": name,
        "industry": industry,
        "isFinancial": is_financial,
        "latestQuarter": latest_quarter,
        "fetchedAt": datetime.utcnow().isoformat() + "Z",
        "quarters": final_quarters
    }
    return result, None, 200

# ================= 網頁呼叫路由 =================
@app.route('/api/stock/<stock_id>', methods=['GET'])
def api_get_stock(stock_id):
    force_refresh = request.args.get('refresh', '0') == '1'
    cache_file = os.path.join(CACHE_DIR, f"{stock_id}.json")
    now = time.time()
    
    if not force_refresh:
        if stock_id in memory_cache and (now - memory_cache[stock_id]['time'] < CACHE_TTL):
            return jsonify(memory_cache[stock_id]['data'])
            
        if os.path.exists(cache_file):
            if now - os.path.getmtime(cache_file) < CACHE_TTL:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    memory_cache[stock_id] = {'time': os.path.getmtime(cache_file), 'data': data}
                    return jsonify(data)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] 正在向 FinMind 爬取 {stock_id} ...")
    
    result, err_msg, status_code = process_financials(stock_id)
    if err_msg:
        return jsonify({"error": err_msg}), status_code
        
    memory_cache[stock_id] = {'time': now, 'data': result}
    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)

    return jsonify(result)

if __name__ == '__main__':
    print("🚀 Python 後端 API 伺服器已啟動！")
    app.run(port=5000, debug=True)