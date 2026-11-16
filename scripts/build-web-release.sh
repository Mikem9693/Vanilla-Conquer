#!/usr/bin/env bash
# Release web build of Red Alert (vanillara.js + vanillara.wasm) with no game data packed in.
# Output: build-release/ (build tree, build.log) and build-release/site/ (files to publish).
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
for f in index.html loader.js loader-config.json multiplayer.js; do
    if [ -f "$repo/web/$f" ]; then cp "$repo/web/$f" "$out/site/"; else missing+=("web/$f"); fi
done
[ ${#missing[@]} -eq 0 ] || die "site incomplete, missing: ${missing[*]}"
echo "Site ready in $out/site:" && ls -l "$out/site"
