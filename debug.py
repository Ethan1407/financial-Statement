import os
import requests
import json
from dotenv import load_dotenv

# ================= 載入環境變數 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(current_dir, '.env')
load_dotenv(dotenv_path=env_path, override=True)

FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")
if not FINMIND_TOKEN:
    raise ValueError("找不到 API Token！請檢查 .env 檔案是否有設定 FINMIND_TOKEN。")

# ================= 核心請求函式 =================
def fetch_data(dataset, stock_id, start_date="2023-01-01"):
    url = "https://api.finmindtrade.com/api/v4/data"
    payload = {
        "dataset": dataset,
        "data_id": stock_id,
        "start_date": start_date,
        "token": FINMIND_TOKEN
    }
    resp = requests.get(url, params=payload)
    data = resp.json()
    return data.get("data", [])

def main():
    stocks = ["2330", "2887"]
    datasets = ["TaiwanStockFinancialStatements", "TaiwanStockBalanceSheet", "TaiwanStockCashFlowsStatement"]
    
    all_names = {}
    raw_data_store = {}

    print("🚀 正在向 FinMind 索取資料，請稍候...\n")
    
    # 1. 抓取資料與整理不重複名稱
    for stock in stocks:
        all_names[stock] = {}
        raw_data_store[stock] = {}
        for ds in datasets:
            data = fetch_data(ds, stock)
            raw_data_store[stock][ds] = data
            
            # 收集不重複的 type 與 origin_name 組合
            unique_pairs = set()
            for item in data:
                t = item.get("type", "")
                o = item.get("origin_name", "")
                unique_pairs.add(f"{t} | {o}")
            all_names[stock][ds] = sorted(list(unique_pairs))

    # 輸出 1: debug_names.json
    with open("debug_names.json", "w", encoding="utf-8") as f:
        json.dump(all_names, f, ensure_ascii=False, indent=2)
    print("✅ 已成功輸出 debug_names.json")

    # 2. 針對 2330 處理 2024 年的現金流量表檢查
    cf_data_2330 = raw_data_store["2330"]["TaiwanStockCashFlowsStatement"]
    cf_2024 = {}
    
    # 關鍵字篩選
    target_keywords = [
        "營業活動", "投資活動", "籌資活動", "融資活動", 
        "取得不動產", "期末現金", "支付之利息", "利息"
    ]
    
    for item in cf_data_2330:
        date = item.get("date", "")
        if date.startswith("2024"):
            if date not in cf_2024:
                cf_2024[date] = {}
            t = item.get("type", "")
            o = item.get("origin_name", "")
            v = item.get("value", 0)
            
            # 檢查是否包含我們關注的關鍵字
            for kw in target_keywords:
                if kw in o or kw in t:
                    key_name = f"{t} ({o})"
                    cf_2024[date][key_name] = v
                    break # 若命中就換下一個項目，避免重複加入
    
    # 輸出 2: debug_cf_check.json
    with open("debug_cf_check.json", "w", encoding="utf-8") as f:
        json.dump(cf_2024, f, ensure_ascii=False, indent=2)
    print("✅ 已成功輸出 debug_cf_check.json\n")

    # 3. 終端機印出 2330 營業活動現金流判斷
    print("-" * 50)
    print("📊【2330 營業現金流分析 (判斷是否為累計值)】")
    q1_val = 0
    q2_val = 0
    
    for date, items in cf_2024.items():
        for k, v in items.items():
            # 尋找營業活動淨現金 (通常包含 '營業活動' 且帶有 '淨' 字)
            if "營業活動" in k and "淨" in k:
                if date == "2024-03-31":
                    q1_val = v
                elif date == "2024-06-30":
                    q2_val = v
                    
    print(f"2024 Q1 (03-31) 營業活動淨現金: {q1_val:,.0f} 元")
    print(f"2024 Q2 (06-30) 營業活動淨現金: {q2_val:,.0f} 元")
    
    if q2_val > q1_val and q1_val != 0:
        if q2_val >= q1_val * 1.5: 
            print("💡 結論：Q2 數值遠大於 Q1 (約為兩倍以上)，代表 FinMind 提供的現金流是【累計數值】！")
        else:
            print("💡 結論：Q2 大於 Q1，但不確定是否為累計。")
    else:
        print("💡 結論：Q2 未顯著大於 Q1，可能為單季數值。")

    # 4. 終端機印出 2330 損益表「利息費用」名稱
    print("-" * 50)
    print("📝【2330 損益表利息費用 Type 檢查】")
    is_data_2330 = raw_data_store["2330"]["TaiwanStockFinancialStatements"]
    interest_types = set()
    for item in is_data_2330:
        o = item.get("origin_name", "")
        t = item.get("type", "")
        if "利息" in o or "財務成本" in o:
            interest_types.add(f"{t} ({o})")
    
    if interest_types:
        for it in interest_types:
            print(f"找到潛在科目: {it}")
    else:
        print("未找到包含「利息」或「財務成本」的科目。")

    # 5. 終端機印出 2887 特殊欄位檢查
    print("-" * 50)
    print("🏦【2887 (金融股) 資產負債表結構檢查】")
    bs_2887_names = all_names["2887"]["TaiwanStockBalanceSheet"]
    
    # 將所有 names 合併成字串方便搜尋
    bs_2887_str = " ".join(bs_2887_names)
    has_current_assets = "CurrentAssets" in bs_2887_str or "流動資產" in bs_2887_str
    has_inventories = "Inventories" in bs_2887_str or "Inventory" in bs_2887_str or "存貨" in bs_2887_str
    
    print(f"是否包含 CurrentAssets (流動資產): {'✅ 是' if has_current_assets else '❌ 否'}")
    print(f"是否包含 Inventories (存貨): {'✅ 是' if has_inventories else '❌ 否'}")
    print("-" * 50)

if __name__ == "__main__":
    main()