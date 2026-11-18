"""同類型公司推薦（階段五）

設計原則：
- 只依「產業類別」找相似公司，不依燈號或財務表現排序，避免成為投資建議。
- 使用者的興趣輪廓在瀏覽器計算，後端只收到產業名稱，不收到使用者查過哪些股票。
- 點擊與回饋只記錄匿名的每日合計（不含 IP、股票代號），存在 raw_finmind（stock_id = "STATS"）。
"""
import os
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
FLUSH_INTERVAL = 300          # 非強制寫回時的最短間隔（目前每筆事件都強制立即寫入）
MAX_INDUSTRIES = 5
MAX_PER_INDUSTRY = 30
TW_TZ = timezone(timedelta(hours=8))

# 背景預先載入：推薦清單中還沒有財報資料的公司，排進佇列慢慢抓，使用者點進去就能立即查看。
# 每檔完整抓取花 4 次 FinMind API（免費帳號每小時 600 次），所以限制速度與每日數量，把額度留給使用者查詢。
def _env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default

PREFETCH_ENABLED = os.getenv("REC_PREFETCH", "1") != "0"
PREFETCH_INTERVAL = _env_int("REC_PREFETCH_INTERVAL", 20)        # 兩檔之間至少相隔幾秒
PREFETCH_PER_HOUR = _env_int("REC_PREFETCH_PER_HOUR", 20)        # 每小時最多 20 檔（80 次 API）
PREFETCH_DAILY_CAP = _env_int("REC_PREFETCH_DAILY_CAP", 60)      # 每天最多 60 檔
PREFETCH_QUEUE_MAX = 60
PREFETCH_PER_REQUEST = 10                                        # 每次推薦請求最多排入幾檔
PREFETCH_FAIL_PAUSE = 600                                        # 抓取失敗（FinMind 異常、額度滿）時暫停 10 分鐘


class Prefetcher:
    """單一背景執行緒，依序替推薦清單中的公司預先建立財報資料"""

    def __init__(self, fetch_fn, on_done):
        self.fetch_fn = fetch_fn          # fetch_fn(stock_id) -> (ok: bool, retryable: bool)
        self.on_done = on_done            # 成功後通知（更新「已有資料」清單）
        self.queue = []
        self.queued = set()
        self.failed = set()               # 抓不到（例如查無財報）的公司不再重試
        self.cond = threading.Condition()
        self.hour_log = []
        self.day = None
        self.day_count = 0
        self.paused_until = 0
        self.thread = None

    def _quota_left(self):
        now = time.time()
        self.hour_log = [t for t in self.hour_log if now - t < 3600]
        today = datetime.now(TW_TZ).strftime("%Y-%m-%d")
        if today != self.day:
            self.day, self.day_count = today, 0
        return len(self.hour_log) < PREFETCH_PER_HOUR and self.day_count < PREFETCH_DAILY_CAP

    def enqueue(self, stock_ids):
        """回傳實際在佇列中的代號（前端顯示「資料準備中」）"""
        if not PREFETCH_ENABLED or self.fetch_fn is None:
            return set()
        with self.cond:
            if not self._quota_left():
                return set(self.queued)
            for sid in stock_ids:
                if sid in self.queued or sid in self.failed or len(self.queue) >= PREFETCH_QUEUE_MAX:
                    continue
                self.queue.append(sid)
                self.queued.add(sid)
            if self.queue and (self.thread is None or not self.thread.is_alive()):
                self.thread = threading.Thread(target=self._run, daemon=True, name="rec-prefetch")
                self.thread.start()
            self.cond.notify()
            return set(self.queued)

    def is_queued(self, sid):
        return sid in self.queued

    def status(self):
        with self.cond:
            self._quota_left()
            return {"enabled": PREFETCH_ENABLED, "queued": len(self.queue), "lastHour": len(self.hour_log),
                    "today": self.day_count, "perHour": PREFETCH_PER_HOUR, "dailyCap": PREFETCH_DAILY_CAP,
                    "pausedSeconds": max(0, int(self.paused_until - time.time()))}

    def _run(self):
        while True:
            with self.cond:
                while not self.queue:
                    if not self.cond.wait(timeout=600):
                        return  # 閒置 10 分鐘就結束執行緒，下次有推薦請求再啟動
                wait = max(self.paused_until - time.time(), 0)
                if not self._quota_left():
                    wait = max(wait, 60)
            if wait:
                time.sleep(min(wait, 60))
                continue
            with self.cond:
                sid = self.queue.pop(0)
            try:
                ok, retryable = self.fetch_fn(sid)
            except Exception as e:
                print(f"[REC] 預先載入 {sid} 發生錯誤: {e}")
                ok, retryable = False, True
            with self.cond:
                self.queued.discard(sid)
                if ok:
                    self.hour_log.append(time.time())
                    self.day_count += 1
                elif retryable:
                    self.paused_until = time.time() + PREFETCH_FAIL_PAUSE
                else:
                    self.failed.add(sid)
            if ok:
                print(f"[REC] 預先載入完成: {sid}")
                self.on_done(sid)
            time.sleep(PREFETCH_INTERVAL)

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
    def __init__(self, supabase, get_industry_map, get_price_map, prefetch_fn=None):
        self.supabase = supabase
        self.prefetcher = Prefetcher(prefetch_fn, self._mark_cached)
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

    def _mark_cached(self, sid):
        ids = self.cached_ids_cache.get("ids")
        if ids is not None:
            ids.add(sid)

    def _card(self, sid, stocks, cached):
        info = stocks.get(sid) or {}
        has = sid in cached
        return {"id": sid, "name": info.get("name", ""), "industries": info.get("industries", []), "hasData": has,
                "preparing": (not has) and self.prefetcher.is_queued(sid)}

    def _prefetch(self, sids, cached):
        """把推薦清單前段中還沒有資料的公司排進背景預先載入"""
        missing = [s for s in sids if s not in cached][:PREFETCH_PER_REQUEST]
        if missing:
            self.prefetcher.enqueue(missing)

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
        self._prefetch(ordered[:limit], cached)
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
            self._prefetch(sids[:limit], cached)
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
            # Render 免費方案閒置 15 分鐘會睡眠，記憶體裡還沒寫回的計數會遺失；流量不大，每筆立即寫入 Supabase
            self._flush(force=True)

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


def register_recommend(app, supabase=None, get_industry_map=None, get_price_map=None, prefetch_fn=None):
    rec = Recommender(supabase, get_industry_map, get_price_map, prefetch_fn)
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
        out = rec.stats(days)
        out["prefetch"] = rec.prefetcher.status()
        return jsonify(out)

    app.register_blueprint(bp)
    return rec
