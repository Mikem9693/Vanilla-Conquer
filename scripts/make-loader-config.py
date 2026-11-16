#!/usr/bin/env python3
# Writes web/loader-config.json: the list of game data files the web loader
# accepts, with their sizes and SHA-256 hashes. No game data goes in the file.
#
# Usage (regenerate the current config):
#   python3 scripts/make-loader-config.py ~/ra-data/skirmish skirmish-v1 \
#       http://localhost:8001/packs/skirmish-v1/ hosted \
#       allied=$HOME/ra-data/full/allied/disc/MAIN.MIX \
#       soviet=$HOME/ra-data/full/soviet/disc/MAIN.MIX \
#       allied=$HOME/ra-data/full/allied/disc/INSTALL/REDALERT.MIX \
#       soviet=$HOME/ra-data/full/soviet/disc/INSTALL/REDALERT.MIX
#
# Arguments: pack folder, pack version, base URL, data source
# ("hosted" or "own-files-only"), then any number of label=path originals.
# Originals with the same name and hash are listed once.
# "multiplayer" ("on"/"off") and "relayUrl" are kept from the existing file
# (defaults "off" and ""); edit them there by hand.

import hashlib
import json
import os
import sys

PACK_FILES = ["MAIN.MIX", "REDALERT.MIX", "SCORES.MIX"]


def describe(path):
    # Hash in 8 MB chunks so large files never sit in memory at once.
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return {"name": os.path.basename(path).upper(), "size": os.path.getsize(path), "sha256": h.hexdigest()}


def main(argv):
    if len(argv) < 5:
        sys.exit(__doc__ or "usage: make-loader-config.py PACK VERSION URL SOURCE [label=path ...]")
    pack, version, url, source = argv[1:5]
    if source not in ("hosted", "own-files-only"):
        sys.exit("data source must be 'hosted' or 'own-files-only'")
    if not url.endswith("/"):
        url += "/"

    files = [describe(os.path.join(pack, name)) for name in PACK_FILES]

    own = []
    for arg in argv[5:]:
        label, sep, path = arg.partition("=")
        if not sep:
            sys.exit("original must be label=path: " + arg)
        entry = describe(os.path.expanduser(path))
        if any(o["name"] == entry["name"] and o["sha256"] == entry["sha256"] for o in own):
            print("same as an earlier file, listed once:", path)
            continue
        entry["label"] = label
        own.append(entry)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "loader-config.json")
    old = {}
    if os.path.exists(out):
        with open(out) as f:
            old = json.load(f)
    config = {"dataSource": source, "dataBaseUrl": url, "packVersion": version,
              "multiplayer": old.get("multiplayer", "off"), "relayUrl": old.get("relayUrl", ""),
              "files": files, "ownFiles": own}
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(config, f, indent=2)
        f.write("\n")
    print("wrote", os.path.normpath(out))


if __name__ == "__main__":
    main(sys.argv)
