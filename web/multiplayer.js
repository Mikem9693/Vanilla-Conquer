// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Multiplayer panel for the browser build of Vanilla Red Alert.
 *
 * Connects to the relay (a small WebSocket server that makes each room act like
 * a LAN) and hands the open socket to the game, which uses it when the player
 * picks Multiplayer Game > Network. Works before or after Play and data loading.
 *
 * Settings (loader-config.json): "multiplayer": "on" | "off" (off: panel hidden,
 * nothing connects); "relayUrl": "" means ws(s)://<page hostname>:8002. A ws://
 * relayUrl is refused on an https page (browsers block unencrypted sockets there).
 * If the socket fails before opening, one no-cors fetch of the relay's /health
 * tells "server down" from "server up but this site's origin not allowed".
 *
 * Page contract: this script uses only these element IDs.
 *   mp-panel   container; hidden when multiplayer is off
 *   mp-create  <button>          creates a room with a new code
 *   mp-code    <input type=text> room code to join
 *   mp-join    <button>          joins the room in mp-code
 *   mp-leave   <button>          leaves the room; hidden when not in a room
 *   mp-link    <input readonly>  invite link; hidden when not in a room
 *   mp-copy    <button>          copies the invite link; hidden with mp-link
 *   mp-status  text; data-state = idle | working | ready | error
 *   mp-notice  text; hidden-tab notice
 *
 * Game contract: Module.vcnetPre = { ws, id, room } while in a room (deleted on
 * close or leave); the game calls Module.onNetGameStart() when a match starts.
 * Only addEventListener is used on the socket: the game adds its own listeners.
 */
"use strict";

window.vcMultiplayerInit = function (config, Module) {
    var el = function (id) { return document.getElementById(id); };
    var panel = el("mp-panel"), createBtn = el("mp-create"), codeIn = el("mp-code"), joinBtn = el("mp-join");
    var leaveBtn = el("mp-leave"), link = el("mp-link"), copyBtn = el("mp-copy");
    var status = el("mp-status"), notice = el("mp-notice");
    if (!panel || window.vcMultiplayerInit.done) return;
    window.vcMultiplayerInit.done = true;
    if (!config || config.multiplayer !== "on") { panel.hidden = true; return; }
    panel.hidden = false;

    var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", CODE_RE = /^[A-Z0-9]{4,32}$/;
    var IDLE = "Not in a room. Create a game, or enter a code and join.";
    var WARN = "Keep this tab visible during a match. If it is hidden for more than about 30 seconds " +
               "the game slows down for everyone.";
    var CLOSE = {
        4000: "That room code is not valid. Codes are 4 to 32 letters or digits.",
        4001: "That room is full (8 players).",
        4002: "A room with that code already exists. Please try again.",
        4003: "There is no room with that code. Check the code, or create a new game.",
        4004: "The game in that room has already started, so it is closed to new players.",
        4005: "The multiplayer server is full right now. Please try again in a few minutes.",
        4006: "The connection was closed because nothing was sent for too long.",
        4007: "The connection was closed because this browser sent data too fast."
    };
    var EXPIRED = "This room has closed: its match was not started in time, or it was open too long. " +
                  "The room no longer exists, so create a new game to play.";
    var ws = null, room = "", peers = 0, inRoom = false, locked = false, gameStarted = false, retried = false;
    var hiddenAt = 0, savedTitle = document.title;

    function setStatus(text, state) { status.textContent = text; status.setAttribute("data-state", state); }

    function relayBase() {
        if (config.relayUrl) return config.relayUrl.replace(/\/+$/, "");
        return (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":8002";
    }

    // A failed handshake hides its HTTP status, so ask /health whether the server is up at all.
    function probeRelay(done) {
        var ctl = window.AbortController ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 3000);
        var url;
        try { url = new URL(relayBase().replace(/^ws/i, "http")).origin + "/health"; } catch (e) { return done(false); }
        fetch(url, { mode: "no-cors", cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(
            function () { clearTimeout(timer); done(true); },
            function () { clearTimeout(timer); done(false); });
    }

    function newCode() {  // 256 is a multiple of 32, so x % 32 has no bias
        var b = new Uint8Array(6);
        crypto.getRandomValues(b);
        return Array.from(b, function (x) { return ALPHABET[x % 32]; }).join("");
    }

    function show() {
        leaveBtn.hidden = link.hidden = copyBtn.hidden = !inRoom;
        createBtn.disabled = joinBtn.disabled = codeIn.disabled = !!ws;
    }

    function roomText() {
        var n = peers + 1;
        var s = "In room " + room + ": " + n + (n === 1 ? " player" : " players") + " connected. ";
        if (locked) return s + "The game has started and the room is closed to new players.";
        return s + "Next: press Play, then Multiplayer Game > Network. One player chooses New; " +
               "the others join the listed game.";
    }

    function restoreTitle() {
        if (hiddenAt) { document.title = savedTitle; hiddenAt = 0; }
    }

    function dropped(sock) {
        if (Module.vcnetPre && Module.vcnetPre.ws === sock) delete Module.vcnetPre;
        restoreTitle();
    }

    function connect(mode, code) {
        room = code; peers = 0; inRoom = false; locked = false; gameStarted = false;
        if (location.protocol === "https:" && /^ws:\/\//i.test(config.relayUrl || "")) {
            ws = null; show();
            return setStatus("Multiplayer is not available: this secure (https) page cannot use the unencrypted " +
                             "(ws://) multiplayer server address in its settings. It needs a wss:// address.", "error");
        }
        setStatus((mode === "create" ? "Creating room " : "Joining room ") + code + "...", "working");
        var sock;
        try {
            sock = new WebSocket(relayBase() + "/?room=" + encodeURIComponent(code) + "&mode=" + mode);
        } catch (e) {
            ws = null; show();
            return setStatus("Could not reach the multiplayer server (" + e.message + ").", "error");
        }
        ws = sock;
        sock.binaryType = "arraybuffer";
        show();
        var opened = false;
        sock.addEventListener("open", function () { opened = true; });
        sock.addEventListener("message", function (ev) {
            if (sock !== ws || typeof ev.data !== "string") return;  // binary frames are game data
            var m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.t === "hello") {
                inRoom = true; retried = false;
                peers = Array.isArray(m.peers) ? m.peers.length : 0;
                Module.vcnetPre = { ws: sock, id: m.id, room: code };
                codeIn.value = code;
                link.value = location.origin + location.pathname + "?room=" + code;
            } else if (m.t === "join") peers++;
            else if (m.t === "leave") peers = Math.max(0, peers - 1);
            else if (m.t === "locked") locked = true;
            else return;
            show();
            setStatus(roomText(), "ready");
        });
        sock.addEventListener("close", function (ev) {
            if (sock !== ws) return;  // left on purpose, or replaced
            var was = inRoom;
            ws = null; inRoom = false;
            dropped(sock);
            if (ev.code === 4002 && mode === "create" && !retried) {
                retried = true;
                return connect("create", newCode());
            }
            retried = false;
            show();
            var msg = CLOSE[ev.code] || "";
            if (ev.code === 4006 && ev.reason === "room expired") msg = EXPIRED;
            else if (was) {
                msg += (msg ? " " : "") + "You are no longer connected to room " + code + ". You can join it again" +
                       (gameStarted ? "; if a match was running, go back to the game's main menu and choose Network again." : ".");
            } else if (!msg) {
                msg = "Could not connect to the multiplayer server. Check your connection and try again.";
                if (!opened) return probeRelay(function (up) {
                    if (ws) return;  // a new attempt has started
                    setStatus(up ? "The multiplayer server is running but did not accept this site. This is a " +
                                   "set-up problem with the site, not your connection: the site's address must be " +
                                   "on the multiplayer server's allowed list." : msg, "error");
                });
            }
            setStatus(msg, "error");
        });
    }

    function join() {
        if (ws) return;
        var code = codeIn.value.trim().toUpperCase();
        codeIn.value = code;
        if (!CODE_RE.test(code)) return setStatus("Enter a room code of 4 to 32 letters or digits.", "error");
        connect("join", code);
    }

    function leave() {
        var sock = ws;
        ws = null; inRoom = false; retried = false;
        if (sock) { dropped(sock); sock.close(1000); }
        show();
        setStatus(IDLE, "idle");
    }

    Module.onNetGameStart = function () {
        gameStarted = true;
        if (ws && inRoom && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "lock" }));
    };

    createBtn.addEventListener("click", function () {
        if (!ws) { retried = false; connect("create", newCode()); }
    });
    joinBtn.addEventListener("click", join);
    codeIn.addEventListener("keydown", function (e) { if (e.key === "Enter") join(); });
    // Keep keys typed in the panel's boxes away from the game's window-level keyboard listeners.
    ["keydown", "keyup", "keypress"].forEach(function (t) {
        [codeIn, link].forEach(function (box) { box.addEventListener(t, function (e) { e.stopPropagation(); }); });
    });
    leaveBtn.addEventListener("click", leave);
    copyBtn.addEventListener("click", function () {
        var done = function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
        };
        var fallback = function () {
            link.select();
            try { if (document.execCommand("copy")) done(); } catch (e) {}
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link.value).then(done, fallback);
        else fallback();
    });

    // Hidden-tab policy: notice only.
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            if (!inRoom || hiddenAt) return;
            hiddenAt = Date.now();
            savedTitle = document.title;
            document.title = "Come back! Your Red Alert match needs this tab";
        } else if (hiddenAt) {
            var secs = Math.round((Date.now() - hiddenAt) / 1000);
            restoreTitle();
            if (secs > 10) notice.textContent = "This tab was hidden for " + secs + " seconds. " + WARN;
        }
    });

    notice.textContent = WARN;
    show();
    setStatus(IDLE, "idle");
    var arrived = new URLSearchParams(location.search).get("room");
    if (arrived) { codeIn.value = arrived; join(); }
};
