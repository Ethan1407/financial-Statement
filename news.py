import re
import time
import urllib.parse
import concurrent.futures
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
import requests
from flask import Blueprint, request, jsonify
from common import get_iso_now, safe_parse_iso, is_admin_request, TTLCache, LockRegistry

# ================= 模組層級全域變數 =================
news_memory_cache = TTLCache(ttl=300)
news_locks = LockRegistry()

HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5",
}

# 分類與否定詞庫（僅標題關鍵字比對，非語意理解）
POS_TERMS = ["創高","創新高","新高","大賺","獲利成長","獲利大增","營收成長","營收創高","上修","調升","升評",
             "看好","擴產","擴廠","大單","買超","轉盈","優於預期","利多","大漲","漲停","受惠"]
NEG_TERMS = ["下修","調降","降評","衰退","虧損","轉虧","利空","裁員","減產","停工","賣超","重挫","大跌","下跌",
             "跌停","警示","罰款","訴訟","違約","掉單","砍單","不如預期","新低","下滑"]
NEGATION_RE = re.compile(r'(不|未|沒|無).{0,3}$')


# ================= 輔助函式 =================
def split_title_source(raw_title):
    """Google News 標題格式為「標題 - 媒體」。只在『空白-空白』時才切，避免誤切「台積電-KY」。"""
    raw_title = (raw_title or "").strip()
    if " - " in raw_title:
        title, source = raw_title.rsplit(" - ", 1)
        return title.strip(), source.strip()
    return raw_title, ""


def get_dedup_key(title):
    return re.sub(r'[^\w]', '', title)[:20].lower()


def classify_news(title):
    pos_score = 0
    neg_score = 0
    hits = []
    marked = [False] * len(title)

    for terms, is_pos in ((sorted(POS_TERMS, key=len, reverse=True), True),
                          (sorted(NEG_TERMS, key=len, reverse=True), False)):
        for term in terms:
            for match in re.finditer(re.escape(term), title):
                if any(marked[match.start():match.end()]):
                    continue
                for i in range(match.start(), match.end()):
                    marked[i] = True
                prefix = title[max(0, match.start() - 4):match.start()]
                negated = bool(NEGATION_RE.search(prefix))
                good = is_pos != negated  # 命中利多詞且未否定，或命中利空詞但被否定 => 利多
                if good:
                    pos_score += 1
                else:
                    neg_score += 1
                if len(hits) < 3:
                    hits.append(f"非{term}" if negated else term)

    sentiment = "neutral"
    if pos_score > neg_score:
        sentiment = "positive"
    elif neg_score > pos_score:
        sentiment = "negative"
    return sentiment, hits


def _http_get(url):
    """GET，遇到 429/5xx 重試一次。回傳 (response或None, 錯誤描述)"""
    last_err = ""
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=HTTP_HEADERS, timeout=10)
            if resp.status_code == 200:
                return resp, ""
            last_err = f"HTTP {resp.status_code}"
            if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                time.sleep(1)
                continue
            return None, last_err
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt == 0:
                time.sleep(0.5)
    return None, last_err


def _make_item(raw_title, link, pubdate_str, source, max_age_days):
    if not link or not link.startswith("http"):
        return None
    title, src_from_title = split_title_source(raw_title)
    if not title:
        return None
    try:
        dt = parsedate_to_datetime(pubdate_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ts = dt.timestamp()
        iso_time = dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    except Exception:
        return None
    if time.time() - ts > max_age_days * 86400:
        return None
    sentiment, hits = classify_news(title)
    return {
        "title": title, "url": link, "source": (source or src_from_title or "").strip(),
        "publishedAt": iso_time, "_timestamp": ts, "sentiment": sentiment, "hits": hits,
    }


def _localname(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def parse_google_rss(content, max_age_days):
    root = ET.fromstring(content)
    items = []
    for item in root.findall(".//item"):
        source_elem = item.find("source")
        source = source_elem.text if source_elem is not None and source_elem.text else ""
        it = _make_item(item.findtext("title", ""), item.findtext("link", ""),
                        item.findtext("pubDate", ""), source, max_age_days)
        if it:
            items.append(it)
    return items


def parse_bing_rss(content, max_age_days):
    root = ET.fromstring(content)
    items = []
    for item in root.findall(".//item"):
        link = item.findtext("link", "")
        # Bing 的連結是轉址，真正網址在 url= 參數
        try:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)
            real = qs.get("url", [""])[0]
            if real.startswith("http"):
                link = real
        except Exception:
            pass
        source = ""
        for child in item:
            if _localname(child.tag) == "Source" and child.text:
                source = child.text
                break
        it = _make_item(item.findtext("title", ""), link, item.findtext("pubDate", ""), source, max_age_days)
        if it:
            items.append(it)
    return items


def fetch_news(query, period_days=30, diag=None):
    """先用 Google News RSS，沒結果或失敗再用 Bing News RSS。
    回傳 list（可能為空），兩邊都連線失敗才回傳 None。diag 若提供，會記錄每個來源的狀態。"""
    google_url = ("https://news.google.com/rss/search?q=" +
                  urllib.parse.quote(f"{query} when:{period_days}d") +
                  "&hl=zh-TW&gl=TW&ceid=TW:zh-Hant")
    bing_url = ("https://www.bing.com/news/search?q=" + urllib.parse.quote(query) +
                "&format=rss&setmkt=zh-TW")

    results = {}
    for name, url, parser in (("google", google_url, parse_google_rss), ("bing", bing_url, parse_bing_rss)):
        resp, err = _http_get(url)
        if resp is None:
            results[name] = None
            if diag is not None:
                diag[name] = {"ok": False, "error": err}
            print(f"[News] {name} 失敗 ({query}): {err}")
            continue
        try:
            items = parser(resp.content, period_days)
            results[name] = items
            if diag is not None:
                diag[name] = {"ok": True, "items": len(items)}
            print(f"[News] {name} 成功 ({query}): {len(items)} 則")
            if items:
                return items
        except Exception as e:
            results[name] = None
            if diag is not None:
                diag[name] = {"ok": False, "error": f"解析失敗 {type(e).__name__}: {e}",
                              "head": resp.text[:120]}
            print(f"[News] {name} 解析失敗 ({query}): {e}")

    if all(v is None for v in results.values()):
        return None
    return []


def get_company_name(supabase, stock_id):
    if not supabase:
        return f"代號 {stock_id}"
    try:
        res = supabase.table("stock_results").select("result").eq("stock_id", stock_id).execute()
        if res.data and "result" in res.data[0] and "name" in res.data[0]["result"]:
            return res.data[0]["result"]["name"]
    except Exception as e:
        print(f"[News DB] 無法讀取公司名稱 {stock_id}: {e}")
    return f"代號 {stock_id}"


def build_queries(company_name, stock_id):
    base = stock_id if company_name.startswith("代號 ") else f"{company_name} {stock_id}"
    name = stock_id if company_name.startswith("代號 ") else company_name
    return [
        base,
        f"{name} 利多 OR 營收 OR 獲利 OR 上修 OR 擴產",
        f"{name} 利空 OR 下修 OR 虧損 OR 衰退 OR 減產",
    ], name



# ================= 核心邏輯 =================
def process_news(stock_id, supabase, force_refresh):
    with news_locks.get(stock_id):
        now = time.time()

        db_cached, db_updated_at = None, 0
        if supabase:
            try:
                res = supabase.table("stock_news").select("items, fetched_at").eq("stock_id", stock_id).execute()
                if res.data:
                    db_cached = res.data[0].get("items")
                    db_updated_at = safe_parse_iso(res.data[0].get("fetched_at")).timestamp()
            except Exception as e:
                print(f"[{stock_id}] stock_news 讀取失敗: {e}")

        if isinstance(db_cached, dict) and not db_cached.get("items"):
            db_cached = None  # 空結果不當作有效快取

        if not force_refresh and db_cached and (now - db_updated_at < 1800):
            db_cached["stale"] = False
            return db_cached, None

        company_name = get_company_name(supabase, stock_id)
        queries, loose_query = build_queries(company_name, stock_id)

        fetch_failed = False
        all_items = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(fetch_news, q, 30) for q in queries]
            for future in futures:
                res = future.result()
                if res is None:
                    fetch_failed = True
                else:
                    all_items.extend(res)

        if not all_items and fetch_failed:
            if db_cached:
                db_cached["stale"] = True
                return db_cached, None
            return None, "新聞來源暫時無法連線"

        dedup = {}
        def merge(items):
            for item in items:
                key = get_dedup_key(item["title"])
                if key not in dedup or item["_timestamp"] > dedup[key]["_timestamp"]:
                    dedup[key] = item
        merge(all_items)

        insufficient = False
        if len(dedup) < 10:
            loose = fetch_news(loose_query, 90)
            if loose:
                merge(loose)
            insufficient = len(dedup) < 10

        final_list = sorted(dedup.values(), key=lambda x: x["_timestamp"], reverse=True)[:30]
        for item in final_list:
            item.pop("_timestamp", None)

        counts = {"total": len(final_list), "positive": 0, "negative": 0, "neutral": 0}
        for item in final_list:
            counts[item["sentiment"]] += 1

        result = {
            "stockId": stock_id, "name": company_name, "fetchedAt": get_iso_now(),
            "counts": counts, "insufficient": insufficient, "stale": False, "items": final_list,
        }

        if final_list and supabase:
            try:
                supabase.table("stock_news").upsert({
                    "stock_id": stock_id, "items": result, "fetched_at": get_iso_now()
                }).execute()
            except Exception as e:
                print(f"[{stock_id}] stock_news 寫入失敗: {e}")
        return result, None


# ================= 對外註冊介面 =================
def register_news(app, supabase=None):
    news_bp = Blueprint("news_bp", __name__)

    @news_bp.route("/api/news/<stock_id>", methods=["GET"])
    def api_get_news(stock_id):
        if not re.match(r"^[0-9]{4,6}$", stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400

        force_refresh = (request.args.get("refresh") == "1") and is_admin_request()

        cached = None if force_refresh else news_memory_cache.get(stock_id)
        if cached:
            return jsonify(cached)

        data, err = process_news(stock_id, supabase, force_refresh)
        if err:
            return jsonify({"error": err}), 502
        if data and data.get("items"):
            news_memory_cache.set(stock_id, data)
        return jsonify(data)

    @news_bp.route("/api/news-debug/<stock_id>", methods=["GET"])
    def api_news_debug(stock_id):
        """管理員診斷：看 Google / Bing 各自的連線狀態（不會顯示任何金鑰）"""
        if not is_admin_request():
            return jsonify({"error": "權限不足"}), 403
        if not re.match(r"^[0-9]{4,6}$", stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        name = get_company_name(supabase, stock_id)
        queries, _ = build_queries(name, stock_id)
        diag = {}
        items = fetch_news(queries[0], 30, diag)
        return jsonify({"name": name, "query": queries[0], "sources": diag,
                        "itemCount": None if items is None else len(items)})

    app.register_blueprint(news_bp)