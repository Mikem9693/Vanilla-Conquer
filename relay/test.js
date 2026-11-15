// Self-test: starts the relay on a spare port and checks protocol v0.
// Run with: node test.js   (exits non-zero on any failure)

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

// Connect a client and record everything it receives.
function connect(port, room) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}`);
        const c = { ws, texts: [], bins: [], closeCode: null };
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
    });
}

const frame = (dest, text) => Buffer.concat([Buffer.from([dest]), Buffer.from(text)]);
const has = (c, id, text) => c.bins.some((b) => b[0] === id && b.subarray(1).toString() === text);

async function main(port) {
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

    for (const cl of [a, c, x, ...extra]) cl.ws.close();
    await sleep(100);
}

const server = start("127.0.0.1", 0, async (srv) => {
    try {
        await main(srv.address().port);
    } catch (e) {
        console.log("FAIL exception:", e.message);
        fail++;
    }
    console.log(`${pass} passed, ${fail} failed`);
    server.close();
    process.exit(fail ? 1 : 0);
});
