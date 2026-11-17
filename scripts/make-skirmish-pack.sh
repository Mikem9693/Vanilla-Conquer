#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuild the trimmed Red Alert skirmish data pack (MAIN.MIX, REDALERT.MIX, SCORES.MIX)
# from the original Allied disc archives. Game data never goes in this repo.
# Usage: make-skirmish-pack.sh <disc folder> <output folder> [vanillamix]
# The disc folder holds MAIN.MIX, and REDALERT.MIX either beside it or in INSTALL/.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $0 <original data folder> <output folder> [path to vanillamix]"
repo=$(realpath "$(dirname "$0")/..")
src=$(cd "$1" && pwd) || die "no such folder: $1"
out=$2
mix=$(realpath "${3:-$repo/build-tools/vanillamix}")
[ -x "$mix" ] || die "vanillamix not found or not executable: $mix"
[ -f "$src/MAIN.MIX" ] || die "missing $src/MAIN.MIX"
# On the real disc REDALERT.MIX sits in INSTALL/; accept either place.
if [ -f "$src/REDALERT.MIX" ]; then ramix="$src/REDALERT.MIX"
elif [ -f "$src/INSTALL/REDALERT.MIX" ]; then ramix="$src/INSTALL/REDALERT.MIX"
else die "missing REDALERT.MIX in $src or $src/INSTALL"; fi

# Refuse to write game data anywhere inside the git repo.
out=$(realpath -m "$out")
case "$out/" in "$repo"/*) die "output folder is inside the repo: $out" ;; esac
mkdir -p "$out"

# Scratch space and a throwaway config folder (vanillamix writes filenames.db there).
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export XDG_CONFIG_HOME="$work/config"
mkdir -p "$XDG_CONFIG_HOME"

# extract <mix> <dir> <names...>: unpack only the named entries, and check each one arrived.
extract() {
    local m=$1 d=$2; shift 2
    mkdir -p "$d"
    local args=(); for f in "$@"; do args+=(-f "$f"); done
    "$mix" -x -d "$d" "${args[@]}" "$m" > /dev/null
    for f in "$@"; do [ -f "$d/$f" ] || die "$f not found in $m"; done
}

# pack <dir> <OUT.MIX>: pack a folder, then rename the lower-case result to upper case.
pack() {
    local lower; lower=$(echo "$2" | tr 'A-Z' 'a-z')
    "$mix" -c -d "$1" "$work/$lower" > /dev/null
    mv "$work/$lower" "$out/$2"
}

# MAIN.MIX: six inner archives as-is, plus a general.mix trimmed to the skirmish maps.
extract "$src/MAIN.MIX" "$work/main" conquer.mix sounds.mix allies.mix russian.mix \
    temperat.mix snow.mix general.mix scores.mix
maps=(missions.pkt mission.ini tutorial.ini)
for i in $(seq -w 1 24); do maps+=("scm${i}ea.ini"); done
extract "$work/main/general.mix" "$work/general" "${maps[@]}"
mv "$work/main/scores.mix" "$work/scores.mix"
rm "$work/main/general.mix"
pack "$work/general" GENERAL.MIX
mv "$out/GENERAL.MIX" "$work/main/general.mix"
pack "$work/main" MAIN.MIX

# REDALERT.MIX: text, high-res sidebar art and speech.
extract "$ramix" "$work/ra" local.mix hires.mix speech.mix
pack "$work/ra" REDALERT.MIX

# SCORES.MIX: four music tracks.
extract "$work/scores.mix" "$work/scores" vector1a.aud snake.aud smsh226m.aud score.aud
pack "$work/scores" SCORES.MIX

ls -l "$out"/MAIN.MIX "$out"/REDALERT.MIX "$out"/SCORES.MIX
