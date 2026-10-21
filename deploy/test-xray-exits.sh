#!/usr/bin/env bash
# Test every proxy-* outbound of an existing xray config WITHOUT touching the running xray:
# builds a throw-away config (one SOCKS inbound per outbound), runs it in a temporary
# container on the same docker network, measures each exit, then removes the container.
#
#   bash deploy/test-xray-exits.sh [CONFIG] [NETWORK] [XRAY_IMAGE] [OUTBOUND_PREFIX]
#   defaults: /opt/smm-ve/deploy/xray/config.json  smm-ve_egress  teddysun/xray:latest  proxy-
set -u
CFG=${1:-/opt/smm-ve/deploy/xray/config.json}
NET=${2:-smm-ve_egress}
IMG=${3:-teddysun/xray:latest}
PREFIX=${4:-proxy-}
OUT=/tmp/xray-exits.json
NAME=xray-exit-test
BASE_PORT=21001

python3 - "$CFG" "$OUT" "$PREFIX" "$BASE_PORT" <<'PY' || exit 1
import json, sys
cfg, out, prefix, base = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
c = json.load(open(cfg))
outs = [o for o in c.get("outbounds", []) if str(o.get("tag", "")).startswith(prefix)]
if not outs:
    sys.exit("no outbounds with prefix %r found" % prefix)
test = {"log": {"loglevel": "warning"}, "inbounds": [], "outbounds": c["outbounds"], "routing": {"rules": []}}
lines = []
for i, o in enumerate(outs):
    tag, port = "t%d" % i, base + i
    test["inbounds"].append({"tag": tag, "listen": "0.0.0.0", "port": port, "protocol": "socks", "settings": {"auth": "noauth", "udp": False}})
    test["routing"]["rules"].append({"type": "field", "inboundTag": [tag], "outboundTag": o["tag"]})
    lines.append("%d %s" % (port, o["tag"]))
json.dump(test, open(out, "w"))
open(out + ".map", "w").write("\n".join(lines) + "\n")
print("test config for %d outbounds written" % len(outs))
PY

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --network "$NET" -v "$OUT":/etc/xray/config.json:ro "$IMG" >/dev/null || { echo "could not start test container"; exit 1; }
sleep 3
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT

printf '%-22s %-17s %-10s %-12s\n' EXIT IP LATENCY SPEED
while read -r port tag; do
  c() { docker run --rm --network "$NET" curlimages/curl:latest -s -m 20 --socks5-hostname "$NAME:$port" "$@" 2>/dev/null; }
  ip=$(c https://api.ipify.org); ip=${ip:-FAIL}
  lat=$(c -o /dev/null -w '%{time_total}' https://www.google.com/generate_204); lat=${lat:-FAIL}
  spd=$(c -o /dev/null -w '%{speed_download}' 'https://speed.cloudflare.com/__down?bytes=8000000')
  if [ -n "$spd" ] && [ "$spd" != "0.000" ]; then spd=$(python3 -c "print('%.1f MB/s' % (float('$spd')/1e6))" 2>/dev/null || echo "$spd"); else spd=FAIL; fi
  printf '%-22s %-17s %-10s %-12s\n' "$tag" "$ip" "$lat" "$spd"
done < "$OUT.map"
echo "(temporary container removed)"
