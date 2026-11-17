#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Local stand-in for the hosted data store (Cloudflare R2). Serves only the
# files directly inside one folder, under one URL prefix, with a CORS header
# so the game page on another port may fetch them.
#
# Usage:
#   python3 scripts/serve-pack.py ~/ra-data/skirmish [/packs/skirmish-v1/] [8001] [http://localhost:8000]

import http.server
import os
import shutil
import sys
import urllib.parse

folder = os.path.realpath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "."))
prefix = sys.argv[2] if len(sys.argv) > 2 else "/packs/skirmish-v1/"
port = int(sys.argv[3]) if len(sys.argv) > 3 else 8001
origin = sys.argv[4] if len(sys.argv) > 4 else "http://localhost:8000"
if not prefix.endswith("/"):
    prefix += "/"


class Handler(http.server.BaseHTTPRequestHandler):
    def find(self):
        # Return the file path, or None. Only plain names directly in the folder.
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if not path.startswith(prefix):
            return None
        name = path[len(prefix):]
        if not name or "/" in name or "\\" in name or name in (".", ".."):
            return None
        full = os.path.join(folder, name)
        if os.path.dirname(os.path.realpath(full)) != folder or not os.path.isfile(full):
            return None
        return full

    def send_head(self):
        full = self.find()
        if full is None:
            self.send_response(404)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(full)))
        self.end_headers()
        return full

    def do_HEAD(self):
        self.send_head()

    def do_GET(self):
        full = self.send_head()
        if full:
            with open(full, "rb") as f:
                try:
                    shutil.copyfileobj(f, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the browser cancelled the download

    def log_message(self, fmt, *args):
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


print("serving %s at http://localhost:%d%s (allowed origin %s)" % (folder, port, prefix, origin), flush=True)
http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
