// SPDX-License-Identifier: GPL-3.0-or-later
// Relay: makes each "room" behave like a LAN for browser players.
// Every player holds one WebSocket; the relay forwards each binary packet to
// one player or to everyone else in the room. It never looks inside payloads.
// Privacy: nothing personal is stored or logged (no IPs, room codes, payloads).
// Addresses are only used as keys of a live connection count, held in memory.

const http = require("http");
const { WebSocketServer } = require("ws");

// Read a number from an environment variable, or use the default.
const env = process.env;
const num = (name, dflt) => (env[name] ? Number(env[name]) : dflt);

// ---- Room rules: every limit lives here ----
// Environment variable names are shown in capitals; tests pass overrides to start().
const RULES = {
    maxClients: 8, // more than this live in one room: refuse with 4001
    maxId: 254, // ids run 1..254 and are never reused within a room
    maxFrame: 2048, // binary frames larger than this are dropped
    maxText: 64, // text frames larger than this are ignored
    roomCode: /^[A-Za-z0-9]{4,32}$/,
    maxRooms: num("MAX_ROOMS", 200), // rooms on the whole relay: refuse with 4005
    maxTotalClients: num("MAX_CLIENTS", 800), // clients on the whole relay: 4005
    maxPerIp: num("MAX_PER_IP", 16), // connections from one address: 4005
    msgsPerSec: num("MSGS_PER_SEC", 600), // frames per second per client, extra dropped
    bytesPerSec: num("BYTES_PER_SEC", 262144), // bytes per second per client, extra dropped
    overLimitSecs: 5, // over the rate limit this many seconds in a row: close 4007
    idleMs: num("IDLE_MS", 1800000), // no binary frame for 30 min: close 4006
    roomMaxAgeMs: num("ROOM_MAX_AGE_MS", 43200000), // rooms live 12 h at most: close 4006
    lobbyMaxAgeMs: num("LOBBY_MAX_AGE_MS", 900000), // rooms not locked after 15 min: close 4006
    pingMs: 30000, // heartbeat ping interval; no pong by the next ping: terminate
    tickMs: 1000, // how often counters reset and timeouts are checked
    trustProxy: env.TRUST_PROXY === "1", // take the address from Fly-Client-IP (set by Fly.io's proxy)
    dev: env.DEV === "1", // local work: also accept localhost pages and a missing Origin
    // Usage counters in Prometheus format on a separate port that is never public (off when unset).
    metricsPort: env.METRICS_PORT ? num("METRICS_PORT", 0) : null,
    metricsHost: env.METRICS_HOST || "::", // all addresses, so Fly.io's collector reaches it privately
    allowedOrigins: (env.ALLOWED_ORIGINS || "") // web pages allowed to connect; required unless dev
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
};

const CLOSE = {
    badRoom: [4000, "bad room code"],
    roomFull: [4001, "room full"],
    exists: [4002, "room exists"],
    noRoom: [4003, "no such room"],
    started: [4004, "game started"],
    relayFull: [4005, "relay full"],
    idle: [4006, "idle"],
    expired: [4006, "room expired"],
    tooFast: [4007, "too fast"],
};
const closeWith = (ws, [code, reason]) => ws.close(code, reason);

// Origins fail closed: only listed pages may connect. Dev mode also lets in
// pages served from this machine, and tools that send no Origin header at all.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
function originAllowed(rules, origin) {
    if (origin && rules.allowedOrigins.includes(origin)) return true;
    if (!rules.dev) return false;
    if (!origin) return true;
    try {
        const u = new URL(origin);
        return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.includes(u.hostname);
    } catch (e) {
        return false;
    }
}

function sendText(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Send obj as text to everyone in the room except one id (0 = send to all).
function tellOthers(room, exceptId, obj) {
    for (const [id, cl] of room.clients) {
        if (id !== exceptId) sendText(cl.ws, obj);
    }
}

// Start the relay; returns the http server so tests can close it.
// overrides replaces any RULES entries for this server only.
function start(host, port, onListening, overrides) {
    const rules = Object.assign({}, RULES, overrides);
    const rooms = new Map(); // room code -> room; a room exists only while someone is in it
    const perIp = new Map(); // address -> live connection count (nothing else kept)
    let total = 0; // live clients on the whole relay
    // Running totals since this process started. Numbers only: no addresses, room codes or players.
    const counts = { roomsCreated: 0, roomsJoined: 0, matchesStarted: 0 };

    const logCounts = () => console.log(`rooms: ${rooms.size}, clients: ${total}`);

    function clientIp(req) {
        // Fly.io's proxy overwrites Fly-Client-IP, so a client cannot fake it. X-Forwarded-For is not
        // used: a client can put any address at the front of it and dodge the per-address limit.
        const fly = req.headers["fly-client-ip"];
        if (rules.trustProxy && fly) return fly.trim();
        return req.socket.remoteAddress || "";
    }

    // A client text frame may only be exactly {"t":"lock"}: the game has started.
    function onText(room, data) {
        if (data.length > rules.maxText || room.started) return;
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            return;
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
        if (Object.keys(msg).length !== 1 || msg.t !== "lock") return;
        room.started = true;
        counts.matchesStarted++;
        tellOthers(room, 0, { t: "locked" });
    }

    function onConnection(ws, req) {
        // Room code and mode come from the query string: /?room=CODE&mode=create|join
        const query = new URL(req.url, "http://x").searchParams;
        const raw = query.get("room") || "";
        if (!rules.roomCode.test(raw)) return closeWith(ws, CLOSE.badRoom);
        const code = raw.toUpperCase(); // codes are case-insensitive
        const mode = query.get("mode"); // none = join-or-create
        let room = rooms.get(code);

        // Refusals, checked in order.
        if (mode === "create" && room) return closeWith(ws, CLOSE.exists);
        if (mode === "join" && !room) return closeWith(ws, CLOSE.noRoom);
        if (room && room.started) return closeWith(ws, CLOSE.started);
        if (room && (room.clients.size >= rules.maxClients || room.nextId > rules.maxId))
            return closeWith(ws, CLOSE.roomFull);
        if (!room && rooms.size >= rules.maxRooms) return closeWith(ws, CLOSE.relayFull);
        if (total >= rules.maxTotalClients) return closeWith(ws, CLOSE.relayFull);
        const ip = clientIp(req);
        if ((perIp.get(ip) || 0) >= rules.maxPerIp) return closeWith(ws, CLOSE.relayFull);

        if (!room) {
            room = { clients: new Map(), nextId: 1, started: false, createdAt: Date.now() };
            rooms.set(code, room);
            counts.roomsCreated++;
        }
        total++;
        perIp.set(ip, (perIp.get(ip) || 0) + 1);

        const id = room.nextId++;
        const peers = [...room.clients.keys()];
        // Per-client state: rate counters for this tick and the idle clock.
        const cl = { ws, msgs: 0, bytes: 0, over: false, overTicks: 0, lastBinary: Date.now() };
        room.clients.set(id, cl);
        if (room.clients.size === 2 && !room.joined) {
            room.joined = true; // count each room once, however many players come and go
            counts.roomsJoined++;
        }
        sendText(ws, { t: "hello", id, peers });
        tellOthers(room, id, { t: "join", id });
        logCounts();

        ws.on("message", (data, isBinary) => {
            // Rate limit: every frame counts; frames over the limit are dropped.
            cl.msgs++;
            cl.bytes += data.length;
            if (cl.msgs > rules.msgsPerSec || cl.bytes > rules.bytesPerSec) {
                cl.over = true;
                return;
            }
            if (!isBinary) return onText(room, data);
            cl.lastBinary = Date.now();
            if (data.length < 2 || data.length > rules.maxFrame) return; // empty or too big
            const dest = data[0];
            // Outgoing frame: byte 0 = sender id, then the payload unchanged.
            const out = Buffer.from(data);
            out[0] = id;
            if (dest === 0) {
                for (const [peerId, peer] of room.clients) {
                    if (peerId !== id && peer.ws.readyState === ws.OPEN) peer.ws.send(out);
                }
            } else {
                const peer = room.clients.get(dest);
                if (peer && dest !== id && peer.ws.readyState === ws.OPEN) peer.ws.send(out);
            }
        });

        ws.on("close", () => {
            room.clients.delete(id);
            total--;
            const left = perIp.get(ip) - 1;
            if (left > 0) perIp.set(ip, left);
            else perIp.delete(ip);
            tellOthers(room, id, { t: "leave", id });
            // An expired room is already gone from the map; do not delete a newer one.
            if (room.clients.size === 0 && rooms.get(code) === room) rooms.delete(code);
            logCounts();
        });
    }

    // Plain HTTP: only GET /health is served; everything else is WebSocket only.
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && new URL(req.url, "http://x").pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: total }));
        }
        res.writeHead(426);
        res.end();
    });

    // Origin check happens before the upgrade: refuse with HTTP 403.
    const verifyClient = (info, done) => {
        done(originAllowed(rules, info.origin), 403, "Forbidden");
    };
    const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient });
    wss.on("connection", (ws, req) => {
        ws.isAlive = true;
        ws.on("pong", () => (ws.isAlive = true));
        onConnection(ws, req);
    });
    server.wss = wss;

    // Every tick: reset rate counters, close clients too fast or idle, expire old rooms.
    // A room whose match never started (not locked) expires sooner, freeing its slot.
    const tick = setInterval(() => {
        const now = Date.now();
        for (const [code, room] of rooms) {
            const age = now - room.createdAt;
            if (age > rules.roomMaxAgeMs || (!room.started && age > rules.lobbyMaxAgeMs)) {
                rooms.delete(code);
                for (const cl of room.clients.values()) closeWith(cl.ws, CLOSE.expired);
                continue;
            }
            for (const cl of room.clients.values()) {
                cl.overTicks = cl.over ? cl.overTicks + 1 : 0;
                cl.over = false;
                cl.msgs = 0;
                cl.bytes = 0;
                if (cl.overTicks >= rules.overLimitSecs) closeWith(cl.ws, CLOSE.tooFast);
                else if (now - cl.lastBinary > rules.idleMs) closeWith(cl.ws, CLOSE.idle);
            }
        }
    }, rules.tickMs);

    // Heartbeat: ping everyone; anyone who missed the previous ping is cut off.
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) ws.terminate();
            else {
                ws.isAlive = false;
                ws.ping();
            }
        }
    }, rules.pingMs);
    server.on("close", () => {
        clearInterval(tick);
        clearInterval(heartbeat);
    });

    // Metrics: GET /metrics only, on its own port, which fly.toml does not publish.
    if (rules.metricsPort !== null && rules.metricsPort !== undefined) {
        const metric = (name, help, value) =>
            `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
        server.metrics = http.createServer((req, res) => {
            if (req.method !== "GET" || new URL(req.url, "http://x").pathname !== "/metrics") {
                res.writeHead(404);
                return res.end();
            }
            res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
            res.end(
                metric("relay_rooms_created_total", "Rooms created since the relay started.", counts.roomsCreated) +
                    metric("relay_rooms_joined_total", "Rooms a second player joined.", counts.roomsJoined) +
                    metric("relay_matches_started_total", "Matches started (rooms locked).", counts.matchesStarted)
            );
        });
        server.metrics.listen(rules.metricsPort, rules.metricsHost, () =>
            console.log(`metrics listening on port ${server.metrics.address().port}`)
        );
        server.on("close", () => server.metrics.close());
    }

    server.listen(port, host, () => {
        console.log(`relay listening on ${host}:${server.address().port}`);
        if (onListening) onListening(server);
    });
    return server;
}

module.exports = { start, RULES };

if (require.main === module) {
    // Refuse to run in public with no origin list: anyone's page could connect.
    if (!RULES.dev && RULES.allowedOrigins.length === 0) {
        console.error("relay: set ALLOWED_ORIGINS to the site's origin(s), or DEV=1 for local work");
        process.exit(1);
    }
    const server = start(env.HOST || "127.0.0.1", num("PORT", 8002));
    // On SIGTERM/SIGINT: tell every client "going away" (1001), then exit.
    const stop = () => {
        for (const ws of server.wss.clients) ws.close(1001, "shutting down");
        server.close();
        setTimeout(() => process.exit(0), 200);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
}
