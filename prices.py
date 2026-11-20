"""
股價：盤中即時報價、日 K 歷史、自選股總覽摘要

- 即時報價（/api/prices/live）
  開盤期間（週一～五 09:00～13:35）向證交所「基本市況報導」API 抓即時成交價，同一檔 10 秒內共用一次結果，
  多位使用者同時看也只會打一次；其餘時間 30 分鐘才抓一次，抓不到就用證交所／櫃買中心的每日收盤價。
- 日 K 歷史（/api/prices/history/<代號>）
  向 FinMind 抓 TaiwanStockPrice，存在 Supabase 的 raw_finmind（dataset = PriceDaily），之後每天只補新的幾天。
  另外抓除權息（TaiwanStockDividendResult）與股票分割（TaiwanStockSplitPrice），換算成調整係數（dataset = PriceEvents），
  前端用來計算「還原股價」。FinMind 的還原股價資料集需要付費，所以自己計算。
- 總覽摘要（/api/prices/summary）
  一次回傳多檔的近一個月收盤價（迷你走勢圖）與 52 週最高／最低價。
"""
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests
from flask import Blueprint, request, jsonify

from common import get_iso_now, safe_parse_iso, TTLCache, LockRegistry

ID_RE = re.compile(r"^[0-9]{4,6}[A-Za-z]?$")
MAX_IDS = 60            # 即時報價：一次請求即可取得，不耗 FinMind 額度
MAX_HEAVY_IDS = 10      # 摘要、風險：每檔第一次可能要 3～4 次 FinMind 呼叫，限制單一請求的工作量（Render 預設 30 秒逾時）
TW_TZ = timezone(timedelta(hours=8))

# ---------- 即時報價 ----------
# 盤中即時報價（證交所「基本市況報導」網站）：把即時行情再提供給別人可能需要證交所授權，預設關閉，
# 只用證交所／櫃買中心 OpenAPI 的每日收盤價（政府資料開放授權，註明來源即可使用）。
# 取得授權後，在環境變數設定 ENABLE_REALTIME_QUOTES=true 即可開啟。
REALTIME_ENABLED = os.getenv("ENABLE_REALTIME_QUOTES", "false").strip().lower() in ("1", "true", "yes")
MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
MIS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://mis.twse.com.tw/stock/fibest.jsp",
    "Accept": "application/json",
}
MIS_CHUNK = 40              # 一次查詢的檔數
LIVE_TTL_OPEN = 10          # 盤中：同一檔 10 秒內共用結果（證交所資料本身約 5 秒更新一次）
LIVE_TTL_CLOSED = 1800      # 非盤中：30 分鐘才重抓
LIVE_POLL_SECONDS = 15      # 盤中前端每 15 秒更新一次
WINDOW_RECHECK_SECONDS = 30 # 交易時段內還沒有成交資料時（剛開盤、國定假日），30 秒後再確認
MIS_TIMEOUT = 6             # 即時報價 API 偶爾會卡住，不要讓使用者等太久
MIS_FAIL_BACKOFF = 30       # 失敗後 30 秒內不再嘗試，沿用上一次取得的報價（沒有的話用收盤價）
MIS_FAIL_WARNING = "即時報價暫時連不上，顯示的是最近一次取得的價格"
MARKET_OPEN = (9, 0)
MARKET_CLOSE = (13, 35)     # 13:30 收盤集合競價，多留 5 分鐘拿最後成交價

# ---------- 日 K 歷史 ----------
HISTORY_START = "2019-01-01"
PRICE_DS, EVENTS_DS = "PriceDaily", "PriceEvents"
DAILY_READY = (15, 30)        # 收盤後 FinMind 通常在這之後才有當天資料
REFETCH_MIN_INTERVAL = 3600   # 資料看起來落後時，最多每小時重抓一次（遇到休市日也不會一直抓）
EVENTS_MAX_AGE = 86400        # 除權息／分割每天更新一次
SUMMARY_WORKERS = 4


def tw_now():
    return datetime.now(TW_TZ)


def is_market_window(now=None):
    now = now or tw_now()
    if now.weekday() >= 5:
        return False
    hm = (now.hour, now.minute)
    return MARKET_OPEN <= hm < MARKET_CLOSE


def seconds_until_open(now=None):
    """距離下一次開盤的秒數（只略過週末，國定假日由即時報價的日期判斷）"""
    now = now or tw_now()
    target = now.replace(hour=MARKET_OPEN[0], minute=MARKET_OPEN[1], second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    return int((target - now).total_seconds())


def expected_latest_date(now=None):
    """FinMind 應該已經有的最新交易日（只略過週末）"""
    now = now or tw_now()
    day = now.date()
    if now.weekday() >= 5 or (now.hour, now.minute) < DAILY_READY:
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.isoformat()


def _num(val):
    try:
        f = float(str(val).replace(",", "").strip())
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def _first_num(val):
    """委買／委賣價格以底線分隔：2100.0000_2095.0000_…，取第一個"""
    for part in str(val or "").split("_"):
        n = _num(part)
        if n:
            return n
    return None


class PriceService:
    def __init__(self, supabase, fetch_finmind, get_price_map):
        self.supabase = supabase
        self.fetch_finmind = fetch_finmind
        self.get_price_map = get_price_map
        self.locks = LockRegistry()
        self.history_cache = TTLCache(ttl=600, maxsize=300)
        self.live_lock = threading.Lock()
        self.live_cache = {}      # code -> (抓取時間, 報價)
        self.last_trade = {}      # code -> 最後一次有成交的價格（即時 API 偶爾某次沒有成交價）
        self.mis_failed_at = 0
        self.official_cache = TTLCache(ttl=OFFICIAL_TTL, maxsize=1)
        self.shares_cache = TTLCache(ttl=12 * 3600, maxsize=500)
        self.official_lock = threading.Lock()

    # ================= 即時報價 =================
    def _fetch_mis(self, codes, market_map):
        channels = []
        for c in codes:
            m = (market_map.get(c) or {}).get("market")
            # 不知道上市還是上櫃時兩邊都查，查不到的那邊會回傳空資料
            channels.extend([f"{m}_{c}.tw"] if m else [f"tse_{c}.tw", f"otc_{c}.tw"])
        items = []
        for i in range(0, len(channels), MIS_CHUNK):
            resp = requests.get(MIS_URL, params={"ex_ch": "|".join(channels[i:i + MIS_CHUNK]), "json": 1, "delay": 0,
                                                 "_": int(time.time() * 1000)}, headers=MIS_HEADERS, timeout=MIS_TIMEOUT)
            resp.raise_for_status()
            items.extend(resp.json().get("msgArray") or [])
        return items

    def _parse_mis(self, item):
        code = str(item.get("c") or "").strip()
        if not code:
            return None
        d = str(item.get("d") or "")
        date = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else None
        prev = _num(item.get("y"))
        open_ = _num(item.get("o"))
        price = _num(item.get("z"))
        estimated = False
        if price:
            self.last_trade[code] = (date, price)
        else:
            # 這一次沒有成交價：用同一天上一次的成交價，再不行用最佳委買／委賣價
            last = self.last_trade.get(code)
            if last and last[0] == date:
                price = last[1]
            elif open_:
                price = _first_num(item.get("b")) or _first_num(item.get("a"))
                estimated = bool(price)
        if not price or not open_:
            return None  # 今天還沒開始交易（開盤前）
        try:
            volume = int(float(item.get("v") or 0))
        except (TypeError, ValueError):
            volume = 0
        change = round(price - prev, 4) if prev else None
        return code, {
            "name": item.get("n") or "", "price": price, "prevClose": prev, "change": change,
            "changePct": round(change / prev * 100, 2) if prev and change is not None else None,
            "open": open_, "high": _num(item.get("h")), "low": _num(item.get("l")), "volume": volume,
            "date": date, "time": item.get("t") or "", "source": "live", "estimated": estimated,
        }

    def get_close_only(self, ids):
        """未開啟即時報價：只回傳每日收盤價（證交所、櫃買中心 OpenAPI，收盤後更新），30 分鐘更新一次"""
        price_map = self.get_price_map() or {}
        quotes = {c: (self._close_quote(price_map[c]) if c in price_map else None) for c in ids}
        return {
            "marketOpen": False, "realtime": False, "pollSeconds": None,
            "nextRefreshSeconds": LIVE_TTL_CLOSED, "nextOpenInSeconds": None,
            "serverTime": tw_now().isoformat(timespec="seconds"), "quotes": quotes,
            "warning": None if price_map else "收盤價暫時無法取得，請稍後再試",
        }

    def _close_quote(self, q):
        """每日收盤價（證交所／櫃買中心 OpenAPI）轉成同樣的格式"""
        change = q.get("change")
        prev = q["price"] - change if change is not None else None
        return {
            "name": q.get("name") or "", "price": q["price"], "prevClose": prev, "change": change,
            "changePct": round(change / prev * 100, 2) if change is not None and prev else None,
            "open": q.get("open"), "high": q.get("high"), "low": q.get("low"), "volume": q.get("volume") or 0,
            "date": q.get("date"), "time": "", "source": "close", "estimated": False,
        }

    def get_live(self, ids):
        if not REALTIME_ENABLED:
            return self.get_close_only(ids)
        now = tw_now()
        window = is_market_window(now)
        ttl = LIVE_TTL_OPEN if window else LIVE_TTL_CLOSED
        today = now.date().isoformat()
        price_map = self.get_price_map() or {}
        warning = None

        with self.live_lock:
            t = time.time()
            stale = [c for c in ids if c not in self.live_cache or t - self.live_cache[c][0] > ttl]
            if stale and t - self.mis_failed_at > MIS_FAIL_BACKOFF:
                try:
                    parsed = {}
                    for item in self._fetch_mis(stale, price_map):
                        r = self._parse_mis(item)
                        if r:
                            parsed[r[0]] = r[1]
                    for c in stale:
                        self.live_cache[c] = (t, parsed.get(c))
                except Exception as e:
                    print(f"[PRICES] 即時報價抓取失敗: {type(e).__name__}")
                    self.mis_failed_at = t
                    warning = MIS_FAIL_WARNING
            elif stale:
                warning = MIS_FAIL_WARNING
            cached = {c: (self.live_cache.get(c) or (0, None))[1] for c in ids}

        quotes = {}
        for c in ids:
            live = cached.get(c)
            close = price_map.get(c)
            # 即時資料比收盤價新（或一樣新）就用即時，否則用收盤價
            if live and (not close or (live.get("date") or "") >= (close.get("date") or "")):
                quotes[c] = live
            elif close:
                quotes[c] = self._close_quote(close)
            else:
                quotes[c] = None

        # 時間在交易時段內、而且真的有今天的成交資料，才算盤中（國定假日不會有今天的資料）
        market_open = window and any(q and q["source"] == "live" and q["date"] == today for q in quotes.values())
        # 前端下次更新的秒數：盤中 15 秒；交易時段內但還沒有成交（剛開盤、國定假日）30 秒後再看；
        # 其他時間 30 分鐘一次，但不超過下次開盤的時間
        next_open = None if market_open else seconds_until_open(now)
        if market_open:
            refresh = LIVE_POLL_SECONDS
        elif window:
            refresh = WINDOW_RECHECK_SECONDS
        else:
            refresh = min(LIVE_TTL_CLOSED, next_open + 5)
        return {
            "realtime": True,
            "marketOpen": market_open,
            "pollSeconds": LIVE_POLL_SECONDS if market_open else None,
            "nextRefreshSeconds": refresh,
            "nextOpenInSeconds": next_open,
            "serverTime": now.isoformat(timespec="seconds"),
            "quotes": quotes,
            "warning": warning,
        }

    # ================= 日 K 歷史 =================
    def _read_db(self, sid):
        if not self.supabase:
            return {}
        try:
            res = self.supabase.table("raw_finmind").select("dataset, payload, fetched_at").eq("stock_id", sid) \
                .in_("dataset", [PRICE_DS, EVENTS_DS]).execute()
            return {r["dataset"]: (r["payload"], r["fetched_at"]) for r in res.data}
        except Exception as e:
            print(f"[{sid}] 股價資料讀取失敗: {type(e).__name__}")
            return {}

    def _write_db(self, sid, dataset, payload):
        if not self.supabase:
            return
        try:
            self.supabase.table("raw_finmind").upsert({
                "stock_id": sid, "dataset": dataset, "payload": payload, "fetched_at": get_iso_now()
            }).execute()
        except Exception as e:
            print(f"[{sid}] 股價資料寫入失敗 ({dataset}): {type(e).__name__}")

    def _fetch_rows(self, sid, start):
        data, err = self.fetch_finmind("TaiwanStockPrice", sid, start)
        if err:
            return None, err
        rows = []
        for r in data or []:
            o, h, l, c = (_num(r.get(k)) for k in ("open", "max", "min", "close"))
            if not c:
                continue  # 暫停交易等沒有成交的日子
            vol = r.get("Trading_Volume") or 0
            rows.append([r["date"], o or c, h or c, l or c, c, round(vol / 1000)])
        return rows, None

    def _fetch_events(self, sid):
        """除權息與股票分割 → [[日期, 係數, 種類]]；該日以前的價格乘上係數即為調整後價格"""
        events = []
        div, err1 = self.fetch_finmind("TaiwanStockDividendResult", sid, HISTORY_START)
        for r in div or []:
            b, a = _num(r.get("before_price")), _num(r.get("after_price"))
            if b and a and 0.3 < a / b <= 1:
                events.append([r["date"], round(a / b, 6), "div"])
        split, err2 = self.fetch_finmind("TaiwanStockSplitPrice", sid, HISTORY_START)
        for r in split or []:
            b, a = _num(r.get("before_price")), _num(r.get("after_price"))
            if b and a and 0.01 < a / b < 100:
                events.append([r["date"], round(a / b, 6), "split"])
        if err1 and err2:
            return None, err1
        events.sort(key=lambda e: e[0])
        return events, None

    def get_history(self, sid, with_events=True):
        """回傳 (entry, 錯誤訊息, HTTP 狀態)。entry = {rows, rowsAt, events, eventsAt, warning}"""
        with self.locks.get(sid):
            entry = self.history_cache.get(sid)
            if entry is None:
                db = self._read_db(sid)
                rows, rows_at = db.get(PRICE_DS, (None, None))
                events, events_at = db.get(EVENTS_DS, (None, None))
                entry = {"rows": (rows or {}).get("rows") or [], "rowsAt": rows_at,
                         "events": (events or {}).get("events"), "eventsAt": events_at}
            entry = dict(entry)
            entry["warning"] = None
            now_ts = datetime.now(timezone.utc)

            last_date = entry["rows"][-1][0] if entry["rows"] else None
            age = (now_ts - safe_parse_iso(entry["rowsAt"])).total_seconds() if entry["rowsAt"] else None
            behind = last_date is None or last_date < expected_latest_date()
            if behind and (age is None or age > REFETCH_MIN_INTERVAL or not entry["rows"]):
                # 增量：從最後一天開始抓（重抓最後一天，避免當天資料不完整）
                rows, err = self._fetch_rows(sid, last_date or HISTORY_START)
                if rows is None:
                    if not entry["rows"]:
                        return None, f"股價資料取得失敗（{err}），請稍後再試", 502
                    entry["warning"] = "股價資料暫時無法更新，顯示上次取得的資料"
                else:
                    if not rows and not entry["rows"]:
                        return None, "查無這個代號的股價資料", 404
                    merged = {r[0]: r for r in entry["rows"]}
                    merged.update({r[0]: r for r in rows})
                    entry["rows"] = [merged[d] for d in sorted(merged)]
                    entry["rowsAt"] = get_iso_now()
                    self._write_db(sid, PRICE_DS, {"rows": entry["rows"]})

            if with_events:
                ev_age = (now_ts - safe_parse_iso(entry["eventsAt"])).total_seconds() if entry["eventsAt"] else None
                if entry["events"] is None or ev_age is None or ev_age > EVENTS_MAX_AGE:
                    events, err = self._fetch_events(sid)
                    if events is not None:
                        entry["events"] = events
                        entry["eventsAt"] = get_iso_now()
                        self._write_db(sid, EVENTS_DS, {"events": events})
                    elif entry["events"] is None:
                        entry["warning"] = "除權息資料暫時無法取得，還原股價可能不準確"

            cached = dict(entry)
            cached.pop("warning", None)
            self.history_cache.set(sid, cached)
            return entry, None, 200

    # ================= 股價健康度 =================
    def get_official_flags(self):
        with self.official_lock:
            cached = self.official_cache.get("flags")
            if cached is None:
                flags, failed = fetch_official_flags()
                cached = {"flags": flags, "complete": failed == 0, "fetchedAt": get_iso_now()}
                # 全部來源都失敗時不快取，下次再試
                if failed < len(OFFICIAL_SOURCES):
                    self.official_cache.set("flags", cached)
            return cached

    def _balance_raw(self, sid):
        """財報資料庫裡已存的資產負債表原始資料（查過財報的股票才有）"""
        if not self.supabase:
            return None
        try:
            res = self.supabase.table("raw_finmind").select("payload").eq("stock_id", sid) \
                .eq("dataset", "TaiwanStockBalanceSheet").execute()
            return res.data[0]["payload"] if res.data else None
        except Exception as e:
            print(f"[{sid}] 資產負債表讀取失敗: {type(e).__name__}")
            return None

    def get_shares_issued(self, sid):
        """已發行股數（證交所公布，FinMind TaiwanStockShareholding），一天抓一次"""
        key = f"shares:{sid}"
        cached = self.shares_cache.get(key)
        if cached is not None:
            return cached or None
        start = (tw_now().date() - timedelta(days=14)).isoformat()
        data, _ = self.fetch_finmind("TaiwanStockShareholding", sid, start)
        rows = [r for r in data or [] if r.get("NumberOfSharesIssued")]
        shares = float(max(rows, key=lambda r: r["date"])["NumberOfSharesIssued"]) if rows else 0
        if data is not None:  # 抓取失敗（例如額度用完）不快取，下次再試
            self.shares_cache.set(key, shares)
        return shares or None

    def get_risk(self, sid, bench_rows, official):
        entry, err, _ = self.get_history(sid, with_events=True)
        if not entry:
            return {"error": err}
        raw = entry["rows"]
        adj = adjust_rows(raw, entry["events"] or [])
        result = {
            "lastDate": raw[-1][0] if raw else None,
            "sigma3m": None, "exret3m": None, "dd": None, "ddInputs": None, "ddNote": None,
            "flags": official["flags"].get(sid, []), "flagsComplete": official["complete"],
        }
        sigma = calc_sigma(adj, SIGMA_DAYS)
        result["sigma3m"] = round(sigma, 4) if sigma else None
        if bench_rows and sid != BENCHMARK_ID:
            ex = calc_exret(adj, bench_rows)
            result["exret3m"] = round(ex, 4) if ex is not None else None
        balance = self._balance_raw(sid)
        if balance:
            dd, info = calc_naive_dd(raw, adj, balance, self.get_shares_issued(sid))
            result["dd"], result["ddInputs" if dd is not None else "ddNote"] = dd, info
        else:
            result["ddNote"] = "尚未取得資產負債表（先查詢這檔的財報）"
        return result

    def get_valuation_rows(self, sid):
        """近 5 年每日本益比、股價淨值比、殖利率；存在 raw_finmind（PriceValuation），之後每天只補新資料"""
        with self.locks.get(f"val:{sid}"):
            entry = self.history_cache.get(f"val:{sid}")
            if entry is None:
                entry = {"rows": [], "at": None}
                if self.supabase:
                    try:
                        res = self.supabase.table("raw_finmind").select("payload, fetched_at").eq("stock_id", sid) \
                            .eq("dataset", VALUATION_DS).execute()
                        if res.data:
                            entry = {"rows": (res.data[0]["payload"] or {}).get("rows") or [], "at": res.data[0]["fetched_at"]}
                    except Exception as e:
                        print(f"[{sid}] 估值資料讀取失敗: {type(e).__name__}")
            rows = entry["rows"]
            last = rows[-1][0] if rows else None
            age = (datetime.now(timezone.utc) - safe_parse_iso(entry["at"])).total_seconds() if entry["at"] else None
            if (last is None or last < expected_latest_date()) and (age is None or age > REFETCH_MIN_INTERVAL or not rows):
                start = last or (tw_now().date() - timedelta(days=365 * VALUATION_YEARS + 10)).isoformat()
                data, err = self.fetch_finmind("TaiwanStockPER", sid, start)
                if data is not None:
                    merged = {r[0]: r for r in rows}
                    for d in data:
                        merged[d["date"]] = [d["date"], d.get("PER"), d.get("PBR"), d.get("dividend_yield")]
                    cutoff = (tw_now().date() - timedelta(days=365 * VALUATION_YEARS)).isoformat()
                    rows = [merged[k] for k in sorted(merged) if k >= cutoff]
                    entry = {"rows": rows, "at": get_iso_now()}
                    if rows:
                        self._write_db(sid, VALUATION_DS, {"rows": rows})
                elif not rows:
                    return None, f"估值資料取得失敗（{err}）"
            self.history_cache.set(f"val:{sid}", entry)
            return entry["rows"], None

    def get_valuation(self, sid):
        rows, err = self.get_valuation_rows(sid)
        entry, err2, _ = self.get_history(sid, with_events=True)
        bench, _, _ = self.get_history(BENCHMARK_ID, with_events=True)
        adj = adjust_rows(entry["rows"], entry["events"] or []) if entry else None
        bench_adj = adjust_rows(bench["rows"], bench["events"] or []) if bench else None
        return {
            "id": sid,
            "valuation": valuation_stats(rows) if rows else None, "valuationError": err,
            "momentum": momentum_stats(adj, bench_adj) if adj else None, "priceError": err2,
            "benchmark": BENCHMARK_ID,
        }

    def get_summary(self, sid):
        entry, err, _ = self.get_history(sid, with_events=True)
        if not entry:
            return {"error": err}
        rows = adjust_rows(entry["rows"], [e for e in (entry["events"] or []) if e[2] == "split"])
        last_year = rows[-250:]
        return {
            "spark": [r[4] for r in rows[-22:]],
            "high52": max(r[2] for r in last_year) if last_year else None,
            "low52": min(r[3] for r in last_year) if last_year else None,
            "lastDate": rows[-1][0] if rows else None,
        }


# ================= 股價健康度指標（供 rules.js 的股價規則使用） =================
# 依據：
# - 波動度 SIGMA、超額報酬 EXRET：Campbell, Hilscher & Szilagyi (2008) "In Search of Distress Risk", Journal of Finance
#   SIGMA = sqrt(252 × Σr² ÷ (N−1))，r 為近 3 個月的每日報酬；EXRET = log(1+個股月報酬) − log(1+大盤月報酬)
# - 違約距離（naive DD）：Bharath & Shumway (2008) "Forecasting Default with the Merton Distance to Default Model", RFS
#   V = E + F、σV = E/(E+F)·σE + F/(E+F)·(0.05 + 0.25·σE)、μ = 過去一年股價報酬、T = 1 年
#   F（違約點）＝ 流動負債 + ½ 非流動負債（KMV 的慣例，與 Bharath & Shumway 相同）
BENCHMARK_ID = "0050"          # 大盤代理：元大台灣 50（還原權息），台股沒有免費的含息加權報酬指數日資料
SIGMA_DAYS = 63                # 3 個月
MONTH_DAYS = 21
EXRET_MONTHS = 3
YEAR_DAYS = 252
OFFICIAL_TTL = 3600            # 官方注意／處置／變更交易名單每小時更新一次

OFFICIAL_SOURCES = [
    # (網址, 代號欄位, 種類, 說明文字函式)
    ("https://openapi.twse.com.tw/v1/announcement/notice", "Code", "notice",
     lambda r: f"證交所公布注意股票：{r.get('TradingInfoForAttention') or ''}".strip("：")),
    ("https://openapi.twse.com.tw/v1/announcement/punish", "Code", "punish",
     lambda r: f"證交所處置股票（{r.get('ReasonsOfDisposition') or ''}，處置期間 {r.get('DispositionPeriod') or ''}）"),
    ("https://openapi.twse.com.tw/v1/exchangeReport/TWT85U", "Code", "altered",
     lambda r: "證交所變更交易方法（全額交割或分盤交易）"),
    ("https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information", "SecuritiesCompanyCode", "notice",
     lambda r: f"櫃買中心公布注意股票：{r.get('TradingInformation') or ''}".strip("：")),
    ("https://www.tpex.org.tw/openapi/v1/tpex_disposal_information", "SecuritiesCompanyCode", "punish",
     lambda r: f"櫃買中心處置股票（{r.get('DispositionReasons') or ''}，處置期間 {r.get('DispositionPeriod') or ''}）"),
    ("https://www.tpex.org.tw/openapi/v1/tpex_cmode", "SecuritiesCompanyCode", "altered",
     lambda r: "櫃買中心變更交易方法／管理股票" if _is_yes(r.get("AlteredTrading")) or _is_yes(r.get("ManagedStock")) else None),
]


def _is_yes(v):
    return str(v or "").strip() in ("Y", "Ｙ", "y")


def fetch_official_flags():
    """{代號: [{type, text}]}；任一來源失敗就略過該來源，回傳 (flags, 失敗的來源數)"""
    flags, failed = {}, 0
    for url, code_key, kind, describe in OFFICIAL_SOURCES:
        try:
            resp = requests.get(url, headers=MIS_HEADERS, timeout=20)
            resp.raise_for_status()
            rows = resp.json()
        except Exception as e:
            print(f"[PRICES] 官方警示名單抓取失敗 {url}: {type(e).__name__}")
            failed += 1
            continue
        for r in rows or []:
            code = str(r.get(code_key) or "").strip()
            text = describe(r) if code else None
            if code and text:
                flags.setdefault(code, []).append({"type": kind, "text": text[:200]})
    return flags, failed


def _daily_returns(rows):
    return [rows[i][4] / rows[i - 1][4] - 1 for i in range(1, len(rows)) if rows[i - 1][4] > 0]


def calc_sigma(rows, days):
    r = _daily_returns(rows[-(days + 1):])
    if len(r) < days * 0.6:
        return None
    return math.sqrt(YEAR_DAYS * sum(x * x for x in r) / (len(r) - 1))


def calc_exret(rows, bench):
    """近 EXRET_MONTHS 個月（每 21 個交易日一段）的月超額報酬平均（對數）"""
    bench_close = {r[0]: r[4] for r in bench}
    values = []
    for k in range(EXRET_MONTHS):
        end, start = len(rows) - 1 - k * MONTH_DAYS, len(rows) - 1 - (k + 1) * MONTH_DAYS
        if start < 0:
            return None
        d0, d1 = rows[start][0], rows[end][0]
        if d0 not in bench_close or d1 not in bench_close:
            return None
        rs = rows[end][4] / rows[start][4]
        rm = bench_close[d1] / bench_close[d0]
        values.append(math.log(rs) - math.log(rm))
    return sum(values) / len(values)


def _latest_value(raw_rows, type_name):
    vals = [r for r in raw_rows or [] if r.get("type") == type_name and r.get("value") is not None]
    if not vals:
        return None, None
    last = max(vals, key=lambda r: r.get("date", ""))
    return float(last["value"]), last.get("date")


def calc_naive_dd(raw_close_rows, adj_rows, balance_raw, shares_issued=None):
    """回傳 (DD, 計算依據)；資料不足回傳 (None, 原因)"""
    cur_liab, bs_date = _latest_value(balance_raw, "CurrentLiabilities")
    noncur_liab, _ = _latest_value(balance_raw, "NoncurrentLiabilities")
    share_capital, _ = _latest_value(balance_raw, "OrdinaryShare")
    if cur_liab is None or share_capital is None or share_capital <= 0:
        return None, "缺少資產負債表資料"
    if noncur_liab is None:
        total, _ = _latest_value(balance_raw, "Liabilities")
        noncur_liab = max((total or cur_liab) - cur_liab, 0)
    if len(adj_rows) < YEAR_DAYS + 1:
        return None, "股價資料未滿一年"
    # 股數用公開的已發行股數（FinMind TaiwanStockShareholding）；面額不一定是 10 元（例如 KY 公司），
    # 用「股本 ÷ 10」會讓市值差好幾倍，只有查不到股數時才退回這個估算
    shares = shares_issued if shares_issued and shares_issued > 0 else share_capital / 10
    E = raw_close_rows[-1][4] * shares               # 市值用實際收盤價
    F = cur_liab + 0.5 * noncur_liab
    if F <= 0 or E <= 0:
        return None, "負債或市值為零"
    sigma_e = calc_sigma(adj_rows, YEAR_DAYS)
    if not sigma_e:
        return None, "股價資料不足"
    mu = adj_rows[-1][4] / adj_rows[-(YEAR_DAYS + 1)][4] - 1   # 過去一年報酬（還原權息）
    sigma_v = E / (E + F) * sigma_e + F / (E + F) * (0.05 + 0.25 * sigma_e)
    dd = (math.log((E + F) / F) + (mu - 0.5 * sigma_v ** 2)) / sigma_v
    return round(dd, 2), {
        "marketCap": round(E / 1e8, 1), "defaultPoint": round(F / 1e8, 1), "sigmaE": round(sigma_e, 3),
        "mu": round(mu, 3), "sigmaV": round(sigma_v, 3), "balanceDate": bs_date, "unit": "億元",
        "sharesSource": "issued" if shares_issued and shares_issued > 0 else "capital/10",
    }


# ================= 估值與動能（個股詳情「股價與基本面」區塊） =================
# 估值：證交所每日公布的本益比、股價淨值比、殖利率（FinMind TaiwanStockPER），和公司自己近 5 年比較
#       （CFA Institute 估值教材：倍數可與同業或公司自己的歷史中位數比較）
# 動能：過去 12 個月扣掉最近 1 個月的報酬（Jegadeesh & Titman 1993 以來的慣例），離 52 週高點的距離（George & Hwang 2004）
VALUATION_DS = "PriceValuation"
VALUATION_YEARS = 5


def _percentile_of(values, current):
    """current 在歷史中的位置：有多少比例的日子比現在低（0～100）"""
    if not values or current is None:
        return None
    below = sum(1 for v in values if v < current)
    return round(below / len(values) * 100)


def _median(values):
    s = sorted(values)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def valuation_stats(rows):
    """rows: [[日期, 本益比, 股價淨值比, 殖利率]]；本益比 0 代表虧損（證交所不計算），不列入分布"""
    if not rows:
        return None
    latest = rows[-1]
    out = {"date": latest[0]}
    for idx, key, valid in ((1, "per", lambda v: v and v > 0), (2, "pbr", lambda v: v and v > 0), (3, "yield", lambda v: v is not None and v >= 0)):
        hist = [r[idx] for r in rows if valid(r[idx])]
        cur = latest[idx] if valid(latest[idx]) else None
        out[key] = {
            "current": cur, "median": round(_median(hist), 2) if hist else None,
            "percentile": _percentile_of(hist, cur), "days": len(hist),
            "min": min(hist) if hist else None, "max": max(hist) if hist else None,
        }
    return out


def momentum_stats(adj, bench_adj):
    """adj：還原權息日 K。回傳 12-1 動能、近 12 月報酬、離 52 週高點、近 1 年最大回撤（與 0050 比較）"""
    def ret(rows, back, skip=0):
        if len(rows) <= back:
            return None
        a, b = rows[-(back + 1)][4], rows[-(skip + 1)][4]
        return b / a - 1 if a else None

    def stats(rows):
        if not rows or len(rows) < YEAR_DAYS + 1:
            return None
        last_year = rows[-YEAR_DAYS:]
        high = max(r[2] for r in last_year)
        peak, mdd = -1, 0
        for r in last_year:
            peak = max(peak, r[4])
            mdd = min(mdd, r[4] / peak - 1)
        return {
            "mom12_1": ret(rows, YEAR_DAYS, MONTH_DAYS), "ret12": ret(rows, YEAR_DAYS),
            "fromHigh52": rows[-1][4] / high - 1 if high else None, "maxDrawdown1y": mdd,
        }

    r = lambda d: {k: (round(v, 4) if isinstance(v, float) else v) for k, v in d.items()} if d else None
    return {"stock": r(stats(adj)), "benchmark": r(stats(bench_adj)) if bench_adj else None}


def adjust_rows(rows, events):
    """events 日期以前的價格乘上係數（由新往舊累乘）；成交量不調整"""
    if not events:
        return rows
    out = []
    factor = 1.0
    ev = sorted(events, key=lambda e: e[0], reverse=True)
    i = 0
    for r in reversed(rows):
        while i < len(ev) and r[0] < ev[i][0]:
            factor *= ev[i][1]
            i += 1
        out.append([r[0]] + [round(v * factor, 4) for v in r[1:5]] + [r[5]])
    out.reverse()
    return out


def parse_ids(limit=MAX_IDS):
    ids = [s.strip().upper() for s in request.args.get("ids", "").split(",") if s.strip()]
    ids = list(dict.fromkeys(ids))
    if not ids or len(ids) > limit or not all(ID_RE.match(s) for s in ids):
        return None
    return ids


# ================= 對外註冊介面 =================
def register_prices(app, supabase, fetch_finmind, get_price_map):
    service = PriceService(supabase, fetch_finmind, get_price_map)
    bp = Blueprint("prices_bp", __name__)

    @bp.route("/api/prices/live", methods=["GET"])
    def api_prices_live():
        ids = parse_ids()
        if not ids:
            return jsonify({"error": f"代號格式錯誤（最多 {MAX_IDS} 檔，以逗號分隔）"}), 400
        resp = jsonify(service.get_live(ids))
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.route("/api/prices/history/<stock_id>", methods=["GET"])
    def api_prices_history(stock_id):
        sid = stock_id.strip().upper()
        if not ID_RE.match(sid):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        entry, err, status = service.get_history(sid)
        if not entry:
            return jsonify({"error": err}), status
        return jsonify({"id": sid, "rows": entry["rows"], "events": entry["events"] or [],
                        "updatedAt": entry["rowsAt"], "warning": entry["warning"]})

    @bp.route("/api/prices/summary", methods=["GET"])
    def api_prices_summary():
        ids = parse_ids(MAX_HEAVY_IDS)
        if not ids:
            return jsonify({"error": f"代號格式錯誤（最多 {MAX_HEAVY_IDS} 檔，以逗號分隔）"}), 400
        with ThreadPoolExecutor(max_workers=SUMMARY_WORKERS) as ex:
            results = dict(zip(ids, ex.map(service.get_summary, ids)))
        return jsonify({"summary": results})

    @bp.route("/api/prices/valuation/<stock_id>", methods=["GET"])
    def api_prices_valuation(stock_id):
        """個股詳情「股價與基本面」：本益比／股價淨值比／殖利率與近 5 年比較、動能、52 週高點、最大回撤"""
        sid = stock_id.strip().upper()
        if not ID_RE.match(sid):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        return jsonify(service.get_valuation(sid))

    @bp.route("/api/prices/risk", methods=["GET"])
    def api_prices_risk():
        """股價健康度指標：官方注意／處置／變更交易、近 3 月波動度與超額報酬、違約距離"""
        ids = parse_ids(MAX_HEAVY_IDS)
        if not ids:
            return jsonify({"error": f"代號格式錯誤（最多 {MAX_HEAVY_IDS} 檔，以逗號分隔）"}), 400
        official = service.get_official_flags()
        bench, _, _ = service.get_history(BENCHMARK_ID, with_events=True)
        bench_rows = adjust_rows(bench["rows"], bench["events"] or []) if bench else None
        with ThreadPoolExecutor(max_workers=SUMMARY_WORKERS) as ex:
            results = dict(zip(ids, ex.map(lambda s: service.get_risk(s, bench_rows, official), ids)))
        return jsonify({"risk": results, "benchmark": BENCHMARK_ID, "officialFetchedAt": official["fetchedAt"],
                        "officialComplete": official["complete"]})

    app.register_blueprint(bp)
    return service
