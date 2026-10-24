"""
RadArc — local server
Reads this PC's active TCP/UDP connections, geolocates them (offline GeoIP)
and streams them live to the browser page (Server-Sent Events).

Start:    python server.py        (or double-click start.bat)
Options:  --port 8765  --interval 1.0  --online  --no-browser
"""
import argparse
import datetime
import gzip
import ipaddress
import json
import os
import shutil
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import psutil
except ImportError:
    sys.exit("psutil is missing:  python -m pip install psutil maxminddb")

try:
    import maxminddb
except ImportError:
    maxminddb = None

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
CONFIG = os.path.join(ROOT, "config.json")


# ----------------------------------------------------------------- config
def load_config():
    cfg = {"port": 8765, "interval": 1.0, "home": None, "online_geo": False}
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG, encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print(f"[config] cannot read config.json: {e}")
    return cfg


# ----------------------------------------------------------------- GeoIP
class Geo:
    """Offline GeoIP (DB-IP Lite City or GeoLite2-City .mmdb in the data/ folder).
    Online fallback (ip-api.com) only when explicitly enabled."""

    def __init__(self, online=False):
        self.reader = None
        self.online = online
        self.cache = {}
        self.lock = threading.Lock()
        self.pending = set()
        os.makedirs(DATA, exist_ok=True)
        self._open_db()

    def _find_db(self):
        dbs = [f for f in os.listdir(DATA) if f.lower().endswith(".mmdb")]
        dbs.sort(reverse=True)
        return os.path.join(DATA, dbs[0]) if dbs else None

    def _download(self):
        today = datetime.date.today()
        months = [today.replace(day=1)]
        prev = months[0] - datetime.timedelta(days=1)
        months.append(prev.replace(day=1))
        for m in months:
            name = f"dbip-city-lite-{m:%Y-%m}.mmdb"
            url = f"https://download.db-ip.com/free/{name}.gz"
            dest = os.path.join(DATA, name)
            print(f"[geo] downloading GeoIP database (one time only, ~60 MB): {url}")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "radarc/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r, open(dest + ".gz", "wb") as f:
                    total = int(r.headers.get("Content-Length") or 0)
                    done = 0
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        done += len(chunk)
                        if total:
                            print(f"\r[geo] {done * 100 // total:3d}%", end="", flush=True)
                print()
                with gzip.open(dest + ".gz", "rb") as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.remove(dest + ".gz")
                print(f"[geo] done: {dest}")
                return dest
            except Exception as e:
                print(f"\n[geo] failed ({e})")
                for p in (dest, dest + ".gz"):
                    if os.path.exists(p):
                        os.remove(p)
        return None

    def _open_db(self):
        if maxminddb is None:
            print("[geo] maxminddb module is missing (python -m pip install maxminddb)")
            return
        path = self._find_db() or self._download()
        if path:
            self.reader = maxminddb.open_database(path)
            print(f"[geo] using {os.path.basename(path)}")
        else:
            print("[geo] no GeoIP database. Put an .mmdb file in the data/ folder manually "
                  "(e.g. from https://db-ip.com/db/download/ip-to-city-lite)")

    @staticmethod
    def _parse(rec):
        if not rec or "location" not in rec:
            return None
        loc = rec["location"]
        city = (rec.get("city") or {}).get("names", {}).get("en", "")
        ctry = rec.get("country") or {}
        sub = rec.get("subdivisions") or [{}]
        return {
            "lat": loc.get("latitude"),
            "lon": loc.get("longitude"),
            "city": city,
            "region": sub[0].get("names", {}).get("en", "") if sub else "",
            "country": ctry.get("names", {}).get("en", ""),
            "cc": ctry.get("iso_code", ""),
        }

    def lookup(self, ip):
        with self.lock:
            if ip in self.cache:
                return self.cache[ip]
        res = None
        if self.reader:
            try:
                res = self._parse(self.reader.get(ip))
            except Exception:
                res = None
        if res is None and self.online:
            with self.lock:
                self.pending.add(ip)
            return None
        with self.lock:
            self.cache[ip] = res
        return res

    def flush_online(self):
        """Resolve unknown IPs in batches via ip-api.com (only with --online)."""
        with self.lock:
            batch = list(self.pending)[:100]
            self.pending.difference_update(batch)
        if not batch:
            return
        try:
            body = json.dumps([{"query": ip, "fields": "status,lat,lon,city,regionName,country,countryCode,query"}
                               for ip in batch]).encode()
            req = urllib.request.Request("http://ip-api.com/batch", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                for it in json.load(r):
                    ok = it.get("status") == "success"
                    with self.lock:
                        self.cache[it["query"]] = {
                            "lat": it["lat"], "lon": it["lon"], "city": it.get("city", ""),
                            "region": it.get("regionName", ""), "country": it.get("country", ""),
                            "cc": it.get("countryCode", ""),
                        } if ok else None
        except Exception as e:
            print(f"[geo-online] {e}")


# ----------------------------------------------------------------- Reverse DNS
class RDNS:
    def __init__(self):
        self.cache = {}
        self.pool = ThreadPoolExecutor(max_workers=8)
        self.lock = threading.Lock()

    def get(self, ip):
        with self.lock:
            if ip in self.cache:
                return self.cache[ip]
            self.cache[ip] = ""  # in progress
        self.pool.submit(self._resolve, ip)
        return ""

    def _resolve(self, ip):
        try:
            host = socket.gethostbyaddr(ip)[0]
        except Exception:
            host = ""
        with self.lock:
            self.cache[ip] = host


# ----------------------------------------------------------------- My location
def find_home(cfg, geo):
    if cfg.get("home") and cfg["home"].get("lat") is not None:
        h = dict(cfg["home"])
        h.setdefault("ip", "")
        h.setdefault("source", "config")
        return h
    ip = ""
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            with urllib.request.urlopen(url, timeout=6) as r:
                ip = r.read().decode().strip()
                if ip:
                    break
        except Exception:
            continue
    if not ip:
        print("[home] could not get the public IP; set \"home\" in config.json")
        return {"ip": "", "lat": None, "lon": None, "city": "", "country": "", "source": "none"}
    g = geo.lookup(ip)
    if g is None and geo.online:
        geo.flush_online()
        g = geo.lookup(ip)
    g = g or {"lat": None, "lon": None, "city": "", "country": "", "cc": ""}
    print(f"[home] public IP {ip} → {g.get('city')}, {g.get('country')} ({g.get('lat')}, {g.get('lon')})")
    return {"ip": ip, **g, "source": "ip"}


# ----------------------------------------------------------------- Collector
def classify(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return "invalid"
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    if a.is_loopback or a.is_unspecified:
        return "loopback"
    if a.is_private or a.is_link_local or a.is_multicast or a.is_reserved:
        return "lan"
    return "public"


class Collector:
    def __init__(self, geo, interval):
        self.geo = geo
        self.rdns = RDNS()
        self.interval = interval
        self.first_seen = {}
        self.proc_cache = {}
        self.snapshot = {"t": 0, "conns": [], "listen": [], "stats": {}}
        self.lock = threading.Lock()
        self.version = 0
        self.home = None

    def proc_name(self, pid):
        if not pid:
            return "System"
        if pid in self.proc_cache:
            return self.proc_cache[pid]
        try:
            n = psutil.Process(pid).name()
        except Exception:
            n = f"pid {pid}"
        self.proc_cache[pid] = n
        return n

    def collect(self):
        try:
            raw = psutil.net_connections(kind="inet")
        except psutil.AccessDenied:
            raw = []
            print("[conn] access denied — run as administrator for the full list")
        listen_tcp = set()
        for c in raw:
            if c.type == socket.SOCK_STREAM and c.status == psutil.CONN_LISTEN and c.laddr:
                listen_tcp.add(c.laddr.port)

        now = time.time()
        conns, seen = [], set()
        stats = {"in": 0, "out": 0, "lan": 0, "unknown": 0}
        for c in raw:
            if not c.raddr:
                continue
            rip, rport = c.raddr.ip, c.raddr.port
            kind = classify(rip)
            if kind in ("loopback", "invalid"):
                continue
            proto = "TCP" if c.type == socket.SOCK_STREAM else "UDP"
            lip, lport = (c.laddr.ip, c.laddr.port) if c.laddr else ("", 0)
            direction = "in" if (proto == "TCP" and lport in listen_tcp) else "out"
            cid = f"{proto}|{lip}|{lport}|{rip}|{rport}"
            if cid in seen:
                continue
            seen.add(cid)
            self.first_seen.setdefault(cid, now)
            item = {
                "id": cid, "dir": direction, "proto": proto, "state": c.status or "",
                "lip": lip, "lport": lport, "rip": rip, "rport": rport,
                "pid": c.pid or 0, "proc": self.proc_name(c.pid),
                "first": self.first_seen[cid], "lan": kind == "lan",
            }
            if kind == "public":
                g = self.geo.lookup(rip)
                if g:
                    item.update(g)
                else:
                    stats["unknown"] += 1
                item["host"] = self.rdns.get(rip)
            else:
                stats["lan"] += 1
            stats[direction] += 1
            conns.append(item)

        for k in list(self.first_seen):
            if k not in seen:
                del self.first_seen[k]
        if len(self.proc_cache) > 2000:
            self.proc_cache.clear()

        with self.lock:
            self.snapshot = {
                "t": now, "home": self.home, "conns": conns,
                "listen": sorted(listen_tcp), "stats": stats,
            }
            self.version += 1

    def loop(self):
        while True:
            try:
                self.collect()
                if self.geo.online:
                    self.geo.flush_online()
            except Exception as e:
                print(f"[conn] error: {e}")
            time.sleep(self.interval)

    def get(self):
        with self.lock:
            return self.version, self.snapshot


# ----------------------------------------------------------------- HTTP
def make_handler(collector):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=WEB, **kw)

        def log_message(self, fmt, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def do_GET(self):
            if self.path.startswith("/api/snapshot"):
                _, snap = collector.get()
                body = json.dumps(snap).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.startswith("/events"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                last = -1
                try:
                    while True:
                        v, snap = collector.get()
                        if v != last:
                            last = v
                            self.wfile.write(b"data: " + json.dumps(snap).encode() + b"\n\n")
                            self.wfile.flush()
                        time.sleep(0.25)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return
            return super().do_GET()

    return Handler


def main():
    cfg = load_config()
    ap = argparse.ArgumentParser(description="RadArc — local server")
    ap.add_argument("--port", type=int, default=cfg["port"])
    ap.add_argument("--interval", type=float, default=cfg["interval"])
    ap.add_argument("--online", action="store_true", default=cfg["online_geo"],
                    help="use ip-api.com for IPs not found in the offline database")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    geo = Geo(online=args.online)
    col = Collector(geo, args.interval)
    col.home = find_home(cfg, geo)
    threading.Thread(target=col.loop, daemon=True).start()

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(col))
    srv.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}/"
    print(f"\n  RadArc running at {url}\n  (Ctrl+C to stop)\n")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped.")


if __name__ == "__main__":
    main()
