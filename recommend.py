"""同類型公司推薦（階段五）

設計原則：
- 只依「產業類別」找相似公司，不依燈號或財務表現排序，避免成為投資建議。
- 使用者的興趣輪廓在瀏覽器計算，後端只收到產業名稱，不收到使用者查過哪些股票。
- 點擊與回饋只記錄匿名的每日合計（不含 IP、股票代號），存在 raw_finmind（stock_id = "STATS"）。
"""
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, jsonify
from common import get_iso_now, TTLCache

STATS_ID = "STATS"
EVENTS_DATASET = "rec_events"
EVENT_TYPES = ("impression", "click", "helpful", "unhelpful")
PLACEMENTS = ("home", "detail")
EVENTS_KEEP_DAYS = 120
FLUSH_INTERVAL = 300          # 回饋計數最多每 5 分鐘寫回資料庫一次
MAX_INDUSTRIES = 5
MAX_PER_INDUSTRY = 30
TW_TZ = timezone(timedelta(hours=8))

COMMON_STOCK_RE = re.compile(r"^[1-9][0-9]{3}$")   # 四碼普通股（排除 00 開頭的 ETF、特別股、權證）
STOCK_ID_RE = re.compile(r"^[0-9]{4,6}[A-Z]?$")

# 太廣或不是產業的分類不拿來比較相似度
EXCLUDED_INDUSTRIES = {
    "電子工業", "其他", "所有證券", "大盤", "Index", "ETF", "ETN", "上櫃ETF", "上櫃指數股票型基金(ETF)",
    "指數投資證券(ETN)", "存託憑證", "受益證券", "創新板股票", "創新版股票",
}
# 同一產業在上市、上櫃的不同寫法
INDUSTRY_ALIASES = {"金融業": "金融保險", "觀光事業": "觀光餐旅", "化學生技醫療": "生技醫療"}


def normalize_industry(name):
    name = (name or "").strip()
    if not name or name in EXCLUDED_INDUSTRIES:
        return None
    name = INDUSTRY_ALIASES.get(name, name)
    # 「數位雲端類」「數位雲端」「半導體業」→ 去掉結尾的「類」「業」後比較
    return re.sub(r"[類業]$", "", name) or None


class Recommender:
    def __init__(self, supabase, get_industry_map, get_price_map):
        self.supabase = supabase
        self.get_industry_map = get_industry_map
        self.get_price_map = get_price_map
        self.universe_cache = TTLCache(ttl=3600, maxsize=1)
        self.cached_ids_cache = TTLCache(ttl=600, maxsize=1)
        self.popular_cache = TTLCache(ttl=600, maxsize=1)
        self.lock = threading.Lock()
        # 匿名回饋計數：{日期: {placement: {event: 次數}}}
        self.events = None
        self.events_lock = threading.Lock()
        self.last_flush = time.time()
        self.dirty = False

    # ---------- 股票池 ----------
    def universe(self):
        """回傳 (stocks, by_industry)。stocks: {id: {"name", "industries"(正規化後)}}"""
        cached = self.universe_cache.get("u")
        if cached is not None:
            return cached
        with self.lock:
            cached = self.universe_cache.get("u")
            if cached is not None:
                return cached
            industry_map = self.get_industry_map() or {}
            prices = self.get_price_map() or {}
            stocks, by_industry = {}, {}
            for sid, industries in industry_map.items():
                if not COMMON_STOCK_RE.match(sid):
                    continue
                # 有收盤價代表目前仍在交易；收盤價來源失敗時就不過濾
                if prices and sid not in prices:
                    continue
                norm = []
                for ind in industries or []:
                    n = normalize_industry(ind)
                    if n and n not in norm:
                        norm.append(n)
                if not norm:
                    continue
                stocks[sid] = {"name": (prices.get(sid) or {}).get("name", ""), "industries": norm}
                for n in norm:
                    by_industry.setdefault(n, []).append(sid)
            result = (stocks, by_industry)
            if stocks:
                self.universe_cache.set("u", result)
            return result

    def cached_ids(self):
        """已有財報快取的公司（點進去不必再向 FinMind 完整抓取）"""
        cached = self.cached_ids_cache.get("ids")
        if cached is not None:
            return cached
        ids = set()
        if self.supabase is not None:
            try:
                res = self.supabase.table("stock_results").select("stock_id").execute()
                ids = {r["stock_id"] for r in res.data or []}
            except Exception as e:
                print(f"[REC] 讀取已快取股票失敗: {e}")
                return ids
        self.cached_ids_cache.set("ids", ids)
        return ids

    def _card(self, sid, stocks, cached):
        info = stocks.get(sid) or {}
        return {"id": sid, "name": info.get("name", ""), "industries": info.get("industries", []), "hasData": sid in cached}

    def _order(self, sids, cached):
        # 已有快取的排前面（點進去比較快、不耗 FinMind 額度），其餘依代號；不依任何財務表現排序
        return sorted(sids, key=lambda s: (s not in cached, s))

    def peers(self, stock_id, limit):
        stocks, by_industry = self.universe()
        mine = (stocks.get(stock_id) or {}).get("industries") or []
        if not mine:
            # 不在股票池（例如沒有收盤價）時，直接用原始產業別
            mine = [n for n in (normalize_industry(i) for i in (self.get_industry_map() or {}).get(stock_id, [])) if n]
        cached = self.cached_ids()
        shared = {}
        for ind in mine:
            for sid in by_industry.get(ind, []):
                if sid != stock_id:
                    shared[sid] = shared.get(sid, 0) + 1
        ordered = sorted(shared, key=lambda s: (-shared[s], s not in cached, s))
        return {"stockId": stock_id, "industries": mine, "total": len(shared),
                "items": [self._card(s, stocks, cached) for s in ordered[:limit]]}

    def by_industries(self, industries, limit):
        stocks, by_industry = self.universe()
        cached = self.cached_ids()
        groups = []
        for raw in industries[:MAX_INDUSTRIES]:
            ind = normalize_industry(raw)
            if not ind or any(g["industry"] == ind for g in groups):
                continue
            sids = self._order(by_industry.get(ind, []), cached)
            groups.append({"industry": ind, "total": len(sids), "items": [self._card(s, stocks, cached) for s in sids[:limit]]})
        return groups

    def popular(self, limit):
        """其他使用者最近查詢過的公司（依財報快取的最後檢查時間），只回傳個股"""
        cached = self.popular_cache.get("p")
        if cached is None:
            cached = []
            if self.supabase is not None:
                try:
                    res = self.supabase.table("stock_results").select("stock_id, checked_at").order("checked_at", desc=True).limit(60).execute()
                    cached = [r["stock_id"] for r in res.data or [] if COMMON_STOCK_RE.match(r["stock_id"])]
                except Exception as e:
                    print(f"[REC] 讀取最近查詢失敗: {e}")
            self.popular_cache.set("p", cached)
        stocks, _ = self.universe()
        ids = self.cached_ids()
        return [self._card(s, stocks, ids) for s in cached if s in stocks][:limit]

    # ---------- 匿名回饋計數 ----------
    def _load_events(self):
        if self.events is not None:
            return
        self.events = {}
        if self.supabase is not None:
            try:
                res = self.supabase.table("raw_finmind").select("payload").eq("stock_id", STATS_ID).eq("dataset", EVENTS_DATASET).execute()
                if res.data:
                    self.events = res.data[0]["payload"] or {}
            except Exception as e:
                print(f"[REC] 讀取回饋計數失敗: {e}")

    def _flush(self, force=False):
        if not self.dirty or self.supabase is None:
            return
        if not force and time.time() - self.last_flush < FLUSH_INTERVAL:
            return
        cutoff = (datetime.now(TW_TZ) - timedelta(days=EVENTS_KEEP_DAYS)).strftime("%Y-%m-%d")
        for day in [d for d in self.events if d < cutoff]:
            self.events.pop(day, None)
        try:
            self.supabase.table("raw_finmind").upsert({
                "stock_id": STATS_ID, "dataset": EVENTS_DATASET, "payload": self.events, "fetched_at": get_iso_now()
            }).execute()
            self.dirty = False
            self.last_flush = time.time()
        except Exception as e:
            print(f"[REC] 寫入回饋計數失敗: {e}")

    def record(self, event, placement):
        day = datetime.now(TW_TZ).strftime("%Y-%m-%d")
        with self.events_lock:
            self._load_events()
            bucket = self.events.setdefault(day, {}).setdefault(placement, {})
            bucket[event] = bucket.get(event, 0) + 1
            self.dirty = True
            self._flush()

    def stats(self, days):
        with self.events_lock:
            self._load_events()
            self._flush(force=True)
            snapshot = {d: v for d, v in self.events.items()}
        since = (datetime.now(TW_TZ) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        totals = {p: {e: 0 for e in EVENT_TYPES} for p in PLACEMENTS}
        daily = []
        for day in sorted(d for d in snapshot if d >= since):
            row = {"date": day}
            for p in PLACEMENTS:
                counts = snapshot[day].get(p, {})
                row[p] = {e: counts.get(e, 0) for e in EVENT_TYPES}
                for e in EVENT_TYPES:
                    totals[p][e] += counts.get(e, 0)
            daily.append(row)
        for p in PLACEMENTS:
            t = totals[p]
            t["ctr"] = round(t["click"] / t["impression"] * 100, 2) if t["impression"] else None
            votes = t["helpful"] + t["unhelpful"]
            t["helpfulRate"] = round(t["helpful"] / votes * 100, 2) if votes else None
        return {"days": days, "totals": totals, "daily": daily}


def register_recommend(app, supabase=None, get_industry_map=None, get_price_map=None):
    rec = Recommender(supabase, get_industry_map, get_price_map)
    bp = Blueprint("recommend_bp", __name__)

    def parse_limit(default, maximum):
        try:
            return max(1, min(int(request.args.get("limit", default)), maximum))
        except (TypeError, ValueError):
            return default

    @bp.route("/api/recommend/peers/<stock_id>", methods=["GET"])
    def api_peers(stock_id):
        if not STOCK_ID_RE.match(stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        return jsonify(rec.peers(stock_id, parse_limit(8, MAX_PER_INDUSTRY)))

    @bp.route("/api/recommend/industries", methods=["GET"])
    def api_by_industries():
        names = [n.strip() for n in request.args.get("names", "").split(",") if n.strip()]
        if not names:
            return jsonify({"error": "必須提供 names 參數"}), 400
        return jsonify({"groups": rec.by_industries(names, parse_limit(12, MAX_PER_INDUSTRY))})

    @bp.route("/api/recommend/popular", methods=["GET"])
    def api_popular():
        return jsonify({"items": rec.popular(parse_limit(8, 20))})

    @bp.route("/api/recommend/event", methods=["POST"])
    def api_event():
        # 前端以 sendBeacon 送出 text/plain 的 JSON，避免跨網域預檢請求
        data = request.get_json(force=True, silent=True) or {}
        event, placement = data.get("event"), data.get("placement")
        if event not in EVENT_TYPES or placement not in PLACEMENTS:
            return jsonify({"error": "參數錯誤"}), 400
        rec.record(event, placement)
        return ("", 204)

    @bp.route("/api/recommend/stats", methods=["GET"])
    def api_stats():
        try:
            days = max(1, min(int(request.args.get("days", 30)), EVENTS_KEEP_DAYS))
        except (TypeError, ValueError):
            days = 30
        return jsonify(rec.stats(days))

    app.register_blueprint(bp)
    return rec
