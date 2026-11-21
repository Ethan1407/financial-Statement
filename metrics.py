"""財報衍生指標：用完整歷史算好後附在每一季，前端只存 8 季也能顯示與判斷

- ROE、ROA 與杜邦分析（近 4 季淨利，資產與權益用期初、期末平均）
- Piotroski F-score（9 項）
- Beneish M-score（8 變數）
- Altman Z''-score（非製造業版，只用帳面數字）與 Z-score 的輸入值（市值由前端用股價資料補上）
- 配息：盈餘分配率、自由現金流是否足以支付現金股利、連續配息年數

金額單位都是百萬元。資料不足或沒有意義時回傳 None，並盡量附上原因。
"""
import re


def _ok(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def q_shift(q, k):
    y, n = int(q[:4]), int(q[-1])
    idx = y * 4 + (n - 1) + k
    return f"{idx // 4}Q{idx % 4 + 1}"


def _r(v, d=2):
    return round(v, d) if _ok(v) else None


class _Aux:
    """每季的原始金額（不輸出到結果，只用來計算）"""

    def __init__(self, aux):
        self.aux = aux

    def v(self, q, key):
        val = (self.aux.get(q) or {}).get(key)
        return val if _ok(val) else None

    def ttm(self, q, key):
        vals = [self.v(q_shift(q, -i), key) for i in range(4)]
        return sum(vals) if all(_ok(x) for x in vals) else None

    def avg(self, q, key):
        a, b = self.v(q, key), self.v(q_shift(q, -4), key)
        return (a + b) / 2 if a is not None and b is not None else None


def _safe_div(n, d):
    return n / d if _ok(n) and _ok(d) and d != 0 else None


# ================= ROE、ROA、杜邦 =================
def dupont(a, q):
    ni, rev = a.ttm(q, "ni"), a.ttm(q, "rev")
    ta, te = a.avg(q, "ta"), a.avg(q, "te")
    out = {"roe": None, "roeStatus": None, "roa": None, "netMarginTTM": None, "assetTurnover": None, "equityMultiplier": None}
    if ni is None or ta is None:
        out["roeStatus"] = "missing"
        return out
    out["roa"] = _r(ni / ta * 100) if ta > 0 else None
    if rev and rev > 0:
        out["netMarginTTM"] = _r(ni / rev * 100)
        out["assetTurnover"] = _r(rev / ta, 3) if ta > 0 else None
    if te is None:
        out["roeStatus"] = "missing"
    elif te <= 0:
        out["roeStatus"] = "negEquity"   # 權益為負：ROE 沒有意義
    else:
        out["equityMultiplier"] = _r(ta / te)
        if ni < 0:
            out["roeStatus"] = "loss"    # 虧損：ROE 為負，不拿來和其他公司比較
        else:
            out["roe"] = _r(ni / te * 100)
            out["roeStatus"] = "ok"
    return out


# ================= Piotroski F-score =================
F_ITEMS = [
    ("roaPositive", "ROA 為正"),
    ("cfoPositive", "營業現金流為正"),
    ("roaUp", "ROA 比去年同期高"),
    ("accrual", "營業現金流大於淨利"),
    ("leverageDown", "長期負債比沒有上升"),
    ("liquidityUp", "流動比率比去年同期高"),
    ("noIssuance", "沒有現金增資發行新股"),
    ("marginUp", "毛利率比去年同期高"),
    ("turnoverUp", "資產週轉率比去年同期高"),
]


def fscore(a, q):
    p = q_shift(q, -4)

    def roa(x):
        return _safe_div(a.ttm(x, "ni"), a.v(q_shift(x, -4), "ta"))   # 期初總資產

    def gm(x):
        return _safe_div(a.ttm(x, "gp"), a.ttm(x, "rev"))

    def ato(x):
        return _safe_div(a.ttm(x, "rev"), a.v(q_shift(x, -4), "ta"))

    def cr(x):
        return _safe_div(a.v(x, "ca"), a.v(x, "cl"))

    def lev(x):
        return _safe_div(a.v(x, "ltd"), a.v(x, "ta"))

    def cmp(x, y, strict=True):
        if x is None or y is None:
            return None
        return x > y if strict else x <= y

    roa_q, roa_p = roa(q), roa(p)
    cfo, ni = a.ttm(q, "ocf"), a.ttm(q, "ni")
    sc, sc_p = a.v(q, "share"), a.v(p, "share")
    pr, pr_p = a.v(q, "premium"), a.v(p, "premium")
    if sc is None or sc_p is None:
        issued = None
    elif pr is not None and pr_p is not None:
        # 台灣常見盈餘轉增資（股票股利）只增加股本、不增加發行溢價；股本與發行溢價同時增加才視為現金增資
        issued = sc > sc_p * 1.02 and pr > pr_p * 1.02
    else:
        issued = sc > sc_p * 1.02
    checks = {
        "roaPositive": None if roa_q is None else roa_q > 0,
        "cfoPositive": None if cfo is None else cfo > 0,
        "roaUp": cmp(roa_q, roa_p),
        "accrual": cmp(cfo, ni),
        "leverageDown": cmp(lev(q), lev(p), strict=False),
        "liquidityUp": cmp(cr(q), cr(p)),
        "noIssuance": None if issued is None else not issued,
        "marginUp": cmp(gm(q), gm(p)),
        "turnoverUp": cmp(ato(q), ato(p)),
    }
    known = [v for v in checks.values() if v is not None]
    if not known:
        return None
    return {"score": sum(1 for v in known if v), "n": len(known),
            "items": [{"key": k, "pass": checks[k]} for k, _ in F_ITEMS]}


# ================= Beneish M-score =================
def mscore(a, q):
    p = q_shift(q, -4)
    s_t, s_p = a.ttm(q, "rev"), a.ttm(p, "rev")
    gp_t, gp_p = a.ttm(q, "gp"), a.ttm(p, "gp")
    dep_t, dep_p = a.ttm(q, "dep"), a.ttm(p, "dep")
    sga_t, sga_p = a.ttm(q, "opex"), a.ttm(p, "opex")
    ni, cfo = a.ttm(q, "ni"), a.ttm(q, "ocf")
    vals = {k: (a.v(q, k), a.v(p, k)) for k in ("ar", "ca", "ppe", "ta", "tl")}
    needed = [s_t, s_p, gp_t, gp_p, dep_t, dep_p, sga_t, sga_p, ni, cfo] + [x for pair in vals.values() for x in pair]
    if any(v is None for v in needed):
        return None
    (ar_t, ar_p), (ca_t, ca_p), (ppe_t, ppe_p), (ta_t, ta_p), (tl_t, tl_p) = (vals[k] for k in ("ar", "ca", "ppe", "ta", "tl"))
    if min(s_t, s_p, ta_t, ta_p) <= 0 or gp_t <= 0 or gp_p <= 0 or ar_p <= 0 or sga_p <= 0:
        return None
    gm_t, gm_p = gp_t / s_t, gp_p / s_p
    aq_t, aq_p = 1 - (ca_t + ppe_t) / ta_t, 1 - (ca_p + ppe_p) / ta_p
    dr_t, dr_p = _safe_div(dep_t, dep_t + ppe_t), _safe_div(dep_p, dep_p + ppe_p)
    if aq_p <= 0 or not dr_t or dr_p is None:
        return None
    comp = {
        "DSRI": (ar_t / s_t) / (ar_p / s_p),       # 應收帳款相對營收
        "GMI": gm_p / gm_t,                         # 毛利率變化
        "AQI": aq_t / aq_p,                         # 資產品質
        "SGI": s_t / s_p,                           # 營收成長
        "DEPI": dr_p / dr_t,                        # 折舊率
        "SGAI": (sga_t / s_t) / (sga_p / s_p),     # 營業費用率（以營業費用代替管銷費用）
        "LVGI": (tl_t / ta_t) / (tl_p / ta_p),     # 槓桿
        "TATA": (ni - cfo) / ta_t,                  # 應計項目
    }
    m = (-4.84 + 0.920 * comp["DSRI"] + 0.528 * comp["GMI"] + 0.404 * comp["AQI"] + 0.892 * comp["SGI"]
         + 0.115 * comp["DEPI"] - 0.172 * comp["SGAI"] + 4.679 * comp["TATA"] - 0.327 * comp["LVGI"])
    return {"score": _r(m), "components": {k: _r(v, 3) for k, v in comp.items()}}


# ================= Altman Z =================
def zscore(a, q):
    ta, tl = a.v(q, "ta"), a.v(q, "tl")
    ca, cl, re_, te = a.v(q, "ca"), a.v(q, "cl"), a.v(q, "re"), a.v(q, "te")
    ebit, rev = a.ttm(q, "ebit"), a.ttm(q, "rev")
    if None in (ta, tl, ca, cl, re_, te, ebit) or ta <= 0 or tl <= 0:
        return None
    x1, x2, x3, x4 = (ca - cl) / ta, re_ / ta, ebit / ta, te / tl
    return {
        "zpp": _r(6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4),   # Z''：非製造業版（帳面權益 ÷ 負債）
        # Z（製造業原始版）需要市值：1.2X1 + 1.4X2 + 3.3X3 + 0.6(市值 ÷ 負債) + 1.0(營收 ÷ 總資產)
        "x1": _r(x1, 4), "x2": _r(x2, 4), "x3": _r(x3, 4),
        "salesTA": _r(rev / ta, 4) if rev is not None else None, "totalLiab": _r(tl, 0),
    }


def add_derived(quarters, aux, is_financial):
    """把衍生指標寫進 quarters（就地修改）"""
    a = _Aux(aux)
    for row in quarters:
        q = row["q"]
        row.update(dupont(a, q))
        cl, cl_p = a.v(q, "contract"), a.v(q_shift(q, -4), "contract")
        row["contractYoY"] = _r((cl / cl_p - 1) * 100) if cl is not None and cl_p and cl_p > 0 else None
        if is_financial:
            row["fscore"] = row["mscore"] = row["zscore"] = None
            continue
        row["fscore"] = fscore(a, q)
        row["mscore"] = mscore(a, q)
        row["zscore"] = zscore(a, q)


# ================= 配息 =================
def _periods_expected(year_text):
    if "季" in year_text:
        return 4
    if "半年" in year_text:
        return 2
    return 1


def compute_dividends(div_raw, quarters, aux):
    """依盈餘所屬年度彙總現金與股票股利，計算盈餘分配率與自由現金流涵蓋率"""
    a = _Aux(aux)
    years, seen = {}, set()
    for r in div_raw or []:
        text = str(r.get("year") or "")
        m = re.match(r"(\d+)", text)
        if not m:
            continue
        cash = (r.get("CashEarningsDistribution") or 0) + (r.get("CashStatutorySurplus") or 0)
        stock = (r.get("StockEarningsDistribution") or 0) + (r.get("StockStatutorySurplus") or 0)
        if cash <= 0 and stock <= 0:
            continue  # 現金增資、更正公告等沒有配發股利的紀錄
        key = (text, round(cash, 4), round(stock, 4), r.get("CashExDividendTradingDate") or r.get("date"))
        if key in seen:
            continue
        seen.add(key)
        fy = int(m.group(1)) + 1911
        y = years.setdefault(fy, {"cash": 0.0, "stock": 0.0, "periods": set(), "expected": _periods_expected(text),
                                  "exDates": []})
        y["cash"] += cash
        y["stock"] += stock
        y["periods"].add(text)
        ex = r.get("CashExDividendTradingDate") or r.get("StockExDividendTradingDate")
        if ex:
            y["exDates"].append(ex)

    eps_by_q = {row["q"]: row.get("eps") for row in quarters}
    out = []
    for fy in sorted(years):
        y = years[fy]
        qs = [f"{fy}Q{i}" for i in range(1, 5)]
        eps = [eps_by_q.get(q) for q in qs]
        eps_year = sum(eps) if all(_ok(e) for e in eps) else None
        complete = len(y["periods"]) >= y["expected"]
        fcf = [a.v(q, "fcf") for q in qs]
        fcf_year = sum(fcf) if all(_ok(x) for x in fcf) else None
        share = a.v(f"{fy}Q4", "share")
        total_cash = y["cash"] * share / 10 if share else None   # 股本 ÷ 面額 10 元 = 股數（百萬股）
        out.append({
            "year": fy, "cash": _r(y["cash"], 4), "stock": _r(y["stock"], 4), "complete": complete,
            "periods": len(y["periods"]), "expected": y["expected"], "eps": _r(eps_year),
            "payout": _r(y["cash"] / eps_year * 100, 1) if eps_year and eps_year > 0 and complete else None,
            "lossPayout": bool(eps_year is not None and eps_year <= 0 and y["cash"] > 0),
            "totalCash": _r(total_cash, 0), "fcf": _r(fcf_year, 0),
            "fcfCover": _r(fcf_year / total_cash, 2) if fcf_year is not None and total_cash else None,
            "exDates": sorted(y["exDates"]),
        })
    # 連續配息年數：從最近一個有配現金股利的年度往回數，中間不能有缺年
    streak, expect = 0, None
    for d in reversed(out):
        if not (d["cash"] and d["cash"] > 0) or (expect is not None and d["year"] != expect):
            break
        streak += 1
        expect = d["year"] - 1
    return {"years": out[-10:], "consecutiveYears": streak}
