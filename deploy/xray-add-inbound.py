#!/usr/bin/env python3
"""
Add a dedicated SOCKS inbound for the addon to an existing xray config, pinned to ONE outbound.

Why pinned: stream tokens are bound to the IP that requested them. A balancer
(leastPing etc.) that switches exit between the playlist request and the segment
requests makes the CDN answer 403. A separate inbound with a fixed outbound avoids that,
and leaves every existing inbound and rule untouched.

  python3 xray-add-inbound.py /opt/smm-ve/deploy/xray/config.json proxy-finland
  python3 xray-add-inbound.py CONFIG OUTBOUND_TAG [PORT] [INBOUND_TAG]

Idempotent; writes CONFIG.bak first and rewrites the file IN PLACE (a docker file bind
mount breaks if the inode changes).
"""
import json, shutil, sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
path, outbound = sys.argv[1], sys.argv[2]
port = int(sys.argv[3]) if len(sys.argv) > 3 else 1081
tag = sys.argv[4] if len(sys.argv) > 4 else "nuvio-in"

cfg = json.load(open(path))
tags = [o.get("tag") for o in cfg.get("outbounds", [])]
if outbound not in tags:
    sys.exit(f"outbound '{outbound}' not found. Available: {', '.join(str(t) for t in tags)}")
if any(i.get("tag") == tag for i in cfg.get("inbounds", [])):
    sys.exit(f"inbound '{tag}' already exists - nothing to do (edit it by hand to change the outbound)")
if any(i.get("port") == port for i in cfg.get("inbounds", [])):
    sys.exit(f"port {port} is already used by another inbound; pass a different PORT")

shutil.copyfile(path, path + ".bak")
cfg.setdefault("inbounds", []).append({
    "tag": tag, "listen": "0.0.0.0", "port": port, "protocol": "socks",
    "settings": {"auth": "noauth", "udp": False},
})
routing = cfg.setdefault("routing", {})
routing.setdefault("rules", []).insert(0, {"type": "field", "inboundTag": [tag], "outboundTag": outbound})

with open(path, "r+") as f:           # same inode
    f.seek(0); f.truncate()
    json.dump(cfg, f, indent=2); f.write("\n")
print(f"ok: inbound '{tag}' 0.0.0.0:{port} -> outbound '{outbound}' (backup: {path}.bak)")
print("next: docker exec <xray container> xray run -test -config /etc/xray/config.json && docker restart <xray container>")
