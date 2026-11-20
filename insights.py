"""產業框架、領先指標與「領先 ↔ 落後」驗證

分析主軸：落後指標（季報、月營收）用來避開雷區；領先指標用來提早看到變化。
領先指標要放在產業脈絡下才讀得懂，而且要驗證它真的會反映在之後的財報上，才值得參考。

1. 產業關鍵指標與同業比較（/api/industry/<代號>）
   - 每種公司類型看不同的關鍵指標（例：半導體看存貨天數與資本支出、營建看合約負債、零售看月營收）。
   - 同業 = 同產業、且資料庫裡已有財報的公司；排名只是「相對位置」，不是好壞判決。
   - 有資料品質旗標（資產負債不平、利潤率超出 ±100%、營收 ≤ 0、現金流暴增）的季度不納入計算。

2. 結構化領先指標（/api/leading/<代號>）
   先做結構化、可驗證的訊號，非結構化資料（新聞全文、影音）等這些訊號驗證有效後再做。
   - 月營收動能轉強／轉弱：近 3 個月營收年增率與近 12 個月相比（月營收比季報早 1～2 個月公布）
   - 合約負債大增／大減：預收客戶款項的變化，反映訂單能見度
   - 存貨堆積且營收轉弱：之後常伴隨降價去化、毛利率下滑
   - 資本支出擴張：公司對未來需求的判斷

3. 驗證
   - 回測：用每個時間點「當時已公布」的資料判斷訊號（不用未來資料），再看之後的財報是否如訊號方向變化，
     並和「沒有訊號時也會變好（變差）的比例」比較，訊號命中率要明顯高於這個基準才有意義。
   - 限制：歷史財報用的是目前的版本，若公司重編過財報，和當時看到的數字可能不同。
   - 因此另外把每次偵測到的訊號連同日期存下來（raw_finmind，stock_id = "SIGNALS"），
     之後用真正「當時就看到」的紀錄驗證。

所有訊號都只是「需要留意的變化」，不是買賣建議。
"""
import re
import threading
from datetime import date, datetime, timedelta, timezone
from statistics import median

from flask import Blueprint, request, jsonify

from common import TTLCache, get_iso_now

STOCK_ID_RE = re.compile(r"^(?!00)[0-9]{4,6}$")
TW_TZ = timezone(timedelta(hours=8))
SIGNAL_STORE_ID = "SIGNALS"
LOG_MAX = 200                 # 每檔最多保存幾筆訊號紀錄
PEER_MAX = 200                # 同業最多比較幾家
DB_CHUNK = 80
BAD_FLAGS = {"BAL_MISMATCH", "MARGIN_RANGE", "REV_NEGATIVE", "CF_JUMP"}
MIN_SAMPLE = 5                # 回測事件少於這個數字時，提醒樣本太少
MONTH_COOLDOWN = 3            # 月訊號重複出現的冷卻期（月）


# ================= 時間工具 =================
def _ok(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def q_parts(q):
    return int(q[:4]), int(q[-1])


def q_shift(q, k):
    y, n = q_parts(q)
    idx = y * 4 + (n - 1) + k
    return f"{idx // 4}Q{idx % 4 + 1}"


def q_report_date(q):
    """季報法定公布期限：Q1 5/15、Q2 8/14、Q3 11/14、Q4（年報）隔年 3/31"""
    y, n = q_parts(q)
    return {1: date(y, 5, 15), 2: date(y, 8, 14), 3: date(y, 11, 14), 4: date(y + 1, 3, 31)}[n]


def ym_shift(ym, k):
    y, m = int(ym[:4]), int(ym[5:7])
    idx = y * 12 + (m - 1) + k
    return f"{idx // 12}-{idx % 12 + 1:02d}"


def month_avail_date(ym):
    """月營收公布期限：次月 10 日"""
    nxt = ym_shift(ym, 1)
    return date(int(nxt[:4]), int(nxt[5:7]), 10)


def last_ended_quarter(ym):
    """這個月底時，最近一個已經結束的季度"""
    y, m = int(ym[:4]), int(ym[5:7])
    if m % 3 == 0:
        return f"{y}Q{m // 3}"
    return q_shift(f"{y}Q{(m - 1) // 3 + 1}", -1)


def months_between(d1, d2):
    return (d2 - d1).days / 30.44


def today_tw():
    return datetime.now(TW_TZ).date()


# ================= 資料包裝 =================
class Series:
    """一家公司的季資料與月營收"""

    def __init__(self, quarters, months):
        self.qs = sorted([q for q in (quarters or []) if q.get("q")], key=lambda q: q["q"])
        self.qmap = {q["q"]: q for q in self.qs}
        self.mmap = {m["ym"]: m["revenue"] for m in (months or []) if m.get("ym") and _ok(m.get("revenue"))}
        self.months = sorted(self.mmap)

    def val(self, q, key):
        row = self.qmap.get(q)
        if not row or BAD_FLAGS.intersection(row.get("qualityFlags") or []):
            return None
        v = row.get(key)
        return v if _ok(v) else None

    def latest_q(self):
        """最新一季有完整三表的季度"""
        for row in reversed(self.qs):
            if not row.get("missing"):
                return row["q"]
        return self.qs[-1]["q"] if self.qs else None


# ================= 1. 產業關鍵指標 =================
def _window(s, n=4):
    q = s.latest_q()
    return [q_shift(q, -i) for i in range(n - 1, -1, -1)] if q else []


def _weighted(s, key):
    num = den = 0.0
    for q in _window(s):
        v, r = s.val(q, key), s.val(q, "revenue")
        if v is not None and r is not None and r > 0:
            num += v * r
            den += r
    return num / den if den > 0 else None


def _sum_ratio(s, key):
    qs = _window(s)
    vals = [s.val(q, key) for q in qs]
    revs = [s.val(q, "revenue") for q in qs]
    if any(v is None for v in vals + revs) or sum(revs) <= 0:
        return None
    return sum(vals) / sum(revs) * 100


def _avg(s, key, positive_only=False):
    vals = [s.val(q, key) for q in _window(s)]
    vals = [v for v in vals if v is not None and (v > 0 or not positive_only)]
    return sum(vals) / len(vals) if vals else None


def m_gross_margin(s): return _weighted(s, "grossMargin")
def m_op_margin(s): return _weighted(s, "operatingMargin")
def m_ocf_margin(s): return _sum_ratio(s, "operatingCF")
def m_capex_intensity(s): return _sum_ratio(s, "capex")
def m_inv_days(s): return _avg(s, "invDays", positive_only=True)
def m_ar_days(s): return _avg(s, "arDays")


def m_rev_growth(s):
    q = s.latest_q()
    if not q:
        return None
    cur = [s.val(q_shift(q, -i), "revenue") for i in range(4)]
    prev = [s.val(q_shift(q, -i - 4), "revenue") for i in range(4)]
    if any(v is None for v in cur + prev) or sum(prev) <= 0:
        return None
    return (sum(cur) / sum(prev) - 1) * 100


def m_debt(s):
    q = s.latest_q()
    return s.val(q, "debtRatio") if q else None


def m_contract_ratio(s):
    q = s.latest_q()
    if not q:
        return None
    cl = s.val(q, "contractLiabilities")
    revs = [s.val(x, "revenue") for x in _window(s)]
    if cl is None or any(r is None for r in revs) or sum(revs) <= 0:
        return None
    return cl / sum(revs) * 100


def rev_window_yoy(s, ym, n):
    cur = [s.mmap.get(ym_shift(ym, -i)) for i in range(n)]
    prev = [s.mmap.get(ym_shift(ym, -i - 12)) for i in range(n)]
    if any(v is None for v in cur + prev) or sum(prev) <= 0:
        return None
    return (sum(cur) / sum(prev) - 1) * 100


def m_month_rev_3m(s):
    return rev_window_yoy(s, s.months[-1], 3) if s.months else None


# key: (名稱, 單位, 方向, 計算函式)；方向 high = 越高越好、low = 越低越好、info = 只看相對位置
METRICS = {
    "grossMargin": ("毛利率（近 4 季）", "%", "high", m_gross_margin),
    "operatingMargin": ("營益率（近 4 季）", "%", "high", m_op_margin),
    "revenueGrowth": ("營收年增（近 4 季合計）", "%", "high", m_rev_growth),
    "monthRevenue3m": ("近 3 個月營收年增", "%", "high", m_month_rev_3m),
    "invDays": ("存貨天數（近 4 季平均）", " 天", "low", m_inv_days),
    "arDays": ("應收帳款天數（近 4 季平均）", " 天", "low", m_ar_days),
    "capexIntensity": ("資本支出／營收（近 4 季）", "%", "info", m_capex_intensity),
    "ocfMargin": ("營業現金流／營收（近 4 季）", "%", "high", m_ocf_margin),
    "debtRatio": ("負債比（最新一季）", "%", "low", m_debt),
    "contractRatio": ("合約負債／近 4 季營收", "%", "high", m_contract_ratio),
}

# 各公司類型的關鍵指標與理由（類型代號與 js/rules.js 的 TYPE_PROFILES 相同）
INDUSTRY_KPIS = {
    "electronics": {
        "focus": "電子與半導體業景氣循環明顯、資本密集：毛利率反映技術與定價能力，存貨天數是景氣轉折的早期訊號，資本支出代表公司對未來需求的判斷。",
        "kpis": ["grossMargin", "operatingMargin", "revenueGrowth", "invDays", "capexIntensity"],
    },
    "cyclical": {
        "focus": "傳產與景氣循環股的獲利隨原物料、運價起伏：重點是毛利率的位置、存貨是否堆積，以及負債能否撐過景氣低點。",
        "kpis": ["grossMargin", "invDays", "debtRatio", "revenueGrowth", "ocfMargin"],
    },
    "growth": {
        "focus": "成長股的價值來自營收擴張：看營收成長是否延續、毛利率是否支撐得住，以及燒錢速度（營業現金流）。",
        "kpis": ["revenueGrowth", "monthRevenue3m", "grossMargin", "ocfMargin"],
    },
    "retail": {
        "focus": "零售、通路與服務業：月營收是最即時的經營數字，存貨週轉與營益率反映經營效率。",
        "kpis": ["monthRevenue3m", "revenueGrowth", "operatingMargin", "invDays"],
    },
    "construction": {
        "focus": "營建業完工才認列營收，季報波動大：合約負債（預收房款）代表已賣出、尚未認列的案量，是未來營收的領先指標；負債比反映財務壓力。",
        "kpis": ["contractRatio", "revenueGrowth", "operatingMargin", "debtRatio"],
    },
    "financial": {
        "focus": "金融業報表結構不同，毛利、存貨與流動比率不適用：先看營收與本業獲利率的相對位置。",
        "kpis": ["revenueGrowth", "operatingMargin", "monthRevenue3m"],
    },
    "dividend": {
        "focus": "存股型公司重視獲利與現金流的穩定：毛利率、營益率、營業現金流與負債比是股利能否持續的基礎。",
        "kpis": ["grossMargin", "operatingMargin", "ocfMargin", "debtRatio", "revenueGrowth"],
    },
    "general": {
        "focus": "沒有特定產業調整時，比較獲利能力、成長、現金流與財務結構。",
        "kpis": ["grossMargin", "operatingMargin", "revenueGrowth", "ocfMargin", "debtRatio"],
    },
}


def compare_with_peers(stock_id, ctype, peer_series, names):
    """peer_series: {代號: Series}（包含自己）"""
    conf = INDUSTRY_KPIS.get(ctype) or INDUSTRY_KPIS["general"]
    me = peer_series.get(stock_id)
    out = []
    for key in conf["kpis"]:
        label, unit, better, fn = METRICS[key]
        values = {}
        for sid, s in peer_series.items():
            try:
                v = fn(s)
            except Exception:
                v = None
            if v is not None:
                values[sid] = v
        mine = values.get(stock_id) if me else None
        item = {"key": key, "label": label, "unit": unit, "better": better,
                "value": round(mine, 1) if mine is not None else None, "n": len(values),
                "median": round(median(values.values()), 1) if values else None,
                "rank": None, "percentile": None, "best": None}
        if values:
            reverse = better != "low"  # info 類依數值由高到低排
            ordered = sorted(values, key=lambda k: values[k], reverse=reverse)
            top = ordered[0]
            item["best"] = {"id": top, "name": names.get(top, ""), "value": round(values[top], 1)}
            if mine is not None:
                rank = ordered.index(stock_id) + 1
                item["rank"] = rank
                item["percentile"] = round((len(ordered) - rank) / (len(ordered) - 1) * 100) if len(ordered) > 1 else None
        out.append(item)
    return {"focus": conf["focus"], "kpis": out}


# ================= 2. 領先指標 =================
OUTCOMES = {
    "revenue": ("營收", "sum"),
    "operatingIncome": ("營業利益", "sum"),
    "grossMargin": ("毛利率", "avg"),
}

SIGNALS = {
    "revAccel": {
        "name": "月營收動能轉強", "direction": "positive", "freq": "month", "outcome": "operatingIncome", "horizon": 2,
        "why": "近 3 個月營收年增率比近 12 個月高出 10 個百分點以上，且為正成長。月營收比季報早 1～2 個月公布，常先反映接單與出貨變化。",
    },
    "revDecel": {
        "name": "月營收動能轉弱", "direction": "negative", "freq": "month", "outcome": "operatingIncome", "horizon": 2,
        "why": "近 3 個月營收年增率比近 12 個月低 10 個百分點以上，且為負成長。",
    },
    "contractUp": {
        "name": "合約負債大增", "direction": "positive", "freq": "quarter", "outcome": "revenue", "horizon": 4,
        "why": "合約負債（預收客戶款項）比去年同季增加 20% 以上，且金額達單季營收的 10%。代表已接單、尚未認列營收的部分變多，營建與設備業特別明顯。",
    },
    "contractDown": {
        "name": "合約負債大減", "direction": "negative", "freq": "quarter", "outcome": "revenue", "horizon": 4,
        "why": "合約負債比去年同季減少 20% 以上（去年同季金額達營收的 10%），訂單能見度可能下降。",
    },
    "inventoryPileup": {
        "name": "存貨堆積且營收轉弱", "direction": "negative", "freq": "quarter", "outcome": "grossMargin", "horizon": 2,
        "why": "存貨天數比去年同季增加 20% 以上，同時營收年增率小於等於 0。需求轉弱時存貨賣不掉，之後常需要降價去化。",
    },
    "capexExpand": {
        "name": "資本支出擴張", "direction": "positive", "freq": "quarter", "outcome": "revenue", "horizon": 4,
        "why": "近 4 季資本支出佔營收 5% 以上，且比去年同期的比例增加 30% 以上，營業現金流為正。代表公司看好未來需求而擴產。",
    },
}

for _k, _sig in SIGNALS.items():
    _label, _ = OUTCOMES[_sig["outcome"]]
    _cmp = "年增率" if OUTCOMES[_sig["outcome"]][1] == "sum" else "和去年同期的差距"
    _sig["test"] = f"訊號出現後的 {_sig['horizon']} 季，{_label}{_cmp}是否{'優於' if _sig['direction'] == 'positive' else '差於'}訊號出現前的 {_sig['horizon']} 季"


def _fmt(v, unit="%"):
    return f"{v:+.1f}{unit}" if unit == "%" else f"{v:.0f}{unit}"


def detect(s, key, point):
    """回傳 (是否成立, 說明文字)；資料不足時回傳 None。point：月份（YYYY-MM）或季度（YYYYQn）"""
    if key in ("revAccel", "revDecel"):
        y3, y12 = rev_window_yoy(s, point, 3), rev_window_yoy(s, point, 12)
        if y3 is None or y12 is None:
            return None
        gap = y3 - y12
        cond = (gap >= 10 and y3 > 0) if key == "revAccel" else (gap <= -10 and y3 < 0)
        return cond, f"近 3 個月營收年增 {_fmt(y3)}，近 12 個月 {_fmt(y12)}"

    prev_q = q_shift(point, -4)
    if key in ("contractUp", "contractDown"):
        cl, cl_prev = s.val(point, "contractLiabilities"), s.val(prev_q, "contractLiabilities")
        rev, rev_prev = s.val(point, "revenue"), s.val(prev_q, "revenue")
        if None in (cl, cl_prev, rev, rev_prev) or cl_prev <= 0 or rev <= 0 or rev_prev <= 0:
            return None
        change = (cl / cl_prev - 1) * 100
        if key == "contractUp":
            cond = change >= 20 and cl >= rev * 0.1
        else:
            cond = change <= -20 and cl_prev >= rev_prev * 0.1
        return cond, f"合約負債 {cl_prev:,.0f} → {cl:,.0f} 百萬（{_fmt(change)}），約為單季營收的 {cl / rev * 100:.0f}%"

    if key == "inventoryPileup":
        inv, inv_prev, yoy = s.val(point, "invDays"), s.val(prev_q, "invDays"), s.val(point, "revenueYoY")
        if None in (inv, inv_prev, yoy) or inv_prev <= 0:
            return None
        rise = (inv / inv_prev - 1) * 100
        return (rise >= 20 and yoy <= 0), f"存貨天數 {inv_prev:.0f} → {inv:.0f} 天（{_fmt(rise)}），營收年增 {_fmt(yoy)}"

    if key == "capexExpand":
        cur = [point if i == 0 else q_shift(point, -i) for i in range(4)]
        prev = [q_shift(q, -4) for q in cur]
        capex = [s.val(q, "capex") for q in cur]
        capex_p = [s.val(q, "capex") for q in prev]
        rev = [s.val(q, "revenue") for q in cur]
        rev_p = [s.val(q, "revenue") for q in prev]
        ocf = [s.val(q, "operatingCF") for q in cur]
        if any(v is None for v in capex + capex_p + rev + rev_p + ocf) or sum(rev) <= 0 or sum(rev_p) <= 0:
            return None
        inten, inten_p = sum(capex) / sum(rev) * 100, sum(capex_p) / sum(rev_p) * 100
        cond = inten >= 5 and inten_p > 0 and inten >= inten_p * 1.3 and sum(ocf) > 0
        return cond, f"近 4 季資本支出佔營收 {inten:.1f}%（去年同期 {inten_p:.1f}%）"
    return None


def _window_change(s, qlist, outcome):
    """這幾季的指標和去年同期比：sum 類回傳合計年增率（%），avg 類回傳平均值差距（百分點）"""
    _, kind = OUTCOMES[outcome]
    cur = [s.val(q, outcome) for q in qlist]
    prev = [s.val(q_shift(q, -4), outcome) for q in qlist]
    if any(v is None for v in cur + prev):
        return None
    if kind == "sum":
        p = sum(prev)
        return (sum(cur) / p - 1) * 100 if p > 0 else None
    return sum(cur) / len(cur) - sum(prev) / len(prev)


def evaluate(s, last_known_q, horizon, outcome):
    """比較訊號出現前、後各 horizon 季的落後指標變化；之後的財報還沒公布時回傳 None"""
    before = [q_shift(last_known_q, -i) for i in range(horizon - 1, -1, -1)]
    after = [q_shift(last_known_q, i) for i in range(1, horizon + 1)]
    b = _window_change(s, before, outcome)
    a = _window_change(s, after, outcome)
    if a is None or b is None:
        return None
    return {"before": round(b, 1), "after": round(a, 1), "improved": a > b, "confirmQ": after[-1],
            "beforeQs": [before[0], before[-1]], "afterQs": [after[0], after[-1]]}


def _points(s, sig):
    return s.months if sig["freq"] == "month" else [q["q"] for q in s.qs]


def _anchor_q(sig, point):
    return last_ended_quarter(point) if sig["freq"] == "month" else point


def _avail(sig, point):
    return month_avail_date(point) if sig["freq"] == "month" else q_report_date(point)


def backtest_series(s, key):
    """回傳 (事件清單, 基準可評估數, 基準變好數)。事件 = 條件從「不成立」變成「成立」的時間點"""
    sig = SIGNALS[key]
    events, base_n, base_up = [], 0, 0
    prev_cond = None
    for p in _points(s, sig):
        r = detect(s, key, p)
        cond = r[0] if r else None
        ev = evaluate(s, _anchor_q(sig, p), sig["horizon"], sig["outcome"]) if cond is not None else None
        if ev is not None:
            base_n += 1
            base_up += 1 if ev["improved"] else 0
        # 月訊號在門檻附近來回時，3 個月內重複出現只算一次
        recent = events and sig["freq"] == "month" and p <= ym_shift(events[-1]["period"], MONTH_COOLDOWN)
        if cond and prev_cond is False and not recent:
            events.append({"period": p, "date": _avail(sig, p).isoformat(), "detail": r[1], "eval": ev})
        prev_cond = cond
    return events, base_n, base_up


def summarize(key, events, base_n, base_up):
    sig = SIGNALS[key]
    positive = sig["direction"] == "positive"
    done = [e for e in events if e["eval"]]
    hits = sum(1 for e in done if e["eval"]["improved"] == positive)
    leads = [months_between(date.fromisoformat(e["date"]), q_report_date(e["eval"]["confirmQ"])) for e in done]
    base = (base_up / base_n if positive else (base_n - base_up) / base_n) if base_n else None
    return {
        "events": len(events), "evaluated": len(done), "hits": hits,
        "hitRate": round(hits / len(done) * 100) if done else None,
        "baseRate": round(base * 100) if base is not None else None,
        "avgLeadMonths": round(sum(leads) / len(leads), 1) if leads else None,
        "smallSample": len(done) < MIN_SAMPLE,
    }


def current_signals(s):
    """最新一個時間點的訊號（成立的才列出），並標出是否為這一期新出現"""
    out = []
    for key, sig in SIGNALS.items():
        pts = _points(s, sig)
        if sig["freq"] == "quarter":
            lq = s.latest_q()
            pts = [p for p in pts if lq and p <= lq]
        if not pts:
            continue
        p = pts[-1]
        r = detect(s, key, p)
        if not r or not r[0]:
            continue
        prev = detect(s, key, ym_shift(p, -1) if sig["freq"] == "month" else q_shift(p, -1))
        out.append({"key": key, "period": p, "availableDate": _avail(sig, p).isoformat(), "detail": r[1],
                    "isNew": bool(prev) and prev[0] is False})
    return out


def signal_meta():
    return {k: {"name": v["name"], "direction": v["direction"], "freq": v["freq"], "horizon": v["horizon"],
                "outcome": OUTCOMES[v["outcome"]][0], "why": v["why"], "test": v["test"]} for k, v in SIGNALS.items()}


# ================= 3. 訊號紀錄（按時間保存） =================
class SignalLog:
    def __init__(self, supabase):
        self.supabase = supabase
        self.cache = TTLCache(ttl=600, maxsize=300)
        self.lock = threading.Lock()

    def read(self, sid):
        cached = self.cache.get(sid)
        if cached is not None:
            return cached
        entries = []
        if self.supabase:
            try:
                res = self.supabase.table("raw_finmind").select("payload").eq("stock_id", SIGNAL_STORE_ID) \
                    .eq("dataset", f"log:{sid}").execute()
                if res.data:
                    entries = (res.data[0]["payload"] or {}).get("entries") or []
            except Exception as e:
                print(f"[{sid}] 訊號紀錄讀取失敗: {e}")
                return entries
        self.cache.set(sid, entries)
        return entries

    def record(self, sid, active):
        """把這次看到、但紀錄裡還沒有的訊號（同一個訊號 + 同一期只記一次）加進去，回傳完整紀錄"""
        with self.lock:
            entries = list(self.read(sid))
            seen = {(e["key"], e["period"]) for e in entries}
            added = [{"key": a["key"], "period": a["period"], "detail": a["detail"], "firstSeen": today_tw().isoformat()}
                     for a in active if (a["key"], a["period"]) not in seen]
            if not added:
                return entries
            entries = (entries + added)[-LOG_MAX:]
            self.cache.set(sid, entries)
            if self.supabase:
                try:
                    self.supabase.table("raw_finmind").upsert({
                        "stock_id": SIGNAL_STORE_ID, "dataset": f"log:{sid}",
                        "payload": {"entries": entries}, "fetched_at": get_iso_now()
                    }).execute()
                except Exception as e:
                    print(f"[{sid}] 訊號紀錄寫入失敗: {e}")
            return entries


# ================= 同業資料 =================
class PeerData:
    def __init__(self, supabase, recommender):
        self.supabase = supabase
        self.recommender = recommender
        self.cache = TTLCache(ttl=6 * 3600, maxsize=8)
        self.locks = {}
        self.guard = threading.Lock()

    def _lock(self, industry):
        with self.guard:
            return self.locks.setdefault(industry, threading.Lock())

    def load(self, industry):
        """回傳 {"series": {代號: Series}, "names": {代號: 名稱}, "candidates": 同產業家數}"""
        cached = self.cache.get(industry)
        if cached is not None:
            return cached
        with self._lock(industry):
            cached = self.cache.get(industry)
            if cached is not None:
                return cached
            stocks, by_industry = self.recommender.universe() if self.recommender else ({}, {})
            ids = sorted(by_industry.get(industry, []))
            series, names = {}, {}
            if self.supabase and ids:
                fin, mon = {}, {}
                try:
                    for i in range(0, len(ids), DB_CHUNK):
                        chunk = ids[i:i + DB_CHUNK]
                        res = self.supabase.table("stock_results").select("stock_id, result").in_("stock_id", chunk).execute()
                        for row in res.data or []:
                            fin[row["stock_id"]] = row["result"] or {}
                        if len(fin) >= PEER_MAX:
                            break
                    have = sorted(fin)
                    for i in range(0, len(have), DB_CHUNK):
                        res = self.supabase.table("monthly_results").select("stock_id, result").in_("stock_id", have[i:i + DB_CHUNK]).execute()
                        for row in res.data or []:
                            mon[row["stock_id"]] = (row["result"] or {}).get("months") or []
                except Exception as e:
                    print(f"[industry {industry}] 同業資料讀取失敗: {e}")
                for sid, r in fin.items():
                    series[sid] = Series(r.get("quarters"), mon.get(sid))
                    names[sid] = r.get("name") or (stocks.get(sid) or {}).get("name", "")
            data = {"series": series, "names": names, "candidates": len(ids)}
            self.cache.set(industry, data)
            return data


# ================= API =================
def register_insights(app, supabase=None, recommender=None, get_financials=None, get_monthly=None, normalize_industry=None):
    """get_financials(sid) / get_monthly(sid) -> (result, 錯誤訊息, 狀態碼)，沿用 server.py 的快取流程"""
    bp = Blueprint("insights", __name__)
    peers = PeerData(supabase, recommender)
    log = SignalLog(supabase)
    agg_cache = TTLCache(ttl=6 * 3600, maxsize=8)
    norm = normalize_industry or (lambda x: x)

    def load_self(stock_id):
        fin, err, code = get_financials(stock_id)
        if err:
            return None, None, (err, code)
        mon, _, _ = get_monthly(stock_id) if get_monthly else (None, None, None)
        return fin, (mon or {}).get("months") or [], None

    def pick_industry(fin):
        mine = [n for n in (norm(i) for i in (fin.get("industryAll") or [fin.get("industry")])) if n]
        wanted = norm(request.args.get("industry", "") or "")
        return wanted if wanted in mine else (mine[0] if mine else None)

    def peer_set(stock_id, fin, months, industry):
        data = peers.load(industry) if industry else {"series": {}, "names": {}, "candidates": 0}
        series = dict(data["series"])
        names = dict(data["names"])
        series[stock_id] = Series(fin.get("quarters"), months)  # 自己用最新的資料
        names[stock_id] = fin.get("name", "")
        return series, names, data["candidates"]

    @bp.route("/api/industry/<stock_id>", methods=["GET"])
    def api_industry(stock_id):
        if not STOCK_ID_RE.match(stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        fin, months, err = load_self(stock_id)
        if err:
            return jsonify({"error": err[0]}), err[1]
        ctype = request.args.get("type", "general")
        if ctype not in INDUSTRY_KPIS:
            ctype = "general"
        industry = pick_industry(fin)
        series, names, candidates = peer_set(stock_id, fin, months, industry)
        cmp = compare_with_peers(stock_id, ctype, series, names)
        peer_list = sorted(((sid, names.get(sid, "")) for sid in series if sid != stock_id))
        return jsonify({
            "stockId": stock_id, "industry": industry, "type": ctype, **cmp,
            "peerCount": len(series) - 1, "industryTotal": candidates,
            "peers": [{"id": sid, "name": n} for sid, n in peer_list[:60]],
            "dbAvailable": supabase is not None,
        })

    @bp.route("/api/leading/<stock_id>", methods=["GET"])
    def api_leading(stock_id):
        if not STOCK_ID_RE.match(stock_id):
            return jsonify({"error": "股票代號格式錯誤"}), 400
        fin, months, err = load_self(stock_id)
        if err:
            return jsonify({"error": err[0]}), err[1]
        me = Series(fin.get("quarters"), months)

        # 這檔自己的歷史回測
        own = {}
        for key in SIGNALS:
            events, bn, bu = backtest_series(me, key)
            own[key] = {**summarize(key, events, bn, bu), "recent": events[-4:][::-1]}

        # 同產業所有已有資料的公司合併回測（樣本比單一公司多）
        industry = pick_industry(fin)
        agg = agg_cache.get(industry) if industry else None
        if agg is None and industry:
            series, _, _ = peer_set(stock_id, fin, months, industry)
            if len(series) > 1:
                agg = {"industry": industry, "stocks": len(series), "byKey": {}}
                for key in SIGNALS:
                    all_events, bn, bu = [], 0, 0
                    for s in series.values():
                        e, n, u = backtest_series(s, key)
                        all_events += e
                        bn += n
                        bu += u
                    agg["byKey"][key] = summarize(key, all_events, bn, bu)
                agg_cache.set(industry, agg)

        # 目前的訊號：記錄下來（按時間保存），並驗證過去的紀錄
        active = current_signals(me)
        entries = log.record(stock_id, active)
        checked = []
        for e in reversed(entries[-30:]):
            sig = SIGNALS.get(e["key"])
            if not sig:
                continue
            ev = evaluate(me, _anchor_q(sig, e["period"]), sig["horizon"], sig["outcome"])
            status = "pending" if ev is None else ("hit" if ev["improved"] == (sig["direction"] == "positive") else "miss")
            wait_q = q_shift(_anchor_q(sig, e["period"]), sig["horizon"])
            checked.append({**e, "status": status, "eval": ev, "waitFor": wait_q,
                            "waitDate": q_report_date(wait_q).isoformat()})

        return jsonify({
            "stockId": stock_id,
            "asOf": {"month": me.months[-1] if me.months else None, "quarter": me.latest_q()},
            "meta": signal_meta(), "order": list(SIGNALS), "active": active, "backtest": own, "industryBacktest": agg,
            "log": checked, "logStored": supabase is not None,
        })

    app.register_blueprint(bp)
    return {"peers": peers, "log": log}
