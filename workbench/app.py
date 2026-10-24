# -*- coding: utf-8 -*-
"""Local-only merchant order console. No Doudian or Feishu API calls."""

import csv
from email import policy
from email.parser import BytesParser
import hashlib
import hmac
import html
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import zipfile
import getpass
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from zoneinfo import ZoneInfo
from partial_due_display import render_partial_due

ROOT = Path(__file__).resolve().parent
# Set a separate directory for development or cloud work. The production default stays local.
DATA = Path(os.environ.get("TUTIANDUO_DATA_DIR", str(ROOT / "data"))).expanduser()
DB = DATA / "orders.db"
PARTIAL_DUE_JSON = DATA / "partial_due.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("TUTIANDUO_PORT", "8765"))
if not 1 <= PORT <= 65535:
    raise ValueError("TUTIANDUO_PORT 须在 1—65535 之间")
FIELDS = ["shop_id", "shop_order_id", "sku_order_id", "product_code", "product_name", "color", "size", "quantity", "status", "created_at", "promised_ship_at", "updated_at"]
DOUDIAN_FIELDS = {"主订单编号", "子订单编号", "选购商品", "商家编码", "商品数量", "订单状态", "售后状态", "订单提交时间", "承诺发货时间"}
HISTORY_EXPORT_FIELDS = {"主订单编号", "子订单编号", "选购商品", "货号", "商品ID", "商家编码", "商品数量", "商品金额", "订单提交时间", "支付完成时间", "订单完成时间", "订单状态", "售后状态"}
HISTORY_STAGE_REPORT_PREFIX = os.environ.get("TUTIANDUO_HISTORY_STAGE_REPORT_PREFIX", "")
PRODUCT_CODE_PATTERN = r"(?:\d{5}[A-Z]{4}|\d{6}[A-Z]{2})"
RAW_ORDER_FIELDS = ("merchant_code_raw", "report_code_raw", "product_id_raw", "code_source")
SNAPSHOT_FIELDS = (*FIELDS, "source_type", "aftersale_status", "shipped_at", *RAW_ORDER_FIELDS)
PRODUCT_COLORS = ("中花灰", "黑灰", "深灰", "浅灰", "宝蓝", "黑色", "大红",
                  "灰色", "橙黄", "焦糖", "豆沙", "花芋粉", "花金咖", "花兰紫",
                  "竹青绿", "嫣粉", "铂灰", "月白蓝", "贝壳粉")
OPEN_STATUSES = ("备货中", "待发货", "部分发货")
MATRIX_SIZES = ("M", "L", "XL", "2XL", "3XL")
FORM_NONCE = secrets.token_urlsafe(32)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_CSV_BYTES = 50 * 1024 * 1024
BEIJING_TZ = ZoneInfo("Asia/Shanghai")
TEMP_ZIP_PASSWORDS = {}
TEMP_ZIP_LOCK = threading.RLock()


def beijing_day():
    return datetime.now(BEIJING_TZ).date().isoformat()


def temporary_zip_list(session_hash):
    with TEMP_ZIP_LOCK:
        today = beijing_day()
        for key, entry in list(TEMP_ZIP_PASSWORDS.items()):
            if entry["day"] != today:
                del TEMP_ZIP_PASSWORDS[key]
        return [(archive_hash, entry["filename"], entry["saved_at"])
                for (owner, archive_hash), entry in TEMP_ZIP_PASSWORDS.items() if owner == session_hash]


def temporary_zip_get(session_hash, archive_hash):
    temporary_zip_list(session_hash)
    with TEMP_ZIP_LOCK:
        entry = TEMP_ZIP_PASSWORDS.get((session_hash, archive_hash))
        return entry["password"] if entry else None


def temporary_zip_put(session_hash, archive_hash, filename, password):
    if not password:
        raise ValueError("空密码不会临时记住")
    temporary_zip_list(session_hash)
    with TEMP_ZIP_LOCK:
        TEMP_ZIP_PASSWORDS[(session_hash, archive_hash)] = {
            "password": password, "filename": filename,
            "day": beijing_day(), "saved_at": datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")}


def temporary_zip_forget(session_hash, archive_hash=None):
    with TEMP_ZIP_LOCK:
        for key in list(TEMP_ZIP_PASSWORDS):
            if key[0] == session_hash and (archive_hash is None or key[1] == archive_hash):
                del TEMP_ZIP_PASSWORDS[key]


def parse_multipart_form(body, content_type):
    if "boundary=" not in content_type.lower():
        raise ValueError("上传表单缺少分隔符")
    envelope = ("MIME-Version: 1.0\r\nContent-Type: " + content_type + "\r\n\r\n").encode("ascii")
    message = BytesParser(policy=policy.default).parsebytes(envelope + body)
    if not message.is_multipart():
        raise ValueError("上传表单格式错误")
    fields = {}
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if not name or name in fields:
            raise ValueError("上传表单字段重复或缺失")
        payload = part.get_payload(decode=True) or b""
        if len(payload) > MAX_UPLOAD_BYTES:
            raise ValueError("上传文件超过 25 MB")
        if part.get_filename() is not None:
            filename = part.get_filename().replace("\\", "/").split("/")[-1]
            filename = "".join(ch for ch in filename if ch.isprintable())[:120]
            fields[name] = (filename, payload)
        else:
            fields[name] = payload.decode("utf-8")
    return fields


def decode_order_file(filename, data, password=""):
    suffix = Path(filename).suffix.lower()
    if not filename or not data:
        raise ValueError("请选择非空的抖店 ZIP 或 CSV 文件")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("上传文件超过 25 MB")
    if suffix == ".zip":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = [entry for entry in archive.infolist()
                         if not entry.is_dir() and entry.filename.lower().endswith(".csv")]
                if len(names) != 1:
                    raise ValueError("ZIP 中必须恰好包含一个 CSV 文件")
                if names[0].file_size > MAX_CSV_BYTES:
                    raise ValueError("ZIP 内 CSV 超过 50 MB")
                if names[0].flag_bits & 1 and not password:
                    raise ValueError("此 ZIP 已加密，请填写解压密码")
                with archive.open(names[0], pwd=password.encode("utf-8") if password else None) as member:
                    content_bytes = member.read(MAX_CSV_BYTES + 1)
        except RuntimeError as exc:
            if "password" in str(exc).lower():
                raise ValueError("ZIP 解压密码错误，请核对短信中的密码") from None
            raise ValueError("ZIP 解压失败，文件可能损坏或加密格式不受支持") from None
        except zipfile.BadZipFile:
            raise ValueError("ZIP 文件损坏或格式不正确") from None
        except EOFError:
            raise ValueError("ZIP 文件不完整或已损坏") from None
        except NotImplementedError:
            raise ValueError("ZIP 使用了当前工作台不支持的压缩格式") from None
    elif suffix == ".csv":
        content_bytes = data
    else:
        raise ValueError("仅支持 .zip 或 .csv 文件")
    if len(content_bytes) > MAX_CSV_BYTES:
        raise ValueError("CSV 超过 50 MB")
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return content_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别 CSV 编码，请使用 UTF-8 或 GB18030")


def connection():
    DATA.mkdir(exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db():
    with connection() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orders (
            shop_id TEXT NOT NULL, shop_order_id TEXT NOT NULL, sku_order_id TEXT NOT NULL,
            product_code TEXT NOT NULL, product_name TEXT NOT NULL, color TEXT NOT NULL,
            size TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
            status TEXT NOT NULL, created_at TEXT NOT NULL, promised_ship_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, imported_at TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'test', aftersale_status TEXT NOT NULL DEFAULT '-',
            shipped_at TEXT NOT NULL DEFAULT '',
            merchant_code_raw TEXT NOT NULL DEFAULT '', report_code_raw TEXT NOT NULL DEFAULT '',
            product_id_raw TEXT NOT NULL DEFAULT '', code_source TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(shop_id, sku_order_id)
        );
        CREATE TABLE IF NOT EXISTS import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT, imported_at TEXT NOT NULL,
            source TEXT NOT NULL, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL,
            errors TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS order_snapshots (
            batch_id INTEGER NOT NULL REFERENCES import_batches(id), row_number INTEGER NOT NULL,
            shop_id TEXT NOT NULL, shop_order_id TEXT NOT NULL, sku_order_id TEXT NOT NULL,
            product_code TEXT NOT NULL, product_name TEXT NOT NULL, color TEXT NOT NULL,
            size TEXT NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, promised_ship_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            source_type TEXT NOT NULL, aftersale_status TEXT NOT NULL, shipped_at TEXT NOT NULL,
            merchant_code_raw TEXT NOT NULL, report_code_raw TEXT NOT NULL,
            product_id_raw TEXT NOT NULL, code_source TEXT NOT NULL,
            PRIMARY KEY(batch_id, row_number)
        );
        CREATE INDEX IF NOT EXISTS idx_order_snapshots_order
            ON order_snapshots(shop_id, sku_order_id, batch_id);
        CREATE TABLE IF NOT EXISTS current_open_batches (
            shop_id TEXT PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES import_batches(id),
            published_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS historical_orders (
            shop_id TEXT NOT NULL, shop_order_id TEXT NOT NULL, sku_order_id TEXT NOT NULL,
            product_code TEXT NOT NULL, product_name TEXT NOT NULL, color TEXT NOT NULL,
            size TEXT NOT NULL, quantity INTEGER NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, promised_ship_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            source_type TEXT NOT NULL, aftersale_status TEXT NOT NULL, shipped_at TEXT NOT NULL,
            merchant_code_raw TEXT NOT NULL, report_code_raw TEXT NOT NULL,
            product_id_raw TEXT NOT NULL, code_source TEXT NOT NULL,
            first_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
            last_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
            first_imported_at TEXT NOT NULL, last_imported_at TEXT NOT NULL,
            PRIMARY KEY(shop_id, sku_order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_historical_orders_created
            ON historical_orders(created_at, shop_id, sku_order_id);
        CREATE TABLE IF NOT EXISTS historical_sku_order_lines (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL,
            parent_order_id TEXT NOT NULL, child_order_id TEXT NOT NULL,
            variant_label TEXT NOT NULL DEFAULT '', size_detail_raw TEXT NOT NULL DEFAULT '',
            quantity INTEGER NOT NULL CHECK(quantity > 0),
            order_status_raw TEXT NOT NULL DEFAULT '',
            aftersale_status_raw TEXT NOT NULL DEFAULT '',
            submitted_at TEXT NOT NULL DEFAULT '', paid_at TEXT NOT NULL DEFAULT '',
            review_reason TEXT NOT NULL DEFAULT '', selection_raw TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(shop_id, product_id, child_order_id)
        );
        CREATE INDEX IF NOT EXISTS idx_historical_sku_paid
            ON historical_sku_order_lines(shop_id, product_id, paid_at);
        CREATE TABLE IF NOT EXISTS sales_import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT, imported_at TEXT NOT NULL,
            source TEXT NOT NULL, row_count INTEGER NOT NULL, zero_days INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sku_daily_sales (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            sku_id TEXT NOT NULL, sku_title TEXT NOT NULL,
            sold_units INTEGER NOT NULL CHECK(sold_units >= 0),
            refund_units_by_refund_date INTEGER NOT NULL CHECK(refund_units_by_refund_date >= 0),
            pay_amount TEXT NOT NULL, source_file TEXT NOT NULL,
            first_batch_id INTEGER NOT NULL REFERENCES sales_import_batches(id),
            last_batch_id INTEGER NOT NULL REFERENCES sales_import_batches(id),
            PRIMARY KEY(shop_id,product_id,sale_date,sku_id)
        );
        CREATE TABLE IF NOT EXISTS sales_day_evidence (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('export','ui_verified_zero')),
            source_file TEXT NOT NULL, last_batch_id INTEGER NOT NULL REFERENCES sales_import_batches(id),
            PRIMARY KEY(shop_id,product_id,sale_date)
        );
        CREATE TABLE IF NOT EXISTS sales_ui_day_evidence (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            visible_row_count INTEGER NOT NULL CHECK(visible_row_count >= 0),
            observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
            last_batch_id INTEGER NOT NULL REFERENCES sales_import_batches(id),
            PRIMARY KEY(shop_id,product_id,sale_date)
        );
        CREATE TABLE IF NOT EXISTS product_daily_summary (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            sold_units INTEGER NOT NULL CHECK(sold_units >= 0),
            paid_order_count INTEGER NOT NULL CHECK(paid_order_count >= 0),
            pay_amount TEXT NOT NULL, observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
            PRIMARY KEY(shop_id,product_id,sale_date)
        );
        CREATE TABLE IF NOT EXISTS refund_sku_page_rows (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            sku_id TEXT NOT NULL, paid_order_count INTEGER NOT NULL CHECK(paid_order_count >= 0),
            refund_order_count_payment_date INTEGER NOT NULL CHECK(refund_order_count_payment_date >= 0),
            observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
            PRIMARY KEY(shop_id,product_id,sale_date,sku_id)
        );
        CREATE TABLE IF NOT EXISTS refund_sku_page_days (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            visible_row_count INTEGER NOT NULL CHECK(visible_row_count >= 0),
            empty_table INTEGER NOT NULL CHECK(empty_table IN (0,1)),
            observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
            PRIMARY KEY(shop_id,product_id,sale_date)
        );
        CREATE TABLE IF NOT EXISTS refund_sku_verified_zero (
            shop_id TEXT NOT NULL, product_id TEXT NOT NULL, sale_date TEXT NOT NULL,
            sku_id TEXT NOT NULL, evidence_kind TEXT NOT NULL
                CHECK(evidence_kind IN ('day_empty','sku_absent')),
            observed_at TEXT NOT NULL, source_url TEXT NOT NULL,
            PRIMARY KEY(shop_id,product_id,sale_date,sku_id)
        );
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(orders)")}
        if "source_type" not in columns:
            db.execute("ALTER TABLE orders ADD COLUMN source_type TEXT NOT NULL DEFAULT 'test'")
        if "aftersale_status" not in columns:
            db.execute("ALTER TABLE orders ADD COLUMN aftersale_status TEXT NOT NULL DEFAULT '-'")
        if "shipped_at" not in columns:
            db.execute("ALTER TABLE orders ADD COLUMN shipped_at TEXT NOT NULL DEFAULT ''")
        for name in RAW_ORDER_FIELDS:
            if name not in columns:
                db.execute(f"ALTER TABLE orders ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
        batch_columns = {row[1] for row in db.execute("PRAGMA table_info(import_batches)")}
        if "snapshot_kind" not in batch_columns:
            db.execute("ALTER TABLE import_batches ADD COLUMN snapshot_kind TEXT NOT NULL DEFAULT 'unavailable'")
        # Older import logs contain counts only. Preserve today's current rows as one
        # migration baseline; never attach them to their old import batch IDs.
        if not db.execute("SELECT 1 FROM order_snapshots LIMIT 1").fetchone() and not db.execute(
                "SELECT 1 FROM import_batches WHERE snapshot_kind='baseline' LIMIT 1").fetchone():
            current = db.execute("SELECT * FROM orders ORDER BY shop_id,sku_order_id").fetchall()
            if current:
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                cursor = db.execute("""INSERT INTO import_batches
                    (imported_at,source,accepted,rejected,errors,snapshot_kind)
                    VALUES(?,?,?,?,?,?)""", (now, "迁移基线：迁移时当前订单表", len(current), 0, "", "baseline"))
                insert_snapshots(db, cursor.lastrowid, current)


def insert_snapshots(db, batch_id, rows):
    columns = "batch_id,row_number," + ",".join(SNAPSHOT_FIELDS)
    placeholders = ",".join("?" for _ in range(len(SNAPSHOT_FIELDS) + 2))
    db.executemany(f"INSERT INTO order_snapshots({columns}) VALUES({placeholders})",
                   ((batch_id, index, *(row[key] for key in SNAPSHOT_FIELDS))
                    for index, row in enumerate(rows, 1)))


def import_daily_sales_json(content, source="罗盘逐日 SKU 导出"):
    """Import verified daily SKU rows and day-level zero evidence, never order rows."""
    payload = json.loads(content)
    shop_id, product_id = str(payload["shop_id"]).strip(), str(payload["product_id"]).strip()
    rows, days = payload["rows"], payload["days"]
    if not shop_id or not product_id or not isinstance(rows, list) or not isinstance(days, list):
        raise ValueError("销量数据缺少店铺、商品或日期明细")
    if len(rows) > 5000 or len(days) > 366:
        raise ValueError("销量数据超过单次导入限制")
    day_map = {}
    for item in days:
        day = str(item["date"])
        date.fromisoformat(day)
        kind = item["kind"]
        filename = str(item.get("source_file", ""))
        if kind not in ("export", "ui_verified_zero") or (kind == "export" and not filename):
            raise ValueError("日期证据不完整")
        if day in day_map:
            raise ValueError(f"重复日期：{day}")
        day_map[day] = (kind, filename)
    clean, keys = [], set()
    for row in rows:
        day, sku = str(row["date"]), str(row["sku_id"]).strip()
        date.fromisoformat(day)
        if day not in day_map or day_map[day][0] != "export" or not sku:
            raise ValueError("SKU 行缺少对应的原始导出日期")
        key = (day, sku)
        if key in keys:
            raise ValueError(f"重复 SKU 日期：{day} {sku}")
        keys.add(key)
        sold, refund = int(row["sold_units"]), int(row["refund_units_by_refund_date"])
        if sold < 0 or refund < 0:
            raise ValueError("成交和退款件数不能为负")
        filename = str(row["source_file"])
        if filename != day_map[day][1]:
            raise ValueError("SKU 行来源文件与日期证据不一致")
        clean.append((day, sku, str(row["sku_title"]), sold, refund,
                      str(row["pay_amount"]), filename))
    if any(kind == "export" and not any(r[0] == day for r in clean)
           for day, (kind, _) in day_map.items()):
        raise ValueError("有导出日期没有 SKU 行")
    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")
    with connection() as db:
        cursor = db.execute("INSERT INTO sales_import_batches(imported_at,source,row_count,zero_days) VALUES(?,?,?,?)",
                            (now, source, len(clean), sum(k == "ui_verified_zero" for k, _ in day_map.values())))
        batch = cursor.lastrowid
        for day, sku, title, sold, refund, amount, filename in clean:
            db.execute("""INSERT INTO sku_daily_sales VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(shop_id,product_id,sale_date,sku_id) DO UPDATE SET
                sku_title=excluded.sku_title,sold_units=excluded.sold_units,
                refund_units_by_refund_date=excluded.refund_units_by_refund_date,
                pay_amount=excluded.pay_amount,source_file=excluded.source_file,
                last_batch_id=excluded.last_batch_id""",
                (shop_id, product_id, day, sku, title, sold, refund, amount, filename, batch, batch))
        for day, (kind, filename) in day_map.items():
            db.execute("""INSERT INTO sales_day_evidence VALUES(?,?,?,?,?,?)
                ON CONFLICT(shop_id,product_id,sale_date) DO UPDATE SET
                evidence_kind=excluded.evidence_kind,source_file=excluded.source_file,
                last_batch_id=excluded.last_batch_id""",
                (shop_id, product_id, day, kind, filename, batch))
    return batch, len(clean), len(day_map)


def import_daily_sales_ui_json(content):
    """Import verified visible Compass SKU rows; keep page evidence distinct from exports."""
    payload = json.loads(content)
    shop, product = str(payload["shop_id"]).strip(), str(payload["product_id"]).strip()
    observed_at, source_url = str(payload["observed_at"]), str(payload["source_url"])
    days = payload["days"]
    if not shop or not product or not observed_at or not source_url.startswith(
            "https://compass.jinritemai.com/shop/product-detail"):
        raise ValueError("销量页面来源或商品信息无效")
    if not isinstance(days, list) or len(days) > 31:
        raise ValueError("单次页面日期数量无效")
    seen_days, clean = set(), []
    for item in days:
        day = str(item["day"])
        date.fromisoformat(day)
        if day in seen_days:
            raise ValueError(f"重复日期 {day}")
        seen_days.add(day)
        rows = item["rows"]
        if not isinstance(rows, list) or item["reported_count"] != len(rows):
            raise ValueError(f"SKU 页面行数不符 {day}")
        if not rows and item.get("sold_units_total") != 0:
            raise ValueError(f"空表日期缺少零成交汇总证据 {day}")
        seen_skus, total = set(), 0
        for row in rows:
            sku = str(row["sku_id"]).strip()
            if not sku or sku in seen_skus:
                raise ValueError(f"重复或空 SKU {day}")
            seen_skus.add(sku)
            sold = int(row["sold_units"])
            refund = int(row["refund_units_by_refund_date"])
            if sold < 0 or refund < 0:
                raise ValueError("成交和退款件数不能为负")
            total += sold
            clean.append((day, sku, str(row["sku_title"]), sold, refund,
                          str(row["pay_amount"]), f"罗盘页面核验 {day}"))
        if total != int(item["sold_units_total"]):
            raise ValueError(f"SKU 件数与页面汇总不符 {day}")
    now = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d %H:%M:%S")
    with connection() as db:
        cursor = db.execute("INSERT INTO sales_import_batches(imported_at,source,row_count,zero_days) VALUES(?,?,?,?)",
                            (now, f"罗盘页面逐日核验 {source_url}", len(clean), sum(not d["rows"] for d in days)))
        batch = cursor.lastrowid
        for day, sku, title, sold, refund, amount, evidence in clean:
            db.execute("""INSERT INTO sku_daily_sales VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(shop_id,product_id,sale_date,sku_id) DO UPDATE SET
                sku_title=excluded.sku_title,sold_units=excluded.sold_units,
                refund_units_by_refund_date=excluded.refund_units_by_refund_date,
                pay_amount=excluded.pay_amount,source_file=excluded.source_file,
                last_batch_id=excluded.last_batch_id""",
                (shop, product, day, sku, title, sold, refund, amount, evidence, batch, batch))
        for item in days:
            db.execute("""INSERT INTO sales_ui_day_evidence VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(shop_id,product_id,sale_date) DO UPDATE SET
                visible_row_count=excluded.visible_row_count,observed_at=excluded.observed_at,
                source_url=excluded.source_url,last_batch_id=excluded.last_batch_id""",
                (shop, product, item["day"], len(item["rows"]), observed_at, source_url, batch))
    return batch, len(clean), len(days)


def import_product_daily_summary_json(content):
    """Store product-level history separately; never allocate totals to SKUs."""
    payload = json.loads(content)
    shop, product = str(payload["shop_id"]).strip(), str(payload["product_id"]).strip()
    observed_at, source_url = str(payload["observed_at"]), str(payload["source_url"])
    days = payload["days"]
    if not shop or not product or not observed_at or not source_url.startswith(
            "https://compass.jinritemai.com/shop/product-detail"):
        raise ValueError("商品整体页面来源无效")
    if not isinstance(days, list) or len(days) > 31:
        raise ValueError("商品整体日期数量无效")
    clean, seen = [], set()
    for item in days:
        day = str(item["day"])
        date.fromisoformat(day)
        if day in seen:
            raise ValueError(f"重复日期 {day}")
        seen.add(day)
        units, orders = int(item["sold_units"]), int(item["paid_order_count"])
        amount = str(item["pay_amount"])
        if units < 0 or orders < 0 or not re.fullmatch(r"\d+(?:\.\d{1,2})?", amount):
            raise ValueError(f"商品整体指标无效 {day}")
        clean.append((shop, product, day, units, orders, amount, observed_at, source_url))
    with connection() as db:
        db.executemany("""INSERT INTO product_daily_summary VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(shop_id,product_id,sale_date) DO UPDATE SET
            sold_units=excluded.sold_units,paid_order_count=excluded.paid_order_count,
            pay_amount=excluded.pay_amount,observed_at=excluded.observed_at,
            source_url=excluded.source_url""", clean)
    return len(clean)


def import_refund_sku_page_json(content):
    payload = json.loads(content)
    shop, product = str(payload["shop_id"]), str(payload["product_id"])
    observed_at, source_url = str(payload["observed_at"]), str(payload["source_url"])
    if not shop or not product or not observed_at or not source_url.startswith("https://compass.jinritemai.com/shop/product-detail"):
        raise ValueError("退款页面来源或商品信息无效")
    dates = payload["days"]
    if not isinstance(dates, list) or len(dates) > 31:
        raise ValueError("退款页面日期数量无效")
    seen_days, total_rows = set(), 0
    with connection() as db:
        for item in dates:
            day = str(item["day"])
            date.fromisoformat(day)
            if day in seen_days:
                raise ValueError(f"重复日期 {day}")
            seen_days.add(day)
            rows = item["rows"]
            empty = bool(item.get("no_refund_sku_rows", False))
            if not isinstance(rows, list) or (empty and rows) or item.get("reported_count") != len(rows) and not empty:
                raise ValueError(f"退款 SKU 表行数不符 {day}")
            seen_skus = set()
            for row in rows:
                sku = str(row["sku_id"])
                if sku in seen_skus or not sku:
                    raise ValueError(f"重复或空 SKU {day}")
                seen_skus.add(sku)
                paid, refund = int(row["paid_order_count"]), int(row["refund_order_count_payment_date"])
                if paid < 0 or refund < 0:
                    raise ValueError("订单数不能为负")
                db.execute("""INSERT INTO refund_sku_page_rows VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(shop_id,product_id,sale_date,sku_id) DO UPDATE SET
                    paid_order_count=excluded.paid_order_count,
                    refund_order_count_payment_date=excluded.refund_order_count_payment_date,
                    observed_at=excluded.observed_at,source_url=excluded.source_url""",
                    (shop, product, day, sku, paid, refund, observed_at, source_url))
            db.execute("""INSERT INTO refund_sku_page_days VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(shop_id,product_id,sale_date) DO UPDATE SET
                visible_row_count=excluded.visible_row_count,empty_table=excluded.empty_table,
                observed_at=excluded.observed_at,source_url=excluded.source_url""",
                (shop, product, day, len(rows), int(empty), observed_at, source_url))
            total_rows += len(rows)
    return len(dates), total_rows


def validate_row(row, line):
    item = {key: (row.get(key) or "").strip() for key in FIELDS}
    if any(not item[key] for key in FIELDS):
        raise ValueError(f"第 {line} 行存在空字段")
    try:
        item["quantity"] = int(item["quantity"])
        if item["quantity"] <= 0:
            raise ValueError()
    except ValueError:
        raise ValueError(f"第 {line} 行数量应为正整数") from None
    for key in ("created_at", "promised_ship_at", "updated_at"):
        try:
            datetime.strptime(item[key], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            raise ValueError(f"第 {line} 行 {key} 时间格式错误") from None
    return item


def save_orders(items, errors, source, source_type, history_only=False,
                publish_open_shop=None, allow_complete_empty=False):
    if errors:
        raise ValueError(f"报表有 {len(errors)} 行未通过校验；本批未发布，原待发货快照保留。"
                         + "；".join(errors[:3]))
    if not items and not (allow_complete_empty and publish_open_shop):
        raise ValueError("CSV 没有数据行")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with connection() as db:
        cursor = db.execute("""INSERT INTO import_batches
            (imported_at,source,accepted,rejected,errors,snapshot_kind)
            VALUES(?,?,?,?,?,?)""",
            (now, source, len(items), len(errors), "\n".join(errors[:20]), "full"))
        snapshots = [dict(item, source_type=source_type,
                          aftersale_status=item.get("aftersale_status", "-"),
                          shipped_at=item.get("shipped_at", ""),
                          **{key: item.get(key, "") for key in RAW_ORDER_FIELDS}) for item in items]
        insert_snapshots(db, cursor.lastrowid, snapshots)
        if publish_open_shop:
            if any(item["shop_id"] != publish_open_shop for item in items):
                raise ValueError("报表中包含其他店铺的订单；本批未发布")
            db.execute("""INSERT INTO current_open_batches(shop_id,batch_id,published_at)
                VALUES(?,?,?) ON CONFLICT(shop_id) DO UPDATE SET
                batch_id=excluded.batch_id,published_at=excluded.published_at""",
                (publish_open_shop, cursor.lastrowid, now))
        if history_only:
            columns = ",".join(SNAPSHOT_FIELDS) + ",first_batch_id,last_batch_id,first_imported_at,last_imported_at"
            placeholders = ",".join("?" for _ in range(len(SNAPSHOT_FIELDS) + 4))
            updates = ",".join(f"{key}=excluded.{key}" for key in SNAPSHOT_FIELDS if key not in ("shop_id", "sku_order_id"))
            for item in snapshots:
                db.execute(f"""INSERT INTO historical_orders({columns}) VALUES({placeholders})
                    ON CONFLICT(shop_id,sku_order_id) DO UPDATE SET
                    {updates},last_batch_id=excluded.last_batch_id,
                    last_imported_at=excluded.last_imported_at""",
                    tuple(item[key] for key in SNAPSHOT_FIELDS) + (cursor.lastrowid, cursor.lastrowid, now, now))
        for item in (() if history_only else items):
            db.execute("""INSERT INTO orders(
                shop_id,shop_order_id,sku_order_id,product_code,product_name,color,size,
                quantity,status,created_at,promised_ship_at,updated_at,imported_at,
                source_type,aftersale_status,shipped_at,
                merchant_code_raw,report_code_raw,product_id_raw,code_source)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(shop_id,sku_order_id) DO UPDATE SET
                shop_order_id=excluded.shop_order_id, product_code=excluded.product_code,
                product_name=excluded.product_name, color=excluded.color, size=excluded.size,
                quantity=excluded.quantity, status=excluded.status, created_at=excluded.created_at,
                promised_ship_at=excluded.promised_ship_at, updated_at=excluded.updated_at,
                imported_at=excluded.imported_at, source_type=excluded.source_type,
                aftersale_status=excluded.aftersale_status,
                merchant_code_raw=excluded.merchant_code_raw,
                report_code_raw=excluded.report_code_raw,
                product_id_raw=excluded.product_id_raw,
                code_source=excluded.code_source,
                shipped_at=CASE WHEN excluded.shipped_at='' THEN orders.shipped_at ELSE excluded.shipped_at END""",
                tuple(item[key] for key in FIELDS) + (now, source_type, item.get("aftersale_status", "-"), item.get("shipped_at", ""))
                + tuple(item.get(key, "") for key in RAW_ORDER_FIELDS))
    return len(items), errors


def import_csv(content, source="手动上传测试 CSV"):
    reader = csv.DictReader(io.StringIO(content))
    if reader.fieldnames is None or set(reader.fieldnames) != set(FIELDS):
        raise ValueError("CSV 表头必须与模板字段完全一致")
    items, errors = [], []
    for line, row in enumerate(reader, 2):
        try:
            items.append(validate_row(row, line))
        except ValueError as exc:
            errors.append(str(exc))
    return save_orders(items, errors, source, "test")


def convert_doudian_row(row, line, shop_id, updated_at):
    title = (row.get("选购商品") or "").strip()
    size_match = re.search(r"/([2-9]?XL|[SML]|\d{2,3}cm)(?=\(|（|\s|$)", title, re.IGNORECASE)
    specification = title[:size_match.start()] if size_match else title
    matches = [(specification.rfind(value), value) for value in PRODUCT_COLORS if value in specification]
    color = max(matches)[1] if matches else None
    color = color or "颜色待核"
    merchant_code = row.get("商家编码") or ""
    report_code = row.get("货号") or ""
    product_id = (row.get("商品ID") or "").strip()
    # 两个原始字段独立保存；显示编码优先商家编码，再回退完整货号，不拆分或猜测。
    if merchant_code.strip():
        product_code, code_source = merchant_code, "商家编码"
    elif report_code.strip():
        product_code, code_source = report_code, "货号回退"
    else:
        product_code = f"编码待核:{product_id or (row.get('子订单编号') or '').strip()}"
        code_source = "两列均空"
    item = {
        "shop_id": shop_id,
        "shop_order_id": (row.get("主订单编号") or "").strip(),
        "sku_order_id": (row.get("子订单编号") or "").strip(),
        "product_code": product_code,
        "product_name": title,
        "color": color,
        "size": size_match.group(1).upper() if size_match and not size_match.group(1).lower().endswith("cm") else (size_match.group(1).lower() if size_match else "尺码待核"),
        "quantity": (row.get("商品数量") or "").strip(),
        "status": (row.get("订单状态") or "").strip(),
        "created_at": (row.get("订单提交时间") or "").strip(),
        "promised_ship_at": (row.get("承诺发货时间") or "").strip(),
        "updated_at": updated_at,
    }
    item = validate_row(item, line)
    item.update(merchant_code_raw=merchant_code, report_code_raw=report_code,
                product_id_raw=product_id, code_source=code_source)
    item["aftersale_status"] = (row.get("售后状态") or "-").strip()
    item["shipped_at"] = (row.get("发货时间") or "").strip()
    if item["shipped_at"]:
        try:
            datetime.strptime(item["shipped_at"], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            raise ValueError(f"第 {line} 行发货时间格式错误") from None
    return item


def import_doudian_csv(content, shop_id, source="抖店后台商品维度 CSV", shipped_day=None,
                       history_only=False):
    if not shop_id or not shop_id.isdigit():
        raise ValueError("抖店店铺 ID 必须是数字")
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
    if reader.fieldnames is None or not DOUDIAN_FIELDS.issubset(set(reader.fieldnames)):
        raise ValueError("不是抖店商品维度订单报表，缺少必要中文列")
    if shipped_day:
        date.fromisoformat(shipped_day)
        if "发货时间" not in reader.fieldnames:
            raise ValueError("按实际发货日导入必须包含“发货时间”列")
    if history_only and shipped_day:
        raise ValueError("历史订单回填不能同时筛选实际发货日")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    items, errors, seen = [], [], set()
    for line, row in enumerate(reader, 2):
        try:
            if shipped_day and not (row.get("发货时间") or "").strip().startswith(shipped_day + " "):
                continue
            item = convert_doudian_row(row, line, shop_id, now)
            key = (item["shop_id"], item["sku_order_id"])
            if key in seen:
                raise ValueError(f"第 {line} 行子订单编号重复")
            seen.add(key)
            items.append(item)
        except ValueError as exc:
            errors.append(str(exc))
    if shipped_day and not items and not errors:
        raise ValueError(f"报表中没有 {shipped_day} 实际发货的子订单")
    return save_orders(items, errors, source, "doudian_history" if history_only else "doudian",
                       history_only=history_only,
                       publish_open_shop=shop_id if not history_only and not shipped_day else None)


def validate_direct_order_pages(evidence, expected_shop_id):
    """Validate a complete, independently captured order-page set before publication.

    This function does not browse or capture the shop. The future read-only page
    adapter must supply observed values, including both six-month partitions.
    """
    if not expected_shop_id or not str(expected_shop_id).isdigit():
        raise ValueError("缺少已核验的数字店铺 ID")
    if not isinstance(evidence, dict) or evidence.get("shop_id") != str(expected_shop_id):
        raise ValueError("订单页面店铺 ID 与目标店铺不符")
    url = urlparse(str(evidence.get("source_url") or ""))
    if url.scheme != "https" or url.netloc != "fxg.jinritemai.com" or not url.path.startswith(
            "/ffa/morder/order/list"):
        raise ValueError("订单页面来源未核验")
    filters = evidence.get("filters")
    if filters != {"order_status": "待发货", "aftersale_status": "全部",
                   "created_from": "", "created_to": ""}:
        raise ValueError("未证明筛选为全部待发货且无下单时间限制")
    try:
        observed_at = datetime.fromisoformat(str(evidence["observed_at"]))
        if observed_at.tzinfo is None:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError("缺少有效的页面观察时间") from None
    partitions = evidence.get("partitions")
    expected_partitions = {"recent_6_months", "older_than_6_months"}
    if not isinstance(partitions, list) or {p.get("key") for p in partitions if isinstance(p, dict)} != expected_partitions or len(partitions) != 2:
        raise ValueError("须核对近 6 个月与 6 个月前两个订单分区")

    normalized, seen_children, seen_parents = [], set(), set()
    for partition in partitions:
        name = partition["key"]
        total, pages = partition.get("total_main_orders"), partition.get("pages")
        if type(total) is not int or total < 0 or not isinstance(pages, list):
            raise ValueError(f"{name} 缺少平台主订单总数或分页")
        page_count = partition.get("page_count")
        if type(page_count) is not int or page_count < 0 or len(pages) != page_count or (total == 0) != (page_count == 0):
            raise ValueError(f"{name} 分页数量不完整")
        partition_parents = set()
        for number, page in enumerate(pages, 1):
            if not isinstance(page, dict) or page.get("number") != number or not isinstance(page.get("orders"), list) or not page["orders"]:
                raise ValueError(f"{name} 第 {number} 页未按顺序完整读取")
            for order in page["orders"]:
                if not isinstance(order, dict):
                    raise ValueError("主订单结构无效")
                parent = str(order.get("shop_order_id") or "").strip()
                if not parent or parent in partition_parents or parent in seen_parents:
                    raise ValueError("主订单编号缺失或跨页重复")
                partition_parents.add(parent)
                seen_parents.add(parent)
                children = order.get("items")
                if not isinstance(children, list) or not children:
                    raise ValueError("主订单缺少完整商品子订单")
                for child in children:
                    if not isinstance(child, dict):
                        raise ValueError("商品子订单结构无效")
                    if child.get("shop_id") not in (None, str(expected_shop_id)) or child.get("shop_order_id") not in (None, parent):
                        raise ValueError("商品子订单与店铺或主订单不符")
                    item = dict(child, shop_id=str(expected_shop_id), shop_order_id=parent)
                    item = validate_row(item, len(normalized) + 1)
                    key = item["sku_order_id"]
                    if key in seen_children:
                        raise ValueError("商品子订单编号跨页重复")
                    seen_children.add(key)
                    if item["status"] not in OPEN_STATUSES:
                        raise ValueError("待发货集合混入非开放状态")
                    if item["product_code"].startswith("编码待核:") or item["color"] == "颜色待核" or item["size"] == "尺码待核":
                        raise ValueError("商品编码或规格待核，不能发布尺码矩阵")
                    item.update(source_type="doudian",
                                aftersale_status=str(child.get("aftersale_status") or "-").strip(),
                                shipped_at="", merchant_code_raw=str(child.get("merchant_code_raw") or ""),
                                report_code_raw=str(child.get("report_code_raw") or ""),
                                product_id_raw=str(child.get("product_id_raw") or ""),
                                code_source=str(child.get("code_source") or "页面核验"))
                    if item["status"] == "部分发货" or item["aftersale_status"] not in ("", "-"):
                        raise ValueError("部分发货或售后状态待复核，不能自动发布")
                    normalized.append(item)
        if len(partition_parents) != total:
            raise ValueError(f"{name} 实际主订单数与平台总数不符")
    return normalized


def import_direct_order_pages(evidence, expected_shop_id):
    """Publish only after two-partition, parent/child and field checks pass."""
    items = validate_direct_order_pages(evidence, expected_shop_id)
    return save_orders(items, [], "抖店订单页完整直接读取", "doudian",
                       publish_open_shop=str(expected_shop_id), allow_complete_empty=True)


def shipped_orders(day, source_type="doudian"):
    date.fromisoformat(day)
    with connection() as db:
        return db.execute("""SELECT * FROM orders WHERE substr(shipped_at,1,10)=? AND source_type=?
            ORDER BY shipped_at,shop_order_id,sku_order_id""", (day, source_type)).fetchall()


def due_orders(day, overdue=False, source_type=None):
    """Return open child orders for a business date; overdue is a separate queue."""
    date.fromisoformat(day)
    if source_type == "doudian":
        return [row for row in open_snapshot_orders(source_type)
                if (row["promised_ship_at"][:10] < day if overdue
                    else row["promised_ship_at"][:10] == day)]
    comparison = "<" if overdue else "="
    with connection() as db:
        return db.execute(f"""SELECT * FROM orders WHERE substr(promised_ship_at,1,10) {comparison} ?
            AND status IN (?,?,?) AND (? IS NULL OR source_type=?)
            AND (source_type!='doudian' OR imported_at=(
                SELECT MAX(imported_at) FROM orders AS latest
                WHERE latest.shop_id=orders.shop_id AND latest.source_type='doudian'
                AND latest.status IN (?,?,?)))
            ORDER BY promised_ship_at,shop_order_id,sku_order_id""",
            (day, *OPEN_STATUSES, source_type, source_type, *OPEN_STATUSES)).fetchall()


def open_snapshot_orders(source_type="doudian"):
    """Current open rows; Doudian rows are scoped to each shop's newest open import."""
    with connection() as db:
        if source_type == "doudian":
            published = db.execute("""SELECT s.*, b.imported_at AS imported_at
                FROM current_open_batches AS current
                JOIN order_snapshots AS s ON s.batch_id=current.batch_id AND s.shop_id=current.shop_id
                JOIN import_batches AS b ON b.id=s.batch_id
                WHERE s.source_type='doudian' AND s.status IN (?,?,?)""",
                OPEN_STATUSES).fetchall()
            legacy = db.execute("""SELECT * FROM orders WHERE source_type='doudian'
                AND status IN (?,?,?) AND NOT EXISTS (
                    SELECT 1 FROM current_open_batches WHERE shop_id=orders.shop_id)
                AND imported_at=(SELECT MAX(imported_at) FROM orders AS latest
                    WHERE latest.shop_id=orders.shop_id AND latest.source_type='doudian'
                    AND latest.status IN (?,?,?))""", (*OPEN_STATUSES, *OPEN_STATUSES)).fetchall()
            return sorted([*published, *legacy],
                          key=lambda row: (row["promised_ship_at"], row["shop_order_id"], row["sku_order_id"]))
        return db.execute("""SELECT * FROM orders WHERE source_type=? AND status IN (?,?,?)
            AND (source_type!='doudian' OR imported_at=(
                SELECT MAX(imported_at) FROM orders AS latest
                WHERE latest.shop_id=orders.shop_id AND latest.source_type='doudian'
                AND latest.status IN (?,?,?)))
            ORDER BY promised_ship_at,shop_order_id,sku_order_id""",
            (source_type, *OPEN_STATUSES, *OPEN_STATUSES)).fetchall()


def latest_open_publication():
    with connection() as db:
        return db.execute("SELECT MAX(published_at) FROM current_open_batches").fetchone()[0]


def size_matrix(rows, include_review=False):
    """Sum product quantities by shop + product code + color."""
    groups = {}
    extras = set()
    review = []
    for row in rows:
        if not include_review and (row["status"] == "部分发货" or row["aftersale_status"] not in ("", "-")
                                   or row["size"] == "尺码待核" or row["color"] == "颜色待核"):
            review.append(row)
            continue
        key = (row["shop_id"], row["product_code"], row["color"])
        group = groups.setdefault(key, {"product_ids": set(), "sources": set(), "sizes": {}, "orders": 0})
        if row["source_type"] == "doudian" and row["product_id_raw"]:
            group["product_ids"].add(row["product_id_raw"])
        group["sources"].add(row["code_source"] if row["source_type"] == "doudian" else "测试数据")
        group["sizes"][row["size"]] = group["sizes"].get(row["size"], 0) + row["quantity"]
        group["orders"] += 1
        if row["size"] not in MATRIX_SIZES:
            extras.add(row["size"])
    return (*MATRIX_SIZES, *sorted(extras)), groups, review


def esc(value):
    return html.escape(str(value), quote=True)


def current_source(query):
    requested = query.get("source", [""])[0]
    if requested in ("test", "doudian"):
        return requested
    with connection() as db:
        real_exists = db.execute("SELECT 1 FROM orders WHERE source_type='doudian' LIMIT 1").fetchone()
    return "doudian" if real_exists else "test"


def source_links(path, selected):
    return (f'<p>数据来源：<strong>{"抖店导出" if selected == "doudian" else "测试数据"}</strong>　'
            f'<a href="{path}?source=doudian">抖店导出</a> / '
            f'<a href="{path}?source=test">测试数据</a></p>')


def display_fallback_code(raw_report_code):
    """Shorten a report label only when its final & part is plainly a code list."""
    if "&" not in raw_report_code:
        return raw_report_code
    candidate = raw_report_code.rsplit("&", 1)[-1].strip()
    code = r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*"
    if re.fullmatch(rf"{code}(?:[、,，/ ]+{code})*", candidate):
        return candidate
    return raw_report_code


def render_matrix(rows, include_review=False):
    sizes, groups, review = size_matrix(rows, include_review)
    heads = "".join(f"<th>{esc(size)}</th>" for size in sizes)
    body = []
    totals = {size: 0 for size in sizes}
    for (shop, code, color), group in sorted(groups.items()):
        fallback = group["sources"] == {"货号回退"}
        display_code = display_fallback_code(code) if fallback else code
        product_ids = "、".join(sorted(group["product_ids"])) or "未提供"
        qty_cells = []
        for size in sizes:
            qty = group["sizes"].get(size, 0)
            totals[size] += qty
            qty_cells.append(f"<td>{qty if qty else '—'}</td>")
        total = sum(group["sizes"].values())
        source_label = "、".join(sorted(group["sources"]))
        body.append(f'<tr><td><strong>{esc(display_code)} · {esc(color)}</strong><br><small>来源：{esc(source_label)}｜商品ID：{esc(product_ids)}｜店铺ID：{esc(shop)}</small></td>{"".join(qty_cells)}<td><strong>{total}</strong></td><td>{group["orders"]}</td></tr>')
    footer = "".join(f"<th>{totals[size]}</th>" for size in sizes)
    empty = '<tr><td colspan="99" class="muted">该日期暂无可计入矩阵的商品</td></tr>'
    table = f'<table class="matrix"><tr><th>有效编码＋颜色（测试数据为货号）</th>{heads}<th>合计件数</th><th>子订单数</th></tr>{"".join(body) or empty}<tr><th>合计</th>{footer}<th>{sum(totals.values())}</th><th>{sum(g["orders"] for g in groups.values())}</th></tr></table>'
    return table, review


STYLE = """<style>
*{box-sizing:border-box}body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fb;color:#18243b;margin:0}a{color:#1b62b9}
.app-shell{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr)}
.sidebar{background:#172e55;color:#fff;padding:24px 14px;position:sticky;top:0;height:100vh;overflow-y:auto}
.brand{font-size:18px;font-weight:700;line-height:1.35;padding:0 12px 22px}.brand small{display:block;font-size:12px;font-weight:400;color:#b9cae2;margin-top:5px}
.nav-label{color:#8ea9cb;font-size:12px;font-weight:700;letter-spacing:.08em;padding:16px 12px 6px}
.sidebar nav a{display:block;color:#dbe9ff;text-decoration:none;padding:10px 12px;border-radius:8px;margin:2px 0;white-space:nowrap}
.sidebar nav a:hover{background:#254572}.sidebar nav a.active{background:#e8f1ff;color:#173d78;font-weight:700}
.content{min-width:0}.page-header{background:#fff;border-bottom:1px solid #e0e6ee;padding:18px 32px}.page-header h1{margin:0;font-size:21px}.page-header p{margin:4px 0 0;color:#64748b;font-size:13px}
main{max-width:1600px;margin:0 auto;padding:22px 32px 48px;min-width:0}
section{background:#fff;border:1px solid #e0e6ee;border-radius:12px;padding:22px;margin:18px 0;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:max-content}th,td{padding:10px;border-bottom:1px solid #e7ecf3;text-align:left;vertical-align:top}th{background:#f4f7fb}
input,select,button{font:inherit;padding:9px;border:1px solid #bdc8d7;border-radius:6px}button{background:#1b62b9;color:#fff;cursor:pointer}
.warn{background:#fff4d6;padding:12px;border-radius:7px}.muted{color:#64748b}.error{color:#b42318}.matrix th,.matrix td{text-align:center;white-space:nowrap}.matrix th:first-child,.matrix td:first-child{text-align:left}.matrix strong{font-size:18px}
@media(max-width:760px){.app-shell{display:block}.sidebar{height:auto;position:static;padding:14px}.brand{padding:0 8px 10px}.nav-label{display:none}.sidebar nav{display:flex;gap:4px;overflow-x:auto}.sidebar nav a{flex:none;padding:8px 10px}.page-header{padding:16px}.page-header h1{font-size:18px}main{padding:12px}section{padding:16px;margin:12px 0}}
</style>"""


def layout(title, body, logged=False):
    items = (("订单履约", (("/due", "全部待发货", ("全部待发货",)), ("/shipped", "当日已发货", ("实际已发货",)), ("/", "全部订单", ("订单列表", "订单详情")))),
             ("销量分析", (("/sales", "销量历史", ("销量历史", "销量导入结果")), ("/stock", "平台库存快照", ("平台库存快照",)))),
             ("数据管理", (("/history", "历史订单", ("历史订单",)), ("/history-sku", "历史 SKU 子订单", ("历史 SKU 子订单",)), ("/imports", "导入记录", ("导入记录", "导入批次", "旧导入日志")), ("/import", "导入报表", ("导入报表", "导入结果")))))
    groups = []
    for label, links in items:
        anchors = ''.join(f'<a href="{path}" class="{"active" if title in titles else ""}" {"aria-current=page" if title in titles else ""}>{name}</a>'
                          for path, name, titles in links)
        groups.append(f'<div class="nav-label">{label}</div>{anchors}')
    nav = f'<nav aria-label="工作台导航">{"".join(groups)}</nav>'
    sidebar = f'<aside class="sidebar"><div class="brand">线上经营工具<small>本地研发版 · V1.0.0</small></div>{nav}</aside>'
    shell_class = "app-shell"
    body = re.sub(r'(<form\b[^>]*\bmethod="post"[^>]*>)',
                  lambda match: match.group(1) + f'<input type="hidden" name="_csrf" value="{FORM_NONCE}">',
                  body, flags=re.IGNORECASE)
    return f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}｜线上经营工具 V1.0.0</title>{STYLE}<div class="{shell_class}">{sidebar}<div class="content"><header class="page-header"><h1>{esc(title)}</h1><p>线上经营工具 V1.0.0 · 研发版</p></header><main><p class="warn">本地研发原型｜支持手动导入抖店报表｜未连接抖店 API 或飞书</p>{body}</main></div></div></html>'


def embedded_due_layout(body):
    """Show only the verified result inside OBA's native order view."""
    compact_style = """<style>
body{background:#fff}main{max-width:none;padding:0;margin:0}
section{border:0;border-radius:0;margin:0;padding:16px 20px;overflow-x:auto}
section h2{display:none}section p{margin:0 0 10px}
table{width:100%;min-width:680px}th,td{padding:8px 10px}
</style>"""
    return (f'<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>待发货结果</title>{STYLE}{compact_style}<main>{body}</main></html>')


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if self.path != "/api/pending-view" or origin not in (
                "http://localhost:5173", "http://127.0.0.1:5173"):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def send_pending_view(self):
        origin = self.headers.get("Origin", "")
        if origin not in ("http://localhost:5173", "http://127.0.0.1:5173"):
            return self.send_html("Forbidden", 403)
        if not render_partial_due(PARTIAL_DUE_JSON):
            payload = {"available": False}
        else:
            candidate = json.loads(PARTIAL_DUE_JSON.read_text(encoding="utf-8"))
            payload = {"available": True, "scope": candidate["scope"],
                       "observed_at": candidate.get("observed_at"),
                       "page_complete": candidate.get("page_complete"),
                       "displayed_parent_count": candidate.get("displayed_parent_count"),
                       "rows": [{key: row.get(key) for key in
                                 ("shop_order_id", "sku_order_id", "merchant_code", "product_id",
                                  "product_name", "color", "size", "quantity")}
                                for row in candidate["rows"]]}
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, body, status=200, cookie=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, path, cookie=None):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", path)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def session_identity(self):
        # ZIP passwords remain in this process's memory only; there is no login session.
        return hashlib.sha256(FORM_NONCE.encode("ascii")).hexdigest()

    def valid_host(self):
        return self.headers.get("Host", "") == f"127.0.0.1:{PORT}"

    def form(self):
        if hasattr(self, "_parsed_form"):
            return self._parsed_form
        size = int(self.headers.get("Content-Length", "0"))
        content_type = self.headers.get("Content-Type", "")
        limit = MAX_UPLOAD_BYTES if content_type.lower().startswith("multipart/form-data") else 1_000_000
        if size < 1 or size > limit:
            raise ValueError("请求为空或超过上传大小限制")
        body = self.rfile.read(size)
        if content_type.lower().startswith("multipart/form-data"):
            self._parsed_form = {key: [value] for key, value in parse_multipart_form(body, content_type).items()}
        else:
            self._parsed_form = parse_qs(body.decode("utf-8"), keep_blank_values=True)
        return self._parsed_form

    def do_GET(self):
        if not self.valid_host():
            return self.send_html("Invalid Host", 403)
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/pending-view":
            return self.send_pending_view()
        if path in ("/login", "/logout", "/setup"):
            return self.redirect("/due")
        if path == "/sales-refund-import":
            body = ('<section><h2>导入罗盘退款 SKU 页面数据</h2><p>仅接受从目标商品“退款及体验”逐日核对的 JSON。'
                    '订单数与商品件数独立存储；空表日期不补造 SKU 行。</p>'
                    '<form method="post" action="/sales-refund-import"><textarea name="refund_json" rows="12" style="width:100%" required></textarea>'
                    '<p><button>写入本机销量历史</button></p></form></section>')
            return self.send_html(layout("导入退款 SKU 页面数据", body, True))
        if path == "/stock":
            with connection() as db:
                latest = db.execute("""SELECT shop_id,product_id,captured_at,warehouse_display,source_url
                    FROM platform_stock_snapshots ORDER BY captured_at DESC LIMIT 1""").fetchone()
                rows = db.execute("""SELECT * FROM platform_stock_snapshots
                    WHERE shop_id=? AND product_id=? AND captured_at=? ORDER BY sku_id""",
                    (latest["shop_id"],latest["product_id"],latest["captured_at"])).fetchall() if latest else []
            if not latest:
                return self.send_html(layout("平台库存快照", '<section><h2>尚无平台库存快照</h2></section>', True))
            totals = [sum(r[key] for r in rows) for key in ("total","ready_stock","presale_batch")]
            table_rows = ''.join(
                f'<tr><td>{esc(r["sku_id"])}</td><td>{esc(r["sku_title"])}</td>'
                f'<td>{esc(r["listing_status"])}</td><td>{r["total"]}</td>'
                f'<td>{r["ready_stock"]}</td><td>{r["presale_batch"]}</td></tr>' for r in rows)
            body = (f'<section><h2>抖店平台库存快照</h2><p>店铺 {esc(latest["shop_id"])}；'
                    f'商品 {esc(latest["product_id"])}；采集时间 {esc(latest["captured_at"])}；'
                    f'{esc(latest["warehouse_display"])}。</p><p><strong>{len(rows)} 个 SKU：'
                    f'总库存 {totals[0]}、现货 {totals[1]}、预售批次 {totals[2]}</strong>。</p>'
                    '<p class="muted">这些数字仅为抖店库存管理页面的可见快照，不代表 ERP 实物库存、'
                    '工厂在途、可回流退货或真实预售欠单；请勿据此直接下采购单。</p>'
                    '<table><tr><th>SKU ID</th><th>规格</th><th>上架状态</th><th>总库存</th>'
                    f'<th>平台现货</th><th>预售批次</th></tr>{table_rows}</table>'
                    f'<p>来源：<a href="{esc(latest["source_url"])}">抖店库存管理</a></p></section>')
            return self.send_html(layout("平台库存快照", body, True))
        if path == "/sales":
            query = parse_qs(parsed.query)
            shop = query.get("shop", [""])[0][:100]
            product = query.get("product", [""])[0][:100]
            with connection() as db:
                products = db.execute("""SELECT shop_id,product_id,COUNT(*) AS days,
                    MIN(sale_date) AS first_day,MAX(sale_date) AS last_day
                    FROM (SELECT shop_id,product_id,sale_date FROM sales_day_evidence
                          UNION SELECT shop_id,product_id,sale_date FROM sales_ui_day_evidence)
                    GROUP BY shop_id,product_id ORDER BY last_day DESC""").fetchall()
                if not shop and products:
                    shop, product = products[0]["shop_id"], products[0]["product_id"]
                details = db.execute("""SELECT * FROM sku_daily_sales WHERE shop_id=? AND product_id=?
                    ORDER BY sale_date DESC,sku_id""", (shop, product)).fetchall()
                refund_rows = db.execute("""SELECT * FROM refund_sku_page_rows WHERE shop_id=? AND product_id=?
                    ORDER BY sale_date DESC,sku_id""", (shop, product)).fetchall()
                zero_rows = db.execute("""SELECT * FROM refund_sku_verified_zero WHERE shop_id=? AND product_id=?""",
                                       (shop, product)).fetchall()
                historical_sku_totals = db.execute("""SELECT COUNT(*) AS line_count,
                    COUNT(DISTINCT parent_order_id) AS parent_count,
                    COALESCE(SUM(quantity),0) AS pieces,
                    COUNT(DISTINCT variant_label) AS variants,
                    SUM(CASE WHEN paid_at<>'' THEN 1 ELSE 0 END) AS paid_time_lines,
                    COALESCE(SUM(CASE WHEN paid_at<>'' THEN quantity ELSE 0 END),0) AS paid_pieces,
                    SUM(CASE WHEN paid_at='' AND aftersale_status_raw NOT LIKE '%退款成功%' THEN 1 ELSE 0 END) AS excluded_unpaid_lines,
                    SUM(CASE WHEN review_reason<>'' THEN 1 ELSE 0 END) AS review_lines
                    FROM historical_sku_order_lines WHERE shop_id=? AND product_id=?""",
                    (shop, product)).fetchone()
                historical_sku_days = db.execute("""SELECT substr(paid_at,1,10) AS paid_day,
                    variant_label, SUM(quantity) AS paid_pieces,
                    SUM(CASE WHEN order_status_raw='已关闭' AND aftersale_status_raw LIKE '%退款成功%' THEN 1 ELSE 0 END) AS refunded_child_orders,
                    SUM(CASE WHEN order_status_raw='已完成' AND aftersale_status_raw LIKE '%退款成功%' THEN 1 ELSE 0 END) AS loss_child_orders
                    FROM historical_sku_order_lines
                    WHERE shop_id=? AND product_id=? AND paid_at<>''
                    GROUP BY substr(paid_at,1,10),variant_label
                    ORDER BY paid_day DESC,variant_label""", (shop, product)).fetchall()
            links = ' '.join(f'<a href="/sales?shop={quote(r["shop_id"])}&product={quote(r["product_id"])}">{esc(r["shop_id"])} / {esc(r["product_id"])}（{r["days"]} 天）</a>' for r in products)
            sku_titles = {}
            for row in details:
                sku_titles.setdefault(row["sku_id"], set()).add(row["sku_title"].strip())
            def sku_spec(sku):
                titles = sku_titles.get(sku, set()) - {""}
                return next(iter(titles)) if len(titles) == 1 else "待核规格"
            refund_by_day_sku = {(r["sale_date"], r["sku_id"]): r for r in refund_rows}
            zero_by_day_sku = {(r["sale_date"], r["sku_id"]): r for r in zero_rows}
            def refund_count_cell(row):
                key = row["sale_date"], row["sku_id"]
                if key in refund_by_day_sku:
                    return str(refund_by_day_sku[key]["refund_order_count_payment_date"])
                if key in zero_by_day_sku:
                    return '<span title="当日退款 SKU 页面无对应行；按用户确认口径记为 0">0</span>'
                return "未核"
            detail_rows = ''.join(
                f'<tr><td>{esc(r["sale_date"])}</td><td>{esc(r["sku_id"])}</td>'
                f'<td>{esc(sku_spec(r["sku_id"]))}</td><td>{r["sold_units"]}</td>'
                f'<td>{refund_count_cell(r)}</td>'
                f'<td>{esc(r["pay_amount"])}</td><td>{esc(r["source_file"])}</td></tr>' for r in details)
            body = (f'<section><h2>本销售季销量（2026年9月起）</h2><p>{links}</p>'
                    '<p class="muted">当前已核实 2026年9月1日至10月22日；后续日期尚未纳入本区块。规格依据同店铺、同商品的原始 SKU 导出映射；同一 SKU 规格不一致时标“待核规格”。'
                    '退款订单数按支付归属日与 SKU 对应；页面无对应 SKU 行且已核实的记录，按用户确认口径补 0，原始页面并未显式返回这些 0。未核实的记录仍标“未核”。'
                    '该列为订单数，不是退款件数；原按退款发生日统计的件数不在此表混用。来源列可为原文件或逐日页面核验。</p>'
                    f'<table><tr><th>支付归属日</th><th>SKU 编号</th><th>颜色／尺码规格</th><th>成交件数</th>'
                    f'<th>退款订单数（支付时间）</th><th>支付金额</th><th>来源</th></tr>{detail_rows}</table></section>')
            if historical_sku_totals["line_count"]:
                history_rows = ''.join(
                    f'<tr><td>{esc(r["paid_day"])}</td><td>{esc(r["variant_label"])}</td>'
                    f'<td>{r["paid_pieces"]}</td><td>{r["refunded_child_orders"]}</td>'
                    f'<td>{r["loss_child_orders"]}</td></tr>'
                    for r in historical_sku_days)
                body += (
                    '<section><h2>上一销售季销量（2026年1月）</h2>'
                    f'<p>原始报表目标商品：{historical_sku_totals["parent_count"]} 个主订单、'
                    f'{historical_sku_totals["line_count"]} 个不同子订单、'
                    f'{historical_sku_totals["pieces"]} 件商品数量；'
                    f'{historical_sku_totals["variants"]} 个颜色／尺码组合。'
                    f'其中 {historical_sku_totals["paid_time_lines"]} 个子订单有支付完成时间，'
                    f'对应成交件数 {historical_sku_totals["paid_pieces"]} 件；'
                    f'{historical_sku_totals["excluded_unpaid_lines"]} 个无支付时间且无退款成功记录的子订单已排除于销量统计，原始记录保留。'
                    f'{historical_sku_totals["review_lines"]} 行规格或命名待核。</p>'
                    '<p class="muted">按颜色、尺码汇总；按支付日统计。来源为抖店历史订单导出，平台未提供 SKU 编号，表中的组合不是官方 SKU ID。'
                    '下表成交件数为有“支付完成时间”的不同子订单商品数量之和，按支付日归属，未扣后续退款；'
                    '未填支付时间的子订单不进入日表，也不与上方罗盘数据相加。'
                    '退款订单数仅数“已关闭”且售后状态为“退款成功”的不同子订单；'
                    '“货损订单数”按用户指定业务分类，仅数“已完成”且“退款成功”的不同子订单，不代表已核实实物损坏。'
                    '两列互斥，均按原订单支付日归属，不能直接从成交件数扣除订单数。'
                    '本报表没有退款发生时间，仍待补充售后数据；“已完成”不等于结算。'
                    '<a href="/history-sku">查看逐子订单原始记录</a>。</p>'
                    '<table><tr><th>支付日期</th><th>颜色／尺码组合</th><th>成交件数</th>'
                    f'<th>退款订单数（支付日归属）</th><th>货损订单数（支付日归属）</th></tr>{history_rows}</table></section>')
            return self.send_html(layout("销量历史", body, True))
        if path == "/history-sku":
            query = parse_qs(parsed.query)
            try:
                page = max(1, int(query.get("page", ["1"])[0]))
            except ValueError:
                page = 1
            with connection() as db:
                total = db.execute("SELECT COUNT(*) FROM historical_sku_order_lines").fetchone()[0]
                rows = db.execute("""SELECT * FROM historical_sku_order_lines
                    ORDER BY submitted_at DESC,child_order_id LIMIT 100 OFFSET ?""",
                    ((page - 1) * 100,)).fetchall()
            links = ' '.join(f'<a href="/history-sku?page={n}">{n}</a>' if n != page else str(n)
                             for n in range(1, (total + 99) // 100 + 1))
            lines = ''.join(
                f'<tr><td>{esc(r["parent_order_id"])}<br><small>{esc(r["child_order_id"])}</small></td>'
                f'<td>{esc(r["variant_label"])}<br><small>{esc(r["size_detail_raw"])}</small></td>'
                f'<td>{r["quantity"]}</td><td>{esc(r["order_status_raw"])}</td>'
                f'<td>{esc(r["aftersale_status_raw"])}</td><td>{esc(r["submitted_at"])}</td>'
                f'<td>{esc(r["paid_at"])}</td><td>{esc(r["review_reason"])}</td>'
                f'<td><details><summary>原始选购商品</summary>{esc(r["selection_raw"])}</details></td></tr>'
                for r in rows)
            body = (f'<section><h2>历史订单逐子订单明细</h2><p>{total} 行，按店铺、商品和子订单号去重。'
                    '平台 SKU 编号未导出，颜色／尺码组合仅从原始“选购商品”文本拆出。</p>'
                    f'<p>{links}</p><table><tr><th>主／子订单号</th><th>组合／原始尺码</th>'
                    '<th>件数</th><th>订单状态</th><th>售后状态</th><th>下单时间</th>'
                    f'<th>支付时间</th><th>待核原因</th><th>源字段</th></tr>{lines}</table></section>')
            return self.send_html(layout("历史 SKU 子订单", body, True))
        if path == "/shipped":
            query = parse_qs(parsed.query)
            day = query.get("day", [beijing_day()])[0]
            try:
                rows = shipped_orders(day)
            except ValueError:
                return self.send_html(layout("日期错误", '<section>日期须为 YYYY-MM-DD。</section>', True), 400)
            count = len(rows)
            quantity = sum(r["quantity"] for r in rows)
            parents = len({r["shop_order_id"] for r in rows})
            matrix, _ = render_matrix(rows, include_review=True)
            trs = ''.join(f'<tr><td><a href="/order?shop={quote(r["shop_id"])}&sku={quote(r["sku_order_id"])}">{esc(r["shop_order_id"])}</a><br><small>{esc(r["sku_order_id"])}</small></td><td>{esc(r["product_code"])}<br><small>来源：{esc(r["code_source"])}</small></td><td>{esc(r["color"])} / {esc(r["size"])}</td><td>{r["quantity"]}</td><td>{esc(r["status"])}</td><td>{esc(r["aftersale_status"])}</td><td>{esc(r["shipped_at"])}</td></tr>' for r in rows)
            body = f'<section><h2>实际已发货 · 按发货时间</h2><form method="get"><label>发货日期 <input type="date" name="day" value="{esc(day)}" required></label> <button>查询</button></form><p>抖店导出快照：{parents} 个主订单、{count} 个子订单、{quantity} 件。</p><p class="muted">依据报表“发货时间”列筛选，包含当前状态已变化或存在售后的订单；这是导入时的快照，不会自动更新。部分发货按整行商品数量显示，需人工核对实际发出件数。</p></section><section><h2>尺码矩阵</h2>{matrix}</section><section><h2>已发货订单明细</h2><table><tr><th>订单号</th><th>有效编码</th><th>颜色 / 尺码</th><th>商品数量</th><th>当前状态</th><th>售后状态</th><th>发货时间</th></tr>{trs}</table></section>'
            return self.send_html(layout("实际已发货", body, True))
        if path == "/due":
            body = render_partial_due(PARTIAL_DUE_JSON)
            if "Electron/" in self.headers.get("User-Agent", ""):
                return self.send_html(embedded_due_layout(body))
            return self.send_html(layout("全部待发货", body, True))
        if path == "/":
            query = parse_qs(parsed.query)
            source_type = current_source(query)
            status = query.get("status", [""])[0][:50]
            keyword = query.get("q", [""])[0][:80]
            with connection() as db:
                statuses = [r[0] for r in db.execute("SELECT DISTINCT status FROM orders WHERE source_type=? ORDER BY status", (source_type,))]
                rows = db.execute("""SELECT * FROM orders WHERE source_type=? AND (?='' OR status=?)
                    AND (?='' OR shop_order_id LIKE ? OR sku_order_id LIKE ? OR product_code LIKE ? OR product_name LIKE ?)
                    ORDER BY promised_ship_at,shop_order_id,sku_order_id LIMIT 500""",
                    (source_type,status,status,keyword,*([f"%{keyword}%"]*4))).fetchall()
            options = '<option value="">全部状态</option>' + ''.join(f'<option value="{esc(s)}" {"selected" if s==status else ""}>{esc(s)}</option>' for s in statuses)
            trs = ''.join(f'<tr><td><a href="/order?shop={quote(r["shop_id"])}&sku={quote(r["sku_order_id"])}">{esc(r["shop_order_id"])}</a><br><small>{esc(r["sku_order_id"])}</small></td><td>{esc(r["product_code"])}<br><small>来源：{esc(r["code_source"])}</small></td><td>{esc(r["product_name"])}</td><td>{esc(r["color"])} / {esc(r["size"])}</td><td>{r["quantity"]}</td><td>{esc(r["status"])}</td><td>{esc(r["promised_ship_at"])}</td></tr>' for r in rows)
            body = f'<section><h2>订单列表</h2>{source_links("/", source_type)}<form><input type="hidden" name="source" value="{source_type}"><input name="q" value="{esc(keyword)}" placeholder="订单号、有效编码或商品名"><select name="status">{options}</select><button>查询</button></form><p class="muted">当前显示 {len(rows)} 条，最多显示 500 条；此原型尚未实现分页。</p><table><tr><th>订单号</th><th>{"有效编码" if source_type == "doudian" else "测试货号"}</th><th>商品</th><th>颜色 / 尺码</th><th>数量</th><th>状态</th><th>承诺发货</th></tr>{trs}</table></section>'
            return self.send_html(layout("订单列表", body, True))
        if path == "/order":
            query = parse_qs(parsed.query)
            shop, sku = query.get("shop", [""])[0], query.get("sku", [""])[0]
            with connection() as db:
                r = db.execute("SELECT * FROM orders WHERE shop_id=? AND sku_order_id=?", (shop,sku)).fetchone()
            if not r:
                return self.send_html(layout("未找到", "<section>未找到订单。</section>", True), 404)
            detail_fields = FIELDS + ["merchant_code_raw", "report_code_raw", "product_id_raw", "code_source", "shipped_at", "source_type", "aftersale_status", "imported_at"]
            labels = {"product_code": "有效编码（测试数据为货号）", "merchant_code_raw": "导出原始商家编码", "report_code_raw": "导出原始货号", "product_id_raw": "导出商品ID", "code_source": "有效编码来源"}
            body = "<section><h2>订单详情</h2><table>" + ''.join(f'<tr><th>{esc(labels.get(key, key))}</th><td>{esc(r[key])}</td></tr>' for key in detail_fields) + "</table></section>"
            return self.send_html(layout("订单详情", body, True))
        if path == "/imports":
            with connection() as db:
                rows = db.execute("SELECT * FROM import_batches ORDER BY id DESC LIMIT 100").fetchall()
            def detail_link(row):
                if row["snapshot_kind"] == "unavailable":
                    return "旧记录：明细不可恢复"
                label = "迁移基线" if row["snapshot_kind"] == "baseline" else "查看快照"
                return f'<a href="/imports/{row["id"]}">{label}</a>'
            trs = ''.join(f'<tr><td>{r["id"]}</td><td>{esc(r["imported_at"])}</td><td>{esc(r["source"])}</td><td>{r["accepted"]}</td><td>{r["rejected"]}</td><td>{detail_link(r)}</td><td class="error">{esc(r["errors"])}</td></tr>' for r in rows)
            body = ('<section><h2>导入记录</h2><p class="muted">每次导入是独立快照，重复批次不能相加当作新增销量。'
                    '迁移前的批次只有日志和行数，历史明细无法恢复；迁移基线仅保存迁移时的当前订单状态。</p>'
                    f'<table><tr><th>批次</th><th>时间</th><th>来源</th><th>接受</th><th>拒绝</th><th>明细</th><th>错误</th></tr>{trs}</table></section>')
            return self.send_html(layout("导入记录", body, True))
        if path == "/history":
            query = parse_qs(parsed.query)
            try:
                page = int(query.get("page", ["1"])[0])
                if page < 1:
                    raise ValueError()
            except ValueError:
                return self.send_html(layout("页码错误", "<section>页码无效。</section>", True), 400)
            with connection() as db:
                totals = db.execute("""SELECT COUNT(*) AS children, COALESCE(SUM(quantity),0) AS pieces,
                    COUNT(DISTINCT shop_id || ':' || shop_order_id) AS parents
                    FROM historical_orders""").fetchone()
                page_size = 100
                rows = db.execute("""SELECT * FROM historical_orders
                    ORDER BY created_at DESC,shop_id,sku_order_id LIMIT ? OFFSET ?""",
                    (page_size, (page - 1) * page_size)).fetchall()
            last_page = max(1, (totals["children"] + page_size - 1) // page_size)
            pages = ' '.join(f'<a href="/history?page={n}">{n}</a>' if n != page else f'<strong>{n}</strong>'
                             for n in range(1, last_page + 1))
            trs = ''.join(
                f'<tr><td>{esc(r["shop_id"])}</td><td>{esc(r["shop_order_id"])}<br><small>{esc(r["sku_order_id"])}</small></td>'
                f'<td>{esc(r["product_code"])}</td><td>{esc(r["color"])} / {esc(r["size"])}</td>'
                f'<td>{r["quantity"]}</td><td>{esc(r["status"])}</td><td>{esc(r["created_at"])}</td>'
                f'<td>{esc(r["shipped_at"])}</td><td><a href="/imports/{r["last_batch_id"]}">#{r["last_batch_id"]}</a></td></tr>'
                for r in rows)
            body = (f'<section><h2>历史订单 · 本地回填</h2><p><strong>{totals["parents"]} 个主订单、'
                    f'{totals["children"]} 个不同子订单、{totals["pieces"]} 件</strong>。</p>'
                    '<p class="muted">仅包含明确作为历史回填导入的报表；按店铺 ID＋子订单号去重。'
                    '同一订单多次导入不代表新增销量，且这里尚不是全店完整销售历史。历史回填不会改动当前待发货矩阵。</p>'
                    f'<p>第 {page} / {last_page} 页　{pages}</p>'
                    f'<table><tr><th>店铺ID</th><th>主/子订单号</th><th>有效编码</th><th>颜色/尺码</th>'
                    f'<th>件数</th><th>状态</th><th>下单时间</th><th>发货时间</th><th>来源批次</th></tr>{trs}</table></section>')
            return self.send_html(layout("历史订单", body, True))
        if path.startswith("/imports/"):
            try:
                batch_id = int(path.removeprefix("/imports/"))
                page = int(parse_qs(parsed.query).get("page", ["1"])[0])
                if batch_id < 1 or page < 1:
                    raise ValueError()
            except ValueError:
                return self.send_html(layout("批次错误", "<section>批次或页码无效。</section>", True), 400)
            with connection() as db:
                batch = db.execute("SELECT * FROM import_batches WHERE id=?", (batch_id,)).fetchone()
                if not batch:
                    return self.send_html(layout("未找到", "<section>未找到该导入批次。</section>", True), 404)
                totals = db.execute("""SELECT COUNT(*) AS rows, COALESCE(SUM(quantity),0) AS pieces,
                    COUNT(DISTINCT shop_id || ':' || shop_order_id) AS parents,
                    COUNT(DISTINCT shop_id || ':' || sku_order_id) AS children
                    FROM order_snapshots WHERE batch_id=?""", (batch_id,)).fetchone()
                page_size = 100
                snapshots = db.execute("""SELECT * FROM order_snapshots WHERE batch_id=?
                    ORDER BY row_number LIMIT ? OFFSET ?""",
                    (batch_id, page_size, (page - 1) * page_size)).fetchall()
            if batch["snapshot_kind"] == "unavailable":
                body = '<section><h2>旧导入日志</h2><p>该批次只保存了时间、来源和行数；逐行历史明细无法恢复。</p></section>'
            else:
                kind = "迁移基线：仅代表迁移时当前订单表" if batch["snapshot_kind"] == "baseline" else "独立导入快照"
                trs = ''.join(
                    f'<tr><td>{r["row_number"]}</td><td>{esc(r["shop_id"])}</td>'
                    f'<td>{esc(r["shop_order_id"])}<br><small>{esc(r["sku_order_id"])}</small></td>'
                    f'<td>{esc(r["product_code"])}<br><small>来源：{esc(r["code_source"])}</small></td>'
                    f'<td>{esc(r["product_name"])}</td><td>{esc(r["color"])} / {esc(r["size"])}</td>'
                    f'<td>{r["quantity"]}</td><td>{esc(r["status"])}</td>'
                    f'<td>{esc(r["aftersale_status"])}</td><td>{esc(r["created_at"])}</td>'
                    f'<td>{esc(r["promised_ship_at"])}</td><td>{esc(r["shipped_at"])}</td>'
                    f'<td>{esc(r["updated_at"])}</td></tr>' for r in snapshots)
                last_page = max(1, (totals["rows"] + page_size - 1) // page_size)
                pages = ' '.join(f'<a href="/imports/{batch_id}?page={n}">{n}</a>' if n != page else f'<strong>{n}</strong>'
                                 for n in range(1, last_page + 1))
                body = (f'<section><h2>导入批次 #{batch_id}</h2><p>{esc(kind)}；导入时间 {esc(batch["imported_at"])}；'
                        f'来源 {esc(batch["source"])}。</p><p><strong>{totals["parents"]} 个主订单、'
                        f'{totals["children"]} 个不同子订单、{totals["rows"]} 行、{totals["pieces"]} 件</strong>；'
                        f'导入拒绝 {batch["rejected"]} 行。</p>'
                        '<p class="muted">这是该次报表的记录，不代表当天新增销量；相同订单可能出现在多个批次中。'
                        '报表未覆盖的订单不在此快照内。</p>'
                        f'<p>第 {page} / {last_page} 页　{pages}</p>'
                        f'<table><tr><th>行</th><th>店铺ID</th><th>主/子订单号</th><th>有效编码</th>'
                        '<th>商品</th><th>颜色/尺码</th><th>件数</th><th>订单状态</th><th>售后状态</th>'
                        f'<th>下单时间</th><th>承诺发货</th><th>实际发货</th><th>数据更新时间</th></tr>{trs}</table></section>')
            return self.send_html(layout("导入批次", '<p><a href="/imports">返回导入记录</a></p>' + body, True))
        if path == "/import":
            remembered = temporary_zip_list(self.session_identity())
            remembered_rows = ''.join(
                f'<tr><td>{esc(filename)}</td><td>{esc(saved_at)}</td>'
                f'<td><form method="post" action="/forget-archive"><input type="hidden" name="archive_hash" value="{esc(archive_hash)}">'
                f'<button>清除此 ZIP 的临时密码</button></form></td></tr>' for archive_hash, filename, saved_at in remembered)
            body = ('<section><h2>上传抖店报表</h2><p>选择抖店导出的加密 ZIP 或 CSV。默认只在本次解压时使用密码；主动勾选后，仅在当前本机工作台进程的内存中临时记住同一 ZIP，供北京时间当天复用。当天结束、手动清除或服务重启后失效。密码不写入数据库、磁盘或浏览器存储。报表须为商品维度，包含商家编码等中文列。</p>'
                    '<form method="post" action="/import" enctype="multipart/form-data">'
                    '<p><label>报表文件 <input type="file" name="upload" accept=".zip,.csv" required></label></p>'
                    '<p><label>ZIP 解压密码 <input type="password" name="zip_password" autocomplete="off" placeholder="已记住的同一 ZIP 可留空"></label></p>'
                    '<p><label><input type="checkbox" name="remember_zip" value="yes"> 当天临时记住此压缩包密码（仅当前本机进程）</label></p>'
                    '<p><label>抖店店铺 ID <input name="shop_id" inputmode="numeric" required placeholder="店铺 ID"></label></p>'
                    '<p><label>仅导入实际发货日 <input type="date" name="shipped_day"></label> <small class="muted">留空则导入整份报表；填写后只导入该日“发货时间”对应的订单。</small></p>'
                    '<p><label><input type="checkbox" name="history_only" value="yes"> 作为历史订单回填（仅存本机历史区，不更新当前待发货）</label></p>'
                    '<p><button>解压并导入</button></p></form><p class="muted">单个上传文件最多 25 MB，解压后 CSV 最多 50 MB。每次导入都是快照，不会自动同步抖店或飞书。</p></section>'
                    f'<section><h2>当天临时记住的 ZIP</h2><form method="post" action="/forget-archive"><input type="hidden" name="scope" value="all"><button>清除本机进程全部临时密码</button></form><table><tr><th>文件</th><th>保存时间</th><th>操作</th></tr>{remembered_rows}</table></section>'
                    '<section><h2>粘贴 CSV</h2><p>保留原有方式，支持抖店商品维度 CSV 或 sample_orders.csv 测试格式。</p>'
                    '<form method="post" action="/import"><p><label>抖店店铺 ID（抖店报表必填） <input name="shop_id" inputmode="numeric" placeholder="店铺 ID"></label></p>'
                    '<p><label>仅导入实际发货日 <input type="date" name="shipped_day"></label></p>'
                    '<p><label><input type="checkbox" name="history_only" value="yes"> 作为历史订单回填（不更新当前待发货）</label></p>'
                    '<textarea name="csv" rows="12" style="width:100%" required></textarea><p><button>导入粘贴的 CSV</button></p></form></section>')
            return self.send_html(layout("导入报表", body, True))
        if path == "/history-stage":
            body = ('<section><h2>历史订单报表解压与检查</h2>'
                    '<p>仅用于已授权的目标商品历史报表。密码只在这次本机请求中用于解压，不保存。'
                    '先检查表头是否严格为所选的 13 个业务字段，再把原始 CSV 保存在本机私有数据目录；此步骤不会写入订单表。</p>'
                    '<form method="post" action="/history-stage" enctype="multipart/form-data">'
                    '<p><label>加密 ZIP <input type="file" name="upload" accept=".zip" required></label></p>'
                    '<p><label>ZIP 解压密码 <input type="password" name="zip_password" autocomplete="off" required></label></p>'
                    '<p><button>解压并核对表头</button></p></form></section>')
            return self.send_html(layout("历史报表检查", body, True))
        self.send_html(layout("未找到", "<section>页面不存在。</section>", True), 404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not self.valid_host() or self.headers.get("Origin") != f"http://127.0.0.1:{PORT}":
                return self.send_html("Invalid request origin", 403)
            if self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin":
                return self.send_html("Invalid request source", 403)
            nonce = self.form().get("_csrf", [""])[0]
            if not isinstance(nonce, str) or not hmac.compare_digest(nonce, FORM_NONCE):
                return self.send_html("Invalid form token", 403)
            if path == "/sales-refund-import":
                content = self.form().get("refund_json", [""])[0]
                days, rows = import_refund_sku_page_json(content)
                return self.send_html(layout("退款 SKU 导入结果", f'<section><h2>已写入退款 SKU 页面数据</h2><p>{days} 天，{rows} 条页面 SKU 行。</p><a href="/sales">回读销量历史</a></section>', True))
            if path == "/history-stage":
                form = self.form()
                upload = form.get("upload", [None])[0]
                if not upload or not upload[0].lower().endswith(".zip"):
                    raise ValueError("请选择历史订单 ZIP")
                filename, file_bytes = upload
                if not HISTORY_STAGE_REPORT_PREFIX or not filename.startswith(HISTORY_STAGE_REPORT_PREFIX + "_"):
                    raise ValueError("历史报表 ID 未配置或文件名不匹配")
                password = form.pop("zip_password", [""])[0]
                try:
                    content = decode_order_file(filename, file_bytes, password)
                finally:
                    password = None
                reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
                headers = reader.fieldnames or []
                if len(headers) != 13 or set(headers) != HISTORY_EXPORT_FIELDS:
                    raise ValueError("报表表头与所选 13 个业务字段不一致：" + ", ".join(headers))
                rows = sum(1 for _ in reader)
                source_hash = hashlib.sha256(file_bytes).hexdigest()
                destination = DATA / ("history_source_" + source_hash[:16] + ".csv")
                DATA.mkdir(exist_ok=True)
                if not destination.exists():
                    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
                        output.write(content)
                return self.send_html(layout("历史报表检查结果", f'<section><h2>已解压并暂存原始业务字段</h2><p>CSV 行数：{rows}；表头 13 列，未包含买家姓名、电话或地址。尚未写入订单表。</p><p>本机文件：{esc(destination)}</p></section>', True))
            if path == "/sales-import":
                upload = self.form().get("upload", [None])[0]
                if not upload or not upload[0].lower().endswith(".json"):
                    raise ValueError("请选择销量 JSON 文件")
                batch, rows, days = import_daily_sales_json(upload[1].decode("utf-8"), f"本机上传：{upload[0]}")
                return self.send_html(layout("销量导入结果", f'<section><h2>销量导入结果</h2><p>批次 {batch}：{days} 天、{rows} 条 SKU 日记录。</p><a href="/sales">查看销量历史</a></section>', True))
            if path == "/forget-archive":
                archive_hash = self.form().get("archive_hash", [""])[0]
                temporary_zip_forget(self.session_identity(), archive_hash or None)
                return self.redirect("/import")
            if path == "/import":
                form = self.form()
                upload = form.get("upload", [None])[0]
                shipped_day = form.get("shipped_day", [""])[0].strip() or None
                history_only = form.get("history_only", [""])[0] == "yes"
                if history_only and shipped_day:
                    raise ValueError("历史订单回填不能同时筛选实际发货日")
                archive_hash, save_password, password_from_memory = None, False, False
                password_for_memory = None
                if upload is not None:
                    filename, file_bytes = upload
                    if filename.lower().endswith(".zip"):
                        archive_hash = hashlib.sha256(file_bytes).hexdigest()
                        save_password = form.get("remember_zip", [""])[0] == "yes"
                    zip_password = form.pop("zip_password", [""])[0]
                    try:
                        if archive_hash and not zip_password:
                            zip_password = temporary_zip_get(self.session_identity(), archive_hash) or ""
                            password_from_memory = bool(zip_password)
                        content = decode_order_file(filename, file_bytes, zip_password)
                        if save_password and not zip_password:
                            raise ValueError("勾选记住密码时，请输入此 ZIP 的密码")
                    finally:
                        password_for_memory = zip_password if save_password and not password_from_memory else None
                        zip_password = None
                    source = f"本机上传：{filename}"
                else:
                    content = form.get("csv", [""])[0]
                    source = "手动粘贴 CSV"
                header = next(csv.reader(io.StringIO(content.lstrip("\ufeff"))), [])
                if DOUDIAN_FIELDS.issubset(set(header)):
                    accepted, errors = import_doudian_csv(content, form.get("shop_id", [""])[0], source,
                                                          shipped_day, history_only=history_only)
                else:
                    if shipped_day or history_only:
                        raise ValueError("实际发货或历史回填需要抖店商品维度报表")
                    accepted, errors = import_csv(content, source)
                save_note = ""
                if archive_hash and password_for_memory:
                    try:
                        temporary_zip_put(self.session_identity(), archive_hash, filename, password_for_memory)
                        save_note = "此 ZIP 密码仅在当前本机工作台进程的内存中暂存，北京时间当天有效。"
                    finally:
                        password_for_memory = None
                elif password_from_memory:
                    save_note = "已使用当前本机工作台进程当天临时记住的此 ZIP 密码。"
                result_link = '<a href="/history">查看历史订单</a>' if history_only else '<a href="/due">查看全部待发货</a>'
                return self.send_html(layout("导入结果", f'<section><h2>导入结果</h2><p>接受 {accepted} 行，拒绝 {len(errors)} 行。</p><p>{esc(save_note)}</p><pre>{esc(chr(10).join(errors))}</pre>{result_link}</section>', True))
            self.send_html(layout("未找到", "<section>操作不存在。</section>", True), 404)
        except (ValueError, UnicodeDecodeError) as exc:
            self.send_html(layout("输入错误", f'<section><p class="error">{esc(exc)}</p><a href="/">返回</a></section>', True), 400)


if __name__ == "__main__":
    init_db()
    if (len(sys.argv) == 4 and sys.argv[1] in ("import-doudian", "import-doudian-history")) or (len(sys.argv) == 5 and sys.argv[1] == "import-doudian-shipped-day"):
        archive = Path(sys.argv[2])
        shop_id = sys.argv[3]
        if archive.suffix.lower() == ".zip":
            password = getpass.getpass("抖店 ZIP 解压密码: ").encode()
            with zipfile.ZipFile(archive) as z:
                csv_names = [name for name in z.namelist() if name.lower().endswith(".csv")]
                if len(csv_names) != 1:
                    raise ValueError("ZIP 中应恰好有一个 CSV")
                content_bytes = z.read(csv_names[0], pwd=password)
        elif archive.suffix.lower() == ".csv":
            content_bytes = archive.read_bytes()
        else:
            raise ValueError("仅接受抖店导出的 CSV 或加密 ZIP")
        for encoding in ("utf-8-sig", "gb18030"):
            try:
                content = content_bytes.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("无法识别 CSV 编码")
        shipped_day = sys.argv[4] if len(sys.argv) == 5 else None
        history_only = sys.argv[1] == "import-doudian-history"
        accepted, errors = import_doudian_csv(
            content, shop_id,
            f"抖店导出：{archive.name}" + (f"；实际发货日 {shipped_day}" if shipped_day else "")
            + ("；历史订单回填" if history_only else ""), shipped_day, history_only=history_only)
        print(f"导入完成：接受 {accepted} 行，拒绝 {len(errors)} 行")
        for error in errors[:20]:
            print(error)
    elif len(sys.argv) == 1:
        print(f"订单管理原型运行于 http://{HOST}:{PORT}")
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    else:
        raise SystemExit("用法：python3 app.py [import-doudian 导出.csv或.zip 店铺ID | import-doudian-shipped-day 导出.csv或.zip 店铺ID YYYY-MM-DD | import-doudian-history 导出.csv或.zip 店铺ID]")
