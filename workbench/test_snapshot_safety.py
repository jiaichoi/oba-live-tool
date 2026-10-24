"""Regression checks using a single in-memory database and synthetic orders."""

import csv
import io
import json
import sqlite3
import unittest
from types import SimpleNamespace

from workbench import app
from workbench.partial_due_display import render_partial_due


FIELDS = ["主订单编号", "子订单编号", "选购商品", "商家编码", "商品数量", "订单状态",
          "售后状态", "订单提交时间", "承诺发货时间"]


def report(*rows):
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def order(sku, *, status="待发货", size="L", quantity="1", aftersale="-"):
    return dict(zip(FIELDS, ["P1", sku, "测试羊毛裤黑色/" + size, "TEST-1480", quantity,
                             status, aftersale, "2026-10-24 09:00:00", "2026-10-24 18:00:00"]))


def direct_evidence(*children):
    items = []
    for sku, size in children:
        items.append({
            "sku_order_id": sku, "product_code": "TEST-1480",
            "product_name": "测试羊毛裤", "color": "黑色", "size": size,
            "quantity": "1", "status": "待发货",
            "created_at": "2026-10-24 09:00:00",
            "promised_ship_at": "2026-10-24 18:00:00",
            "updated_at": "2026-10-24 10:00:00", "aftersale_status": "-",
        })
    recent = {"key": "recent_6_months", "total_main_orders": 1 if items else 0,
              "page_count": 1 if items else 0,
              "pages": [{"number": 1, "orders": [{"shop_order_id": "P1", "items": items}]}] if items else []}
    return {
        "shop_id": "123456",
        "source_url": "https://fxg.jinritemai.com/ffa/morder/order/list",
        "observed_at": "2026-10-24T12:34:48+08:00",
        "filters": {"order_status": "待发货", "aftersale_status": "全部",
                    "created_from": "", "created_to": ""},
        "partitions": [recent, {"key": "older_than_6_months",
                                 "total_main_orders": 0, "page_count": 0, "pages": []}],
    }


class SnapshotSafetyTest(unittest.TestCase):
    def setUp(self):
        self.database = sqlite3.connect(":memory:")
        self.database.row_factory = sqlite3.Row
        self.database.execute("PRAGMA foreign_keys=ON")
        self.original_connection = app.connection
        app.connection = lambda: self.database
        app.init_db()

    def tearDown(self):
        app.connection = self.original_connection
        self.database.close()

    def test_rejected_duplicate_keeps_previous_batch(self):
        app.import_doudian_csv(report(order("S1"), order("S2", size="XL")), "123456")
        with self.assertRaisesRegex(ValueError, "本批未发布"):
            app.import_doudian_csv(report(order("S1"), order("S1")), "123456")
        self.assertEqual(len(app.open_snapshot_orders()), 2)
        self.assertEqual(self.database.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0], 1)

    def test_bad_quantity_keeps_previous_batch(self):
        app.import_doudian_csv(report(order("S1"), order("S2", size="XL")), "123456")
        with self.assertRaisesRegex(ValueError, "本批未发布"):
            app.import_doudian_csv(report(order("S1"), order("S2", quantity="bad")), "123456")
        self.assertEqual({item["sku_order_id"] for item in app.open_snapshot_orders()}, {"S1", "S2"})

    def test_cancelled_and_verified_empty_do_not_resurrect_old_orders(self):
        app.import_doudian_csv(report(order("S1"), order("S2", size="XL")), "123456")
        app.import_doudian_csv(report(order("S1", status="已关闭"), order("S2", size="XL")), "123456")
        self.assertEqual([item["sku_order_id"] for item in app.open_snapshot_orders()], ["S2"])
        self.assertEqual(len(app.due_orders("2026-10-24", source_type="doudian")), 1)
        app.save_orders([], [], "verified complete empty", "doudian",
                        publish_open_shop="123456", allow_complete_empty=True)
        self.assertEqual(app.open_snapshot_orders(), [])

    def test_shops_and_matrix_are_separate(self):
        app.import_doudian_csv(report(order("S1", quantity="2"), order("S2", size="XL")), "123456")
        app.import_doudian_csv(report(order("T1")), "654321")
        rows = app.open_snapshot_orders()
        self.assertEqual(len(rows), 3)
        _, groups, _ = app.size_matrix(rows)
        self.assertEqual(groups[("123456", "TEST-1480", "黑色")]["sizes"], {"L": 2, "XL": 1})
        self.assertEqual(groups[("654321", "TEST-1480", "黑色")]["sizes"], {"L": 1})

    def test_four_xl_is_a_matrix_column(self):
        app.import_doudian_csv(report(order("S1", size="4XL")), "123456")
        sizes, groups, _ = app.size_matrix(app.open_snapshot_orders())
        self.assertIn("4XL", sizes)
        self.assertEqual(groups[("123456", "TEST-1480", "黑色")]["sizes"], {"4XL": 1})

    def test_partial_matrix_keeps_new_codes_and_products_separate(self):
        candidate = {"scope": "recent_6_months_pending", "page_complete": True,
                     "displayed_parent_count": 3, "observed_at": "2026-10-24T12:00:00+08:00",
                     "rows": [
                         dict(shop_order_id="P1", sku_order_id="S1", merchant_code="NEW-1",
                              product_id="1001", product_name="甲", color="雾松绿", size="5XL", quantity=2),
                         dict(shop_order_id="P2", sku_order_id="S2", merchant_code="NEW-1",
                              product_id="1002", product_name="乙", color="雾松绿", size="XS", quantity=1),
                         dict(shop_order_id="P3", sku_order_id="S3", merchant_code="",
                              product_id="1003", product_name="丙", color="月影蓝", size="加大号", quantity=1),
                     ]}
        source = SimpleNamespace(is_file=lambda: True,
                                 read_text=lambda **_: json.dumps(candidate, ensure_ascii=False))
        rendered = render_partial_due(source)
        self.assertIn("NEW-1", rendered)
        self.assertIn("丙", rendered)
        self.assertIn("商家编码未填写", rendered)
        self.assertLess(rendered.index("<th>XS</th>"), rendered.index("<th>5XL</th>"))
        self.assertIn("<th>加大号</th>", rendered)
        self.assertIn("商品ID：1001", rendered)
        self.assertIn("商品ID：1002", rendered)

    def test_direct_pages_publish_only_after_both_partitions_match(self):
        evidence = direct_evidence(("S1", "L"), ("S2", "XL"))
        app.import_direct_order_pages(evidence, "123456")
        self.assertEqual(len(app.open_snapshot_orders()), 2)
        evidence["partitions"].pop()
        with self.assertRaisesRegex(ValueError, "两个订单分区"):
            app.import_direct_order_pages(evidence, "123456")
        self.assertEqual(len(app.open_snapshot_orders()), 2)

    def test_direct_pages_reject_partial_and_duplicate_before_publication(self):
        app.import_direct_order_pages(direct_evidence(("S0", "M")), "123456")
        evidence = direct_evidence(("S1", "L"), ("S1", "XL"))
        with self.assertRaisesRegex(ValueError, "子订单编号跨页重复"):
            app.import_direct_order_pages(evidence, "123456")
        evidence = direct_evidence(("S1", "L"))
        evidence["partitions"][0]["total_main_orders"] = 2
        with self.assertRaisesRegex(ValueError, "平台总数不符"):
            app.import_direct_order_pages(evidence, "123456")
        self.assertEqual([row["sku_order_id"] for row in app.open_snapshot_orders()], ["S0"])

    def test_direct_pages_require_shop_scope_and_reviewed_sku(self):
        evidence = direct_evidence(("S1", "L"))
        with self.assertRaisesRegex(ValueError, "店铺 ID"):
            app.import_direct_order_pages(evidence, "654321")
        evidence["partitions"][0]["pages"][0]["orders"][0]["items"][0]["size"] = "尺码待核"
        with self.assertRaisesRegex(ValueError, "规格待核"):
            app.import_direct_order_pages(evidence, "123456")
        self.assertEqual(self.database.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
