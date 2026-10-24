"""Build a partial display from current visible rows and exact prior item IDs."""
import json
import re
import sys
from pathlib import Path


COLORS = ("中花灰", "花紫黑", "黑灰", "深灰", "浅灰", "宝蓝", "黑色", "粉色", "大红",
          "灰色", "橙黄", "焦糖", "豆沙", "花芋粉", "花金咖", "花兰紫", "竹青绿",
          "嫣粉", "铂灰", "月白蓝", "贝壳粉")


def variant(line):
    if line.get("color") and line.get("size"):
        return line["color"], line["size"]
    title = str(line.get("productName") or "")
    for color in COLORS:
        match = re.search(re.escape(color) + r"\s*(?:（[^）]*）)?\s*[/／]\s*(3XL|2XL|XL|L|M)(?![A-Za-z])",
                          title, re.I)
        if match:
            return color, match.group(1).upper()
    return None


def business_items(candidate):
    result = {}
    for evidence in candidate.get("networkEvidence", []):
        if not evidence.get("path", "").endswith("/api/order/searchlist"):
            continue
        for order in evidence.get("fields", {}).get("data", []):
            parent = str(order.get("shop_order_id") or "")
            for item in order.get("product_item", []):
                child = str(item.get("item_order_id") or "")
                if len(parent) == 19 and len(child) == 19:
                    result[(parent, child)] = item
    return result


def build(source: Path, target: Path, prior_source: Path = None):
    captured = json.loads(source.read_text(encoding="utf-8"))
    recent = [p for p in captured.get("partitions", []) if p.get("key") == "recent_6_months"]
    if len(recent) != 1:
        raise ValueError("近六个月分区不唯一")
    partition = recent[0]
    visible = [line for page in partition.get("pages", []) for line in page.get("lines", [])]
    indexed = {}
    for line in visible:
        parent, child = str(line.get("parentId") or ""), str(line.get("skuOrderId") or "")
        if len(parent) == 19 and len(child) >= 19:
            indexed.setdefault((parent, child[:19]), []).append(line)
    current_items = business_items(captured)
    prior_items = business_items(json.loads(prior_source.read_text(encoding="utf-8"))) if prior_source else {}
    rows = []
    seen = set()
    for key, matches in indexed.items():
        if key in seen:
            continue
        item = current_items.get(key) or prior_items.get(key)
        valid = [line for line in matches if variant(line) and type(line.get("quantity")) is int
                 and line["quantity"] > 0 and str(line.get("orderStatus") or "").startswith("待发货")]
        if len(valid) != 1:
            continue
        line = valid[0]
        spec = variant(line)
        if not item or not spec or type(line.get("quantity")) is not int or line["quantity"] < 1:
            continue
        if not str(line.get("orderStatus") or "").startswith("待发货"):
            continue
        product_id = str(item.get("product_id") or "")
        product_name = str(item.get("product_name") or "")
        if not (product_id.isdigit() and product_name):
            continue
        # A prior response proves stable item/product identity, never today's code or status.
        merchant_code = str(item.get("merchant_sku_code") or "") if key in current_items else str(line.get("merchantCode") or "")
        source_spec = str(line.get("productName") or "")
        rows.append({"shop_order_id": key[0], "sku_order_id": key[1],
                     "product_id": product_id, "product_name": product_name,
                     "merchant_code": merchant_code, "color": spec[0], "size": spec[1],
                     "quantity": line["quantity"], "source_spec": source_spec,
                     "status": "待发货"})
        seen.add(key)
    if not rows or len(seen) != len(rows):
        raise ValueError("没有可唯一关联的完整商品行")
    page_complete = (prior_source is None and bool(current_items)
                     and set(seen) == set(current_items)
                     and len({key[0] for key in current_items}) == partition.get("displayedPendingCount")
                     and sum(page.get("parentCount", 0) for page in partition.get("pages", []))
                     == partition.get("displayedPendingCount"))
    output = {"source": source.name, "identity_source": prior_source.name if prior_source else None,
              "observed_at": captured.get("finishedAt"),
              "scope": "recent_6_months_pending", "displayed_parent_count": partition.get("displayedPendingCount"),
              "official_parent_count": len({key[0] for key in current_items}),
              "official_item_count": len(current_items), "page_complete": page_complete,
              "observed_parent_rows": sum(page.get("parentCount", 0) for page in partition.get("pages", [])),
              "observed_item_rows": len(visible), "rows": rows}
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print("parents", len({row["shop_order_id"] for row in rows}),
          "children", len(rows), "source quantity", sum(row["quantity"] for row in rows))


if __name__ == "__main__":
    build(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None)
