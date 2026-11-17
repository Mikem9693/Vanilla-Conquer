#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Release web build of Red Alert (vanillara.js + vanillara.wasm) with no game data packed in.
# Output: build-release/ (build tree, build.log), build-release/site/ (files to publish, production
# config and _headers) and build-release/site-local/ (same files with the local config, for local testing).
# The page's loader script starts the game itself with Module.callMain([]).
# Usage: build-web-release.sh   (needs Emscripten in ~/emsdk)
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

repo=$(realpath "$(dirname "$0")/..")
out="$repo/build-release"
log="$out/build.log"

# Put emcc, emcmake and friends on PATH (quietly).
source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
# Create the build folder and start an empty log.
mkdir -p "$out" && : >"$log"

# Link settings: keep main() from running at load, and expose FS and callMain on Module for the loader.
link="-O2 -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain,requestFullscreen"

start=$(date +%s)
echo "Configuring and building into $out (log: $log)..."
# Configure with a custom "WebRelease" build type: -O2, no -g (cmake/Compilers.cmake adds -g to
# plain Release). No WEB_DATA_DIR, so no game data is packaged.
emcmake cmake -S "$repo" -B "$out" -DBUILD_VANILLATD=OFF -DCMAKE_BUILD_TYPE=WebRelease \
    "-DCMAKE_C_FLAGS_WEBRELEASE=-O2 -DNDEBUG" "-DCMAKE_CXX_FLAGS_WEBRELEASE=-O2 -DNDEBUG" \
    "-DCMAKE_EXE_LINKER_FLAGS=$link" "-DVC_CXX_FLAGS=-w;-ferror-limit=0" -DWEB_DATA_DIR= >>"$log" 2>&1 \
    || die "configure failed, see $log"
# Build only the Red Alert executable, 8 jobs in parallel.
cmake --build "$out" --target VanillaRA -j8 >>"$log" 2>&1 || die "build failed, see $log"
echo "Build finished in $(($(date +%s) - start)) s; warnings: $(grep -c 'warning:' "$log" || true)"

# Refuse to continue if any packaged game data (.data) ended up in the build output.
if ls "$out"/*.data >/dev/null 2>&1; then die "a .data file was produced: $(ls "$out"/*.data)"; fi

# Print raw and gzip -9 sizes in bytes (gzip writes to a pipe, so no .gz files are left).
printf '%-16s %12s %12s\n' file raw gzip-9
for f in vanillara.wasm vanillara.js; do
    printf '%-16s %12d %12d\n' "$f" "$(stat -c %s "$out/$f")" "$(gzip -9 -c "$out/$f" | wc -c)"
done

# Start the site folder fresh and copy in the engine files (never vanillara.html or .data).
rm -rf "$out/site" && mkdir -p "$out/site"
cp "$out/vanillara.js" "$out/vanillara.wasm" "$out/site/"
# Copy the hand-written page, loader and config; collect any that do not exist yet.
missing=()
for f in index.html style.css site.js favicon.svg loader.js loader-config.json multiplayer.js _headers; do
    if [ -f "$repo/web/$f" ]; then cp "$repo/web/$f" "$out/site/"; else missing+=("web/$f"); fi
done
for f in ChakraPetch-SemiBold.woff2 ChakraPetch-Bold.woff2 Inter-Variable.woff2 OFL-ChakraPetch.txt OFL-Inter.txt; do
    [ -f "$repo/web/fonts/$f" ] || missing+=("web/fonts/$f")
done
[ ${#missing[@]} -eq 0 ] || die "site incomplete, missing: ${missing[*]}"
# Self-hosted fonts and their licences.
cp -r "$repo/web/fonts" "$out/site/"
# The GPL needs the licence text to travel with the published files.
cp "$repo/License.txt" "$out/site/LICENSE.txt"
# Changelog page, built from CHANGELOG.md with the home page's header and footer.
python3 "$repo/scripts/make-changelog.py" "$repo/CHANGELOG.md" "$repo/web/index.html" "$out/site/changelog.html" \
    || die "changelog build failed"
# site-local: local config (localhost data and relay), no _headers. start-local-mp.sh serves it.
rm -rf "$out/site-local" && cp -r "$out/site" "$out/site-local" && rm "$out/site-local/_headers"
# site: merge the production settings (R2 data, Fly.io relay) over the local config.
python3 - "$out/site/loader-config.json" "$repo/web/loader-config.production.json" <<'PY' || die "config merge failed"
import json, sys
path, prod = sys.argv[1], sys.argv[2]
config = json.load(open(path))
config.update(json.load(open(prod)))
json.dump(config, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
echo "Site ready in $out/site:" && ls -l "$out/site"
