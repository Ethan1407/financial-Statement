"""
ETF 成分股：改用各投信官網每天公告的「申購買回清單／每日持股」
（法規要求投信公開的資訊，直接來自發行公司，取代原本爬取第三方網站 MoneyDJ）

原則：
- 只用投信網站本身提供給網頁使用的公開資料，以真實的程式名稱連線（不偽裝成瀏覽器）；
  網站若拒絕程式存取（例如國泰投信），就不串接。
- 每檔 ETF 每天最多抓一次，結果存在資料庫（etf.py 的 etf_holdings），不會頻繁打擾對方網站。

目前支援：元大、群益、復華。新增投信時，在 FETCHERS 加一個函式即可。
"""
import re
import threading
from datetime import datetime, timedelta, timezone

import requests

from common import TTLCache

HTTP_HEADERS = {
    "User-Agent": "FinancialHealthDashboard/1.0 (+https://github.com/Ethan1407/financial-Statement)",
    "Accept": "application/json",
}
TIMEOUT = 20
STOCK_ID_RE = re.compile(r"^[0-9]{4,6}[A-Z]?$")
TW_TZ = timezone(timedelta(hours=8))

# 證交所開放資料「基金基本資料彙總表」：用基金全名判斷是哪一家投信發行
FUND_LIST_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap47_L"
ISSUER_PREFIXES = [
    ("元大", "yuanta"), ("群益", "capital"), ("復華", "fuhwa"), ("國泰", "cathay"), ("富邦", "fubon"),
    ("中國信託", "ctbc"), ("中信", "ctbc"), ("統一", "uni"), ("永豐", "sinopac"), ("凱基", "kgi"),
    ("野村", "nomura"), ("新光", "shinkong"), ("第一金", "firstsec"), ("兆豐", "megafunds"), ("台新", "taishin"),
    ("玉山", "esun"), ("大華銀", "uob"), ("街口", "jko"), ("貝萊德", "blackrock"), ("安聯", "allianz"),
]
ISSUER_NAMES = {code: name for name, code in ISSUER_PREFIXES}

issuer_cache = TTLCache(ttl=86400, maxsize=1)
issuer_lock = threading.Lock()
lookup_cache = TTLCache(ttl=86400, maxsize=10)   # 各投信「ETF 代號 → 內部基金編號」對照表


def tw_today():
    return datetime.now(TW_TZ).date()


def _get(url, **kw):
    resp = requests.get(url, headers=HTTP_HEADERS, timeout=TIMEOUT, **kw)
    resp.raise_for_status()
    return resp.json()


def _post(url, **kw):
    resp = requests.post(url, headers=HTTP_HEADERS, timeout=TIMEOUT, **kw)
    resp.raise_for_status()
    return resp.json()


def _num(v):
    try:
        return float(str(v).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def _strip_prefix(name):
    return re.sub(r"^主動", "", (name or "").strip())


def issuer_of(etf_id, fallback_name=""):
    """回傳投信代碼（例如 yuanta）；查不到回傳 None"""
    with issuer_lock:
        mapping = issuer_cache.get("map")
        if mapping is None:
            mapping = {}
            try:
                for row in _get(FUND_LIST_URL):
                    code = str(row.get("基金代號") or "").strip()
                    full = str(row.get("基金中文名稱") or row.get("基金簡稱") or "")
                    if code:
                        mapping[code] = full
                issuer_cache.set("map", mapping)
            except Exception as e:
                print(f"[PCF] 基金基本資料讀取失敗: {type(e).__name__}")
    for name in (mapping.get(etf_id, ""), fallback_name):
        name = _strip_prefix(name)
        for prefix, code in ISSUER_PREFIXES:
            if name.startswith(prefix):
                return code
    return None


# ================= 元大投信 =================
# 元大 ETF 網站的申購買回清單資料（etfapi.yuantaetfs.com）。成分股為每一申購基數的股數，
# 權重 = 股數 × 收盤價 ÷（每單位淨值 × 申購基數）
YUANTA_URL = "https://etfapi.yuantaetfs.com/ectranslation/api/bridge"


def fetch_yuanta(etf_id, price_map):
    params = {"APIType": "ETFAPI", "CompanyName": "YUANTAFUNDS", "DeviceId": "null", "FuncId": "PCF/Daily",
              "AppName": "ETF", "Device": "3", "Platform": "ETF", "ticker": etf_id}
    data = _get(YUANTA_URL, params=params)
    pcf = data.get("PCF") or {}
    d = str(pcf.get("trandate") or "")
    as_of = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else ""
    fund = {"aum": _num(pcf.get("totalav")), "units": _num(pcf.get("osunit")), "nav": _num(pcf.get("nav")), "navDate": as_of,
            "holders": _num((pcf.get("Beneficiary") or {}).get("bf_cnt_a"))}
    base_info = {"name": pcf.get("fundname") or etf_id, "asOf": as_of, "fund": fund}

    # 優先用官方公布的持股權重（現金申贖的 ETF 也有）
    weights = ((data.get("FundWeights") or {}).get("StockWeights")) or []
    holdings = []
    for w in weights:
        sid, pct = str(w.get("code") or "").strip(), _num(w.get("weights"))
        if STOCK_ID_RE.match(sid) and pct:
            holdings.append({"stockId": sid, "name": w.get("name") or sid, "weight": pct})
    if holdings:
        return {**base_info, "source": "元大投信基金持股權重", "holdings": holdings, "note": None}, None

    # 沒有權重時，用實物申購的每基數股數 × 收盤價換算
    comp = ((data.get("InKind") or {}).get("FundComposition")) or []
    nav, base = _num(pcf.get("nav")), _num(pcf.get("baseunit"))
    if not comp or not nav or not base:
        return None, "元大投信沒有公布這檔 ETF 的股票成分（可能是債券、期貨型 ETF）"
    basket = nav * base
    missing = 0
    for c in comp:
        sid, qty = str(c.get("stkcd") or "").strip(), _num(c.get("qty"))
        price = (price_map.get(sid) or {}).get("price")
        if not STOCK_ID_RE.match(sid) or not qty:
            continue
        if not price:
            missing += 1
            continue
        holdings.append({"stockId": sid, "name": c.get("name") or sid, "weight": qty * price / basket * 100})
    return {**base_info, "source": "元大投信申購買回清單", "holdings": holdings,
            "note": f"{missing} 檔成分股缺少收盤價，未列入" if missing else None}, None


# ================= 群益投信 =================
# 群益投信網站的申購買回清單資料（/CFWeb/api/etf/buyback），直接提供每檔股票的權重
CAPITAL_BASE = "https://www.capitalfund.com.tw/CFWeb/api/etf"


def _capital_fund_no(etf_id):
    table = lookup_cache.get("capital")
    if table is None:
        items = _post(f"{CAPITAL_BASE}/items", data=b"")  # 空的 body（對方要求要有 Content-Length）
        rows = items.get("data") if isinstance(items, dict) else items
        table = {str(r.get("stockNo")): str(r.get("fundNo")) for r in rows or [] if r.get("stockNo")}
        lookup_cache.set("capital", table)
    return table.get(etf_id)


def fetch_capital(etf_id, price_map):
    fund_no = _capital_fund_no(etf_id)
    if not fund_no:
        return None, "群益投信沒有這檔 ETF 的資料"
    body = _post(f"{CAPITAL_BASE}/buyback", json={"fundId": fund_no, "date": None})
    data = body.get("data") or {}
    pcf = data.get("pcf") or {}
    holdings = []
    for s in data.get("stocks") or []:
        sid, w = str(s.get("stocNo") or "").strip(), _num(s.get("weight"))
        if STOCK_ID_RE.match(sid) and w:
            holdings.append({"stockId": sid, "name": s.get("stocName") or sid, "weight": w})
    if not holdings:
        return None, "群益投信的申購買回清單沒有股票成分"
    fund = {"aum": _num(pcf.get("nav")), "units": _num(pcf.get("totUnit")), "nav": _num(pcf.get("pUnit")),
            "navDate": str(pcf.get("date2") or "")[:10], "holders": None}
    return {"name": pcf.get("fundName") or etf_id, "asOf": str(pcf.get("date1") or "")[:10],
            "source": "群益投信申購買回清單", "holdings": holdings, "note": None, "fund": fund}, None


# ================= 復華投信 =================
# 復華投信網站的每日持股資料（/api/assets），提供每檔股票的權重；需要指定日期，從今天往前找最近有資料的一天
FUHWA_BASE = "https://www.fhtrust.com.tw/api"


def _fuhwa_fund_id(etf_id):
    table = lookup_cache.get("fuhwa")
    if table is None:
        rows = (_get(f"{FUHWA_BASE}/fundList", params={"ec001": 3}) or {}).get("result") or []
        table = {str(r.get("etf002")): str(r.get("fundID")) for r in rows if r.get("etf002")}
        lookup_cache.set("fuhwa", table)
    return table.get(etf_id)


def fetch_fuhwa(etf_id, price_map):
    fund_id = _fuhwa_fund_id(etf_id)
    if not fund_id:
        return None, "復華投信沒有這檔 ETF 的資料"
    day = tw_today()
    for _ in range(7):
        rows = (_get(f"{FUHWA_BASE}/assets", params={"fundID": fund_id, "qDate": day.strftime("%Y/%m/%d")}) or {}).get("result") or []
        info = rows[0] if rows else {}
        detail = info.get("detail") or []
        holdings = []
        for d in detail:
            sid, w = str(d.get("stockid") or "").strip(), _num(d.get("prate_addaccint"))
            if d.get("ftype") == "股票" and STOCK_ID_RE.match(sid) and w:
                holdings.append({"stockId": sid, "name": d.get("stockname") or sid, "weight": w})
        if holdings:
            as_of = str(info.get("dDate") or day.strftime("%Y/%m/%d")).replace("/", "-")
            return {"name": info.get("twNameFull") or etf_id, "asOf": as_of,
                    "source": "復華投信每日持股", "holdings": holdings, "note": None}, None
        day -= timedelta(days=1)
    return None, "復華投信近 7 天沒有這檔 ETF 的持股資料"


FETCHERS = {"yuanta": fetch_yuanta, "capital": fetch_capital, "fuhwa": fetch_fuhwa}
SUPPORTED_TEXT = "、".join(ISSUER_NAMES[c] for c in FETCHERS)


def fetch_holdings(etf_id, price_map=None, fallback_name=""):
    """回傳 (raw 或 None, 錯誤訊息)。raw = {name, asOf, source, holdings: [{stockId, name, weight(%)}], note,
    fund（有提供時）: {aum 淨資產（元）, units 受益權單位數, nav 每單位淨值, navDate, holders 受益人數}}"""
    issuer = issuer_of(etf_id, fallback_name)
    if issuer not in FETCHERS:
        who = ISSUER_NAMES.get(issuer, "這家投信")
        return None, f"{who}的 ETF 成分股目前不提供（目前支援：{SUPPORTED_TEXT}）"
    try:
        return FETCHERS[issuer](etf_id, price_map or {})
    except Exception as e:
        print(f"[PCF] {etf_id}（{issuer}）抓取失敗: {type(e).__name__}: {e}")
        return None, f"{ISSUER_NAMES[issuer]}投信網站暫時無法取得資料"
