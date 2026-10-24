"""Render a verified subset of the pending-page candidate separately from published snapshots."""
import html
import json
from datetime import datetime
from zoneinfo import ZoneInfo


def render_partial_due(path):
    if not path.is_file():
        return ""
    try:
        candidate = json.loads(path.read_text(encoding="utf-8"))
        if candidate.get("scope") != "recent_6_months_pending":
            return ""
        rows = candidate["rows"]
        if (not rows and candidate.get("page_complete") is True
                and candidate.get("empty_state_confirmed") is True
                and candidate.get("displayed_parent_count") == 0):
            observed = candidate.get("observed_at") or ""
            try:
                observed = datetime.fromisoformat(observed.replace("Z", "+00:00")).astimezone(
                    ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                observed = observed or "待核"
            return ("<section><h2>近6个月待发货 · 本次读取结果</h2>"
                    f"<p><strong>当前待发货 0 个主订单、0 个商品子订单</strong>；"
                    f"读取时间 {html.escape(observed)}（北京时间）。</p>"
                    "<p class='muted'>官方页面近6个月待发货标签显示0，空表显示“暂无数据”。"
                    "这是本次读取结果，不代表实时自动同步；历史导入数据未删除。</p></section>")
        ids = [str(row["sku_order_id"]) for row in rows]
        if not rows or len(ids) != len(set(ids)):
            return ""
        groups = {}
        preferred = ("M", "L", "XL", "2XL", "3XL")
        sizes = set(preferred)
        for row in rows:
            code, product_id, name = (str(row[k]) for k in ("merchant_code", "product_id", "product_name"))
            color, size, qty = str(row["color"]), str(row["size"]), int(row["quantity"])
            if not product_id.isdigit() or not name or not color or not size or qty < 1:
                return ""
            group = groups.setdefault((product_id, code, name, color), {"sizes": {}, "children": 0})
            group["sizes"][size] = group["sizes"].get(size, 0) + qty
            group["children"] += 1
            sizes.add(size)
        columns = [*preferred, *sorted(sizes - set(preferred))]
        escape = lambda value: html.escape(str(value), quote=True)
        head = "".join(f"<th>{escape(size)}</th>" for size in columns)
        body = ""
        for (product_id, code, name, color), group in sorted(groups.items()):
            label = code if code else name
            source = "商家编码" if code else "商家编码未填写；按商品名称展示"
            cells = "".join(f"<td>{group['sizes'].get(size, 0) or '—'}</td>" for size in columns)
            body += (f"<tr><td>{escape(label)} · {escape(color)}<br><small>{escape(source)}｜"
                     f"商品ID：{escape(product_id)}</small></td>{cells}"
                     f"<td>{sum(group['sizes'].values())}</td><td>{group['children']}</td></tr>")
        source_quantity = sum(int(row["quantity"]) for row in rows)
        parents = len({row["shop_order_id"] for row in rows})
        complete = candidate.get("page_complete") is True
        title = "近6个月待发货 · 本次页面已读全" if complete else "近6个月待发货 · 部分已读取"
        note = ("该时点页面显示的主订单和商品子订单已逐页对应；店铺ID尚待核实。"
                if complete else "其余商品行待关联或核对，未知数量不计为0。")
        observed = candidate.get("observed_at") or ""
        try:
            observed = datetime.fromisoformat(observed.replace("Z", "+00:00")).astimezone(
                ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            observed = observed or "待核"
        return (f"<section><h2>{escape(title)}</h2>"
                f"<p><strong>{parents} 个主订单、{len(rows)} 个商品子订单、源订单数量 {source_quantity}</strong>；"
                f"读取时间 {escape(observed)}（北京时间）。</p>"
                f"<p class='muted'>范围：近6个月待发货。页面当时显示主订单 "
                f"{escape(candidate.get('displayed_parent_count'))} 个；{escape(note)}"
                "组合款按原规格显示两个颜色；未将源订单数量乘以二。"
                "这是读取时点的快照，不代表实时同步。</p>"
                f"<table><tr><th>商家编码或商品名称 · 颜色</th>{head}<th>源订单数量</th>"
                f"<th>商品子订单</th></tr>{body}</table></section>")
    except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError):
        return ""
