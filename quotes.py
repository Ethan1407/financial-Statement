import re
import threading
import requests
from flask import Blueprint, request, jsonify
from common import TTLCache

# ================= 收盤價來源 =================
# 證交所（上市）與櫃買中心（上櫃）的 OpenAPI 各一次請求即可取得全市場收盤價（含 ETF），不消耗 FinMind 額度
TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json",
}
QUOTE_ID_RE = re.compile(r"^[0-9]{4,6}[A-Za-z]?$")
MAX_IDS = 60

price_cache = TTLCache(ttl=1800, maxsize=1)  # 收盤價一天只變一次，30 分鐘重抓即可
price_lock = threading.Lock()


def roc_to_iso(roc):
    """民國日期 1151104 → 2026-11-04"""
    s = str(roc or "").strip()
    if len(s) != 7 or not s.isdigit():
        return ""
    return f"{int(s[:3]) + 1911}-{s[3:5]}-{s[5:]}"


def parse_price(val):
    try:
        p = float(str(val).replace(",", "").strip())
        return p if p > 0 else None
    except (TypeError, ValueError):
        return None


def fetch_market(url, code_key, name_key, close_key):
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=30)
        resp.raise_for_status()
        rows = resp.json()
    except Exception as e:
        print(f"[QUOTES] {url} 抓取失敗: {type(e).__name__}")
        return {}
    result = {}
    for row in rows:
        code, price = str(row.get(code_key, "")).strip(), parse_price(row.get(close_key))
        if code and price:
            result[code] = {"name": str(row.get(name_key, "")).strip(), "price": price, "date": roc_to_iso(row.get("Date"))}
    return result


def get_price_map():
    with price_lock:
        cached = price_cache.get("all")
        if cached is not None:
            return cached
        prices = fetch_market(TPEX_URL, "SecuritiesCompanyCode", "CompanyName", "Close")
        prices.update(fetch_market(TWSE_URL, "Code", "Name", "ClosingPrice"))
        if prices:  # 兩邊都失敗時不快取，下次再試
            price_cache.set("all", prices)
        return prices


# ================= 對外註冊介面 =================
def register_quotes(app, get_industry_map=None):
    quotes_bp = Blueprint("quotes_bp", __name__)

    @quotes_bp.route("/api/quotes", methods=["GET"])
    def api_get_quotes():
        ids = [s.strip().upper() for s in request.args.get("ids", "").split(",") if s.strip()]
        ids = list(dict.fromkeys(ids))
        if not ids or len(ids) > MAX_IDS or not all(QUOTE_ID_RE.match(s) for s in ids):
            return jsonify({"error": f"代號格式錯誤（最多 {MAX_IDS} 檔，以逗號分隔）"}), 400

        prices = get_price_map()
        if not prices:
            return jsonify({"error": "暫時無法取得收盤價，請稍後再試"}), 503

        industry_map = get_industry_map() if get_industry_map else {}
        quotes = {}
        for sid in ids:
            q = prices.get(sid)
            quotes[sid] = {**q, "industries": industry_map.get(sid, [])} if q else None
        return jsonify({"quotes": quotes})

    app.register_blueprint(quotes_bp)
