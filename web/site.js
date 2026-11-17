// SPDX-License-Identifier: GPL-3.0-or-later
// Classic RTS site behaviour: accessible tabs, and Enter to start the game.
// Kept separate from loader.js so the page works under a strict CSP.
(function () {
  "use strict";

  // Tabs: click, or arrow keys / Home / End when a tab has focus.
  document.querySelectorAll('[role="tablist"]').forEach(function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));

    function select(tab, moveFocus) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
      if (moveFocus) tab.focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        if (next !== null) {
          e.preventDefault();
          select(tabs[next], true);
        }
      });
    });
  });

  // While the game has focus, keys that would scroll the page don't. The events still reach the game
  // (SDL listens on the canvas); only the browser's default action is cancelled. Space is cancelled on
  // keypress, not keydown, so it still types in the game's text boxes.
  var canvas = document.getElementById("canvas");
  if (canvas) {
    var SCROLL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
    canvas.addEventListener("keydown", function (e) { if (SCROLL_KEYS.indexOf(e.key) >= 0) e.preventDefault(); });
    canvas.addEventListener("keypress", function (e) { if (e.key === " ") e.preventDefault(); });
  }

  // Enter starts the game, but only before it has started, and never while
  // the player is typing in a field or using another control.
  var play = document.getElementById("play");
  if (!play) return;

  function onKey(e) {
    if (e.key !== "Enter") return;
    if (document.body.classList.contains("is-playing")) { stop(); return; }
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, button, a")) return;
    if (play.disabled) return;
    e.preventDefault();
    play.click();
  }
  function stop() { document.removeEventListener("keydown", onKey); }

  document.addEventListener("keydown", onKey);
  play.addEventListener("click", stop);
})();
