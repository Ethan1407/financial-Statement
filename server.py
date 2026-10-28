import os
import re
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
CALC_VERSION = 3  # 運算邏輯版本號，已更新為 3

app = Flask(__name__)
CORS(app) 

START_DATE = "2019-01-01"
CACHE_DIR = os.path.join(current_dir, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# 季報與月營收獨立快取
memory_cache = {}
monthly_memory_cache = {}
CACHE_TTL = 6 * 3600  # 季報 6 小時
MONTHLY_CACHE_TTL = 12 * 3600  # 月營收 12 小時

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

# ================= 核心分析函式 (季報) =================
def process_financials(stock_id):
    info_data, err = fetch_finmind_data("TaiwanStockInfo", stock_id)
    name = f"代號 {stock_id}"
    industry = "未分類產業"
    industry_all = []
    is_financial = False
    
    if info_data:
        name = info_data[0].get("stock_name", name)
        for row in info_data:
            ind = row.get("industry_category")
            if ind and ind not in industry_all:
                industry_all.append(ind)
        
        if industry_all:
            industry = industry_all[0]
            
    fin_keywords = ["金融", "保險", "證券", "銀行"]
    if any(kw in industry for kw in fin_keywords):
        is_financial = True

    income_raw, err1 = fetch_finmind_data("TaiwanStockFinancialStatements", stock_id)
    bs_raw, err2 = fetch_finmind_data("TaiwanStockBalanceSheet", stock_id)
    cf_raw, err3 = fetch_finmind_data("TaiwanStockCashFlowsStatement", stock_id)
    
    warnings = []
    fetch_failed = False
    if err2:
        warnings.append("資產負債表抓取失敗")
        fetch_failed = True
    if err3:
        warnings.append("現金流量表抓取失敗")
        fetch_failed = True
        
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
    
    all_qs = sorted(list(set(list(income_by_q.keys()) + list(bs_by_q.keys()) + list(cf_by_q.keys()))))
    
    for q_str in all_qs:
        inc_row = income_by_q.get(q_str, {})
        bs_row = bs_by_q.get(q_str, {})
        cf_row = cf_by_q.get(q_str, {})
        
        missing = []
        if q_str not in income_by_q: missing.append("income")
        if q_str not in bs_by_q: missing.append("balance")
        if q_str not in cf_by_q: missing.append("cashflow")
        
        merged_row = {**inc_row, **bs_row, **cf_row}
        
        # --- 損益表與混合指標 ---
        revenue = scale_val(get_val(inc_row, ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]))
        cogs = scale_val(get_val(inc_row, ["CostOfGoodsSold", "營業成本", "營業成本合計"]))
        gross_profit = scale_val(get_val(inc_row, ["GrossProfit", "營業毛利", "營業毛利(毛損)"]))
        operating_income = scale_val(get_val(inc_row, ["OperatingIncome", "營業利益", "營業利益(損失)", "稅前淨利", "繼續營業單位稅前損益", "PreTaxIncome"]))
        non_operating_income = scale_val(get_val(inc_row, ["TotalNonoperatingIncomeAndExpense", "營業外收入及支出"]))
        net_income = scale_val(get_val(inc_row, ["IncomeAfterTaxes", "IncomeAfterTax", "NetIncome", "本期淨利", "本期淨利(淨損)", "本期稅後淨利", "本期稅後淨利(淨損)"]))
        eps = get_val(inc_row, ["EPS", "基本每股盈餘", "基本每股盈餘(元)"])
        
        interest_expense = scale_val(get_val(inc_row, ["FinanceCosts", "財務成本"]))
        if interest_expense is None:
            interest_expense = scale_val(get_single_q_cf(cf_by_q, q_str, ["InterestExpense", "利息費用"]))
        
        if gross_profit is None and revenue is not None and cogs is not None:
            gross_profit = revenue - cogs

        # --- 資產負債表指標 ---
        raw_assets = get_val(bs_row, ["TotalAssets", "資產總計", "資產總額"])
        raw_liabilities = get_val(bs_row, ["TotalLiabilities", "Liabilities", "負債總計", "負債總額", "負債", "負債總"])
        raw_equity = get_val(bs_row, ["TotalEquity", "Equity", "權益總計", "權益總額", "權益", "母公司業主權益", "權益總計(淨值)"])
        
        total_assets = raw_assets
        total_liabilities = raw_liabilities
        total_equity = raw_equity
        
        if total_liabilities is None and total_assets is not None and total_equity is not None:
            total_liabilities = total_assets - total_equity
            
        current_assets = get_val(bs_row, ["CurrentAssets", "流動資產", "流動資產合計"])
        current_liabilities = get_val(bs_row, ["CurrentLiabilities", "流動負債", "流動負債合計"])
        ar = scale_val(get_val(bs_row, ["AccountsReceivableNet", "AccountsReceivable", "應收帳款淨額", "應收帳款", "應收款項淨額"]))
        
        raw_inv = get_val(bs_row, ["Inventories", "Inventory", "存貨", "存貨淨額"])
        inv = scale_val(raw_inv)
        
        cash_end = scale_val(get_val(merged_row, ["CashBalancesEndOfPeriod", "期末現金及約當現金餘額", "期末現金及約當現金", "CashAndCashEquivalents", "現金及約當現金"]))

        # --- 現金流量表指標 ---
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
        
        quickRatio = None
        if current_assets is not None and current_liabilities is not None and current_liabilities != 0 and raw_inv is not None:
            quickRatio = (current_assets - raw_inv) / current_liabilities
        
        interestStatus = "missing"
        interestCoverage = None
        
        if is_financial:
            grossMargin = None
            currentRatio = None
            arDays = None
            invDays = None
            free_cf = None
            quickRatio = None
            interestCoverage = None
            interestStatus = "n/a"
        else:
            if "income" in missing or "cashflow" in missing:
                interestStatus = "missing"
            else:
                if interest_expense is not None and abs(interest_expense) > 0:
                    interestStatus = "ok"
                    interestCoverage = safe_div(operating_income, abs(interest_expense))
                else:
                    interestStatus = "none"
                    
        # --- 資料品質檢驗 ---
        qualityFlags = []
        if raw_assets is not None and raw_liabilities is not None and raw_equity is not None and raw_assets != 0:
            if abs(raw_assets - (raw_liabilities + raw_equity)) / abs(raw_assets) > 0.01:
                qualityFlags.append("BAL_MISMATCH")
                
        if not is_financial and debtRatio is not None:
            if debtRatio < 0 or debtRatio > 100:
                qualityFlags.append("DEBT_RANGE")
                
        if grossMargin is not None and (grossMargin < -100 or grossMargin > 100):
            qualityFlags.append("MARGIN_RANGE")
        if operatingMargin is not None and (operatingMargin < -100 or operatingMargin > 100) and "MARGIN_RANGE" not in qualityFlags:
            qualityFlags.append("MARGIN_RANGE")
            
        if revenue is not None and revenue <= 0:
            qualityFlags.append("REV_NEGATIVE")
            
        if quickRatio is not None and currentRatio is not None:
            if quickRatio > currentRatio:
                qualityFlags.append("QUICK_GT_CURRENT")
            elif raw_inv is not None and raw_inv > 0 and round(quickRatio, 2) == round(currentRatio, 2):
                qualityFlags.append("QUICK_EQ_CURRENT")
            
        quarters_data.append({
            "q": q_str,
            "missing": missing,
            "interestStatus": interestStatus,
            "qualityFlags": qualityFlags,
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

    op_cfs = [abs(q['operatingCF']) for q in quarters_data if q['operatingCF'] is not None]
    cf_median = 0
    if op_cfs:
        op_cfs.sort()
        mid = len(op_cfs) // 2
        cf_median = (op_cfs[mid - 1] + op_cfs[mid]) / 2.0 if len(op_cfs) % 2 == 0 else op_cfs[mid]

    for q in quarters_data:
        if q['operatingCF'] is not None and cf_median > 0:
            if abs(q['operatingCF']) > 10 * cf_median:
                q['qualityFlags'].append("CF_JUMP")
                
        if "BAL_MISMATCH" in q['qualityFlags']: warnings.append(f"{q['q']} 發現資產負債不平(誤差>1%)")
        if "DEBT_RANGE" in q['qualityFlags']: warnings.append(f"{q['q']} 負債比異常(小於0或大於100)")
        if "MARGIN_RANGE" in q['qualityFlags']: warnings.append(f"{q['q']} 利潤率異常(超出±100%)")
        if "REV_NEGATIVE" in q['qualityFlags']: warnings.append(f"{q['q']} 營收小於等於0")
        if "CF_JUMP" in q['qualityFlags']: warnings.append(f"{q['q']} 營業現金流單季絕對值暴增(可能累計相減異常)")
        if "QUICK_GT_CURRENT" in q['qualityFlags']: warnings.append(f"{q['q']} 速動比率不可能大於流動比率(邏輯異常)")
        if "QUICK_EQ_CURRENT" in q['qualityFlags']: warnings.append(f"{q['q']} 存貨大於0但速動比率四捨五入後等於流動比率(可能存貨過小)")

    latestQuarterPartial = bool(quarters_data[-1]["missing"]) if quarters_data else False
    latestCompleteQuarter = next((q["q"] for q in reversed(quarters_data) if not q["missing"]), None)

    result = {
        "calcVersion": CALC_VERSION,
        "name": name,
        "industry": industry,
        "industryAll": industry_all,
        "isFinancial": is_financial,
        "latestQuarterPartial": latestQuarterPartial,
        "latestCompleteQuarter": latestCompleteQuarter,
        "fetchedAt": datetime.utcnow().isoformat() + "Z",
        "warnings": warnings,
        "_fetch_failed": fetch_failed,
        "quarters": quarters_data
    }
    return result, None, 200

# ================= 核心分析函式 (月營收) =================
def process_monthly(stock_id):
    raw_data, err = fetch_finmind_data("TaiwanStockMonthRevenue", stock_id)
    
    if err:
        return None, err, 502
    if not raw_data:
        return None, f"找不到代號 {stock_id} 的月營收資料", 404
        
    # 印出一筆原始資料，供開發者核對欄位名稱
    if raw_data:
        print(f"[{stock_id}] 月營收原始資料範例: {raw_data[-1]}")

    rev_dict = {}
    for row in raw_data:
        # 依實際欄位判斷年、月
        if "revenue_year" in row and "revenue_month" in row:
            try:
                y = int(row["revenue_year"])
                m = int(row["revenue_month"])
            except:
                continue
        elif "date" in row:
            try:
                d = datetime.strptime(row["date"], "%Y-%m-%d")
                y, m = d.year, d.month
            except:
                continue
        else:
            continue
            
        rev_val = row.get("revenue", None)
        if rev_val is not None:
            try:
                rev_dict[(y, m)] = float(rev_val) / 1000000.0  # 轉為百萬元
            except:
                pass

    monthly_data = []
    # 將所有讀取到的年月排序
    sorted_keys = sorted(rev_dict.keys())
    
    for (y, m) in sorted_keys:
        rev = rev_dict[(y, m)]
        ym_str = f"{y}-{m:02d}"
        
        # 計算 MoM
        prev_y, prev_m = (y, m - 1) if m > 1 else (y - 1, 12)
        mom = None
        if (prev_y, prev_m) in rev_dict and rev_dict[(prev_y, prev_m)] != 0:
            mom = (rev - rev_dict[(prev_y, prev_m)]) / abs(rev_dict[(prev_y, prev_m)]) * 100
            
        # 計算 YoY
        yoy = None
        if (y - 1, m) in rev_dict and rev_dict[(y - 1, m)] != 0:
            yoy = (rev - rev_dict[(y - 1, m)]) / abs(rev_dict[(y - 1, m)]) * 100
            
        # 計算累計營收與 cumYoY
        cum_rev = sum([rev_dict[(y, i)] for i in range(1, m + 1) if (y, i) in rev_dict])
        cum_rev_last = sum([rev_dict[(y - 1, i)] for i in range(1, m + 1) if (y - 1, i) in rev_dict])
        
        has_last_year_data = any((y - 1, i) in rev_dict for i in range(1, m + 1))
        cum_yoy = None
        if has_last_year_data and cum_rev_last != 0:
            cum_yoy = (cum_rev - cum_rev_last) / abs(cum_rev_last) * 100

        monthly_data.append({
            "ym": ym_str,
            "revenue": safe_round(rev, 0),
            "mom": safe_round(mom, 2),
            "yoy": safe_round(yoy, 2),
            "cumYoY": safe_round(cum_yoy, 2)
        })

    latest_month = monthly_data[-1]["ym"] if monthly_data else None

    result = {
        "latestMonth": latest_month,
        "fetchedAt": datetime.utcnow().isoformat() + "Z",
        "months": monthly_data
    }
    return result, None, 200

# ================= 網頁呼叫路由 =================
@app.route('/api/health', methods=['GET'])
def api_health():
    return jsonify({
        "ok": True,
        "calcVersion": CALC_VERSION,
        "time": datetime.utcnow().isoformat() + "Z"
    })

@app.route('/api/stock/<stock_id>', methods=['GET'])
def api_get_stock(stock_id):
    if not re.match(r"^[0-9]{4,6}$", stock_id):
        return jsonify({"error": "股票代號格式錯誤"}), 400

    try:
        limit = int(request.args.get('limit', 8))
        if limit < 4 or limit > 24: limit = 8
    except:
        limit = 8

    force_refresh = request.args.get('refresh', '0') == '1'
    cache_file = os.path.join(CACHE_DIR, f"{stock_id}.json")
    now = time.time()
    
    if not force_refresh:
        if stock_id in memory_cache and (now - memory_cache[stock_id]['time'] < CACHE_TTL):
            res_copy = dict(memory_cache[stock_id]['data'])
            res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
            return jsonify(res_copy)
            
        if os.path.exists(cache_file):
            if now - os.path.getmtime(cache_file) < CACHE_TTL:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    memory_cache[stock_id] = {'time': os.path.getmtime(cache_file), 'data': data}
                    res_copy = dict(data)
                    res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
                    return jsonify(res_copy)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] 正在向 FinMind 爬取財報 {stock_id} (請求季數: {limit})...")
    
    result, err_msg, status_code = process_financials(stock_id)
    if err_msg:
        return jsonify({"error": err_msg}), status_code
        
    fetch_failed = result.pop("_fetch_failed", False)
    
    if not fetch_failed:
        memory_cache[stock_id] = {'time': now, 'data': result}
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

    res_copy = dict(result)
    res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']

    return jsonify(res_copy)

@app.route('/api/monthly/<stock_id>', methods=['GET'])
def api_get_monthly(stock_id):
    if not re.match(r"^[0-9]{4,6}$", stock_id):
        return jsonify({"error": "股票代號格式錯誤"}), 400

    try:
        limit = int(request.args.get('months', 24))
        if limit < 6 or limit > 60: limit = 24
    except:
        limit = 24

    force_refresh = request.args.get('refresh', '0') == '1'
    cache_file = os.path.join(CACHE_DIR, f"{stock_id}_monthly.json")
    now = time.time()
    
    # 讀取月營收快取 (TTL 12小時)
    if not force_refresh:
        if stock_id in monthly_memory_cache and (now - monthly_memory_cache[stock_id]['time'] < MONTHLY_CACHE_TTL):
            res_copy = dict(monthly_memory_cache[stock_id]['data'])
            res_copy['months'] = res_copy['months'][-limit:] if limit < len(res_copy['months']) else res_copy['months']
            return jsonify(res_copy)
            
        if os.path.exists(cache_file):
            if now - os.path.getmtime(cache_file) < MONTHLY_CACHE_TTL:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    monthly_memory_cache[stock_id] = {'time': os.path.getmtime(cache_file), 'data': data}
                    res_copy = dict(data)
                    res_copy['months'] = res_copy['months'][-limit:] if limit < len(res_copy['months']) else res_copy['months']
                    return jsonify(res_copy)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] 正在向 FinMind 爬取月營收 {stock_id} (請求月數: {limit})...")
    
    result, err_msg, status_code = process_monthly(stock_id)
    if err_msg:
        return jsonify({"error": err_msg}), status_code
        
    monthly_memory_cache[stock_id] = {'time': now, 'data': result}
    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)

    res_copy = dict(result)
    res_copy['months'] = res_copy['months'][-limit:] if limit < len(res_copy['months']) else res_copy['months']

    return jsonify(res_copy)

if __name__ == '__main__':
    is_debug = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    print(f"🚀 Python 後端 API 伺服器已啟動！(Debug Mode: {is_debug})")
    app.run(port=5000, debug=is_debug)