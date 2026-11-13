"""法人說明會（公開資訊觀測站「法人說明會一覽表」t100sb02_1）

觀測站對頻繁查詢會封鎖 IP，因此這裡不逐檔查詢，而是整批抓「某市場某月份」的全部法說會：
- 每天最多同步一次：當月、下個月（已公告的未來法說會）各市場一次，再補 2 個歷史月份，
  總共最多 6 次請求，每次間隔 REQUEST_GAP_SECONDS 秒。
- 被封鎖（伺服器不回應、安全性頁面）時暫停 BLOCK_BACKOFF_HOURS 小時，其他錯誤暫停 ERROR_BACKOFF_HOURS 小時。
- 只保存日期、摘要、簡報檔名與連結，不下載簡報檔案。資料存在 raw_finmind（stock_id = "MOPS"）。
"""
import os
import re
import html
import time
import threading
from datetime import datetime, timezone, timedelta
import requests
from flask import Blueprint, request, jsonify
from common import get_iso_now, safe_parse_iso, is_admin_request, TTLCache

MOPS_AJAX_URL = "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1"
MOPS_PAGE_URL = "https://mopsov.twse.com.tw/mops/web/t100sb02_1"
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "zh-TW,zh;q=0.9",
}

MARKETS = ("sii", "otc")          # 上市、上櫃
STORE_ID = "MOPS"                 # raw_finmind.stock_id
STATE_DATASET = "conf:state"
BACKFILL_MONTHS = 12              # 保留過去 12 個月
BACKFILL_PER_RUN = 2              # 每次同步最多補幾個歷史月份（市場×月份算一個）
REQUEST_GAP_SECONDS = 15
BLOCK_BACKOFF_HOURS = 24
ERROR_BACKOFF_HOURS = 3
TW_TZ = timezone(timedelta(hours=8))

# 同步只在正式環境執行：本機與正式站共用同一個 Supabase，本機若被觀測站封鎖，
# 寫入的「暫停 24 小時」狀態會連正式站一起停掉。Render 會自動設定 RENDER 環境變數。
# 需要在本機測試同步時，設定 MOPS_SYNC=on；要在正式站停用時設定 MOPS_SYNC=off。
_sync_setting = os.getenv("MOPS_SYNC", "auto").lower()
SYNC_ENABLED = _sync_setting == "on" or (_sync_setting == "auto" and bool(os.getenv("RENDER")))

ROW_RE = re.compile(r"<tr class='(?:even|odd)' data-type='body'\s*>(.*?)</tr>", re.S)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
FILE_RE = re.compile(r'fileName\.value="([^"]+)"')
HREF_RE = re.compile(r"""href=['"](https?://[^'"\s]+)['"]""", re.I)
DATE_RE = re.compile(r"(\d{2,3})/(\d{1,2})/(\d{1,2})")
STOCK_ID_RE = re.compile(r"^[0-9]{4,6}[A-Z]?$")


class MopsError(Exception):
    def __init__(self, message, blocked=False):
        super().__init__(message)
        self.blocked = blocked


# ================= 解析 =================
def _text(cell):
    cell = re.sub(r"<br\s*/?>", "\n", cell, flags=re.I)
    cell = html.unescape(re.sub(r"<[^>]+>", " ", cell)).replace("\xa0", " ")
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in cell.split("\n")]
    return "\n".join(line for line in lines if line)


def _roc_to_iso(match):
    y, m, d = int(match.group(1)) + 1911, int(match.group(2)), int(match.group(3))
    try:
        return datetime(y, m, d).strftime("%Y-%m-%d")
    except ValueError:
        return None


def _links(cells_with_labels):
    """從多個欄位取出網址，同一網址只保留第一次出現的標籤"""
    seen, out = set(), []
    for cell, label in cells_with_labels:
        for url in HREF_RE.findall(cell):
            url = html.unescape(url)
            if url not in seen:
                seen.add(url)
                out.append({"label": label, "url": url})
    return out


def parse_conferences(page):
    """解析 t100sb02_1 查詢結果。欄位：代號、名稱、日期、時間、地點、擇要訊息、中文簡報、英文簡報、公司網站、影音連結、其他"""
    items = []
    for row in ROW_RE.findall(page):
        cells = CELL_RE.findall(row)
        if len(cells) < 11:
            continue
        stock_id = _text(cells[0])
        date_text = _text(cells[2])
        dates = [_roc_to_iso(m) for m in DATE_RE.finditer(date_text)]
        if not STOCK_ID_RE.match(stock_id) or not dates or not dates[0]:
            continue
        file_zh, file_en = FILE_RE.search(cells[6]), FILE_RE.search(cells[7])
        note = _text(cells[10])
        links = _links([(cells[9], "影音／直播"), (cells[8], "公司網站")])
        items.append({
            "id": stock_id,
            "name": _text(cells[1]),
            "date": dates[0],
            "endDate": dates[-1] if len(dates) > 1 and dates[-1] != dates[0] else None,
            "dateText": date_text,
            "time": _text(cells[3]),
            "place": _text(cells[4])[:200],
            "summary": _text(cells[5])[:600],
            "fileZh": file_zh.group(1) if file_zh else None,
            "fileEn": file_en.group(1) if file_en else None,
            "links": links[:6],
            "note": None if note in ("", "無", "無。") else note[:300],
        })
    return items


def fetch_month(market, year, month):
    """抓某市場某月份（西元年）的全部法說會。被封鎖或格式不符時丟出 MopsError"""
    payload = {
        "encodeURIComponent": 1, "step": 1, "firstin": 1, "off": 1,
        "TYPEK": market, "year": str(year - 1911), "month": f"{month:02d}", "co_id": "",
    }
    try:
        resp = requests.post(MOPS_AJAX_URL, data=payload, headers=HTTP_HEADERS, timeout=30)
    except requests.ConnectionError as e:
        # 觀測站封鎖 IP 時是直接斷線（Empty reply / connection reset）
        raise MopsError(f"連線被中斷 ({type(e).__name__})", blocked=True)
    except requests.RequestException as e:
        raise MopsError(type(e).__name__)
    if resp.status_code != 200:
        raise MopsError(f"HTTP {resp.status_code}")
    resp.encoding = "utf-8"
    page = resp.text
    if "FOR SECURITY REASONS" in page or "查詢過於頻繁" in page:
        raise MopsError("觀測站安全性封鎖", blocked=True)
    items = parse_conferences(page)
    if not items and "召開法人說明會日期" not in page and "查無" not in page and "無資料" not in page:
        raise MopsError("回傳頁面格式不符")
    return items


# ================= 月份工具 =================
def _tw_now():
    return datetime.now(TW_TZ)


def _shift(year, month, delta):
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def _dataset(market, year, month):
    return f"conf:{market}:{year}-{month:02d}"


def _month_end_date(year, month):
    ny, nm = _shift(year, month, 1)
    return (datetime(ny, nm, 1) - timedelta(days=1)).date()


# ================= 同步與查詢 =================
class ConferenceStore:
    def __init__(self, supabase=None):
        self.supabase = supabase
        self.months = {}      # dataset -> {"items": [...], "fetched_at": iso}
        self.state = {}       # last_run_date, last_success_at, status, message, blocked_until
        self.loaded = False
        self.load_lock = threading.Lock()
        self.sync_lock = threading.Lock()
        self.index_cache = TTLCache(ttl=3600, maxsize=1)

    # ---------- 資料庫 ----------
    def _ensure_loaded(self):
        if self.loaded:
            return
        with self.load_lock:
            if self.loaded:
                return
            if self.supabase is not None:
                try:
                    res = self.supabase.table("raw_finmind").select("dataset, payload, fetched_at").eq("stock_id", STORE_ID).execute()
                    for row in res.data or []:
                        if row["dataset"] == STATE_DATASET:
                            self.state = row.get("payload") or {}
                        elif row["dataset"].startswith("conf:"):
                            self.months[row["dataset"]] = {"items": row.get("payload") or [], "fetched_at": row.get("fetched_at")}
                except Exception as e:
                    print(f"[MOPS] 讀取法說會快取失敗: {e}")
                    return  # 下次再試，不標記為已載入
            self.loaded = True

    def _save(self, dataset, payload):
        if self.supabase is None:
            return
        try:
            self.supabase.table("raw_finmind").upsert({
                "stock_id": STORE_ID, "dataset": dataset, "payload": payload, "fetched_at": get_iso_now()
            }).execute()
        except Exception as e:
            print(f"[MOPS] 寫入 {dataset} 失敗: {e}")

    def _prune(self, keep):
        old = [ds for ds in self.months if ds.startswith("conf:") and ds not in keep]
        for ds in old:
            self.months.pop(ds, None)
        if old and self.supabase is not None:
            try:
                self.supabase.table("raw_finmind").delete().eq("stock_id", STORE_ID).in_("dataset", old).execute()
            except Exception as e:
                print(f"[MOPS] 刪除過期月份失敗: {e}")

    # ---------- 同步 ----------
    def plan(self, now=None):
        """回傳這次同步要抓的 (market, year, month) 清單，以及要保留的月份資料集"""
        now = now or _tw_now()
        cur = (now.year, now.month)
        nxt = _shift(*cur, 1)
        jobs = [(mk, *cur) for mk in MARKETS] + [(mk, *nxt) for mk in MARKETS]
        keep = {_dataset(mk, y, m) for mk, y, m in jobs}

        backfill = []
        for back in range(1, BACKFILL_MONTHS + 1):
            y, m = _shift(*cur, -back)
            for mk in MARKETS:
                ds = _dataset(mk, y, m)
                keep.add(ds)
                stored = self.months.get(ds)
                # 沒抓過，或是在該月結束前抓的（月底後可能還有補登），都要再抓一次
                fetched_tw = safe_parse_iso(stored["fetched_at"]).astimezone(TW_TZ).date() if stored else None
                if fetched_tw is None or fetched_tw <= _month_end_date(y, m):
                    backfill.append((mk, y, m))
        return jobs + backfill[:BACKFILL_PER_RUN], keep

    def status(self):
        self._ensure_loaded()
        months = sorted({ds.split(":")[2] for ds in self.months})
        return {
            "status": self.state.get("status", "never"),
            "message": self.state.get("message"),
            "lastRunDate": self.state.get("last_run_date"),
            "lastSuccessAt": self.state.get("last_success_at"),
            "blockedUntil": self.state.get("blocked_until"),
            "coverage": {"from": months[0], "to": months[-1]} if months else None,
            "running": self.sync_lock.locked(),
        }

    def start_sync(self, force=False):
        """每天最多同步一次（管理員 force 可略過），在背景執行緒進行，立即回傳目前狀態"""
        self._ensure_loaded()
        if not SYNC_ENABLED:
            return {"started": False, "reason": "此環境未啟用同步（只讀取資料）", **self.status()}
        now = _tw_now()
        today = now.strftime("%Y-%m-%d")
        blocked_until = self.state.get("blocked_until")
        if not force:
            if blocked_until and safe_parse_iso(blocked_until) > datetime.now(timezone.utc):
                return {"started": False, "reason": "觀測站暫停中", **self.status()}
            if self.state.get("last_run_date") == today:
                return {"started": False, "reason": "今天已同步過", **self.status()}
        if not self.sync_lock.acquire(blocking=False):
            return {"started": False, "reason": "同步進行中", **self.status()}
        # 先記下今天已執行，避免同時湧入的請求重複觸發
        self.state["last_run_date"] = today
        threading.Thread(target=self._run_sync, args=(now,), daemon=True).start()
        return {"started": True, **self.status()}

    def _run_sync(self, now):
        try:
            jobs, keep = self.plan(now)
            done, items_total = 0, 0
            for i, (mk, y, m) in enumerate(jobs):
                if i:
                    time.sleep(REQUEST_GAP_SECONDS)
                items = fetch_month(mk, y, m)
                ds = _dataset(mk, y, m)
                self.months[ds] = {"items": items, "fetched_at": get_iso_now()}
                self._save(ds, items)
                done += 1
                items_total += len(items)
            self._prune(keep)
            self.state.update({"status": "ok", "message": f"同步 {done} 個月份、{items_total} 筆",
                               "last_success_at": get_iso_now(), "blocked_until": None})
            print(f"[MOPS] 法說會同步完成：{done} 個月份、{items_total} 筆")
        except MopsError as e:
            hours = BLOCK_BACKOFF_HOURS if e.blocked else ERROR_BACKOFF_HOURS
            until = (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(tzinfo=None).isoformat() + "Z"
            self.state.update({"status": "blocked" if e.blocked else "error", "message": str(e), "blocked_until": until})
            print(f"[MOPS] 法說會同步中止：{e}，暫停 {hours} 小時")
        except Exception as e:
            self.state.update({"status": "error", "message": type(e).__name__})
            print(f"[MOPS] 法說會同步發生例外: {e}")
        finally:
            self.index_cache.clear()
            self._save(STATE_DATASET, self.state)
            self.sync_lock.release()

    # ---------- 查詢 ----------
    def index(self):
        cached = self.index_cache.get("index")
        if cached is not None:
            return cached
        self._ensure_loaded()
        idx, seen = {}, set()
        for ds, month in list(self.months.items()):
            for item in month.get("items") or []:
                # 跨月份的活動可能同時出現在兩個月的查詢結果
                key = (item["id"], item["date"], item.get("time"), item.get("place"), item.get("fileZh"))
                if key in seen:
                    continue
                seen.add(key)
                idx.setdefault(item["id"], []).append(item)
        for items in idx.values():
            items.sort(key=lambda x: (x["date"], x.get("time") or ""), reverse=True)
        self.index_cache.set("index", idx)
        return idx


def register_mops(app, supabase=None):
    store = ConferenceStore(supabase)
    bp = Blueprint("mops_bp", __name__)

    @bp.route("/api/conferences/<stock_id>", methods=["GET"])
    def api_conferences(stock_id):
        if not STOCK_ID_RE.match(stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        # 有人查詢時順便觸發當天的同步（每天最多一次，在背景執行）
        store.start_sync()
        items = store.index().get(stock_id, [])
        return jsonify({"stockId": stock_id, "items": items, "sourceUrl": MOPS_PAGE_URL, **store.status()})

    @bp.route("/api/conferences/sync", methods=["GET", "POST"])
    def api_conferences_sync():
        force = request.args.get("force") == "1" and is_admin_request()
        return jsonify(store.start_sync(force=force))

    app.register_blueprint(bp)
    return store
