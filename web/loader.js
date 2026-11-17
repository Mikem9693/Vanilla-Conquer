// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Loader for the browser build of Vanilla Red Alert.
 *
 * Gets the game data (from the hosted pack, or files the player picks), checks
 * each file's size and SHA-256 against loader-config.json, keeps it in
 * IndexedDB for later visits, copies it into the game's in-memory file system
 * and starts the game when Play is clicked.
 *
 * Page contract: this script uses only these element IDs, so the page can be
 * redesigned freely as long as they exist.
 *   play       <button>          starts the game; disabled until data is ready
 *   progress   <progress>        download progress; hidden when idle
 *   status     any text element  messages; data-state = working | ready | error
 *   own-files  <input type=file multiple>  player-supplied data files
 *   clear-data <button>          deletes the saved data
 *   canvas     <canvas tabindex=-1>        the game screen
 *
 * Multiplayer: once loader-config.json is read, this calls
 * window.vcMultiplayerInit(config, Module) from multiplayer.js, which owns the mp-* elements.
 */
"use strict";

(function () {
    var el = function (id) { return document.getElementById(id); };
    var playBtn = el("play"), progress = el("progress"), status = el("status");
    var ownInput = el("own-files"), clearBtn = el("clear-data"), canvas = el("canvas");
    // Wired here rather than in the HTML, so the Content Security Policy needs no inline script.
    el("fullscreen").addEventListener("click", function () { Module.requestFullscreen(false, false); });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    var DB_NAME = "vanillara-data", STORE = "files", MANIFEST = "manifest";
    var INI = "[Video]\nWindowed=yes\n\n[Mouse]\nRawInput=no\n\n[Intro]\nPlayIntro=no\n\n" +
              "[Options]\nMultiplayerScoreVolume=0.25\n";

    var config = null;       // loader-config.json
    var db = null;           // open IndexedDB, or null if unavailable
    var data = null;         // verified file records ready for the game
    var written = [];        // names already written into the game's file system
    var runtimeReady = false, started = false;
    var job = 0;             // bumped when a new data route starts, so old ones stop
    var pick = 0;            // bumped for each own-files pick, so an older pick stops
    var prepared = false;    // the game's file system holds the current data
    var download = null;     // AbortController of the running download

    function setStatus(text, state) {
        status.textContent = text;
        status.setAttribute("data-state", state);
    }

    // The game program. It compiles while the data arrives; main() waits for Play.
    window.Module = {
        canvas: canvas,
        noInitialRun: true,
        print: function (t) { console.log(t); },
        printErr: function (t) { console.error(t); },
        onRuntimeInitialized: function () { runtimeReady = true; prepareGame(); },
        onAbort: function (what) { setStatus("The game stopped with an error: " + what + ". Please reload.", "error"); }
    };
    var script = document.createElement("script");
    script.src = "vanillara.js";
    script.onerror = function () { setStatus("Could not load the game program. Please reload.", "error"); };
    document.body.appendChild(script);

    // ---- small helpers ----

    function request(r) {
        return new Promise(function (ok, fail) {
            r.onsuccess = function () { ok(r.result); };
            r.onerror = function () { fail(r.error); };
        });
    }

    function openDb() {
        var r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: "id" }); };
        r.addEventListener("success", function () {
            // Let "clear data" in another tab delete the database instead of waiting on us.
            r.result.onversionchange = function () { r.result.close(); if (db === r.result) db = null; };
        });
        return request(r);
    }

    async function sha256(blob) {
        var hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return Array.from(new Uint8Array(hash), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    function mb(bytes) { return (bytes / 1048576).toFixed(1) + " MB"; }

    // Every file the config accepts, with its id prefix ("pack" or the disc label).
    function knownFiles() {
        return config.files.map(function (f) { return Object.assign({ label: "pack" }, f); })
            .concat(config.ownFiles || []);
    }

    // ---- IndexedDB ----

    async function loadStored() {
        if (!db) return null;
        var store = db.transaction(STORE).objectStore(STORE);
        var man = await request(store.get(MANIFEST));
        if (!man) return null;
        var recs = await Promise.all(man.ids.map(function (id) { return request(store.get(id)); }));
        if (recs.some(function (r) { return !r; })) return null;
        if (man.source === "hosted") return man.packVersion === config.packVersion ? recs : null;
        var known = knownFiles();
        var allKnown = recs.every(function (r) {
            return known.some(function (k) { return k.name === r.fsName && k.size === r.size && k.sha256 === r.sha256; });
        });
        return allKnown ? recs : null;
    }

    // Returns true if saved. Old data is replaced in the same transaction.
    async function save(recs, source) {
        if (!db) return false;
        try {
            var tx = db.transaction(STORE, "readwrite");
            var store = tx.objectStore(STORE);
            store.clear();
            recs.forEach(function (r) { store.put(r); });
            store.put({ id: MANIFEST, source: source, packVersion: config.packVersion,
                        ids: recs.map(function (r) { return r.id; }) });
            await new Promise(function (ok, fail) {
                tx.oncomplete = ok;
                tx.onerror = tx.onabort = function () { fail(tx.error); };
            });
        } catch (e) {
            console.warn("Saving game data failed:", e);
            return false;
        }
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(function (p) { console.log("Persistent storage granted:", p); });
        }
        return true;
    }

    // ---- hosted route ----

    async function downloadPack(myJob) {
        download = new AbortController();
        var total = config.files.reduce(function (s, f) { return s + f.size; }, 0), done = 0;
        progress.max = total;
        progress.value = 0;
        progress.hidden = false;
        var recs = [];
        try {
            for (var f of config.files) {
                setStatus("Downloading game data (" + mb(total) + ")...", "working");
                var resp = await fetch(config.dataBaseUrl + f.name, { signal: download.signal });
                if (!resp.ok) throw new Error("The server answered " + resp.status + " for " + f.name + ".");
                var reader = resp.body.getReader(), chunks = [], got = 0;
                for (;;) {
                    var part = await reader.read();
                    if (part.done) break;
                    got += part.value.length;
                    if (got > f.size) {
                        reader.cancel();
                        throw new Error(f.name + " is larger than expected.");
                    }
                    chunks.push(part.value);
                    progress.value = done + got;
                }
                if (got !== f.size) throw new Error(f.name + " is smaller than expected.");
                done += got;
                var blob = new Blob(chunks);
                setStatus("Checking " + f.name + "...", "working");
                if (await sha256(blob) !== f.sha256) throw new Error(f.name + " is damaged (its checksum does not match).");
                recs.push({ id: "pack:" + f.name, fsName: f.name, size: f.size, sha256: f.sha256, blob: blob });
            }
        } catch (e) {
            if (myJob !== job) return;  // the player picked own files instead
            console.error(e);
            setStatus("Downloading the game data failed: " + e.message +
                      " Please reload the page to try again, or use your own Red Alert files.", "error");
            return;
        } finally {
            progress.hidden = true;
        }
        if (myJob !== job) return;
        useData(recs, await save(recs, "hosted"));
    }

    // ---- own files route ----

    async function pickOwnFiles(files) {
        if (started) { setStatus("The game is already running. Reload the page to use other files.", "ready"); return; }
        // Keep any running download and ready data until the picked files pass the checks.
        var myPick = ++pick, stale = function () { return myPick !== pick; };
        playBtn.disabled = true;
        var fail = function (msg) {
            var keep = prepared ? " The game data you had before is still ready." : "";
            setStatus(msg + " Nothing was saved." + keep, "error");
            playBtn.disabled = !prepared;
        };
        var known = knownFiles(), picked = {}, notes = [];
        for (var file of files) {
            var name = file.name.toUpperCase();
            if (!known.some(function (k) { return k.name === name; })) { notes.push(file.name + " is not needed and was ignored."); continue; }
            if (picked[name]) return fail("You picked more than one " + name + ". Please pick only one.");
            picked[name] = file;
        }
        if (!picked["MAIN.MIX"] || !picked["REDALERT.MIX"]) return fail("Please pick both MAIN.MIX and REDALERT.MIX.");

        var recs = [];
        async function check(name) {
            var file = picked[name];
            setStatus("Checking " + name + " (" + mb(file.size) + ")...", "working");
            var hash = await sha256(file);
            var entry = known.find(function (k) { return k.name === name && k.size === file.size && k.sha256 === hash; });
            if (entry) recs.push({ id: entry.label + ":" + name, fsName: name, size: file.size, sha256: hash, blob: file });
            else fail(name + " is not a known Red Alert file (SHA-256 " + hash + ").");
            return entry;
        }
        try {
            var main = await check("MAIN.MIX");
            if (!main || stale() || !await check("REDALERT.MIX") || stale()) return;
            if (main.label === "pack") {
                if (!picked["SCORES.MIX"]) return fail("This MAIN.MIX needs SCORES.MIX too. Please pick all three.");
                if (!await check("SCORES.MIX") || stale()) return;
            } else if (picked["SCORES.MIX"]) {
                notes.push("SCORES.MIX is not needed with a full disc MAIN.MIX and was ignored.");
            }
        } catch (e) {
            console.error(e);
            return fail("Could not read your files: " + e.message);
        }
        var myJob = ++job;  // verified: now replace the download or older data
        if (download) download.abort();
        prepared = false;
        var saved = await save(recs, "own");
        if (myJob !== job) return;
        useData(recs, saved, notes);
    }

    // ---- start the game ----

    function useData(recs, saved, notes) {
        data = recs;
        var msg = "Game data is ready. Click Play.";
        if (!saved) msg += " It could not be saved in this browser, so it will be needed again on your next visit.";
        if (notes && notes.length) msg += " " + notes.join(" ");
        setStatus(msg, "ready");
        prepareGame();
    }

    // Once the program is loaded and the data is ready, write the files and enable Play.
    async function prepareGame() {
        if (!runtimeReady || !data || started) return;
        var recs = data, myJob = job, files = [];
        for (var r of recs) files.push([r.fsName.toUpperCase(), new Uint8Array(await r.blob.arrayBuffer())]);
        if (myJob !== job || recs !== data || started) return;
        var FS = Module.FS;
        written.forEach(function (n) { try { FS.unlink("/" + n); } catch (e) {} });
        written = files.map(function (f) { return f[0]; });
        // canOwn lets the file system keep our bytes instead of copying them.
        files.forEach(function (f) { FS.writeFile("/" + f[0], f[1], { canOwn: true }); });
        FS.writeFile("/REDALERT.INI", INI);
        prepared = true;
        playBtn.disabled = false;
    }

    playBtn.addEventListener("click", function () {
        if (started || playBtn.disabled) return;
        started = true;
        playBtn.disabled = true;
        ownInput.disabled = true;
        setStatus("Game running.", "ready");
        // style.css hides the page and shows the canvas. Done first: a hidden canvas can't take focus,
        // and SDL should see a visible canvas when it starts.
        document.body.classList.add("is-playing");
        canvas.focus();
        Module.callMain([]);
    });

    ownInput.addEventListener("change", function () {
        if (config && ownInput.files.length) pickOwnFiles(Array.from(ownInput.files));
    });

    clearBtn.addEventListener("click", function () {
        if (db) { db.close(); db = null; }
        if (window.indexedDB) indexedDB.deleteDatabase(DB_NAME);
        if (!started) {
            ++job;
            if (download) download.abort();
            data = null;
            prepared = false;
            playBtn.disabled = true;
        }
        var again = config && config.dataSource === "hosted" ? "fetched again" : "needed again";
        setStatus("Saved game data was cleared. It will be " + again + " on your next visit.", started ? "ready" : "working");
    });

    // ---- startup ----

    async function init() {
        playBtn.disabled = true;
        progress.hidden = true;
        if (!window.crypto || !crypto.subtle) {
            return setStatus("This browser cannot check the game files (the page must be opened over https or " +
                             "from localhost). Please use a current browser.", "error");
        }
        try {
            var resp = await fetch("loader-config.json", { cache: "no-cache" });
            if (!resp.ok) throw new Error("status " + resp.status);
            config = await resp.json();
        } catch (e) {
            return setStatus("Could not load the loader settings (" + e.message + "). Please reload.", "error");
        }
        if (window.vcMultiplayerInit) window.vcMultiplayerInit(config, Module);
        try {
            if (window.indexedDB) db = await openDb();
        } catch (e) {
            console.warn("IndexedDB unavailable:", e);
        }
        var stored = null;
        try { stored = await loadStored(); } catch (e) { console.warn("Reading saved data failed:", e); }
        if (stored) return useData(stored, true);
        var noSave = db ? "" : " This browser cannot save it, so it will be needed again on your next visit.";
        if (config.dataSource === "hosted") return downloadPack(job);
        setStatus("Pick your Red Alert files below: MAIN.MIX and REDALERT.MIX from the disc." + noSave, "working");
    }

    init();
})();
