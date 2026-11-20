# gunicorn 啟動時會自動讀取工作目錄下的 gunicorn.conf.py，Render 的 Start Command 維持 `gunicorn server:app` 即可。
import os

# Render 會用 PORT 環境變數指定埠號
bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"

# 維持 1 個行程：快取、限流計數、FinMind 呼叫上限都存在記憶體，多個行程會各算各的；
# 免費方案只有 512MB 記憶體，也不適合開多個行程。
workers = 1

# 大部分時間在等外部 API（FinMind、證交所、Supabase），用多執行緒同時處理多個請求
threads = 8

# 預設 30 秒會中斷較慢的請求（例如第一次批次查詢財報、抓日 K），放寬到 120 秒
timeout = 120

# 讓 Render 的日誌即時看到 print 的內容
accesslog = "-"
errorlog = "-"
