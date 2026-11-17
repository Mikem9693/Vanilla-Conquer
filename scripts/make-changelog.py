#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds changelog.html from CHANGELOG.md, using the home page's header, footer and style.css.
# Supports only: # / ## / ### headings, "- " bullet lists, [text](url) links and **bold**.
# Everything else is escaped and shown as plain text. No inline styles or scripts (strict CSP).
# Usage: make-changelog.py CHANGELOG.md web/index.html OUTPUT.html
import html
import re
import sys

LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
BOLD = re.compile(r"\*\*(.+?)\*\*")
SAFE_URL = re.compile(r"^(https?://|mailto:|[A-Za-z0-9._/#-]+$)")


def inline(text):
    """Escape a line, then turn [text](url) and **bold** back into markup."""
    out, pos = [], 0
    for m in LINK.finditer(text):
        out.append(bold(html.escape(text[pos:m.start()])))
        label, url = m.group(1), m.group(2)
        if SAFE_URL.match(url):
            out.append('<a href="%s">%s</a>' % (html.escape(url, quote=True), bold(html.escape(label))))
        else:  # unknown kind of link (for example javascript:): show it as plain text
            out.append(bold(html.escape(m.group(0))))
        pos = m.end()
    out.append(bold(html.escape(text[pos:])))
    return "".join(out)


def bold(escaped):
    return BOLD.sub(r"<strong>\1</strong>", escaped)


def body(md):
    parts, in_list = [], False
    for raw in md.splitlines():
        line = raw.rstrip()
        bullet = line.startswith("- ")
        if in_list and not bullet:
            parts.append("</ul>")
            in_list = False
        if not line:
            continue
        m = re.match(r"^(#{1,3}) (.*)$", line)
        if m:
            level = len(m.group(1))
            if level == 1:
                continue  # the page has its own title
            parts.append("<h%d>%s</h%d>" % (level, inline(m.group(2)), level))
        elif bullet:
            if not in_list:
                parts.append("<ul>")
                in_list = True
            parts.append("<li>%s</li>" % inline(line[2:]))
        else:
            parts.append("<p>%s</p>" % inline(line))
    if in_list:
        parts.append("</ul>")
    return "\n".join(parts)


def piece(page, start, end):
    """Copy one block (header or footer) out of the home page, so both pages always match."""
    i = page.find(start)
    j = page.find(end, i)
    if i < 0 or j < 0:
        sys.exit("make-changelog: %s not found in the home page" % start)
    return page[i:j + len(end)]


def main(argv):
    if len(argv) != 4:
        sys.exit("usage: make-changelog.py CHANGELOG.md web/index.html OUTPUT.html")
    md = open(argv[1], encoding="utf-8").read()
    page = open(argv[2], encoding="utf-8").read()
    header = piece(page, '<header class="card site-header">', "</header>")
    footer = piece(page, '<footer class="site-footer">', "</footer>")
    out = """<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Generated from CHANGELOG.md by scripts/make-changelog.py. Do not edit. -->
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog: Classic RTS</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="page">
<main class="container">

  %s

  <section class="card stack changelog" aria-labelledby="changelog-title">
    <a class="back-link" href="./">&larr; Back to the game</a>
    <h1 id="changelog-title" class="section-title">Changelog</h1>
%s
  </section>

  %s

</main>
</div>
</body>
</html>
""" % (header, body(md), footer)
    open(argv[3], "w", encoding="utf-8").write(out)


if __name__ == "__main__":
    main(sys.argv)
