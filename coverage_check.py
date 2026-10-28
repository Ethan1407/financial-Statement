import os
import json
import time
import sys
# 從你的後端伺服器引入處理函式與抓取函式
from server import process_financials, fetch_finmind_data

def main():
    stocks = ['2330', '2317', '2454', '2412', '1101', '2603', '1301', '2002', '2912', '6446', '2881', '2887']
    
    fields_to_check = [
        'revenue', 'revenueYoY', 'grossMargin', 'operatingMargin', 
        'debtRatio', 'currentRatio', 'arDays', 'invDays', 
        'operatingCF', 'financingCF', 'freeCF', 'interestCoverage', 
        'quickRatio', 'cashEnd'
    ]

    keyword_mapping = {
        'freeCF': ['不動產', '廠房', '設備', '取得'],
        'financingCF': ['籌資', '融資'],
        'interestCoverage': ['利息', '財務成本'],
        'arDays': ['應收', '存貨'],
        'invDays': ['應收', '存貨']
    }

    report = {
        "summary_table": {},
        "debug_raw_fields": {},
        "tsmc_2024_validation": {}
    }

    print("=" * 100)
    print(f"{'代號':<5} | {'產業':<8} | {'金融':<4} | " + " | ".join([f"{f[:4]:<4}" for f in fields_to_check]))
    print("-" * 100)

    for stock in stocks:
        result, err_msg, status_code = process_financials(stock)
        
        if err_msg and ("額度" in err_msg or "error" in err_msg.lower() or status_code == 502):
            print(f"\n⚠️ 遇到 FinMind 額度限制或 API 錯誤 ({err_msg})，提早停止測試。")
            break
            
        if not result or not result.get("quarters"):
            print(f"{stock:<5} | 取得資料失敗")
            time.sleep(1)
            continue
            
        is_fin = result.get("isFinancial", False)
        ind = result.get("industry", "未知")
        quarters = result.get("quarters", [])
        
        # 1. 計算各欄位 None 的數量
        none_counts = {f: 0 for f in fields_to_check}
        for q in quarters:
            for f in fields_to_check:
                if q.get(f) is None:
                    none_counts[f] += 1
                    
        report["summary_table"][stock] = {
            "industry": ind,
            "isFinancial": is_fin,
            "none_counts": none_counts
        }

        # 印出終端機表格列 (為求對齊，產業名稱取前 4 字)
        ind_str = (ind[:3] + "..") if len(ind) > 4 else ind.ljust(5 - len(ind) + len(ind.encode('big5'))//2)
        fin_str = "V" if is_fin else "X"
        counts_str = " | ".join([f"{none_counts[f]:<4}" for f in fields_to_check])
        print(f"{stock:<5} | {ind_str} | {fin_str:<4} | {counts_str}")

        # 2. 針對非金融股，收集 3 季以上 None 的除錯關鍵字
        if not is_fin:
            debug_keywords = set()
            for f, count in none_counts.items():
                if count >= 3 and f in keyword_mapping:
                    debug_keywords.update(keyword_mapping[f])
            
            if debug_keywords:
                print(f"  └─ 發現 {stock} 缺失過多指標，正在爬取原始欄位進行比對...")
                # 重新抓取三大報表原始名稱
                datasets = ["TaiwanStockFinancialStatements", "TaiwanStockBalanceSheet", "TaiwanStockCashFlowsStatement"]
                found_names = set()
                for ds in datasets:
                    raw_data, _ = fetch_finmind_data(ds, stock)
                    if raw_data:
                        for row in raw_data:
                            origin_name = row.get("origin_name", "")
                            t_name = row.get("type", "")
                            for kw in debug_keywords:
                                if kw in origin_name or kw in t_name:
                                    found_names.add(f"{t_name} ({origin_name})")
                
                report["debug_raw_fields"][stock] = list(found_names)

        # 3. TSMC 2024 年營收驗證收集
        if stock == '2330':
            tsmc_2024_revs = {}
            total_2024_rev = 0
            for q in quarters:
                if q["q"].startswith("2024"):
                    rev = q.get("revenue", 0) or 0
                    tsmc_2024_revs[q["q"]] = rev
                    total_2024_rev += rev
                    
            report["tsmc_2024_validation"] = {
                "quarters": tsmc_2024_revs,
                "total_millions": total_2024_rev
            }
            
        time.sleep(1)

    print("=" * 100)
    
    # 輸出除錯報告
    if report["debug_raw_fields"]:
        print("\n🔍 【非金融股缺失欄位 - 潛在原始命名清單】")
        for stock, names in report["debug_raw_fields"].items():
            print(f"[{stock}] 發現以下可能相關的原始科目：")
            for name in sorted(names):
                print(f"  - {name}")

    # 輸出 TSMC 驗證
    print("\n📊 【2330 台積電 2024 營收單季與加總驗證】")
    tsmc = report["tsmc_2024_validation"]
    for q, rev in tsmc.get("quarters", {}).items():
        print(f"  - {q} 營收: {rev:,.0f} 百萬元")
    
    print(f"  👉 2024 加總營收: {tsmc.get('total_millions', 0):,.0f} 百萬元")
    print("  💡 請與台積電官方年報的 2024 全年營收對照(約 2.89 兆元 / 2,890,000 百萬元)！確認是否成功轉為單季。")

    # 儲存 JSON
    with open("coverage_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n✅ 所有結果已成功儲存至 coverage_report.json")

if __name__ == "__main__":
    main()