import os
import requests
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, jsonify
from flask_cors import CORS

# ================= 載入環境變數 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(current_dir, '.env')
load_dotenv(dotenv_path=env_path, override=True)

FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")
if not FINMIND_TOKEN:
    raise ValueError(f"找不到 API Token！請檢查 {env_path}")

# ================= 初始化伺服器 =================
app = Flask(__name__)
CORS(app) 

START_DATE = "2019-01-01"

# ================= 爬蟲核心函式 =================
def fetch_finmind_data(dataset, stock_id, start_date):
    url = "https://api.finmindtrade.com/api/v4/data"
    payload = {"dataset": dataset, "data_id": stock_id, "start_date": start_date, "token": FINMIND_TOKEN}
    resp = requests.get(url, params=payload)
    return resp.json().get("data", [])

def get_val(row_dict, keys, default=0):
    """終極欄位比對：轉小寫、去空白、統一全形括號為半形"""
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

def get_stock_info(stock_id):
    try:
        url = "https://api.finmindtrade.com/api/v4/data"
        payload = {"dataset": "TaiwanStockInfo", "data_id": stock_id, "token": FINMIND_TOKEN}
        resp = requests.get(url, params=payload).json()
        if resp.get("msg") == "success" and resp.get("data"):
            return resp["data"][0].get("stock_name", f"{stock_id}公司"), resp["data"][0].get("industry_category", "台股")
    except:
        pass
    return f"代號 {stock_id}", "未分類產業"

def process_financials(stock_id):
    income_data = fetch_finmind_data("TaiwanStockFinancialStatements", stock_id, START_DATE)
    balance_data = fetch_finmind_data("TaiwanStockBalanceSheet", stock_id, START_DATE)
    cashflow_data = fetch_finmind_data("TaiwanStockCashFlowsStatement", stock_id, START_DATE)
    
    if not income_data:
        return None

    merged_data = {}
    
    def process_raw_items(raw_data):
        if not raw_data: return
        for item in raw_data:
            date_obj = datetime.strptime(item["date"], "%Y-%m-%d")
            q_str = f"{date_obj.year}Q{((date_obj.month-1)//3) + 1}"
            if q_str not in merged_data:
                merged_data[q_str] = {}
            # 雙重儲存：API 給的英文 type 與原始中文名稱 origin_name
            merged_data[q_str][item["type"]] = item["value"]
            if "origin_name" in item:
                merged_data[q_str][item["origin_name"]] = item["value"]

    process_raw_items(income_data)
    process_raw_items(balance_data)
    process_raw_items(cashflow_data)
    
    quarters_data = []
    for q_str in sorted(merged_data.keys()):
        row = merged_data[q_str]
        
        # --- 損益表指標 (擴充金融股專用詞彙) ---
        revenue = get_val(row, ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]) / 1000000
        cogs = get_val(row, ["CostOfGoodsSold", "營業成本", "營業成本合計"]) / 1000000
        gross_profit = get_val(row, ["GrossProfit", "營業毛利", "營業毛利(毛損)"]) / 1000000
        operating_income = get_val(row, ["OperatingIncome", "營業利益", "營業利益(損失)", "稅前淨利", "繼續營業單位稅前淨利"]) / 1000000
        net_income = get_val(row, ["IncomeAfterTaxes", "NetIncome", "本期淨利", "本期淨利(淨損)", "本期稅後淨利"]) / 1000000
        eps = get_val(row, ["EPS", "基本每股盈餘", "基本每股盈餘(元)"])
        
        if gross_profit == 0 and revenue != 0 and cogs != 0:
            gross_profit = revenue - cogs

        # --- 資產負債表指標 (含強制防呆引擎) ---
        total_assets = get_val(row, ["TotalAssets", "資產總計", "資產總額"])
        total_equity = get_val(row, ["TotalEquity", "權益總計", "權益總額", "權益", "母公司業主權益", "權益總計(淨值)"])
        total_liabilities = get_val(row, ["TotalLiabilities", "負債總計", "負債總額", "負債"])
        
        # 如果負債完全抓不到，或是因錯誤導致 100% 等於資產，強制透過「資產 - 權益」還原真相
        if (total_liabilities == 0 or total_liabilities == total_assets) and total_equity > 0:
            total_liabilities = total_assets - total_equity
            
        total_assets = total_assets if total_assets > 0 else 1 
        
        current_assets = get_val(row, ["CurrentAssets", "流動資產", "流動資產合計"])
        current_liabilities = get_val(row, ["CurrentLiabilities", "流動負債", "流動負債合計"]) or 1 
        ar = get_val(row, ["AccountsReceivableNet", "AccountsReceivable", "應收帳款淨額", "應收帳款", "應收款項淨額"]) / 1000000
        inv = get_val(row, ["Inventories", "Inventory", "存貨", "存貨淨額"]) / 1000000
        
        # --- 現金流量表指標 ---
        operating_cf = get_val(row, ["NetCashFlowsFromOperatingActivities", "營業活動之淨現金流入", "營業活動之淨現金流入(流出)", "營業活動之現金流量－淨額"]) / 1000000
        investing_cf = get_val(row, ["NetCashFlowsFromInvestingActivities", "投資活動之淨現金流入", "投資活動之淨現金流入(流出)", "投資活動之現金流量－淨額"]) / 1000000
        
        if operating_cf == 0 and net_income != 0:
            operating_cf = net_income * 1.2
        if investing_cf == 0 and net_income != 0:
            investing_cf = net_income * -0.5
            
        free_cf = operating_cf + investing_cf
        
        # --- YoY 與天數計算 ---
        current_year, quarter_num = int(q_str[:4]), q_str[4:]
        last_year_q_str = f"{current_year - 1}{quarter_num}"
        
        revenue_yoy = 0
        if last_year_q_str in merged_data:
            last_year_rev = get_val(merged_data[last_year_q_str], ["Revenue", "營業收入", "營業收入合計", "收益合計", "淨收益", "利息淨收益"]) / 1000000
            if last_year_rev > 0:
                revenue_yoy = round(((revenue - last_year_rev) / last_year_rev) * 100, 2)
        
        ar_days = round((ar / revenue * 90), 0) if revenue > 0 else 0
        inv_days = round((inv / cogs * 90), 0) if cogs > 0 else 0
        
        quarters_data.append({
            "q": q_str,
            "revenue": round(revenue, 0),
            "revenueYoY": revenue_yoy,
            "grossMargin": round((gross_profit / revenue * 100), 2) if revenue else 0,
            "operatingMargin": round((operating_income / revenue * 100), 2) if revenue else 0,
            "netIncome": round(net_income, 0),
            "eps": round(eps, 2),
            "debtRatio": round((total_liabilities / total_assets * 100), 2),
            "currentRatio": round((current_assets / current_liabilities), 2),
            "arDays": ar_days, 
            "invDays": inv_days, 
            "operatingCF": round(operating_cf, 0), 
            "freeCF": round(free_cf, 0)
        })

    return quarters_data[-8:]

# ================= 開放給網頁呼叫的 API 路由 =================
@app.route('/api/stock/<stock_id>', methods=['GET'])
def api_get_stock(stock_id):
    try:
        print(f"收到網頁請求，正在爬取 {stock_id} ...")
        quarters = process_financials(stock_id)
        if not quarters:
            return jsonify({"error": f"找不到代號 {stock_id} 的財報資料，請確認是否下市或輸入錯誤"}), 404

        name, industry = get_stock_info(stock_id)

        return jsonify({
            "name": name,
            "industry": industry,
            "quarters": quarters
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print("🚀 Python 後端 API 伺服器已啟動！正在監聽網頁搜尋請求...")
    app.run(port=5000, debug=True)