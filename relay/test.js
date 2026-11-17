// SPDX-License-Identifier: GPL-3.0-or-later
// Self-test: starts the relay on spare ports and checks protocol v1.
// Run with: node test.js   (exits non-zero on any failure)

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { start } = require("./server");

let pass = 0;
let fail = 0;
function check(name, ok) {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start a relay with rule overrides; resolves to { server, port }.
// Dev mode by default, so test clients without an Origin header get in.
function listen(overrides) {
    const rules = Object.assign({ dev: true }, overrides);
    return new Promise((resolve) => {
        const server = start("127.0.0.1", 0, (srv) => resolve({ server, port: srv.address().port }), rules);
    });
}

// Connect a client and record everything it receives. Resolves on hello,
// close, or a refused upgrade (status holds the HTTP code).
function connect(port, room, extra = "", opts = {}) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}${extra}`, opts);
        const c = { ws, texts: [], bins: [], closeCode: null, status: null };
        ws.on("message", (data, isBinary) => {
            if (isBinary) c.bins.push(Buffer.from(data));
            else {
                const msg = JSON.parse(data.toString());
                c.texts.push(msg);
                if (msg.t === "hello") resolve(c);
            }
        });
        ws.on("close", (code) => {
            c.closeCode = code;
            resolve(c);
        });
        ws.on("unexpected-response", (req, res) => {
            c.status = res.statusCode;
            req.destroy();
            resolve(c);
        });
        ws.on("error", () => resolve(c));
    });
}

// Plain HTTP GET; resolves to { status, body }.
function get(port, urlPath) {
    return new Promise((resolve) => {
        http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
            let body = "";
            res.on("data", (d) => (body += d));
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
    });
}

const frame = (dest, text) => Buffer.concat([Buffer.from([dest]), Buffer.from(text)]);
const has = (c, id, text) => c.bins.some((b) => b[0] === id && b.subarray(1).toString() === text);
const closeAll = (list) => list.forEach((cl) => cl.ws.terminate());

// ---- Stage A protocol (unchanged rules) ----
async function protocol(port) {
    const a = await connect(port, "roomAAAA");
    const b = await connect(port, "roomAAAA");
    const c = await connect(port, "roomAAAA");
    const x = await connect(port, "roomBBBB");
    await sleep(100);

    check("hello ids 1,2,3 in room A", a.texts[0].id === 1 && b.texts[0].id === 2 && c.texts[0].id === 3);
    check("hello peers for third client", JSON.stringify(c.texts[0].peers) === "[1,2]");
    check("other room starts at id 1 with no peers", x.texts[0].id === 1 && x.texts[0].peers.length === 0);
    check("join sent to earlier clients", a.texts.some((m) => m.t === "join" && m.id === 3));
    check("no join leaks across rooms", x.texts.length === 1);

    a.ws.send(frame(3, "direct"));
    b.ws.send(frame(0, "bcast"));
    a.ws.send(frame(99, "nobody")); // unknown destination
    a.ws.send(Buffer.alloc(3000)); // too big
    a.ws.send("text is ignored");
    await sleep(100);

    check("directed send reaches target with sender id", has(c, 1, "direct"));
    check("directed send not seen by others", !has(b, 1, "direct"));
    check("broadcast reaches others", has(a, 2, "bcast") && has(c, 2, "bcast"));
    check("broadcast not echoed to sender", b.bins.length === 0);
    check("no binary leaks across rooms", x.bins.length === 0);
    check("unknown dest / oversize / text dropped", a.bins.length === 1 && c.bins.length === 2);

    b.ws.close();
    await sleep(100);
    check("leave sent to others", a.texts.some((m) => m.t === "leave" && m.id === 2));

    const bad = await connect(port, "ab!");
    check("bad room code closed with 4000", bad.closeCode === 4000);

    // Room A now holds 2 (ids 1,3). Add 6 more to reach 8, then the 9th fails.
    const extra = [];
    for (let i = 0; i < 6; i++) extra.push(await connect(port, "roomAAAA"));
    check("ids never reused (next ids 4..9)", extra.map((e) => e.texts[0].id).join() === "4,5,6,7,8,9");
    const ninth = await connect(port, "roomAAAA");
    check("9th client refused with 4001", ninth.closeCode === 4001);

    // ---- Stage B: modes, case, lock ----
    const dup = await connect(port, "roomaaaa", "&mode=create");
    check("create on existing room (any case) closed 4002", dup.closeCode === 4002);
    const none = await connect(port, "nosuchroom", "&mode=join");
    check("join missing room closed 4003", none.closeCode === 4003);
    const host = await connect(port, "lockROOM", "&mode=create");
    const guest = await connect(port, "LOCKroom", "&mode=join");
    check("create then join, codes case-insensitive", host.texts[0].id === 1 && guest.texts[0].id === 2);

    guest.ws.send('{"t":"lock","x":1}'); // extra key: ignored
    guest.ws.send(`{"t":"lock"}${" ".repeat(60)}`); // over 64 bytes: ignored
    await sleep(100);
    const notYet = await connect(port, "lockroom");
    check("other or long text does not lock", notYet.texts[0] && notYet.texts[0].id === 3);
    host.ws.send('{"t":"lock"}');
    host.ws.send('{"t":"lock"}');
    await sleep(100);
    const lockedCount = (cl) => cl.texts.filter((m) => m.t === "locked").length;
    check("lock sends locked once to all incl. sender", [host, guest, notYet].every((cl) => lockedCount(cl) === 1));
    const late = await connect(port, "lockroom");
    check("join after lock closed 4004", late.closeCode === 4004);

    // ---- /health ----
    const h = await get(port, "/health");
    const hj = JSON.parse(h.body);
    check("/health reports rooms and clients", h.status === 200 && hj.ok && hj.rooms === 3 && hj.clients === 12);
    check("other plain HTTP is 426", (await get(port, "/")).status === 426);

    closeAll([a, c, x, host, guest, notYet, ...extra]);
    await sleep(100);
}

// ---- Stage B: limits, each on its own small server ----
async function limits() {
    let s = await listen({ maxRooms: 1 });
    let r1 = await connect(s.port, "room1111");
    let r2 = await connect(s.port, "room2222");
    let r3 = await connect(s.port, "room1111");
    check("MAX_ROOMS: new room over limit 4005, existing room ok", r2.closeCode === 4005 && r3.texts.length > 0);
    closeAll([r1, r3]);
    s.server.close();

    s = await listen({ maxTotalClients: 2 });
    r1 = await connect(s.port, "room1111");
    r2 = await connect(s.port, "room2222");
    r3 = await connect(s.port, "room1111");
    check("MAX_CLIENTS: third client 4005", r3.closeCode === 4005);
    closeAll([r1, r2]);
    s.server.close();

    s = await listen({ maxPerIp: 2, trustProxy: true });
    const ipA = { headers: { "X-Forwarded-For": "10.0.0.1, 10.9.9.9" } };
    r1 = await connect(s.port, "room1111", "", ipA);
    r2 = await connect(s.port, "room1111", "", ipA);
    r3 = await connect(s.port, "room1111", "", ipA);
    const r4 = await connect(s.port, "room1111", "", { headers: { "X-Forwarded-For": "10.0.0.2" } });
    check("MAX_PER_IP: third from one address 4005, other address ok", r3.closeCode === 4005 && r4.texts.length > 0);
    closeAll([r1, r2, r4]);
    s.server.close();

    s = await listen({ msgsPerSec: 2, tickMs: 100, overLimitSecs: 3 });
    let tx = await connect(s.port, "rateroom");
    let rx = await connect(s.port, "rateroom");
    for (let i = 0; i < 5; i++) tx.ws.send(frame(0, "m" + i));
    await sleep(50);
    check("MSGS_PER_SEC: frames over limit dropped", rx.bins.length === 2);
    for (let i = 0; i < 10 && tx.closeCode === null; i++) {
        for (let j = 0; j < 5; j++) if (tx.ws.readyState === WebSocket.OPEN) tx.ws.send(frame(0, "x"));
        await sleep(60);
    }
    await sleep(100);
    check("over rate limit for N ticks in a row closed 4007", tx.closeCode === 4007 && rx.closeCode === null);
    closeAll([rx]);
    s.server.close();

    s = await listen({ bytesPerSec: 100, tickMs: 5000 });
    tx = await connect(s.port, "byteroom");
    rx = await connect(s.port, "byteroom");
    for (let i = 0; i < 3; i++) tx.ws.send(frame(0, "y".repeat(59)));
    await sleep(100);
    check("BYTES_PER_SEC: bytes over limit dropped", rx.bins.length === 1);
    closeAll([tx, rx]);
    s.server.close();

    s = await listen({ idleMs: 300, tickMs: 100 });
    const quiet = await connect(s.port, "idleroom");
    const busy = await connect(s.port, "idleroom");
    for (let i = 0; i < 6; i++) {
        busy.ws.send(frame(1, "k"));
        await sleep(100);
    }
    check("IDLE_MS: silent client closed 4006, busy one kept", quiet.closeCode === 4006 && busy.closeCode === null);
    closeAll([busy]);
    s.server.close();

    s = await listen({ roomMaxAgeMs: 300, tickMs: 100 });
    r1 = await connect(s.port, "oldroom1");
    r2 = await connect(s.port, "oldroom1");
    await sleep(600);
    check("ROOM_MAX_AGE_MS: everyone closed 4006", r1.closeCode === 4006 && r2.closeCode === 4006);
    s.server.close();

    s = await listen({ lobbyMaxAgeMs: 300, tickMs: 100 });
    const lobby = await connect(s.port, "lobbyroom");
    const match = await connect(s.port, "matchroom");
    match.ws.send('{"t":"lock"}');
    await sleep(600);
    check("LOBBY_MAX_AGE_MS: unlocked room closed 4006, locked room kept", lobby.closeCode === 4006 && match.closeCode === null);
    closeAll([match]);
    s.server.close();

    s = await listen({ pingMs: 100 });
    const deaf = await connect(s.port, "pingroom");
    const live = await connect(s.port, "pingroom");
    deaf.ws._socket.pause(); // stops reading, so it never answers pings
    await sleep(450);
    const hb = JSON.parse((await get(s.port, "/health")).body);
    check("heartbeat: silent client terminated, answering one kept", hb.clients === 1 && live.closeCode === null);
    closeAll([deaf, live]);
    s.server.close();

    s = await listen({ dev: false, allowedOrigins: ["https://ok.example"] });
    const evil = await connect(s.port, "origroom", "", { origin: "https://bad.example" });
    const good = await connect(s.port, "origroom", "", { origin: "https://ok.example" });
    const bare = await connect(s.port, "origroom");
    const local = await connect(s.port, "origroom", "", { origin: "http://localhost:8000" });
    check("ALLOWED_ORIGINS: unlisted origin gets 403, listed one joins", evil.status === 403 && good.texts.length > 0);
    check("not dev: missing origin and localhost get 403", bare.status === 403 && local.status === 403);
    closeAll([good]);
    s.server.close();

    s = await listen({ dev: true, allowedOrigins: [] });
    const lh = await connect(s.port, "devroom1", "", { origin: "http://localhost:8000" });
    const lo = await connect(s.port, "devroom1", "", { origin: "http://127.0.0.1:8000" });
    const v6 = await connect(s.port, "devroom1", "", { origin: "http://[::1]:8000" });
    const far = await connect(s.port, "devroom1", "", { origin: "https://bad.example" });
    check("dev: localhost, 127.0.0.1 and [::1] join", [lh, lo, v6].every((cl) => cl.texts.length > 0));
    check("dev: other origin still gets 403", far.status === 403);
    closeAll([lh, lo, v6]);
    s.server.close();
}

// ---- SIGTERM: run the real server as a child process ----
function signals() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
            env: Object.assign({}, process.env, { PORT: "0", DEV: "1" }),
        });
        let client = null;
        child.stdout.on("data", async (d) => {
            const m = /listening on [\d.]+:(\d+)/.exec(d.toString());
            if (!m || client) return;
            client = await connect(Number(m[1]), "sigroom1");
            child.kill("SIGTERM");
        });
        child.on("exit", async (code) => {
            await sleep(100);
            check("SIGTERM closes clients 1001 and exits 0", code === 0 && client && client.closeCode === 1001);
            resolve();
        });
    });
}

// Run directly with no DEV and no ALLOWED_ORIGINS: must refuse to start.
function refusesOpen() {
    return new Promise((resolve) => {
        const env = Object.assign({}, process.env, { PORT: "0" });
        delete env.DEV;
        delete env.ALLOWED_ORIGINS;
        const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("exit", (code) => {
            check("no ALLOWED_ORIGINS outside dev: exits 1 with a message", code === 1 && /ALLOWED_ORIGINS/.test(err));
            resolve();
        });
    });
}

(async () => {
    try {
        const main = await listen();
        await protocol(main.port);
        main.server.close();
        await limits();
        await signals();
        await refusesOpen();
    } catch (e) {
        console.log("FAIL exception:", e.message);
        fail++;
    }
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
