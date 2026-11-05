import os
import re
import requests
import time
import sys
import traceback
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from flask import Flask, jsonify, request, make_response
from flask_cors import CORS
from supabase import create_client
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
import threading
from concurrent.futures import ThreadPoolExecutor
from common import get_iso_now, safe_parse_iso, is_admin_request, TTLCache, LockRegistry

# Windows 繁中終端機預設 cp950，無法輸出 emoji，統一改用 UTF-8 避免啟動時崩潰
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ================= 載入環境變數 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(current_dir, '.env')
load_dotenv(dotenv_path=env_path, override=False)

FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS")
ADMIN_KEY = os.getenv("ADMIN_KEY")

print("=== 環境變數狀態 ===")
print(f"FINMIND_TOKEN: {'已設定' if FINMIND_TOKEN else '未設定'}")
print(f"SUPABASE_URL: {'已設定' if SUPABASE_URL else '未設定'}")
print(f"SUPABASE_SERVICE_KEY: {'已設定' if SUPABASE_KEY else '未設定'}")
print(f"ALLOWED_ORIGINS: {'已設定' if ALLOWED_ORIGINS else '未設定'}")
print(f"ADMIN_KEY: {'已設定' if ADMIN_KEY else '未設定'}")
print("====================")

supabase = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as e:
        print(f"❌ Supabase 初始化失敗，退回純記憶體模式: {e}")
else:
    print("⚠️ 提示：未偵測到 Supabase 設定，系統將以純記憶體模式運作。")

# ================= 系統常數與全域變數 =================
CALC_VERSION = 4
START_DATE = "2019-01-01"

# 個股代號；00 開頭為 ETF，沒有財報，改由 /api/etf 處理
STOCK_ID_RE = re.compile(r"^(?!00)[0-9]{4,6}$")

# 一般使用者按「更新」時，同一檔股票在此秒數內只會向 FinMind 檢查一次
MANUAL_CHECK_INTERVAL = 600

RATE_LIMIT = 30
RATE_WINDOW = 60
RATE_LIMITED_PREFIXES = ('/api/stock', '/api/monthly', '/api/news', '/api/etf', '/api/quotes')

try:
    TRUSTED_PROXY_COUNT = int(os.getenv("TRUSTED_PROXY_COUNT", 1))
except (TypeError, ValueError):
    TRUSTED_PROXY_COUNT = 1

request_history = TTLCache(ttl=RATE_WINDOW, maxsize=10000)
memory_cache = TTLCache(ttl=300)
monthly_memory_cache = TTLCache(ttl=300)
finmind_backoff = TTLCache(ttl=600)
industry_map_cache = TTLCache(ttl=86400, maxsize=1)
industry_map_lock = threading.Lock()
INDUSTRY_MAP_MAX_AGE = 7 * 86400

# 資料庫容量管理：資料超過上限的 85% 時，從最久沒更新的股票開始刪除，降到 75%
try:
    STORAGE_LIMIT_MB = int(os.getenv("SUPABASE_STORAGE_LIMIT_MB", 500))  # Supabase 免費方案資料庫上限
except (TypeError, ValueError):
    STORAGE_LIMIT_MB = 500
STORAGE_MAX_RATIO, STORAGE_TARGET_RATIO = 0.85, 0.75
storage_check_cache = TTLCache(ttl=600, maxsize=1)  # 每 10 分鐘最多檢查一次
stock_locks = LockRegistry()
global_lock = threading.Lock()

# 每日新股票完整抓取上限（每檔 4 次 FinMind API；免費帳號每小時 600 次）
try:
    FULL_FETCH_DAILY_CAP = int(os.getenv("FULL_FETCH_DAILY_CAP", 300))
except (TypeError, ValueError):
    FULL_FETCH_DAILY_CAP = 300

daily_fetches = 0
last_reset_date = ""

stats = {
    "finmind_calls": 0,
    "full_fetches_today": 0,
    "sources": {
        "db": 0, "db-verified": 0, "updated": 0, "full": 0,
        "recompute": 0, "db-stale": 0, "mem-cache": 0
    }
}

app = Flask(__name__)
# 只信任反向代理（如 Render）附加的 X-Forwarded-For，使用者自填的值無法偽造 remote_addr
if TRUSTED_PROXY_COUNT > 0:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=TRUSTED_PROXY_COUNT)
if ALLOWED_ORIGINS and ALLOWED_ORIGINS != "*":
    origins_list = [o.strip() for o in ALLOWED_ORIGINS.split(',') if o.strip()]
    CORS(app, origins=origins_list)
else:
    print("⚠️ 警告：未設定 ALLOWED_ORIGINS，CORS 將允許所有來源跨域請求！")
    CORS(app)

# ================= 全局錯誤攔截 =================
@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        return e
    print("❌ 伺服器內部錯誤:")
    traceback.print_exc()
    return jsonify({"error": f"伺服器發生非預期錯誤，請查看終端機日誌。({type(e).__name__})"}), 500

@app.route('/')
def index():
    return "Financial Statement API is running!", 200

# ================= 輔助函式 =================
def get_tw_now():
    return datetime.now(timezone.utc) + timedelta(hours=8)

def check_rate_limit(ip):
    now = time.time()
    with global_lock:
        history = [t for t in (request_history.get(ip) or []) if now - t < RATE_WINDOW]
        if len(history) >= RATE_LIMIT:
            request_history.set(ip, history)
            return False
        history.append(now)
        request_history.set(ip, history)
        return True


def record_stats(source, finmind_calls, is_full=False):
    with global_lock:
        stats["finmind_calls"] += finmind_calls
        if source in stats["sources"]:
            stats["sources"][source] += 1
        if is_full:
            stats["full_fetches_today"] += 1

def check_daily_cap():
    global daily_fetches, last_reset_date
    tw_now = get_tw_now()
    tw_date = tw_now.strftime("%Y-%m-%d")
    with global_lock:
        if tw_date != last_reset_date:
            last_reset_date = tw_date
            daily_fetches = 0
            stats["full_fetches_today"] = 0
        if daily_fetches >= FULL_FETCH_DAILY_CAP:
            return False
        daily_fetches += 1
        return True

def get_check_ttl(complete):
    override = os.getenv("CHECK_TTL_OVERRIDE_SECONDS")
    if override:
        try: return int(override)
        except: pass
    if not complete:
        return 3600
    tw_now = get_tw_now()
    month, day = tw_now.month, tw_now.day
    is_earn = (month == 1 and day >= 20) or month == 2 or (month == 3 and day <= 31) or \
              (month == 4 and day >= 15) or (month == 5 and day <= 15) or \
              (month == 7 and day >= 15) or (month == 8 and day <= 14) or \
              (month == 10 and day >= 15) or (month == 11 and day <= 14)
    return 6 * 3600 if is_earn else 3 * 86400

def get_monthly_check_ttl():
    override = os.getenv("CHECK_TTL_OVERRIDE_SECONDS")
    if override:
        try: return int(override)
        except: pass
    tw_now = get_tw_now()
    return 6 * 3600 if tw_now.day <= 12 else 2 * 86400

def get_stock_lock(stock_id):
    return stock_locks.get(stock_id)

def fetch_finmind_data(dataset, stock_id=None, start_date=START_DATE):
    """stock_id 為 None 時抓全市場資料"""
    if not FINMIND_TOKEN:
        print(f"[{stock_id}] {dataset} 請求失敗: Token 未設定")
        return None, "TOKEN_MISSING"

    if finmind_backoff.get(stock_id):
        return None, "BACKOFF"

    url = "https://api.finmindtrade.com/api/v4/data"
    payload = {"dataset": dataset, "start_date": start_date, "token": FINMIND_TOKEN}
    if stock_id:
        payload["data_id"] = stock_id
    try:
        resp = requests.get(url, params=payload, timeout=15)
        if resp.status_code != 200:
            print(f"[{stock_id}] FinMind HTTP 錯誤: {resp.status_code} - {resp.text}")
            if resp.status_code == 429:
                finmind_backoff.set(stock_id, True)
                return None, "RATE_LIMITED"
            return None, f"HTTP_{resp.status_code}"
        
        resp_json = resp.json()
        if resp_json.get("msg") != "success":
            msg = resp_json.get("msg", "unknown")
            print(f"[{stock_id}] FinMind API 錯誤: {msg}")
            # 只有明確被限制時才 backoff
            if "limit" in msg.lower(): finmind_backoff.set(stock_id, True)
            return None, f"API_ERROR: {msg}"
            
        data = resp_json.get("data", [])
        return data, None
    except requests.exceptions.Timeout:
        print(f"[{stock_id}] 請求 FinMind 發生逾時")
        return None, "TIMEOUT"
    except Exception as e:
        print(f"[{stock_id}] 網路例外: {str(e)}")
        return None, "NETWORK_ERROR"

def get_industry_map():
    """全市場 {stock_id: [產業別...]}，一次 API 取得；存在 raw_finmind (stock_id='ALL')，每 7 天更新"""
    with industry_map_lock:
        cached = industry_map_cache.get("map")
        if cached is not None:
            return cached

        industry_map, fetched_at = {}, None
        if supabase:
            try:
                res = supabase.table("raw_finmind").select("payload, fetched_at").eq("stock_id", "ALL").eq("dataset", "TaiwanStockInfo").execute()
                if res.data:
                    industry_map, fetched_at = res.data[0]["payload"] or {}, res.data[0]["fetched_at"]
            except Exception as e:
                print(f"[ALL] 產業別讀取失敗: {e}")

        if not industry_map or (datetime.now(timezone.utc) - safe_parse_iso(fetched_at)).total_seconds() > INDUSTRY_MAP_MAX_AGE:
            data, err = fetch_finmind_data("TaiwanStockInfo")
            if data:
                fresh = {}
                for row in data:
                    ind = row.get("industry_category")
                    if ind and ind not in fresh.setdefault(row["stock_id"], []):
                        fresh[row["stock_id"]].append(ind)
                industry_map = fresh
                upsert_raw_to_db("ALL", "TaiwanStockInfo", industry_map)
            elif err:
                print(f"[ALL] 產業別更新失敗 ({err})，沿用舊資料")

        industry_map_cache.set("map", industry_map)
        return industry_map

def get_holding_details(stock_ids):
    """ETF 成分股補充資料：產業別，以及已存在 Supabase 的財報（最近 8 季，供前端計算風險）"""
    industry_map = get_industry_map()
    stored = {}
    if supabase and stock_ids:
        try:
            res = supabase.table("stock_results").select("stock_id, result").in_("stock_id", stock_ids).execute()
            for row in res.data:
                result = row["result"]
                result["quarters"] = (result.get("quarters") or [])[-8:]
                stored[row["stock_id"]] = result
        except Exception as e:
            print(f"[ETF] 成分股財報讀取失敗: {e}")
    return {sid: {"industries": industry_map.get(sid, []), "financials": stored.get(sid)} for sid in stock_ids}

def get_raw_from_db(stock_id):
    if not supabase: return {}
    try:
        res = supabase.table("raw_finmind").select("dataset, payload").eq("stock_id", stock_id).execute()
        return {r["dataset"]: r["payload"] for r in res.data}
    except Exception as e:
        print(f"[{stock_id}] finmind_raw 讀取失敗: {e}")
        return None

def is_raw_incomplete(raw_dict):
    """缺公司基本資料或損益表原始資料時，視為不完整（增量更新無法補回歷史）"""
    return not raw_dict.get("TaiwanStockInfo") or not raw_dict.get("TaiwanStockFinancialStatements")

def upsert_raw_to_db(stock_id, dataset, data):
    if not supabase or not data: return
    try:
        supabase.table("raw_finmind").upsert({
            "stock_id": stock_id, "dataset": dataset, "payload": data, "fetched_at": get_iso_now()
        }).execute()
    except Exception as e:
        print(f"[{stock_id}] finmind_raw 寫入失敗 ({dataset}): {e}")

def merge_raw_data(old_data, new_data, keys=("date", "type", "origin_name")):
    if not old_data: return new_data
    if not new_data: return old_data
    data_dict = {tuple(item.get(k, "") for k in keys): item for item in old_data}
    for item in new_data:
        data_dict[tuple(item.get(k, "") for k in keys)] = item
    merged = list(data_dict.values())
    merged.sort(key=lambda x: x.get("date", ""))
    return merged

def scale_val(val, factor=1000000):
    return val / factor if val is not None else None

def safe_div(n, d, mult=1):
    return (n / d) * mult if n is not None and d is not None and d != 0 else None

def safe_round(val, decimals=0):
    return round(val, decimals) if val is not None else None

# ================= 運算引擎 =================
def compute_financials_from_raw(stock_id, raw_dict):
    info_data = raw_dict.get("TaiwanStockInfo", [])
    income_raw = raw_dict.get("TaiwanStockFinancialStatements", [])
    bs_raw = raw_dict.get("TaiwanStockBalanceSheet", [])
    cf_raw = raw_dict.get("TaiwanStockCashFlowsStatement", [])
    
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
        if industry_all: industry = industry_all[0]
            
    fin_keywords = ["金融", "保險", "證券", "銀行"]
    if any(any(kw in ind for kw in fin_keywords) for ind in industry_all):
        is_financial = True

    income_by_q, bs_by_q, cf_by_q = {}, {}, {}
    
    def populate_dict(data, target_dict):
        for item in data:
            try:
                date_obj = datetime.strptime(item["date"], "%Y-%m-%d")
                q_str = f"{date_obj.year}Q{((date_obj.month-1)//3) + 1}"
                if q_str not in target_dict: target_dict[q_str] = {}
                target_dict[q_str][item["type"]] = item["value"]
                if "origin_name" in item:
                    target_dict[q_str][item["origin_name"]] = item["value"]
            except: pass

    populate_dict(income_raw, income_by_q)
    populate_dict(bs_raw, bs_by_q)
    populate_dict(cf_raw, cf_by_q)
    
    quarters_data = []
    all_qs = sorted(list(set(list(income_by_q.keys()) + list(bs_by_q.keys()) + list(cf_by_q.keys()))))
    
    def get_val(row_dict, keys):
        if not row_dict: return None
        normalized_row = {str(k).lower().replace(" ", "").replace("（", "(").replace("）", ")"): v for k, v in row_dict.items()}
        for k in keys:
            clean_k = str(k).lower().replace(" ", "").replace("（", "(").replace("）", ")")
            if clean_k in normalized_row:
                try: return float(normalized_row[clean_k])
                except: pass
        return None
        
    def get_single_q_cf(cf_dict, q_str, keys):
        curr = get_val(cf_dict.get(q_str, {}), keys)
        if curr is None: return None
        y, q_num = int(q_str[:4]), int(q_str[-1])
        if q_num == 1: return curr
        prev = get_val(cf_dict.get(f"{y}Q{q_num - 1}", {}), keys)
        return curr - prev if prev is not None else curr

    for q_str in all_qs:
        inc_row, bs_row, cf_row = income_by_q.get(q_str, {}), bs_by_q.get(q_str, {}), cf_by_q.get(q_str, {})
        missing = []
        if not inc_row: missing.append("income")
        if not bs_row: missing.append("balance")
        if not cf_row: missing.append("cashflow")
        
        merged_row = {**inc_row, **bs_row, **cf_row}
        
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

        raw_assets = get_val(bs_row, ["TotalAssets", "資產總計", "資產總額"])
        raw_liabilities = get_val(bs_row, ["TotalLiabilities", "Liabilities", "負債總計", "負債總額", "負債", "負債總"])
        raw_equity = get_val(bs_row, ["TotalEquity", "Equity", "權益總計", "權益總額", "權益", "母公司業主權益", "權益總計(淨值)"])
        
        total_assets, total_liabilities, total_equity = raw_assets, raw_liabilities, raw_equity
        if total_liabilities is None and total_assets is not None and total_equity is not None:
            total_liabilities = total_assets - total_equity
            
        current_assets = get_val(bs_row, ["CurrentAssets", "流動資產", "流動資產合計"])
        current_liabilities = get_val(bs_row, ["CurrentLiabilities", "流動負債", "流動負債合計"])
        ar = scale_val(get_val(bs_row, ["AccountsReceivableNet", "AccountsReceivable", "應收帳款淨額", "應收帳款", "應收款項淨額"]))
        raw_inv = get_val(bs_row, ["Inventories", "Inventory", "存貨", "存貨淨額"])
        inv = scale_val(raw_inv)
        cash_end = scale_val(get_val(merged_row, ["CashBalancesEndOfPeriod", "期末現金及約當現金餘額", "期末現金及約當現金", "CashAndCashEquivalents", "現金及約當現金"]))

        op_cf_keys = ["NetCashFlowsFromOperatingActivities", "NetCashInflowFromOperatingActivities", "CashFlowsFromOperatingActivities", "營業活動之淨現金流入", "營業活動之淨現金流入(流出)", "營業活動之現金流量－淨額"]
        capex_keys = ["PropertyAndPlantAndEquipment", "取得不動產、廠房及設備", "取得不動產、廠房及設備(增加)減少"]
        fin_cf_keys = ["CashFlowsProvidedFromFinancingActivities", "籌資活動之淨現金流入（流出）", "籌資活動之淨現金流入", "融資活動之淨現金流入(流出)", "融資活動之淨現金流入"]
        
        operating_cf = scale_val(get_single_q_cf(cf_by_q, q_str, op_cf_keys))
        capex = scale_val(get_single_q_cf(cf_by_q, q_str, capex_keys))
        financing_cf = scale_val(get_single_q_cf(cf_by_q, q_str, fin_cf_keys))
        free_cf = (operating_cf - abs(capex)) if operating_cf is not None and capex is not None else None
        
        y, q_num = int(q_str[:4]), q_str[4:]
        last_year_rev = scale_val(get_val(income_by_q.get(f"{y-1}{q_num}", {}), ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]))
        revenue_yoy = safe_div((revenue - last_year_rev) if (revenue is not None and last_year_rev is not None) else None, last_year_rev, 100)
        
        grossMargin = safe_div(gross_profit, revenue, 100)
        operatingMargin = safe_div(operating_income, revenue, 100)
        debtRatio = safe_div(total_liabilities, total_assets, 100)
        currentRatio = safe_div(current_assets, current_liabilities)
        arDays = safe_div((ar * 90) if ar is not None else None, revenue)
        invDays = safe_div((inv * 90) if inv is not None else None, cogs)
        quickRatio = (current_assets - raw_inv) / current_liabilities if current_assets is not None and current_liabilities and raw_inv is not None else None
        
        interestStatus = "missing"
        interestCoverage = None
        
        if is_financial:
            grossMargin = currentRatio = arDays = invDays = free_cf = quickRatio = interestCoverage = None
            interestStatus = "n/a"
        else:
            if "income" not in missing and "cashflow" not in missing:
                if interest_expense is not None and abs(interest_expense) > 0:
                    interestStatus = "ok"
                    interestCoverage = safe_div(operating_income, abs(interest_expense))
                else:
                    interestStatus = "none"

        qualityFlags = []
        if raw_assets and raw_liabilities and raw_equity and raw_assets != 0:
            if abs(raw_assets - (raw_liabilities + raw_equity)) / abs(raw_assets) > 0.01: qualityFlags.append("BAL_MISMATCH")
        if not is_financial and debtRatio is not None and (debtRatio < 0 or debtRatio > 100): qualityFlags.append("DEBT_RANGE")
        if grossMargin is not None and (grossMargin < -100 or grossMargin > 100): qualityFlags.append("MARGIN_RANGE")
        if operatingMargin is not None and (operatingMargin < -100 or operatingMargin > 100) and "MARGIN_RANGE" not in qualityFlags: qualityFlags.append("MARGIN_RANGE")
        if revenue is not None and revenue <= 0: qualityFlags.append("REV_NEGATIVE")
        if quickRatio is not None and currentRatio is not None:
            if quickRatio > currentRatio: qualityFlags.append("QUICK_GT_CURRENT")
            elif raw_inv and raw_inv > 0 and round(quickRatio, 2) == round(currentRatio, 2): qualityFlags.append("QUICK_EQ_CURRENT")
            
        quarters_data.append({
            "q": q_str, "missing": missing, "interestStatus": interestStatus, "qualityFlags": qualityFlags,
            "revenue": safe_round(revenue, 0), "revenueYoY": safe_round(revenue_yoy, 2), "grossMargin": safe_round(grossMargin, 2),
            "operatingIncome": safe_round(operating_income, 0), "operatingMargin": safe_round(operatingMargin, 2),
            "nonOperatingIncome": safe_round(non_operating_income, 0), "netIncome": safe_round(net_income, 0), "eps": safe_round(eps, 2),
            "interestCoverage": safe_round(interestCoverage, 2), "debtRatio": safe_round(debtRatio, 2), "currentRatio": safe_round(currentRatio, 2),
            "quickRatio": safe_round(quickRatio, 2), "arDays": safe_round(arDays, 0), "invDays": safe_round(invDays, 0),
            "operatingCF": safe_round(operating_cf, 0), "financingCF": safe_round(financing_cf, 0), "freeCF": safe_round(free_cf, 0), "cashEnd": safe_round(cash_end, 0)
        })

    op_cfs = [abs(q['operatingCF']) for q in quarters_data if q['operatingCF'] is not None]
    cf_median = 0
    if op_cfs:
        op_cfs.sort()
        mid = len(op_cfs) // 2
        cf_median = (op_cfs[mid - 1] + op_cfs[mid]) / 2.0 if len(op_cfs) % 2 == 0 else op_cfs[mid]

    warnings = []
    for q in quarters_data:
        if q['operatingCF'] is not None and cf_median > 0 and abs(q['operatingCF']) > 10 * cf_median:
            q['qualityFlags'].append("CF_JUMP")
            
    for q in quarters_data[-8:]:
        if "BAL_MISMATCH" in q['qualityFlags']: warnings.append(f"{q['q']} 發現資產負債不平(誤差>1%)")
        if "DEBT_RANGE" in q['qualityFlags']: warnings.append(f"{q['q']} 負債比異常(小於0或大於100)")
        if "MARGIN_RANGE" in q['qualityFlags']: warnings.append(f"{q['q']} 利潤率異常(超出±100%)")
        if "REV_NEGATIVE" in q['qualityFlags']: warnings.append(f"{q['q']} 營收小於等於0")
        if "CF_JUMP" in q['qualityFlags']: warnings.append(f"{q['q']} 營業現金流單季絕對值暴增(可能累計相減異常)")
        if "QUICK_GT_CURRENT" in q['qualityFlags']: warnings.append(f"{q['q']} 速動比率不可能大於流動比率(邏輯異常)")
        if "QUICK_EQ_CURRENT" in q['qualityFlags']: warnings.append(f"{q['q']} 存貨大於0但速動比率四捨五入後等於流動比率(可能存貨過小)")

    latestQuarterPartial = bool(quarters_data[-1]["missing"]) if quarters_data else False
    latestCompleteQuarter = next((q["q"] for q in reversed(quarters_data) if not q["missing"]), None)
    
    latest_income_date = START_DATE
    if income_raw:
        dates = [r.get("date") for r in income_raw if r.get("date")]
        if dates: latest_income_date = max(dates)

    return {
        "calcVersion": CALC_VERSION, "name": name, "industry": industry, "industryAll": industry_all, "isFinancial": is_financial,
        "latestQuarterPartial": latestQuarterPartial, "latestCompleteQuarter": latestCompleteQuarter,
        "warnings": warnings, "quarters": quarters_data, "_latest_income_date": latest_income_date
    }

def compute_monthly_from_raw(stock_id, raw_dict):
    raw_data = raw_dict.get("TaiwanStockMonthRevenue", [])
    rev_dict = {}
    for row in raw_data:
        if "revenue_year" in row and "revenue_month" in row:
            try:
                y = int(row["revenue_year"])
                m = int(row["revenue_month"])
            except: continue
        elif "date" in row:
            try:
                d = datetime.strptime(row["date"], "%Y-%m-%d")
                y, m = d.year, d.month
            except: continue
        else: continue
            
        rev_val = row.get("revenue", None)
        if rev_val is not None:
            try: rev_dict[(y, m)] = float(rev_val) / 1000000.0
            except: pass

    monthly_data = []
    sorted_keys = sorted(rev_dict.keys())
    
    for (y, m) in sorted_keys:
        rev = rev_dict[(y, m)]
        ym_str = f"{y}-{m:02d}"
        
        prev_y, prev_m = (y, m - 1) if m > 1 else (y - 1, 12)
        mom = None
        if (prev_y, prev_m) in rev_dict and rev_dict[(prev_y, prev_m)] != 0:
            mom = (rev - rev_dict[(prev_y, prev_m)]) / abs(rev_dict[(prev_y, prev_m)]) * 100
            
        yoy = None
        if (y - 1, m) in rev_dict and rev_dict[(y - 1, m)] != 0:
            yoy = (rev - rev_dict[(y - 1, m)]) / abs(rev_dict[(y - 1, m)]) * 100
            
        cum_rev = sum([rev_dict[(y, i)] for i in range(1, m + 1) if (y, i) in rev_dict])
        cum_rev_last = sum([rev_dict[(y - 1, i)] for i in range(1, m + 1) if (y - 1, i) in rev_dict])
        
        has_last_year_data = any((y - 1, i) in rev_dict for i in range(1, m + 1))
        cum_yoy = None
        if has_last_year_data and cum_rev_last != 0:
            cum_yoy = (cum_rev - cum_rev_last) / abs(cum_rev_last) * 100

        monthly_data.append({
            "ym": ym_str, "revenue": safe_round(rev, 0), "mom": safe_round(mom, 2),
            "yoy": safe_round(yoy, 2), "cumYoY": safe_round(cum_yoy, 2)
        })

    latest_month = monthly_data[-1]["ym"] if monthly_data else None
    
    latest_date = START_DATE
    if raw_data:
        dates = [r.get("date") for r in raw_data if r.get("date")]
        if dates: latest_date = max(dates)

    return { "latestMonth": latest_month, "months": monthly_data, "_latest_date": latest_date }

# ================= 核心流 =================
def process_financials(stock_id, refresh_mode=False, allow_full=True):
    with get_stock_lock(stock_id):
        db_res = None
        db_error = False
        if supabase:
            try:
                res = supabase.table("stock_results").select("*").eq("stock_id", stock_id).execute()
                if res.data: db_res = res.data[0]
            except Exception as e:
                print(f"[{stock_id}] stock_results 讀取失敗: {e}")
                db_error = True

        if db_error:
            return None, "資料庫連線異常，暫不提供服務", 502

        if db_res:
            # 季數過少時先確認原始資料是否缺漏（例如只剩最新一季），缺漏就完整重抓
            if len(db_res.get("result", {}).get("quarters") or []) < 4:
                raw_check = get_raw_from_db(stock_id)
                if raw_check is not None and is_raw_incomplete(raw_check) and allow_full and check_daily_cap():
                    print(f"[{stock_id}] 原始資料不完整，改為完整重抓")
                    return full_fetch_financials(stock_id)

            db_calc_v = db_res.get("calc_version", 0)
            db_checked_at = db_res.get("checked_at")

            raw_dict = get_raw_from_db(stock_id) if db_calc_v < CALC_VERSION else None
            if raw_dict:
                new_res = compute_financials_from_raw(stock_id, raw_dict)
                latest_inc_date = new_res.pop("_latest_income_date")
                now_str = get_iso_now()
                try:
                    supabase.table("stock_results").upsert({
                        "stock_id": stock_id, "calc_version": CALC_VERSION, "result": new_res,
                        "latest_income_date": latest_inc_date, "latest_quarter": new_res.get("latestCompleteQuarter"),
                        "complete": not new_res.get("latestQuarterPartial"), "checked_at": db_checked_at, "updated_at": now_str
                    }).execute()
                except Exception: pass
                db_res = {"calc_version": CALC_VERSION, "result": new_res, "checked_at": db_checked_at, "complete": not new_res.get("latestQuarterPartial"), "latest_income_date": latest_inc_date, "updated_at": now_str}
                record_stats("recompute", 0)
                source = "recompute"
                finmind_calls = 0
            else:
                source = "db"
                finmind_calls = 0

            db_checked_at = db_res.get("checked_at")
            db_complete = db_res.get("complete", True)
            
            ttl = get_check_ttl(db_complete)
            if refresh_mode == "check": ttl = min(ttl, MANUAL_CHECK_INTERVAL)
            dt_checked = safe_parse_iso(db_checked_at)
            
            if (datetime.now(timezone.utc) - dt_checked).total_seconds() < ttl and refresh_mode != "force":
                result = db_res["result"]
                result["meta"] = {"source": source, "finmindCalls": finmind_calls, "checkedAt": db_checked_at, "stale": False}
                result["_updated_at"] = db_res.get("updated_at", get_iso_now())
                if source == "db": record_stats("db", 0)
                return result, None, 200

            probe_start = db_res.get("latest_income_date", START_DATE)
            probe_data, err = fetch_finmind_data("TaiwanStockFinancialStatements", stock_id, probe_start)
            
            if err:
                res = db_res["result"]
                res["warnings"].append(f"FinMind 更新失敗 ({err})，目前為過期快取資料")
                res["meta"] = {"source": "db-stale", "finmindCalls": 0 if err in ["BACKOFF", "TOKEN_MISSING"] else 1, "checkedAt": db_checked_at, "stale": True}
                res["_updated_at"] = db_res.get("updated_at", get_iso_now())
                record_stats("db-stale", 0 if err in ["BACKOFF", "TOKEN_MISSING"] else 1)
                return res, None, 200
                
            new_max_date = max([item.get("date", "") for item in probe_data]) if probe_data else START_DATE
            raw_dict = get_raw_from_db(stock_id)
            if raw_dict is None:
                res = db_res["result"]
                res["meta"] = {"source": "db-stale", "finmindCalls": 1, "checkedAt": db_checked_at, "stale": True}
                res["_updated_at"] = db_res.get("updated_at", get_iso_now())
                record_stats("db-stale", 1)
                return res, None, 200
            # 增量合併的前提是歷史原始資料完整，缺漏時合併只會剩下最新一季
            if is_raw_incomplete(raw_dict) and allow_full and check_daily_cap():
                print(f"[{stock_id}] 原始資料不完整，改為完整重抓")
                return full_fetch_financials(stock_id)
            old_income = raw_dict.get("TaiwanStockFinancialStatements", [])
            old_max_date = db_res.get("latest_income_date", START_DATE)
            
            finmind_calls = 1
            need_recompute = False
            
            if new_max_date > old_max_date:
                with ThreadPoolExecutor(max_workers=2) as executor:
                    f1 = executor.submit(fetch_finmind_data, "TaiwanStockBalanceSheet", stock_id, probe_start)
                    f2 = executor.submit(fetch_finmind_data, "TaiwanStockCashFlowsStatement", stock_id, probe_start)
                    bs_data, _ = f1.result()
                    cf_data, _ = f2.result()
                
                finmind_calls = 3
                raw_dict["TaiwanStockFinancialStatements"] = merge_raw_data(old_income, probe_data)
                if bs_data: raw_dict["TaiwanStockBalanceSheet"] = merge_raw_data(raw_dict.get("TaiwanStockBalanceSheet", []), bs_data)
                if cf_data: raw_dict["TaiwanStockCashFlowsStatement"] = merge_raw_data(raw_dict.get("TaiwanStockCashFlowsStatement", []), cf_data)
                
                upsert_raw_to_db(stock_id, "TaiwanStockFinancialStatements", raw_dict["TaiwanStockFinancialStatements"])
                if bs_data: upsert_raw_to_db(stock_id, "TaiwanStockBalanceSheet", raw_dict["TaiwanStockBalanceSheet"])
                if cf_data: upsert_raw_to_db(stock_id, "TaiwanStockCashFlowsStatement", raw_dict["TaiwanStockCashFlowsStatement"])
                need_recompute = True
                source = "updated"
                
            else:
                probe_dict = {(i.get("date"), i.get("type"), i.get("origin_name")): i.get("value") for i in probe_data}
                old_dict = {(i.get("date"), i.get("type"), i.get("origin_name")): i.get("value") for i in old_income if i.get("date") >= probe_start}
                
                if any(probe_dict.get(k) != old_dict.get(k) for k in probe_dict):
                    raw_dict["TaiwanStockFinancialStatements"] = merge_raw_data(old_income, probe_data)
                    upsert_raw_to_db(stock_id, "TaiwanStockFinancialStatements", raw_dict["TaiwanStockFinancialStatements"])
                    need_recompute = True
                    source = "updated"
                else:
                    if not db_complete:
                        with ThreadPoolExecutor(max_workers=2) as executor:
                            f1 = executor.submit(fetch_finmind_data, "TaiwanStockBalanceSheet", stock_id, probe_start)
                            f2 = executor.submit(fetch_finmind_data, "TaiwanStockCashFlowsStatement", stock_id, probe_start)
                            bs_data, _ = f1.result()
                            cf_data, _ = f2.result()
                        finmind_calls = 3
                        if bs_data: raw_dict["TaiwanStockBalanceSheet"] = merge_raw_data(raw_dict.get("TaiwanStockBalanceSheet", []), bs_data)
                        if cf_data: raw_dict["TaiwanStockCashFlowsStatement"] = merge_raw_data(raw_dict.get("TaiwanStockCashFlowsStatement", []), cf_data)
                        if bs_data: upsert_raw_to_db(stock_id, "TaiwanStockBalanceSheet", raw_dict["TaiwanStockBalanceSheet"])
                        if cf_data: upsert_raw_to_db(stock_id, "TaiwanStockCashFlowsStatement", raw_dict["TaiwanStockCashFlowsStatement"])
                        need_recompute = True
                        source = "updated"
                    else:
                        need_recompute = False
                        source = "db-verified"

            now_str = get_iso_now()
            updated_at_val = now_str
            if need_recompute:
                new_res = compute_financials_from_raw(stock_id, raw_dict)
                latest_inc_date = new_res.pop("_latest_income_date")
                try:
                    supabase.table("stock_results").upsert({
                        "stock_id": stock_id, "calc_version": CALC_VERSION, "result": new_res,
                        "latest_income_date": latest_inc_date, "latest_quarter": new_res.get("latestCompleteQuarter"),
                        "complete": not new_res.get("latestQuarterPartial"), "checked_at": now_str, "updated_at": now_str
                    }).execute()
                except Exception: pass
                result = new_res
            else:
                try:
                    supabase.table("stock_results").update({"checked_at": now_str}).eq("stock_id", stock_id).execute()
                except Exception: pass
                result = db_res["result"]
                updated_at_val = db_res.get("updated_at", now_str)
                
            result["meta"] = {"source": source, "finmindCalls": finmind_calls, "checkedAt": now_str, "stale": False}
            result["_updated_at"] = updated_at_val
            record_stats(source, finmind_calls)
            return result, None, 200

        else:
            if not allow_full:
                return None, "尚未建立資料，請單獨查詢", 404
                
            if not check_daily_cap():
                return None, "今日伺服器免費配額已滿，請明天再試", 429
            return full_fetch_financials(stock_id)

def ensure_storage_capacity():
    """新增股票前確認資料庫容量，不足時由 Supabase 函式淘汰最舊的股票資料"""
    if not supabase or storage_check_cache.get("checked"):
        return
    storage_check_cache.set("checked", True)
    limit = STORAGE_LIMIT_MB * 1024 * 1024
    try:
        res = supabase.rpc("ensure_storage_capacity", {
            "max_bytes": int(limit * STORAGE_MAX_RATIO), "target_bytes": int(limit * STORAGE_TARGET_RATIO)
        }).execute()
    except Exception as e:
        print(f"⚠️ 資料庫容量檢查失敗: {e}")
        return
    evicted = res.data or []
    if evicted:
        print(f"⚠️ 資料庫容量超過 {STORAGE_MAX_RATIO:.0%}，已刪除最久沒更新的 {len(evicted)} 檔: {', '.join(evicted)}")
        for sid in evicted:
            memory_cache.pop(f"{sid}_v{CALC_VERSION}")
            monthly_memory_cache.pop(f"{sid}_monthly")

def full_fetch_financials(stock_id):
    """從 START_DATE 起完整抓取四個資料集並重算。呼叫端需持有 stock lock 並已通過 check_daily_cap。"""
    ensure_storage_capacity()
    # 先抓損益表確認有財報，查無資料（代號不存在）只花 1 次 API，也不寫入 DB
    income_data, err = fetch_finmind_data("TaiwanStockFinancialStatements", stock_id)
    if err:
        return None, f"獲取新股票資料失敗 ({err})", 502
    if not income_data:
        return None, "查無此股票的財報資料", 404

    with ThreadPoolExecutor(max_workers=3) as executor:
        fs = {ds: executor.submit(fetch_finmind_data, ds, stock_id)
              for ds in ("TaiwanStockInfo", "TaiwanStockBalanceSheet", "TaiwanStockCashFlowsStatement")}
        raw_dict = {ds: f.result()[0] or [] for ds, f in fs.items()}
    raw_dict["TaiwanStockFinancialStatements"] = income_data

    for ds, data in raw_dict.items():
        upsert_raw_to_db(stock_id, ds, data)

    new_res = compute_financials_from_raw(stock_id, raw_dict)
    latest_inc_date = new_res.pop("_latest_income_date")
    now_str = get_iso_now()

    try:
        supabase.table("stock_results").upsert({
            "stock_id": stock_id, "calc_version": CALC_VERSION, "result": new_res,
            "latest_income_date": latest_inc_date, "latest_quarter": new_res.get("latestCompleteQuarter"),
            "complete": not new_res.get("latestQuarterPartial"), "checked_at": now_str, "updated_at": now_str
        }).execute()
    except Exception: pass

    new_res["meta"] = {"source": "full", "finmindCalls": 4, "checkedAt": now_str, "stale": False}
    new_res["_updated_at"] = now_str
    record_stats("full", 4, is_full=True)
    return new_res, None, 200

def process_monthly(stock_id, refresh_mode=False):
    with get_stock_lock(stock_id):
        db_res = None
        db_error = False
        if supabase:
            try:
                res = supabase.table("monthly_results").select("*").eq("stock_id", stock_id).execute()
                if res.data: db_res = res.data[0]
            except Exception:
                db_error = True

        if db_error:
            return None, "資料庫連線異常，暫不提供服務", 502

        if db_res:
            db_checked_at = db_res.get("checked_at")
            ttl = get_monthly_check_ttl()
            if refresh_mode == "check": ttl = min(ttl, MANUAL_CHECK_INTERVAL)
            dt_checked = safe_parse_iso(db_checked_at)
            
            if (datetime.now(timezone.utc) - dt_checked).total_seconds() < ttl and refresh_mode != "force":
                result = db_res["result"]
                result["meta"] = {"source": "db", "finmindCalls": 0, "checkedAt": db_checked_at, "stale": False}
                result["_updated_at"] = db_res.get("updated_at", get_iso_now())
                record_stats("db", 0)
                return result, None, 200

            probe_start = db_res.get("latest_date", START_DATE)
            probe_data, err = fetch_finmind_data("TaiwanStockMonthRevenue", stock_id, probe_start)
            
            if err:
                res = db_res["result"]
                res["meta"] = {"source": "db-stale", "finmindCalls": 0 if err in ["BACKOFF", "TOKEN_MISSING"] else 1, "checkedAt": db_checked_at, "stale": True}
                res["_updated_at"] = db_res.get("updated_at", get_iso_now())
                record_stats("db-stale", 0 if err in ["BACKOFF", "TOKEN_MISSING"] else 1)
                return res, None, 200
                
            new_max_date = max([item.get("date", "") for item in probe_data]) if probe_data else START_DATE
            raw_dict = get_raw_from_db(stock_id)
            if raw_dict is None:
                res = db_res["result"]
                res["meta"] = {"source": "db-stale", "finmindCalls": 1, "checkedAt": db_checked_at, "stale": True}
                res["_updated_at"] = db_res.get("updated_at", get_iso_now())
                record_stats("db-stale", 1)
                return res, None, 200
            # 沒有歷史月營收原始資料時，增量合併只會剩最新幾個月，改走完整重抓
            if not raw_dict.get("TaiwanStockMonthRevenue") and check_daily_cap():
                print(f"[{stock_id}] 月營收原始資料不存在，改為完整重抓")
                return full_fetch_monthly(stock_id)
            old_revenue = raw_dict.get("TaiwanStockMonthRevenue", [])
            old_max_date = db_res.get("latest_date", START_DATE)
            
            finmind_calls = 1
            need_recompute = False
            
            if new_max_date > old_max_date:
                raw_dict["TaiwanStockMonthRevenue"] = merge_raw_data(old_revenue, probe_data)
                upsert_raw_to_db(stock_id, "TaiwanStockMonthRevenue", raw_dict["TaiwanStockMonthRevenue"])
                need_recompute = True
                source = "updated"
            else:
                probe_dict = {(i.get("date"), i.get("type"), i.get("origin_name")): i.get("value") for i in probe_data}
                old_dict = {(i.get("date"), i.get("type"), i.get("origin_name")): i.get("value") for i in old_revenue if i.get("date") >= probe_start}
                
                if any(probe_dict.get(k) != old_dict.get(k) for k in probe_dict):
                    raw_dict["TaiwanStockMonthRevenue"] = merge_raw_data(old_revenue, probe_data)
                    upsert_raw_to_db(stock_id, "TaiwanStockMonthRevenue", raw_dict["TaiwanStockMonthRevenue"])
                    need_recompute = True
                    source = "updated"
                else:
                    need_recompute = False
                    source = "db-verified"

            now_str = get_iso_now()
            updated_at_val = now_str
            if need_recompute:
                new_res = compute_monthly_from_raw(stock_id, raw_dict)
                latest_date = new_res.pop("_latest_date")
                try:
                    supabase.table("monthly_results").upsert({
                        "stock_id": stock_id, "result": new_res,
                        "latest_date": latest_date, "checked_at": now_str, "updated_at": now_str
                    }).execute()
                except Exception: pass
                result = new_res
            else:
                try:
                    supabase.table("monthly_results").update({"checked_at": now_str}).eq("stock_id", stock_id).execute()
                except Exception: pass
                result = db_res["result"]
                updated_at_val = db_res.get("updated_at", now_str)
                
            result["fetchedAt"] = now_str
            result["meta"] = {"source": source, "finmindCalls": finmind_calls, "checkedAt": now_str, "stale": False}
            result["_updated_at"] = updated_at_val
            record_stats(source, finmind_calls)
            return result, None, 200

        else:
            if not check_daily_cap():
                return None, "今日伺服器免費配額已滿，請明天再試", 429
            return full_fetch_monthly(stock_id)

def full_fetch_monthly(stock_id):
    """從 START_DATE 起完整抓取月營收並重算。呼叫端需持有 stock lock 並已通過 check_daily_cap。"""
    probe_data, err = fetch_finmind_data("TaiwanStockMonthRevenue", stock_id)
    if err:
        return None, f"獲取新股票資料失敗 ({err})", 502
    if not probe_data:
        return None, "查無此股票的月營收資料", 404

    raw_dict = {"TaiwanStockMonthRevenue": probe_data}
    upsert_raw_to_db(stock_id, "TaiwanStockMonthRevenue", probe_data)

    new_res = compute_monthly_from_raw(stock_id, raw_dict)
    latest_date = new_res.pop("_latest_date")
    now_str = get_iso_now()

    try:
        supabase.table("monthly_results").upsert({
            "stock_id": stock_id, "result": new_res,
            "latest_date": latest_date, "checked_at": now_str, "updated_at": now_str
        }).execute()
    except Exception: pass

    new_res["fetchedAt"] = now_str
    new_res["meta"] = {"source": "full", "finmindCalls": 1, "checkedAt": now_str, "stale": False}
    new_res["_updated_at"] = now_str
    record_stats("full", 1)
    return new_res, None, 200

# ================= 網頁呼叫路由 =================
@app.before_request
def before_request_hook():
    if request.method == 'OPTIONS':
        return
    if request.path.startswith(RATE_LIMITED_PREFIXES):
        if not check_rate_limit(request.remote_addr or "unknown"):
            return jsonify({"error": "請求過於頻繁，請稍後再試"}), 429

def get_refresh_mode():
    """?refresh=1：管理員為強制更新 (force)；一般使用者為手動檢查 (check)，受 MANUAL_CHECK_INTERVAL 限制"""
    if request.args.get('refresh') not in ('1', 'full'):
        return False
    return "force" if is_admin_request() else "check"

def generate_etag(stock_id, updated_at, limit):
    return f'W/"{stock_id}-v{CALC_VERSION}-{updated_at}-{limit}"'

@app.route('/api/health', methods=['GET'])
def api_health():
    db_ok = False
    db_err = "Not Configured"
    if supabase:
        try:
            supabase.table("stock_results").select("stock_id").limit(1).execute()
            db_ok = True
            db_err = ""
        except Exception as e:
            db_err = type(e).__name__
    return jsonify({
        "ok": True,
        "calcVersion": CALC_VERSION,
        "time": get_iso_now(),
        "python_version": sys.version,
        "env_vars": {
            "FINMIND_TOKEN": bool(FINMIND_TOKEN),
            "SUPABASE_URL": bool(SUPABASE_URL),
            "SUPABASE_SERVICE_KEY": bool(SUPABASE_KEY),
            "ALLOWED_ORIGINS": bool(ALLOWED_ORIGINS),
            "ADMIN_KEY": bool(ADMIN_KEY)
        },
        "supabase_connected": db_ok,
        "supabase_error": db_err
    })

@app.route('/api/stock/<stock_id>', methods=['GET'])
def api_get_stock(stock_id):
    if not STOCK_ID_RE.match(stock_id):
        return jsonify({"error": "股票代號格式錯誤"}), 400
    try:
        limit = int(request.args.get('limit', 8))
        if limit < 4 or limit > 24: limit = 8
    except:
        limit = 8

    refresh_mode = get_refresh_mode()

    cache_key = f"{stock_id}_v{CALC_VERSION}"
    cached = None if refresh_mode else memory_cache.get(cache_key)
    if cached:
        etag = generate_etag(stock_id, cached.get('_updated_at', ''), limit)
        if request.headers.get('If-None-Match') == etag:
            resp = make_response('', 304)
            resp.headers['ETag'] = etag
            return resp
        res_copy = dict(cached)
        res_copy.pop("_updated_at", None)
        res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
        record_stats("mem-cache", 0)
        print(f"[{stock_id}] meta.source: mem-cache | finmindCalls: 0")
        response = make_response(jsonify(res_copy))
        response.headers['ETag'] = etag
        response.headers['Cache-Control'] = 'no-cache'
        return response

    result, err_msg, status_code = process_financials(stock_id, refresh_mode)
    if err_msg:
        return jsonify({"error": err_msg}), status_code
        
    print(f"[{stock_id}] meta.source: {result.get('meta', {}).get('source')} | finmindCalls: {result.get('meta', {}).get('finmindCalls', 0)}")
    
    updated_at = result.get("_updated_at", "")
    etag = generate_etag(stock_id, updated_at, limit)
    
    memory_cache.set(cache_key, result)
    
    if request.headers.get('If-None-Match') == etag:
        resp = make_response('', 304)
        resp.headers['ETag'] = etag
        return resp
        
    res_copy = dict(result)
    res_copy.pop("_updated_at", None)
    res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
    response = make_response(jsonify(res_copy))
    response.headers['ETag'] = etag
    response.headers['Cache-Control'] = 'no-cache'
    return response

@app.route('/api/stocks', methods=['GET'])
def api_get_stocks_batch():
    ids_str = request.args.get('ids', '')
    if not ids_str:
        return jsonify({"error": "必須提供 ids 參數"}), 400
        
    stock_ids = [sid.strip() for sid in ids_str.split(',') if sid.strip()]
    if len(stock_ids) > 20:
        return jsonify({"error": "每次最多只能查詢 20 檔股票"}), 400
        
    for sid in stock_ids:
        if not STOCK_ID_RE.match(sid):
            return jsonify({"error": f"股票代號 {sid} 格式錯誤"}), 400

    try:
        limit = int(request.args.get('limit', 8))
        if limit < 4 or limit > 24: limit = 8
    except:
        limit = 8
        
    refresh_mode = get_refresh_mode()

    results = {}
    errors = {}
    full_fetch_count = 0
    start_time = time.time()
    
    for sid in stock_ids:
        if time.time() - start_time > 45:
            errors[sid] = "伺服器處理時間不足，請分批查詢"
            continue

        cache_key = f"{sid}_v{CALC_VERSION}"
        cached = None if refresh_mode else memory_cache.get(cache_key)
        if cached:
            res_copy = dict(cached)
            res_copy.pop("_updated_at", None)
            res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
            results[sid] = res_copy
            record_stats("mem-cache", 0)
            print(f"[{sid}] batch meta.source: mem-cache | finmindCalls: 0")
            continue
            
        allow_full = False
        if supabase:
            try:
                db_check = supabase.table("stock_results").select("stock_id").eq("stock_id", sid).execute()
                if db_check.data:
                    allow_full = True
                elif full_fetch_count < 3:
                    allow_full = True
                    full_fetch_count += 1
            except: pass
            
        res, err, status = process_financials(sid, refresh_mode=refresh_mode, allow_full=allow_full)
        if err:
            errors[sid] = err
        else:
            memory_cache.set(cache_key, res)
            print(f"[{sid}] batch meta.source: {res.get('meta', {}).get('source')} | finmindCalls: {res.get('meta', {}).get('finmindCalls', 0)}")
            res_copy = dict(res)
            res_copy.pop("_updated_at", None)
            res_copy['quarters'] = res_copy['quarters'][-limit:] if limit < len(res_copy['quarters']) else res_copy['quarters']
            results[sid] = res_copy

    return jsonify({"results": results, "errors": errors})

@app.route('/api/monthly/<stock_id>', methods=['GET'])
def api_get_monthly(stock_id):
    if not STOCK_ID_RE.match(stock_id):
        return jsonify({"error": "股票代號格式錯誤"}), 400
    try:
        limit = int(request.args.get('months', 24))
        if limit < 6 or limit > 60: limit = 24
    except:
        limit = 24

    refresh_mode = get_refresh_mode()

    cache_key = f"{stock_id}_monthly"
    cached = None if refresh_mode else monthly_memory_cache.get(cache_key)
    if cached:
        etag = generate_etag(stock_id, cached.get('_updated_at', ''), limit)
        if request.headers.get('If-None-Match') == etag:
            resp = make_response('', 304)
            resp.headers['ETag'] = etag
            return resp
        res_copy = dict(cached)
        res_copy.pop("_updated_at", None)
        res_copy['months'] = res_copy['months'][-limit:] if limit < len(res_copy['months']) else res_copy['months']
        record_stats("mem-cache", 0)
        print(f"[{stock_id}] monthly meta.source: mem-cache | finmindCalls: 0")
        response = make_response(jsonify(res_copy))
        response.headers['ETag'] = etag
        response.headers['Cache-Control'] = 'no-cache'
        return response

    result, err_msg, status_code = process_monthly(stock_id, refresh_mode)
    if err_msg:
        return jsonify({"error": err_msg}), status_code
        
    print(f"[{stock_id}] monthly meta.source: {result.get('meta', {}).get('source')} | finmindCalls: {result.get('meta', {}).get('finmindCalls', 0)}")
    
    updated_at = result.get("_updated_at", "")
    etag = generate_etag(stock_id, updated_at, limit)
    
    monthly_memory_cache.set(cache_key, result)
    
    if request.headers.get('If-None-Match') == etag:
        resp = make_response('', 304)
        resp.headers['ETag'] = etag
        return resp
        
    res_copy = dict(result)
    res_copy.pop("_updated_at", None)
    res_copy['months'] = res_copy['months'][-limit:] if limit < len(res_copy['months']) else res_copy['months']
    response = make_response(jsonify(res_copy))
    response.headers['ETag'] = etag
    response.headers['Cache-Control'] = 'no-cache'
    return response

# ================= 管理路由 =================
@app.route('/api/admin/recompute/<stock_id>', methods=['POST'])
def admin_recompute(stock_id):
    if not is_admin_request():
        return jsonify({"error": "權限不足"}), 403
    raw_dict = get_raw_from_db(stock_id)
    if not raw_dict:
        return jsonify({"error": "無原始資料"}), 404
        
    new_res = compute_financials_from_raw(stock_id, raw_dict)
    latest_inc_date = new_res.pop("_latest_income_date")
    now_str = get_iso_now()
    try:
        supabase.table("stock_results").upsert({
            "stock_id": stock_id, "calc_version": CALC_VERSION, "result": new_res,
            "latest_income_date": latest_inc_date, "latest_quarter": new_res.get("latestCompleteQuarter"),
            "complete": not new_res.get("latestQuarterPartial"),
            "checked_at": now_str, "updated_at": now_str
        }).execute()
    except Exception as e:
        print(f"[{stock_id}] admin_recompute 寫入失敗: {e}")

    if "TaiwanStockMonthRevenue" in raw_dict:
        m_res = compute_monthly_from_raw(stock_id, raw_dict)
        m_latest = m_res.pop("_latest_date")
        try:
            supabase.table("monthly_results").upsert({
                "stock_id": stock_id, "result": m_res,
                "latest_date": m_latest,
                "checked_at": now_str, "updated_at": now_str
            }).execute()
        except Exception as e:
            pass
        
    return jsonify({"msg": "重算完成", "stock_id": stock_id})

@app.route('/api/admin/recompute-all', methods=['POST'])
def admin_recompute_all():
    if not is_admin_request():
        return jsonify({"error": "權限不足"}), 403
    try:
        res = supabase.table("stock_results").select("stock_id").execute()
        stocks = [r["stock_id"] for r in res.data]
    except Exception as e:
        return jsonify({"error": str(e)}), 500
        
    for sid in stocks:
        raw_dict = get_raw_from_db(sid)
        if raw_dict:
            new_res = compute_financials_from_raw(sid, raw_dict)
            latest_inc_date = new_res.pop("_latest_income_date")
            now_str = get_iso_now()
            try:
                supabase.table("stock_results").upsert({
                    "stock_id": sid, "calc_version": CALC_VERSION, "result": new_res,
                    "latest_income_date": latest_inc_date, "latest_quarter": new_res.get("latestCompleteQuarter"),
                    "complete": not new_res.get("latestQuarterPartial"),
                    "checked_at": now_str, "updated_at": now_str
                }).execute()
            except Exception:
                pass
            
            if "TaiwanStockMonthRevenue" in raw_dict:
                m_res = compute_monthly_from_raw(sid, raw_dict)
                m_latest = m_res.pop("_latest_date")
                try:
                    supabase.table("monthly_results").upsert({
                        "stock_id": sid, "result": m_res,
                        "latest_date": m_latest,
                        "checked_at": now_str, "updated_at": now_str
                    }).execute()
                except Exception:
                    pass
    return jsonify({"msg": f"共 {len(stocks)} 檔股票重算完成"})

@app.route('/api/admin/clear-cache', methods=['POST'])
def admin_clear_cache():
    if not is_admin_request():
        return jsonify({"error": "權限不足"}), 403
    memory_cache.clear()
    monthly_memory_cache.clear()
    return jsonify({"msg": "記憶體快取已清空"})

@app.route('/api/admin/stats', methods=['GET'])
def api_admin_stats():
    if not is_admin_request():
        return jsonify({"error": "權限不足"}), 403
    storage = None
    if supabase:
        try:
            used = supabase.rpc("storage_used_bytes").execute().data
            storage = {"usedMB": round(used / 1048576, 1), "limitMB": STORAGE_LIMIT_MB, "ratio": round(used / (STORAGE_LIMIT_MB * 1048576), 3)}
        except Exception as e:
            storage = {"error": type(e).__name__}
    return jsonify({**stats, "storage": storage})

from news import register_news
from etf import register_etf
from quotes import register_quotes
register_news(app, supabase=supabase)
register_etf(app, supabase=supabase, get_holding_details=get_holding_details)
register_quotes(app, get_industry_map=get_industry_map)

if __name__ == '__main__':
    is_debug = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=is_debug)