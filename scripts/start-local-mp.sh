#!/bin/bash
# Starts the three local multiplayer servers if they are not already running:
#   relay 8002 (Node), site 8000 (build-release/site), game data 8001 (~/ra-data/skirmish).
# Each runs in the background with nohup, so it keeps running after this terminal closes.
# Logs go to /tmp/vc-<name>.log.
cd "$(dirname "$0")/.." || exit 1
NODE_DIR=~/emsdk/node/24.19.0_64bit/bin

listening() { ss -ltn | /usr/bin/grep -q ":$1 "; }

start() { # start NAME PORT COMMAND...
    local name=$1 port=$2; shift 2
    if listening "$port"; then echo "$name: already listening on $port"; return; fi
    nohup "$@" > "/tmp/vc-$name.log" 2>&1 &
    echo "$name: started on $port (pid $!, log /tmp/vc-$name.log)"
}

[ -d relay/node_modules ] || (cd relay && PATH=$NODE_DIR:$PATH npm install)
HOST=127.0.0.1 PORT=8002 start relay 8002 "$NODE_DIR/node" relay/server.js
start site 8000 python3 -m http.server 8000 -d build-release/site
start data 8001 python3 scripts/serve-pack.py ~/ra-data/skirmish

sleep 1
echo "Site:  http://localhost:8000/"
echo "Data:  http://localhost:8001/"
echo "Relay: ws://127.0.0.1:8002/"
echo "Relay health: $(curl -s --max-time 3 http://127.0.0.1:8002/health || echo 'not answering')"
