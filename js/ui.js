// ==========================================
// 共用介面元件：頁內提示（取代 alert）、確認框（取代 confirm）、財務名詞說明 ⓘ、股票代號／名稱自動完成
// ==========================================

// ---------------- 頁內提示 ----------------
// type：info | success | warn | error。訊息可含換行（\n）
function showToast(message, type = 'info', duration = 4500) {
  let box = document.getElementById('toast-container');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-container';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '關閉');
  close.textContent = '×';
  const remove = () => { toast.classList.add('leaving'); setTimeout(() => toast.remove(), 200); };
  close.onclick = remove;
  toast.append(text, close);
  box.appendChild(toast);
  if (duration > 0) setTimeout(remove, duration);
}

// ---------------- 確認框 ----------------
// 回傳 Promise<boolean>。danger 為 true 時確定按鈕顯示紅色（刪除類操作）
function showConfirm(message, options = {}) {
  return openModal(message, { ...options, input: false });
}

// 取代 prompt()：回傳輸入的文字，按取消回傳 null
function showPrompt(message, { placeholder = '', maxLength = 50, okText = '確定' } = {}) {
  return openModal(message, { okText, input: { placeholder, maxLength } });
}

function openModal(message, { okText = '確定', cancelText = '取消', danger = false, input = false } = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <p class="modal-text"></p>
        ${input ? '<input type="text" class="modal-input">' : ''}
        <div class="modal-actions">
          <button type="button" class="btn-outline modal-cancel"></button>
          <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'} modal-ok"></button>
        </div>
      </div>`;
    backdrop.querySelector('.modal-text').textContent = message;
    backdrop.querySelector('.modal-cancel').textContent = cancelText;
    const okBtn = backdrop.querySelector('.modal-ok');
    okBtn.textContent = okText;
    const field = backdrop.querySelector('.modal-input');
    if (field) { field.placeholder = input.placeholder; field.maxLength = input.maxLength; }
    const previousFocus = document.activeElement;
    // 確認框回傳 true/false；輸入框回傳文字或 null
    const done = (ok) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(field ? (ok ? field.value : null) : ok);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    backdrop.querySelector('.modal-cancel').onclick = () => done(false);
    okBtn.onclick = () => done(true);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) done(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    (field || okBtn).focus();
  });
}

// ---------------- 財務名詞說明 ----------------
// 一句白話解釋，幫新手看懂專有名詞
const GLOSSARY = {
  '年增率': '和去年同一期相比，營收成長或衰退了多少百分比；跟去年同期比可以避開淡旺季的影響。',
  '營收年增': '和去年同一季相比，營收成長或衰退了多少百分比；跟去年同期比可以避開淡旺季的影響。',
  '月增率': '和上個月相比，營收成長或衰退了多少百分比；容易受淡旺季、工作天數影響。',
  '累計年增率': '今年 1 月累計到這個月的營收，和去年同期相比的變化，比單月更能看出趨勢。',
  '營收': '公司賣產品或服務收到的總金額，還沒扣掉任何成本。',
  '毛利率': '每賣 100 元，扣掉原料、製造等直接成本後還剩多少；越高代表產品越有定價能力。',
  '營業利益': '營收扣掉成本，再扣掉管銷、研發等營業費用後，本業實際賺到的錢。',
  '營益率': '營業利益佔營收的比例，代表本業賺錢的能力；比毛利率多扣了營業費用。',
  '營業外收支': '本業以外的收入或損失，例如利息、匯兌、投資收益；通常不穩定，不能當成長期獲利。',
  '淨利': '扣掉所有成本、費用和稅之後，公司最後賺到的錢。',
  'EPS': '每股盈餘＝淨利 ÷ 股數，代表每一股替股東賺了多少錢。',
  '負債比': '公司的資產中，有多少比例是借來的錢；越高代表財務槓桿越大、景氣差時壓力越大。',
  '流動比': '一年內可以變現的資產 ÷ 一年內要還的債，看短期還債能力；通常大於 1.5 倍較安心。',
  '流動比率': '一年內可以變現的資產 ÷ 一年內要還的債，看短期還債能力；通常大於 1.5 倍較安心。',
  '速動比率': '和流動比類似，但扣掉不一定能馬上賣掉的存貨，更嚴格地檢查短期還債能力；通常大於 1 倍較安心。',
  '速動比': '和流動比類似，但扣掉不一定能馬上賣掉的存貨，更嚴格地檢查短期還債能力；通常大於 1 倍較安心。',
  '利息保障倍數': '本業獲利是利息支出的幾倍；倍數越低代表付利息越吃力，低於 3 倍要留意。',
  '應收天數': '商品賣出後，平均要多少天才收到錢；天數變長可能代表客戶付款變慢。',
  '存貨天數': '存貨平均要放多少天才賣掉；天數變長可能代表產品賣不動。',
  '營業現金流': '本業實際收進來的現金；比帳上的獲利更難美化，長期為負要留意。',
  '融資現金流': '借錢、還錢、發股利、增資等籌資活動造成的現金進出。',
  '自由現金流': '營業現金流扣掉買機器、蓋廠房等資本支出後，公司真正可以自由運用的現金。',
  '期末現金': '這一季結束時，公司帳上持有的現金。',
  '風險分數': '依觸發的警訊加總（紅燈 25 分、黃燈 10 分，最高 100）；分數越高越需要留意。',
  '本益比': '股價 ÷ 近 4 季 EPS 合計，代表用現在的價格買，要幾年的獲利才能回本；要和同一家公司過去的水準或同產業比較才有意義。',
  '52 週區間': '過去一年（約 52 週）的最低價到最高價，圓點是現在的價格位置；越靠右代表越接近一年來的高點。',
  '股價淨值比': '股價 ÷ 每股淨值（公司資產扣掉負債後、每股分到的帳面價值）。小於 1 代表股價比帳面價值還低；資產型、金融業常用來看估值。',
  '殖利率': '近一年發放的股利 ÷ 股價，代表用現在的價格買進、一年可以領回多少股利；殖利率越高，以股利來看越便宜。',
  'PEG': '本益比 ÷ 盈餘成長率（%）。Peter Lynch 認為合理價位的公司本益比約等於成長率（PEG≈1），低於 1 偏便宜、2 以上偏貴；只適用於獲利成長的公司。',
  '動能': '過去一段時間（這裡是 12 個月、扣掉最近 1 個月）的股價漲跌。研究發現過去表現強的股票之後傾向延續一段時間，常和估值一起使用。',
  '波動度': '股價每天漲跌幅度的大小，換算成一年的數字；越高代表股價越不穩定。一般公司約 30%～60%，破產前的公司平均超過 100%。',
  '違約距離': '用市值、負債與股價波動計算，公司資產要跌多少（以標準差計）才不夠還債。數字越大越安全；低於 1 代表依模型估計一年內違約機率約 16%。',
  'K線':'每一根「K 棒」代表一段期間（日K＝一天、週K＝一週、月K＝一個月）的開盤、最高、最低、收盤價。紅色＝收盤比開盤高，綠色＝收盤比開盤低（台股習慣）；上下的細線是這段期間的最高與最低價。',
  '均線': '過去 N 根 K 棒收盤價的平均（例如 20 日均線＝近 20 個交易日的平均收盤價），用來看股價的大方向；股價在均線上方代表近期走勢偏強。',
  '成交量': '這段期間成交了多少張股票（1 張＝1,000 股）；價格變動時若成交量也放大，代表參與的人多、走勢比較有參考性。',
  '財報燈號': '標在每季財報的法定公布期限：Q1 5/15、Q2 8/14、Q3 11/14、Q4 隔年 3/31（實際可能更早公布）。顏色是用當時已有的財報、依本站警訊規則判斷的燈號：紅＝警戒、黃＝注意、綠＝正常。點一下可開啟證交所的財務報告書。',
  '法說會': '法人說明會：公司向投資人說明營運狀況與未來展望，屬於「領先指標」（財報與月營收是落後指標）。點一下可開啟公司投資人關係網頁或觀測站的法說會資料。',
  '除權息': '公司發放現金股利（除息）或股票股利（除權）的那一天，股價會依配發金額往下調整，這是正常的發放，不代表公司變差。勾選「還原權息」可把這些調整加回去。',
  '本益比河流圖': '把這家公司過去的本益比分成幾個區間（例如最便宜的 10%、中位數、最貴的 10%），各自乘上當時的 EPS 畫成線。股價靠近上面的線，代表以它自己的歷史標準來看偏貴；只是歷史比較，不代表合理價。',
  '報酬率比較': '把幾檔股票的起點都設為 0%，比較同一段期間誰漲得多。使用還原權息股價，比的是含股利的總報酬。',
  '區間報酬': '比較期間內，從第一天到最後一天的總漲跌幅（含股利再投入）。',
  '年化報酬': '把區間報酬換算成「平均每年」的報酬率，方便比較長短不同的期間；區間未滿 1 年時不計算。',
  '最大回撤': '比較期間內，股價從最高點跌到之後最低點的最大跌幅，代表持有過程中最慘的帳面虧損，越接近 0 越穩定。',
  '分位數': '把歷史數值由小排到大，例如「10% 分位」代表只有 10% 的時間比這個數字低、「中位數」是正中間的值。',
  '還原權息':'把歷年發放的現金與股票股利加回股價，排除除權息造成的價格下跌，才能看出長期持有的真實報酬。',
  'HHI':'衡量持股集中程度的指標（各持股權重百分比的平方和，0～10000）；超過 2500 代表高度集中在少數幾檔。',
  '有效持股數': '把集中程度換算成「相當於平均持有幾檔」；數字越小代表越集中在少數公司。',
  'ROE': '股東權益報酬率＝近 4 季淨利 ÷ 平均股東權益，代表股東投入的每 100 元一年賺多少；長期 15% 以上屬優秀。虧損或權益為負時沒有意義。',
  'ROA': '資產報酬率＝近 4 季淨利 ÷ 平均總資產，代表公司運用全部資產（含借來的錢）賺錢的效率。',
  '杜邦分析': '把 ROE 拆成「淨利率 × 資產週轉率 × 權益乘數」，看報酬是來自賺得多、轉得快，還是借得多。',
  '權益乘數': '平均總資產 ÷ 平均股東權益；數字越大代表借越多錢，ROE 會被放大，風險也一樣被放大。',
  '資產週轉率': '近 4 季營收 ÷ 平均總資產，代表每 1 元資產一年創造多少營收。',
  '應付天數': '向供應商進貨後，平均多少天才付錢；天數突然變長可能是延後付款來撐現金。',
  '現金轉換循環': '應收天數 + 存貨天數 − 應付天數：從付錢給供應商到收回客戶貨款要幾天；越短代表資金週轉越快。',
  'F-score': 'Piotroski F-score：9 項財務體質檢查（獲利、現金流、槓桿、流動性、是否增資、毛利率、週轉率）各給 1 分。原始研究以低股價淨值比的股票為樣本，分數高只代表體質改善，不保證股價表現。',
  'M-score': 'Beneish M-score：用 8 個財務變數估計財報被美化的可能，大於 −1.78 代表可能性較高。以美國公司建立，金融業不適用，只當輔助訊號。',
  'Z-score': 'Altman Z-score：用營運資金、保留盈餘、息稅前利益、市值（或帳面權益）、營收估計破產風險。數字越低越危險；製造業低於 1.81、非製造業（Z\'\'）低於 1.1 為危險區。',
  '盈餘分配率': '現金股利 ÷ 每股盈餘；超過 100% 代表配出的錢比賺的多，通常難以持續。',
  '填息': '除息後股價漲回除息前一天的收盤價。填息天數越短，代表市場越願意用原價承接。'
};

function termInfoButton(term) {
  if (!GLOSSARY[term]) return '';
  return `<button type="button" class="term-info" data-term="${term}" aria-label="什麼是${term}？">ⓘ</button>`;
}
// 名詞＋說明按鈕。label 為顯示文字（預設同名詞）
function termHtml(term, label = term) {
  return `${label}${termInfoButton(term)}`;
}

// 表頭（例如「速動比率」「營收(百萬)」）自動加上說明按鈕
function decorateTermHeaders(root = document) {
  root.querySelectorAll('th:not([data-term-done])').forEach(th => {
    th.dataset.termDone = '1';
    const term = th.textContent.replace(/\(.*?\)/g, '').trim();
    if (GLOSSARY[term]) th.insertAdjacentHTML('beforeend', termInfoButton(term));
  });
}

function closeTermPopover() {
  const pop = document.getElementById('term-popover');
  if (pop) pop.remove();
}

function openTermPopover(btn) {
  const term = btn.dataset.term;
  const already = document.getElementById('term-popover');
  closeTermPopover();
  if (already && already.dataset.term === term && already.dataset.owner === btn.dataset.popId) return; // 再點一次＝關閉
  if (!btn.dataset.popId) btn.dataset.popId = String(Math.random()).slice(2);
  const pop = document.createElement('div');
  pop.id = 'term-popover';
  pop.setAttribute('role', 'tooltip');
  pop.dataset.term = term;
  pop.dataset.owner = btn.dataset.popId;
  const title = document.createElement('strong');
  title.textContent = term;
  const body = document.createElement('p');
  body.textContent = GLOSSARY[term];
  pop.append(title, body);
  document.body.appendChild(pop);
  // 放在按鈕下方，超出畫面時往內推
  const r = btn.getBoundingClientRect();
  const margin = 12;
  const width = pop.offsetWidth;
  let left = Math.min(Math.max(r.left + r.width / 2 - width / 2, margin), window.innerWidth - width - margin);
  let top = r.bottom + 8;
  if (top + pop.offsetHeight > window.innerHeight - margin) top = Math.max(r.top - pop.offsetHeight - 8, margin);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.term-info');
  if (btn) { e.preventDefault(); e.stopPropagation(); openTermPopover(btn); return; }
  if (!e.target.closest('#term-popover')) closeTermPopover();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTermPopover(); });
window.addEventListener('scroll', closeTermPopover, { passive: true });
window.addEventListener('resize', closeTermPopover);
document.addEventListener('DOMContentLoaded', () => decorateTermHeaders());

// ---------------- 股票代號／名稱自動完成 ----------------
// 清單來自 data/stock-list.json（證交所、櫃買中心的上市櫃股票與 ETF，跟網頁一起部署），主機睡眠時也能用
let stockListPromise = null;
function loadStockList() {
  if (!stockListPromise) {
    stockListPromise = fetch('data/stock-list.json', { cache: 'force-cache' })
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return stockListPromise.then(list => {
    // 補上瀏覽器裡已查過、但不在清單中的股票（例如暫停交易）
    const map = new Map(list);
    try {
      Object.entries(loadStockDatabase()).forEach(([id, d]) => { if (d && d.name && !map.has(id)) map.set(id, d.name); });
    } catch {}
    return [...map.entries()];
  });
}

const STOCK_CODE_RE = /^[0-9]{4,6}[A-Za-z]?$/;

// 依代號開頭或名稱包含關鍵字搜尋，代號完全相符、名稱開頭相符的排前面
function searchStocks(list, query, limit = 8) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const scored = [];
  for (const [id, name] of list) {
    const n = name.toUpperCase();
    let score = -1;
    if (id === q || n === q) score = 0;
    else if (id.startsWith(q)) score = 1;
    else if (n.startsWith(q)) score = 2;
    else if (n.includes(q)) score = 3;
    if (score >= 0) scored.push({ id, name, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.id.length - b.id.length || a.id.localeCompare(b.id)).slice(0, limit);
}

// 把輸入框接上自動完成。onPick(id) 在選定股票時呼叫，回傳 true 表示成功（才清空輸入框）
function attachStockAutocomplete(input, onPick, hintEl) {
  const wrap = document.createElement('div');
  wrap.className = 'ac-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const listEl = document.createElement('ul');
  listEl.className = 'ac-list';
  listEl.setAttribute('role', 'listbox');
  listEl.id = `${input.id}-list`;
  wrap.appendChild(listEl);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listEl.id);
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');

  let matches = [];
  let active = -1;
  let busy = false;

  const setHint = (text, isError = false) => {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.classList.toggle('error', isError);
  };
  const hide = () => { listEl.innerHTML = ''; listEl.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const render = () => {
    if (!matches.length) return hide();
    listEl.innerHTML = matches.map((m, i) =>
      `<li role="option" data-id="${escapeHtml(m.id)}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}">
         <span class="ac-id">${escapeHtml(m.id)}</span><span class="ac-name">${escapeHtml(m.name)}</span></li>`).join('');
    listEl.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
  };

  const pick = async (id) => {
    if (busy) return;
    busy = true;
    hide();
    setHint('');
    try {
      if (await onPick(id)) input.value = '';
    } finally { busy = false; }
  };

  input.addEventListener('input', async () => {
    setHint('');
    const q = input.value;
    const list = await loadStockList();
    if (input.value !== q) return; // 已經輸入新的字
    matches = searchStocks(list, q);
    active = matches.length ? 0 : -1;
    render();
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      render();
    } else if (e.key === 'Escape') {
      hide();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      await submit();
    }
  });

  listEl.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-id]');
    if (li) { e.preventDefault(); pick(li.dataset.id); }
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));

  // 按 Enter 或按鈕：清單有選中的就用它；否則輸入的是代號就直接查；名稱只對到一檔也直接查；都不是就提示
  const submit = async () => {
    const raw = input.value.trim();
    if (!raw) return;
    if (listEl.style.display === 'block' && matches[active]) return pick(matches[active].id);
    if (STOCK_CODE_RE.test(raw)) return pick(raw.toUpperCase());
    const found = searchStocks(await loadStockList(), raw, 20);
    if (found.length === 1 || (found.length && found[0].score === 0)) return pick(found[0].id);
    if (found.length) {
      matches = found.slice(0, 8);
      active = 0;
      render();
      setHint(`「${raw}」對到 ${found.length} 檔，請從清單選擇。`);
    } else {
      setHint(`找不到「${raw}」，請確認名稱，或直接輸入股票代號（例如 2330）。`, true);
    }
  };

  return { submit };
}
