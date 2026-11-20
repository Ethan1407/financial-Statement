import re
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify
from common import get_iso_now, safe_parse_iso, TTLCache
from pcf import fetch_holdings

# ================= 模組層級全域變數 =================
etf_memory_cache = TTLCache(ttl=600)

ETF_MAX_AGE = 86400            # 成分股每日公布，超過一天才重抓
MANUAL_REFRESH_MAX_AGE = 3600  # 按「更新」時，超過一小時就重抓

# 成分股來源：各投信官網每天公告的申購買回清單／每日持股（見 pcf.py）。
# 以前爬取 MoneyDJ 的資料不再使用（違反該網站禁止爬蟲的條款），資料庫裡殘留的舊資料也不拿來顯示。
LEGACY_SOURCES = {"MoneyDJ"}


def process_etf_data(etf_id, name, as_of, source, raw_holdings, fetched_at=None):
    """合併重複代號、依權重排序並計算權重統計；沒有任何股票成分時回傳 None"""
    holdings_map = {}
    for h in raw_holdings:
        sid = h["stockId"]
        if sid in holdings_map:
            holdings_map[sid]["weight"] += h["weight"]
        else:
            holdings_map[sid] = {"stockId": sid, "name": h["name"], "weight": h["weight"]}

    if not holdings_map:
        return None

    holdings = sorted(holdings_map.values(), key=lambda x: x["weight"], reverse=True)
    total_weight = sum(x["weight"] for x in holdings)

    warnings = []
    if total_weight < 80 or total_weight > 105:
        warnings.append("股票權重加總異常，資料可能不完整")
    try:
        as_of_date = datetime.strptime(str(as_of)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if (datetime.now(timezone.utc) - as_of_date).days > 30:
            warnings.append("成分股資料已超過 1 個月未更新，僅供參考")
    except ValueError:
        pass

    return {
        "isEtf": True,
        "etfId": etf_id,
        "name": name,
        "asOf": as_of,
        "source": source,
        "fetchedAt": fetched_at or get_iso_now(),
        "count": len(holdings),
        "totalWeight": round(total_weight, 2),
        "otherWeight": round(max(0.0, 100.0 - total_weight), 2),
        "top10Weight": round(sum(x["weight"] for x in holdings[:10]), 2),
        "warnings": warnings,
        "stale": False,
        "holdings": [{"stockId": h["stockId"], "name": h["name"], "weight": round(h["weight"], 2)} for h in holdings]
    }


# ================= 對外註冊介面 =================
def register_etf(app, supabase=None, get_holding_details=None, get_price_map=None):
    etf_bp = Blueprint("etf_bp", __name__)

    def with_holding_details(etf_data):
        if not get_holding_details:
            return etf_data
        details = get_holding_details([h["stockId"] for h in etf_data["holdings"]])
        return {**etf_data, "holdings": [{**h, **details.get(h["stockId"], {})} for h in etf_data["holdings"]]}

    def load_stored(etf_id):
        if not supabase:
            return None
        try:
            res = supabase.table("etf_holdings").select("*").eq("etf_id", etf_id).execute()
            row = res.data[0] if res.data else None
            return None if row and row.get("source") in LEGACY_SOURCES else row
        except Exception as e:
            print(f"[{etf_id}] etf_holdings 讀取失敗: {e}")
            return None

    def save_stored(etf_id, processed):
        if not supabase:
            return
        try:
            supabase.table("etf_holdings").upsert({
                "etf_id": etf_id, "name": processed["name"], "as_of": processed["asOf"],
                "source": processed["source"], "holdings": processed["holdings"], "fetched_at": processed["fetchedAt"]
            }).execute()
        except Exception as e:
            print(f"[{etf_id}] etf_holdings 寫入失敗: {e}")

    @etf_bp.route("/api/etf/<etf_id>", methods=["GET"])
    def api_get_etf(etf_id):
        if not re.match(r"^[0-9]{4,6}[A-Za-z]?$", etf_id):
            return jsonify({"error": "ETF 代號格式錯誤"}), 400

        manual_refresh = request.args.get("refresh") == "1"
        cached = None if manual_refresh else etf_memory_cache.get(etf_id)
        if cached:
            return jsonify(with_holding_details(cached))

        stored = load_stored(etf_id)
        max_age = MANUAL_REFRESH_MAX_AGE if manual_refresh else ETF_MAX_AGE
        is_fresh = stored is not None and \
            (datetime.now(timezone.utc) - safe_parse_iso(stored.get("fetched_at"))).total_seconds() < max_age

        processed, err = None, None
        if not is_fresh:
            price_map = get_price_map() if get_price_map else {}
            raw, err = fetch_holdings(etf_id, price_map, (price_map.get(etf_id) or {}).get("name", ""))
            if raw:
                processed = process_etf_data(etf_id, raw["name"], raw["asOf"], raw["source"], raw["holdings"])
                if processed:
                    if raw.get("note"):
                        processed["warnings"].append(raw["note"])
                    save_stored(etf_id, processed)
            else:
                print(f"[{etf_id}] 成分股抓取失敗: {err}")

        if not processed and stored:
            processed = process_etf_data(etf_id, stored["name"], stored["as_of"], stored["source"],
                                         stored["holdings"], stored["fetched_at"])
            if processed and not is_fresh:
                processed["stale"] = True
                processed["warnings"].append("暫時無法更新成分股，目前顯示上次抓取的資料")

        if not processed:
            return jsonify({"error": err or "查無此 ETF 的股票成分資料（債券、期貨型 ETF 不支援）"}), 404

        etf_memory_cache.set(etf_id, processed)
        return jsonify(with_holding_details(processed))

    app.register_blueprint(etf_bp)
