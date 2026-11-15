// Stage A relay: makes each "room" behave like a LAN for browser players.
// Every player holds one WebSocket; the relay forwards each binary packet to
// one player or to everyone else in the room. It never looks inside payloads.
// Privacy: nothing personal is stored or logged (no IPs, room codes, payloads).

const http = require("http");
const { WebSocketServer } = require("ws");

// ---- Room rules: every limit lives here ----
const RULES = {
    maxClients: 8, // more than this live in one room: refuse with 4001
    maxId: 254, // ids run 1..254 and are never reused within a room
    maxFrame: 2048, // binary frames larger than this are dropped
    roomCode: /^[A-Za-z0-9]{4,32}$/,
};
const CLOSE_BAD_ROOM = 4000;
const CLOSE_ROOM_FULL = 4001;

// Room code -> room object. A room exists only while someone is in it.
const rooms = new Map();

function newRoom() {
    return {
        clients: new Map(), // id -> WebSocket
        nextId: 1,
        started: false, // unused for now (later: close joins at game start)
        createdAt: Date.now(), // unused for now (later: expire old rooms)
    };
}

// Decide whether a new client may join; returns a close code or 0 if allowed.
function joinRefusal(room) {
    if (room.clients.size >= RULES.maxClients) return CLOSE_ROOM_FULL;
    if (room.nextId > RULES.maxId) return CLOSE_ROOM_FULL;
    return 0;
}

function sendText(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Send obj as text to everyone in the room except one id.
function tellOthers(room, exceptId, obj) {
    for (const [id, ws] of room.clients) {
        if (id !== exceptId) sendText(ws, obj);
    }
}

function logCounts() {
    let clients = 0;
    for (const room of rooms.values()) clients += room.clients.size;
    console.log(`rooms: ${rooms.size}, clients: ${clients}`);
}

function onConnection(ws, req) {
    // Room code comes from the query string: ws://host:port/?room=CODE
    const code = new URL(req.url, "http://x").searchParams.get("room") || "";
    if (!RULES.roomCode.test(code)) return ws.close(CLOSE_BAD_ROOM, "bad room code");

    // Join-or-create (stage A rule).
    let room = rooms.get(code);
    if (!room) {
        room = newRoom();
        rooms.set(code, room);
    }
    const refusal = joinRefusal(room);
    if (refusal) {
        if (room.clients.size === 0) rooms.delete(code);
        return ws.close(refusal, "room full");
    }

    const id = room.nextId++;
    const peers = [...room.clients.keys()];
    room.clients.set(id, ws);
    sendText(ws, { t: "hello", id, peers });
    tellOthers(room, id, { t: "join", id });
    logCounts();

    ws.on("message", (data, isBinary) => {
        if (!isBinary) return; // text from clients is ignored
        if (data.length < 2 || data.length > RULES.maxFrame) return; // empty or too big
        const dest = data[0];
        // Outgoing frame: byte 0 = sender id, then the payload unchanged.
        const out = Buffer.from(data);
        out[0] = id;
        if (dest === 0) {
            for (const [peerId, peer] of room.clients) {
                if (peerId !== id && peer.readyState === peer.OPEN) peer.send(out);
            }
        } else {
            const peer = room.clients.get(dest);
            if (peer && dest !== id && peer.readyState === peer.OPEN) peer.send(out);
        }
    });

    ws.on("close", () => {
        room.clients.delete(id);
        tellOthers(room, id, { t: "leave", id });
        if (room.clients.size === 0) rooms.delete(code);
        logCounts();
    });
}

// Start the relay; returns the http server so tests can close it.
function start(host, port, onListening) {
    const server = http.createServer((req, res) => {
        res.writeHead(426); // plain HTTP is not served; WebSocket only
        res.end();
    });
    const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
    wss.on("connection", onConnection);
    server.listen(port, host, () => {
        console.log(`relay listening on ${host}:${port}`);
        if (onListening) onListening(server);
    });
    return server;
}

module.exports = { start, RULES };

if (require.main === module) {
    start(process.env.HOST || "127.0.0.1", Number(process.env.PORT) || 8002);
}
