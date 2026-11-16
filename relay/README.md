# Relay

A small Node.js WebSocket server that lets browser players of Red Alert play
together. Each "room" acts like a LAN: every player keeps one WebSocket open,
and the relay passes each game packet to one player or to everyone else in the
room. It never looks inside the packets.

## Run it locally

```sh
cd relay
npm install            # once; installs the "ws" library
node server.js         # listens on 127.0.0.1:8002
node test.js           # self-test on spare ports; exits non-zero on failure
```

Players connect to `ws://HOST:PORT/?room=CODE&mode=create|join`. The code is
4 to 32 letters or digits, and upper and lower case count as the same. Use
`create` to open a new room and `join` to enter one that exists. Leave `mode`
out to join the room, creating it first if needed.

`GET /health` returns `{"ok":true,"rooms":N,"clients":N}`. Any other plain HTTP
request gets status 426, meaning "use a WebSocket".

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on |
| `PORT` | `8002` | Port to listen on |
| `MAX_ROOMS` | `200` | Rooms on the whole relay |
| `MAX_CLIENTS` | `800` | Players on the whole relay |
| `MAX_PER_IP` | `16` | Connections from one address |
| `MSGS_PER_SEC` | `600` | Frames per second per player; extra frames are dropped |
| `BYTES_PER_SEC` | `262144` | Bytes per second per player; extra frames are dropped |
| `IDLE_MS` | `1800000` (30 min) | Disconnect a player who sends no game packet for this long |
| `ROOM_MAX_AGE_MS` | `43200000` (12 h) | Close a room this long after it was created |
| `TRUST_PROXY` | off | Set to `1` to take the address from the first `X-Forwarded-For` entry |
| `ALLOWED_ORIGINS` | empty (any) | Comma-separated list of web page origins allowed to connect; others get HTTP 403 |

Fixed values (change them in `RULES` in `server.js`): 8 players per room, ids
1 to 254 never reused, 2048-byte packet limit, 64-byte text limit, a ping every
30 s, and disconnection after 5 seconds in a row over the rate limit.

## Close codes

| Code | Reason |
|---|---|
| 1001 | Relay shutting down |
| 4000 | Bad room code |
| 4001 | Room full (8 players, or all 254 ids used) |
| 4002 | Room exists (`mode=create`) |
| 4003 | No such room (`mode=join`) |
| 4004 | Game started (the room was locked) |
| 4005 | Relay full: too many rooms, players, or connections from one address |
| 4006 | Idle, or room expired |
| 4007 | Too fast: over the rate limit for 5 seconds in a row |

## What is logged

Only counts: the number of rooms and the number of players, each time someone
joins or leaves. Addresses, room codes and packet contents are never logged or
saved. The relay keeps addresses in memory only as a count of live connections,
and drops each address when its last connection closes.

## Hosting notes (untested: nothing is deployed and no provider is chosen)

- A page served over `https://` can only open `wss://` (encrypted) WebSockets.
  The relay itself speaks plain `ws://`, so put it behind a reverse proxy
  (for example nginx or Caddy) that handles TLS and passes WebSocket upgrades
  through to `127.0.0.1:8002`.
- Behind the proxy, set `TRUST_PROXY=1` so per-address limits see the real
  player address. Set `ALLOWED_ORIGINS` to the site that serves the game.
- Run it under something that restarts it if it stops (for example a systemd
  service with `Restart=always`). On SIGTERM or SIGINT the relay closes every
  connection with code 1001 and exits.
- Point an uptime check at `/health`.
