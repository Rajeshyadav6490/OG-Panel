"""
OG Panel - Flask Backend
Run: python app.py
Then open: http://127.0.0.1:5000
"""
import json
import random
import re
import string
import time
import threading
from datetime import datetime
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder=None)

# Storage paths
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
ORDERS_FILE = DATA_DIR / "orders.json"
PROVIDERS_FILE = DATA_DIR / "providers.json"
LOGS_FILE = DATA_DIR / "logs.json"

# Default seed providers
DEFAULT_PROVIDERS = {
    "8f4b06c4": {
        "id": "8f4b06c4",
        "name": "yoyo",
        "api_url": "https://yoyomedia.in/api/v2",
        "api_key": "959a3133***",
    },
    "965216c3": {
        "id": "965216c3",
        "name": "Just Smm",
        "api_url": "https://justsmm.com/api/v2",
        "api_key": "c1119b69***",
    },
}


def _load(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def _save(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def load_orders():
    return _load(ORDERS_FILE, {})


def save_orders(data):
    _save(ORDERS_FILE, data)


def load_providers():
    prov = _load(PROVIDERS_FILE, {})
    if not prov:
        prov = dict(DEFAULT_PROVIDERS)
        save_providers(prov)
    return prov


def save_providers(data):
    _save(PROVIDERS_FILE, data)


def load_logs():
    return _load(LOGS_FILE, {})


def save_logs(data):
    _save(LOGS_FILE, data)


def uid():
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def now():
    return int(time.time())


def ts_str():
    return datetime.now().strftime("%H:%M:%S")


def append_log(oid, line):
    logs = load_logs()
    logs[oid] = logs.get(oid, "") + f"[{ts_str()}] {line}\n"
    save_logs(logs)


def order_list():
    orders = load_orders()
    providers = load_providers()
    out = []
    for o in orders.values():
        o = dict(o)
        o["provider_name"] = (
            providers[o["provider_id"]]["name"]
            if o.get("provider_id") and o["provider_id"] in providers
            else ""
        )
        o["created_str"] = datetime.fromtimestamp(o["created_at"]).strftime("%c")
        out.append(o)
    out.sort(key=lambda x: x["created_at"], reverse=True)
    return out


# Growth pattern and delays
VIEW_PATTERN = [
    100, 120, 135, 196, 150, 170, 190, 136, 200, 230,
    210, 192, 260, 280, 100, 196, 135, 120, 150, 136,
    190, 213, 353, 393, 400, 441, 443, 491, 534, 613,
    714, 832, 818, 938, 1013, 978, 1123, 1089, 1132, 1022,
    1209, 1091, 1376, 1160, 1159, 1074, 1132, 1082, 1069, 1134,
    1141, 1157, 1089, 1083, 978, 947, 904, 936, 911, 859,
    816, 757,
]
DELAYS_MIN = [60, 70, 50, 35, 70, 55, 40, 60, 70, 50, 35, 70, 55, 40, 60, 70, 50, 35, 70, 55]
MIN_VIEW_BATCH = 100
MIN_DERIVED = 10


def delay_for(step):
    return DELAYS_MIN[step % len(DELAYS_MIN)]


def due_for(views, pct):
    return int((views or 0) * (pct or 0) / 100)


def send_real_batch(o, providers, label, sid, qty):
    # Placeholder: replace with real provider API call if needed
    if not qty or qty <= 0 or not sid:
        return
    prov = providers.get(o.get("provider_id"))
    if not prov or not prov.get("api_url") or not prov.get("api_key"):
        append_log(o["id"], f"[{ts_str()}] ⚠ {label}: no provider configured, skipped")
        return
    append_log(o["id"], f"[{ts_str()}] ✓ {label} order sent (qty {qty})")


def flush_derived(o, providers, label, sid_key, sent_key, pct_key, enabled_key, force_final):
    if not o.get(enabled_key):
        return
    due = due_for(o.get("current_views", 0), o.get(pct_key, 0))
    sent = o.get(sent_key, 0)
    pending = due - sent
    if pending <= 0:
        return
    if pending >= MIN_DERIVED or force_final:
        if pending < MIN_DERIVED and force_final:
            append_log(
                o["id"],
                f"[{ts_str()}] ⓘ {label} final pending {pending} < provider min {MIN_DERIVED}, skipped",
            )
            return
        o[sent_key] = due
        send_real_batch(o, providers, label, o.get(sid_key), pending)


def simulate_step():
    orders = load_orders()
    providers = load_providers()
    changed = False
    for o in orders.values():
        if o.get("status") == "scheduled" and o.get("scheduled_ts") and now() >= o["scheduled_ts"]:
            o["status"] = "running"
            o["current_step"] = 0
            o["next_step_at"] = now() + delay_for(0)
            changed = True
            append_log(o["id"], "Order started (scheduled time reached)")
        if o.get("status") != "running":
            continue
        if o.get("next_step_at") and now() < o["next_step_at"]:
            continue

        tv = o.get("target_views", 0)
        cv = o.get("current_views", 0)
        remaining = tv - cv
        if remaining <= 0:
            o["status"] = "completed"
            o["next_step_at"] = 0
            append_log(o["id"], "COMPLETED")
            changed = True
            continue

        batch_num = o.get("current_step", 0)
        pattern_batch = max(1, VIEW_PATTERN[batch_num % len(VIEW_PATTERN)])
        if remaining <= pattern_batch + MIN_VIEW_BATCH:
            batch = remaining
        else:
            batch = pattern_batch
        new_cv = cv + batch

        o["current_views"] = new_cv
        if o.get("likes_enabled"):
            o["current_likes"] = due_for(new_cv, o.get("like_pct", 0))
        if o.get("shares_enabled"):
            o["current_shares"] = due_for(new_cv, o.get("share_pct", 0))
        if o.get("saves_enabled"):
            o["current_saves"] = due_for(new_cv, o.get("save_pct", 0))
        if o.get("reposts_enabled"):
            o["current_reposts"] = due_for(new_cv, o.get("repost_pct", 0))
        o["current_step"] = batch_num + 1

        is_final = new_cv >= tv
        line = f"[{ts_str()}] Step {batch_num + 1} +{batch}V ({new_cv}/{tv})"
        if is_final:
            line += " [final]"
        if o.get("likes_enabled"):
            line += f" L:{o['current_likes']}"
        if o.get("shares_enabled"):
            line += f" S:{o['current_shares']}"
        if o.get("saves_enabled"):
            line += f" Sa:{o['current_saves']}"
        if o.get("reposts_enabled"):
            line += f" R:{o['current_reposts']}"
        append_log(o["id"], line)

        if o.get("views_enabled", False) is not False:
            send_real_batch(o, providers, "Views", o.get("views_sid"), batch)
        flush_derived(o, providers, "Likes", "likes_sid", "sent_likes", "like_pct", "likes_enabled", is_final)
        flush_derived(o, providers, "Shares", "shares_sid", "sent_shares", "share_pct", "shares_enabled", is_final)
        flush_derived(o, providers, "Saves", "saves_sid", "sent_saves", "save_pct", "saves_enabled", is_final)
        flush_derived(o, providers, "Reposts", "reposts_sid", "sent_reposts", "repost_pct", "reposts_enabled", is_final)

        if is_final:
            o["status"] = "completed"
            o["next_step_at"] = 0
            append_log(o["id"], "COMPLETED")
        else:
            o["next_step_at"] = now() + delay_for(batch_num + 1)
        changed = True

    if changed:
        save_orders(orders)


def simulator_loop():
    while True:
        try:
            simulate_step()
        except Exception as e:
            print("Simulator error:", e)
        time.sleep(1)


threading.Thread(target=simulator_loop, daemon=True).start()


# Static files
@app.route("/")
def index():
    return send_from_directory(Path(__file__).parent, "index.html")


@app.route("/css/<path:path>")
def css(path):
    return send_from_directory(Path(__file__).parent / "css", path)


@app.route("/js/<path:path>")
def js(path):
    return send_from_directory(Path(__file__).parent / "js", path)


# API routes
@app.route("/api/stats")
def api_stats():
    orders = load_orders().values()
    providers = load_providers()
    return jsonify({
        "running": sum(1 for o in orders if o.get("status") == "running"),
        "pending": sum(1 for o in orders if o.get("status") == "pending"),
        "scheduled": sum(1 for o in orders if o.get("status") == "scheduled"),
        "paused": sum(1 for o in orders if o.get("status") == "paused"),
        "completed": sum(1 for o in orders if o.get("status") == "completed"),
        "stopped": sum(1 for o in orders if o.get("status") == "stopped"),
        "providers": len(providers),
        "total_delivered": sum(o.get("current_views", 0) for o in orders),
    })


@app.route("/api/providers", methods=["GET", "POST"])
def api_providers():
    if request.method == "GET":
        return jsonify({"providers": list(load_providers().values())})
    data = request.get_json() or {}
    pid = uid()
    providers = load_providers()
    providers[pid] = {"id": pid, "name": data.get("name"), "api_url": data.get("api_url"), "api_key": data.get("api_key")}
    save_providers(providers)
    return jsonify({"ok": True, "id": pid})


@app.route("/api/providers/<pid>", methods=["GET", "DELETE"])
def api_provider(pid):
    providers = load_providers()
    if request.method == "DELETE":
        if pid in providers:
            del providers[pid]
            save_providers(providers)
        return jsonify({"ok": True})
    if pid in providers:
        return jsonify({"provider": providers[pid]})
    return jsonify({"error": "Not found"}), 404


@app.route("/api/orders", methods=["GET", "POST"])
def api_orders():
    if request.method == "GET":
        return jsonify({"orders": order_list()})
    data = request.get_json() or {}
    oid = uid()
    scheduled = bool(data.get("is_scheduled"))
    scheduled_time = data.get("scheduled_time", "")
    scheduled_ts = 0
    if scheduled and scheduled_time:
        try:
            scheduled_ts = int(datetime.fromisoformat(scheduled_time).timestamp())
        except Exception:
            scheduled_ts = 0
    order = {
        "id": oid,
        "order_name": data.get("order_name", ""),
        "link": data.get("link", ""),
        "target_views": data.get("views", 0),
        "mode": data.get("mode", "real"),
        "provider_id": data.get("provider_id", ""),
        "views_sid": data.get("views_sid"),
        "likes_sid": data.get("likes_sid"),
        "shares_sid": data.get("shares_sid"),
        "saves_sid": data.get("saves_sid"),
        "reposts_sid": data.get("reposts_sid"),
        "views_enabled": bool(data.get("views_enabled")),
        "likes_enabled": bool(data.get("likes_enabled")),
        "shares_enabled": bool(data.get("shares_enabled")),
        "saves_enabled": bool(data.get("saves_enabled")),
        "reposts_enabled": bool(data.get("reposts_enabled")),
        "like_pct": data.get("like_pct", 0),
        "share_pct": data.get("share_pct", 0),
        "save_pct": data.get("save_pct", 0),
        "repost_pct": data.get("repost_pct", 0),
        "current_views": 0,
        "current_likes": 0,
        "current_shares": 0,
        "current_saves": 0,
        "current_reposts": 0,
        "status": "scheduled" if scheduled else "pending",
        "next_step_at": 0,
        "created_at": now(),
        "scheduled_ts": scheduled_ts,
        "is_scheduled": scheduled,
    }
    orders = load_orders()
    orders[oid] = order
    save_orders(orders)
    append_log(oid, f"Order created ({order['target_views']} views target)")
    return jsonify({"order_id": oid, "is_scheduled": scheduled})


@app.route("/api/orders/<oid>", methods=["DELETE"])
def api_delete_order(oid):
    orders = load_orders()
    if oid in orders:
        del orders[oid]
        save_orders(orders)
    logs = load_logs()
    if oid in logs:
        del logs[oid]
        save_logs(logs)
    return jsonify({"ok": True})


@app.route("/api/orders/<oid>/<action>", methods=["POST"])
def api_order_action(oid, action):
    orders = load_orders()
    o = orders.get(oid)
    if not o:
        return jsonify({"error": "Order not found"}), 404
    if action == "start":
        o["status"] = "running"
        o["next_step_at"] = now() + 2
        append_log(oid, "STARTED")
    elif action == "stop":
        o["status"] = "stopped"
        o["next_step_at"] = 0
        append_log(oid, "STOPPED")
    elif action == "pause":
        o["status"] = "paused"
        append_log(oid, "PAUSED")
    elif action == "resume":
        o["status"] = "running"
        o["next_step_at"] = now() + 2
        append_log(oid, "RESUMED")
    save_orders(orders)
    return jsonify({"ok": True})


@app.route("/api/export/orders/<oid>/logs")
def api_export_logs(oid):
    logs = load_logs()
    return logs.get(oid, ""), 200, {"Content-Type": "text/plain"}


@app.route("/api/export/orders")
def api_export_orders():
    return jsonify(order_list())


@app.route("/api/export/providers")
def api_export_providers():
    return jsonify(list(load_providers().values()))


@app.route("/api/backup", methods=["POST"])
def api_backup():
    filename = "backup_" + datetime.now().isoformat().replace(":", "-").replace(".", "-") + ".json"
    return jsonify({"file": filename})


@app.route("/api/clear/completed", methods=["POST"])
def api_clear_completed():
    orders = load_orders()
    n = 0
    for oid in list(orders.keys()):
        if orders[oid].get("status") in ("completed", "stopped"):
            del orders[oid]
            n += 1
    save_orders(orders)
    return jsonify({"message": f"Cleared {n} orders"})


if __name__ == "__main__":
    print("Starting OG Panel server on http://127.0.0.1:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
