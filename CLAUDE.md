# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

- Goal: browser (WebAssembly) port of Red Alert from this source.
- The owner is learning: briefly explain new concepts and commands.
- Current phase: 0, launch-week spike, branch `spike/web`.
- Game data lives in `~/ra-data/demo` and must never be committed.
- Rules: small diffs; explain commands before running them; summarise build logs instead of printing them in full.

## What this is

Vanilla Conquer is a portable build of the original Command & Conquer engine (EA's GPLv3 source release). One tree produces two kinds of output for each of the two games:

- Standalone executables `vanillatd` (Tiberian Dawn) and `vanillara` (Red Alert), drop-in replacements for the original game binaries. They need the original game data files to run.
- `TiberianDawn.dll` / `RedAlert.dll`, mods for the C&C Remastered Collection (Windows, built 32-bit with `-A win32`).

The project goal is to keep the default out-of-box experience faithful to the original releases while fixing bugs and improving compatibility. Existing behaviour changes are gated behind an INI key or setting rather than made the default.

The main branch is `vanilla`.

## Build

CMake 3.25+, C++11 with compiler extensions off. Dependencies for the standalone builds: SDL2 (or SDL1) and OpenAL.

```sh
# Plain build, any generator. Binaries land in the build directory root.
cmake -B build .
cmake --build build -j

# Preset build (what CI runs). Needs Ninja; uses "Ninja Multi-Config".
# Output: build/<preset>/RelWithDebInfo/
cmake --workflow --preset release
```

Presets in `CMakePresets.json`: `release` (both executables), `internal` (adds the in-game scenario editor and `vanillamix` tool), `testing` (unit tests only, no game executables), `nonet` (networking compiled out), `remaster` (the Remastered DLLs). CI builds `release`, `internal`, `testing` and `nonet` with both gcc and clang, so a change has to compile in all four.

Useful options (`-DNAME=ON|OFF`): `BUILD_VANILLATD`, `BUILD_VANILLARA`, `BUILD_REMASTERTD`, `BUILD_REMASTERRA`, `MAP_EDITORTD`, `MAP_EDITORRA`, `NETWORKING`, `SDL1`, `SDL2`, `OPENAL`, `BUILD_TESTS`, `BUILD_TOOLS`, `BUILD_WITH_ASAN`, `BUILD_WITH_UBSAN`.

Extra compiler flags are passed as a semicolon list through the `VC_CXX_FLAGS` CMake variable or environment variable. CI sets `VC_CXX_FLAGS="-w;-Wwrite-strings;-Werror=write-strings"`: warnings are silenced, but assigning a string literal to a non-const `char*` fails the build.

## Tests

```sh
cmake -B build -DBUILD_TESTS=ON -DBUILD_VANILLATD=OFF -DBUILD_VANILLARA=OFF .
cmake --build build -j
ctest --test-dir build              # all tests
ctest --test-dir build -R lcw       # one test, by name

# Preset equivalent
cmake --workflow --preset testing
ctest --preset testing -R lcw
```

Tests cover only low-level routines in `common/` (compression, blitters, drawing, RNG). There is no test framework: each `tests/<name>.cpp` is a standalone executable with its own `main` that returns non-zero on failure, and each one is registered by hand in `tests/CMakeLists.txt` (an `add_executable` block, an `add_test`, and an entry in the `tests` target dependency list). The `.inc` files are expected-output data. There are no tests for game logic.

## Formatting

```sh
cmake --build build --target format
```

This runs `clang-format -i` over every source file in place. CI runs it and fails if `git diff` is non-empty. The target expects clang-format 14.0.0 to 14.0.6 (CI installs `clang-format-14`); other versions format differently and will produce spurious diffs. Style is in `.clang-format`: 4 spaces, 120 columns, `SortIncludes: false`.

## Architecture

### Library layering

`common/CMakeLists.txt` builds three static libraries from one directory:

- `common`: platform-neutral engine support. File and MIX archive access, INI parsing, pipes/straws (streaming compression and crypto), LCW/XOR-delta codecs, software blitters, fonts, shapes, palettes, timers.
- `commonv`: the standalone platform layer, linked by the executables. Video, audio, keyboard/mouse, VQA movie playback and networking.
- `commonr`: the Remastered platform layer, linked by the DLLs. Null video and sound, because the Remastered client does its own rendering and audio.

Backends are chosen at configure time by which source file gets compiled, not by runtime dispatch. `video.h` is implemented by exactly one of `video_sdl2.cpp`, `video_sdl1.cpp`, `video_ddraw.cpp` or `video_null.cpp`; the same pattern applies to `soundio_*.cpp`, `vqaaudio_*.cpp` and `wwkeyboard_*.cpp`. A change to one of these interfaces has to be made in every implementation. The matching defines are `SDL_BUILD`, `SDL2_BUILD`, `SDL1_BUILD`, `OPENAL_BUILD`, `DSOUND_BUILD` and `NETWORKING`.

Source files are listed explicitly in each `CMakeLists.txt`. A new `.cpp` does nothing until it is added to the right list.

### Two games, two copies of the engine

`tiberiandawn/` and `redalert/` are separate forks of the same game code, not a shared library with game-specific parts. About 226 files share a name across the two directories and nearly all of them differ. Red Alert is the later, more evolved version (rules.ini-driven data, vessels, more trigger types). A bug fixed in one game often exists in the other and has to be ported by hand. Commit messages use a `[TD]` or `[RA]` prefix when a change touches only one game, and `[CI]` for workflow changes.

Each game directory compiles into two targets from the same source list:

- `VanillaTD` / `VanillaRA`: links `commonv`, plus the networking files when `NETWORKING` is on.
- `TiberianDawn` / `RedAlert` (shared libraries): links `commonr`, adds `dllinterface.cpp`, `dllinterfaceeditor.cpp` and `sidebarglyphx.cpp`, and defines `REMASTER_BUILD`.

`#ifdef REMASTER_BUILD` blocks are scattered through the game code, concentrated in `house.cpp`, `scenario.cpp`, `display.cpp`, `techno.cpp` and `startup.cpp`. Code inside them is not compiled or checked by the Linux CI presets, so edits near them need care to keep both variants building. `dllinterface.cpp` is the exported `CNC_*` API the Remastered client calls; it drives the game one frame at a time instead of running the game's own loop.

`INTERNAL_VERSION` (set by `MAP_EDITORTD` / `MAP_EDITORRA`) enables the scenario editor and changes the type of the global `Map` from `MouseClass` to `MapEditClass`.

### Inside a game directory

- `function.h` is the umbrella header that nearly every `.cpp` includes first. It pulls in `defines.h` (enums and constants), `externs.h` (declarations of all globals) and the class headers. Globals are defined in `globals.cpp`.
- Startup: `startup.cpp` `main()` sets up paths, settings, video and audio, then calls `Main_Game()` in `conquer.cpp`. `Main_Game` runs `Init_Game()` once (`init.cpp`), then loops over `Select_Game()` (menus, scenario load) and `Main_Loop()` (one game frame per call).
- Game objects follow one inheritance chain: `AbstractClass` → `ObjectClass` → `MissionClass` → `RadioClass` → `TechnoClass`, which branches to `BuildingClass` and `FootClass`; `FootClass` leads to `InfantryClass`, `AircraftClass` and `DriveClass` → `TurretClass` → `TarComClass` → `UnitClass` in TD. RA flattens the unit chain and adds `VesselClass`.
- Each object class has a matching `*TypeClass` holding its static per-type data (`type.h`). The type instances are defined in the `?data.cpp` files: `udata.cpp` for units, `bdata.cpp` for buildings, `idata.cpp` for infantry, `aadata.cpp` for aircraft, and so on.
- The screen is one object, `Map`, whose class is a deep single-inheritance stack with one layer per feature: `GScreenClass` → `MapClass` → `DisplayClass` → `RadarClass` → `PowerClass` → `SidebarClass` → `TabClass` → `HelpClass` → `ScrollClass` → `MouseClass` (→ `MapEditClass`). Input and drawing calls cascade down through the layers.
- Live objects are stored in fixed-size global heaps (`TFixedIHeapClass<UnitClass> Units`, `Buildings`, `Infantry`, ...) declared in `externs.h`. Save games write these heaps as raw memory, converting pointers to heap indices and back with each class's `Code_Pointers()` / `Decode_Pointers()` (`saveload.cpp`, `ioobj.cpp`, `iomap.cpp`). Adding or reordering a member of a saved class changes the save format.
- Multiplayer is deterministic lockstep: only player commands (`event.cpp`, `queue.cpp`) travel over the network and every machine simulates the same frames. Game logic must draw randomness from the synchronised generator (`Scen.RandomNumber`, `Random_Pick()`) and must not depend on anything local such as wall-clock time, frame rate or display settings, or games desync. Randomness that only affects one machine (cosmetic effects, UI) uses `NonCriticalRandomNumber` / `Sim_Random_Pick()` so it does not advance the shared sequence.

### Portability rules the code depends on

The original code assumed 32-bit Windows with MSVC. Things that keep it working elsewhere:

- No `long` in anything that is saved, sent over the network or read from a data file; its size differs by platform. Use fixed-width types.
- `char` is forced signed with `-fsigned-char`.
- Structs with bitfields whose layout matters are marked `BITFIELD_STRUCT` (`common/bitfields.h`) so gcc and clang pack them the way MSVC does.
- Multi-byte values read from game data files are byte-swapped with the `le16toh` / `le32toh` family in `common/endianness.h`, so big-endian hosts work.
- Paths go through `PathsClass` (`common/paths.h`), which separates the program, data and per-user directories. Game data lookups are case-insensitive on POSIX (`file_posix.cpp`).
- Options added by the port (window size, scaling, frame limit, raw mouse input) live in the global `Settings` (`SettingsClass`, `common/settings.h`), loaded from the game's INI file. The original game options stay in each game's `OptionsClass`.
