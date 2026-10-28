import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()
FINMIND_TOKEN = os.getenv("FINMIND_TOKEN")

def fetch_debug_data(dataset):
    url = "https://api.finmindtrade.com/api/v4/data"
    payload = {
        "dataset": dataset,
        "data_id": "2330",
        "start_date": "2024-01-01", # 只要抓最近一年的來看格式就好
        "token": FINMIND_TOKEN
    }
    resp = requests.get(url, params=payload)
    return resp.json()

if __name__ == "__main__":
    print("正在向 FinMind 索取原始資料...")
    income_data = fetch_debug_data("TaiwanStockFinancialStatements")
    balance_data = fetch_debug_data("TaiwanStockBalanceSheet")
    
    # 將原始資料存成一個文字檔
    with open("debug_raw.json", "w", encoding="utf-8") as f:
        json.dump({
            "income_sample": income_data.get("data", [])[:20],  # 只取前 20 筆
            "balance_sample": balance_data.get("data", [])[:20]
        }, f, ensure_ascii=False, indent=2)
        
    print("✅ 已經成功產生 debug_raw.json 檔案！")