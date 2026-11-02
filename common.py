"""server / news / etf 共用的工具：時間、管理員驗證、有上限的快取與每檔股票的鎖"""
import os
import re
import hmac
import time
import threading
import weakref
from collections import OrderedDict
from datetime import datetime, timezone
from flask import request


def get_iso_now():
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"


def safe_parse_iso(date_str):
    """解析 Supabase ISO 時間字串（相容 Py 3.10 以下）；無法解析時回傳最小時間，視同很久以前"""
    if not date_str:
        return datetime.min.replace(tzinfo=timezone.utc)
    s = re.sub(r'(\.\d{6})\d+', r'\1', str(date_str).replace('Z', '+00:00'))
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def is_admin_request():
    expected = os.getenv("ADMIN_KEY", "")
    given = request.headers.get("X-Admin-Key", "")
    return bool(expected) and bool(given) and hmac.compare_digest(expected, given)


class TTLCache:
    """執行緒安全的記憶體快取：超過 ttl 秒即失效，超過 maxsize 筆時淘汰最舊的項目"""

    def __init__(self, ttl, maxsize=500):
        self.ttl = ttl
        self.maxsize = maxsize
        self._data = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None
            stored_at, value = item
            if time.time() - stored_at >= self.ttl:
                del self._data[key]
                return None
            return value

    def set(self, key, value):
        with self._lock:
            self._data.pop(key, None)
            self._data[key] = (time.time(), value)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def pop(self, key):
        with self._lock:
            self._data.pop(key, None)

    def clear(self):
        with self._lock:
            self._data.clear()


class LockRegistry:
    """依 key 取得同一把鎖；沒有人持有參照時會自動回收，不會無限累積"""

    def __init__(self):
        self._locks = weakref.WeakValueDictionary()
        self._guard = threading.Lock()

    def get(self, key):
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock
