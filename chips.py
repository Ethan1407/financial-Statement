"""籌碼面：三大法人買賣超、融資融券餘額、外資持股比例（FinMind 免費資料集）

籌碼面不宜單獨判斷，所以只顯示趨勢，不列入燈號與風險分數。
集保大戶持股比例（TaiwanStockHoldingSharesPer）是 FinMind 付費資料集，沒有串接。
每檔最多每 3 小時向 FinMind 更新一次（3 次 API），結果存在 raw_finmind（dataset = "Chips"）。
"""
import re
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify

from common import TTLCache, LockRegistry, get_iso_now, safe_parse_iso

STOCK_ID_RE = re.compile(r"^[0-9]{4,6}[A-Z]?$")
TW_TZ = timezone(timedelta(hours=8))
CHIPS_DS = "Chips"
WINDOW_DAYS = 100          # 抓近 100 個日曆天（約 60～70 個交易日）
REFRESH_SECONDS = 3 * 3600
INVESTORS = {
    "foreign": ("外資", ("Foreign_Investor", "Foreign_Dealer_Self")),
    "trust": ("投信", ("Investment_Trust",)),
    "dealer": ("自營商", ("Dealer_self", "Dealer_Hedging")),
}


def _lots(v):
    try:
        return float(v or 0) / 1000
    except (TypeError, ValueError):
        return 0.0


def build(inst, margin, holding):
    """把三個資料集整理成每日序列與摘要"""
    days = {}
    name_to_key = {n: k for k, (_, names) in INVESTORS.items() for n in names}
    for r in inst or []:
        k = name_to_key.get(r.get("name"))
        if not k:
            continue
        d = days.setdefault(r["date"], {})
        d[k] = d.get(k, 0) + _lots(r.get("buy")) - _lots(r.get("sell"))
    for r in margin or []:
        d = days.setdefault(r["date"], {})
        d["margin"] = r.get("MarginPurchaseTodayBalance")
        d["short"] = r.get("ShortSaleTodayBalance")
    for r in holding or []:
        d = days.setdefault(r["date"], {})
        d["foreignRatio"] = r.get("ForeignInvestmentSharesRatio")
    dates = sorted(days)[-60:]
    # 法人買賣超（張）取整數，外資持股比例保留小數
    series = [{"date": dt, **{k: (round(v) if k in INVESTORS else v) for k, v in days[dt].items()}} for dt in dates]

    def net_sum(key, n):
        vals = [s.get(key) for s in series[-n:] if s.get(key) is not None]
        return round(sum(vals)) if vals else None

    def change(key, n):
        vals = [s.get(key) for s in series if s.get(key) is not None]
        if len(vals) <= n:
            return None
        return round(vals[-1] - vals[-1 - n], 2)

    def last(key):
        vals = [s.get(key) for s in series if s.get(key) is not None]
        return vals[-1] if vals else None

    summary = {
        "net": {k: {"label": label, "d5": net_sum(k, 5), "d20": net_sum(k, 20), "d60": net_sum(k, 60)}
                for k, (label, _) in INVESTORS.items()},
        "margin": {"last": last("margin"), "chg20": change("margin", 20)},
        "short": {"last": last("short"), "chg20": change("short", 20)},
        "foreignRatio": {"last": last("foreignRatio"), "chg20": change("foreignRatio", 20)},
    }
    return {"lastDate": dates[-1] if dates else None, "summary": summary, "series": series}


def register_chips(app, supabase=None, fetch_finmind=None):
    bp = Blueprint("chips", __name__)
    cache = TTLCache(ttl=REFRESH_SECONDS, maxsize=300)
    locks = LockRegistry()

    def read_db(sid):
        if not supabase:
            return None, None
        try:
            res = supabase.table("raw_finmind").select("payload, fetched_at").eq("stock_id", sid).eq("dataset", CHIPS_DS).execute()
            if res.data:
                return res.data[0]["payload"], res.data[0]["fetched_at"]
        except Exception as e:
            print(f"[{sid}] 籌碼資料讀取失敗: {type(e).__name__}")
        return None, None

    def write_db(sid, payload):
        if not supabase:
            return
        try:
            supabase.table("raw_finmind").upsert({"stock_id": sid, "dataset": CHIPS_DS, "payload": payload,
                                                  "fetched_at": get_iso_now()}).execute()
        except Exception as e:
            print(f"[{sid}] 籌碼資料寫入失敗: {type(e).__name__}")

    @bp.route("/api/chips/<stock_id>", methods=["GET"])
    def api_chips(stock_id):
        if not STOCK_ID_RE.match(stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        cached = cache.get(stock_id)
        if cached:
            return jsonify(cached)
        with locks.get(stock_id):
            cached = cache.get(stock_id)
            if cached:
                return jsonify(cached)
            payload, fetched_at = read_db(stock_id)
            age = (datetime.now(timezone.utc) - safe_parse_iso(fetched_at)).total_seconds() if fetched_at else None
            if payload is None or age is None or age > REFRESH_SECONDS:
                start = (datetime.now(TW_TZ).date() - timedelta(days=WINDOW_DAYS)).isoformat()
                inst, e1 = fetch_finmind("TaiwanStockInstitutionalInvestorsBuySell", stock_id, start)
                margin, e2 = fetch_finmind("TaiwanStockMarginPurchaseShortSale", stock_id, start)
                holding, e3 = fetch_finmind("TaiwanStockShareholding", stock_id, start)
                if inst is not None or margin is not None or holding is not None:
                    fresh = build(inst, margin, holding)
                    if fresh["series"]:
                        payload = fresh
                        write_db(stock_id, payload)
                if payload is None:
                    err = e1 or e2 or e3
                    return jsonify({"error": f"籌碼資料暫時無法取得（{err}）" if err else "查無這檔的籌碼資料"}), 502 if err else 404
            result = {"id": stock_id, **payload}
            cache.set(stock_id, result)
            return jsonify(result)

    app.register_blueprint(bp)
