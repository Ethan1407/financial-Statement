"""董監事持股與質押：證交所、櫃買中心開放資料「董監事持股餘額明細」（每月更新，全市場一次取得）

- 質押比 = 董事、監察人（含法人代表人）設質股數合計 ÷ 目前持股合計
- 經理人、大股東等其他內部人不列入（和一般「董監質押比」的定義相同）
- 每個資料月份的全市場彙總存一份在 raw_finmind（stock_id = "INSIDERS"，dataset = "ym:{民國年月}"），
  用來比較逐月的持股變化；系統開始記錄後才有歷史
"""
import threading

import requests

from common import TTLCache, get_iso_now

SOURCES = [
    ("上市", "https://openapi.twse.com.tw/v1/opendata/t187ap11_L"),
    ("上櫃", "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap11_O"),
]
HTTP_HEADERS = {
    "User-Agent": "FinancialHealthDashboard/1.0 (+https://github.com/Ethan1407/financial-Statement)",
    "Accept": "application/json",
}
STORE_ID = "INSIDERS"
KEEP_MONTHS = 13
CACHE_TTL = 12 * 3600


def _int(v):
    try:
        return int(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def _is_director(title):
    return ("董事" in title or "監察人" in title) and "經理" not in title


def fetch_snapshot():
    """回傳 (資料年月, {代號: [持股, 設質股數]})；全部來源失敗時回傳 (None, {})"""
    ym, agg = None, {}
    for label, url in SOURCES:
        try:
            resp = requests.get(url, headers=HTTP_HEADERS, timeout=40)
            resp.raise_for_status()
            rows = resp.json()
        except Exception as e:
            print(f"[INSIDERS] {label}董監持股取得失敗: {type(e).__name__}")
            continue
        for r in rows or []:
            sid = str(r.get("公司代號") or "").strip()
            if not sid or not _is_director(str(r.get("職稱") or "")):
                continue
            ym = ym or str(r.get("資料年月") or "").strip()
            cur = agg.setdefault(sid, [0, 0])
            cur[0] += _int(r.get("目前持股"))
            cur[1] += _int(r.get("設質股數"))
    return ym, agg


class InsiderStore:
    def __init__(self, supabase):
        self.supabase = supabase
        self.cache = TTLCache(ttl=CACHE_TTL, maxsize=2)
        self.lock = threading.Lock()

    def _load_history(self):
        """{資料年月: {代號: [持股, 設質]}}"""
        if not self.supabase:
            return {}
        try:
            res = self.supabase.table("raw_finmind").select("dataset, payload").eq("stock_id", STORE_ID).execute()
            return {r["dataset"][3:]: r["payload"] or {} for r in res.data or [] if str(r["dataset"]).startswith("ym:")}
        except Exception as e:
            print(f"[INSIDERS] 歷史資料讀取失敗: {type(e).__name__}")
            return {}

    def _save(self, ym, snap):
        if not self.supabase:
            return
        try:
            self.supabase.table("raw_finmind").upsert({
                "stock_id": STORE_ID, "dataset": f"ym:{ym}", "payload": snap, "fetched_at": get_iso_now()
            }).execute()
        except Exception as e:
            print(f"[INSIDERS] 寫入失敗: {type(e).__name__}")

    def _prune(self, months):
        if not self.supabase or len(months) <= KEEP_MONTHS:
            return
        for ym in sorted(months)[:-KEEP_MONTHS]:
            try:
                self.supabase.table("raw_finmind").delete().eq("stock_id", STORE_ID).eq("dataset", f"ym:{ym}").execute()
            except Exception:
                pass

    def history(self):
        cached = self.cache.get("h")
        if cached is not None:
            return cached
        with self.lock:
            cached = self.cache.get("h")
            if cached is not None:
                return cached
            hist = self._load_history()
            ym, snap = fetch_snapshot()
            if ym and snap:
                if hist.get(ym) != snap:
                    self._save(ym, snap)
                hist[ym] = snap
                self._prune(list(hist))
            if hist:
                self.cache.set("h", hist)
            return hist

    def get(self, sid):
        hist = self.history()
        months = sorted(hist)
        if not months:
            return None
        latest = months[-1]
        cur = hist[latest].get(sid)
        if not cur or cur[0] <= 0:
            return None
        changes = []  # 新到舊，連續月份才比較
        series = [hist[m].get(sid) for m in months]
        for i in range(len(months) - 1, 0, -1):
            a, b = series[i], series[i - 1]
            if not a or not b or b[0] <= 0 or _month_gap(months[i - 1], months[i]) != 1:
                break
            changes.append(round((a[0] / b[0] - 1) * 100, 2))
        return {
            "ym": f"{int(latest[:-2]) + 1911}-{latest[-2:]}",
            "holdingLots": round(cur[0] / 1000), "pledgedLots": round(cur[1] / 1000),
            "pledgeRatio": round(cur[1] / cur[0] * 100, 1),
            "changes": changes, "months": len(months),
        }


def _month_gap(a, b):
    """民國年月字串（例：11510）相差幾個月"""
    ya, ma, yb, mb = int(a[:-2]), int(a[-2:]), int(b[:-2]), int(b[-2:])
    return (yb - ya) * 12 + (mb - ma)
