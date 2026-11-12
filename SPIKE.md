# Spike notes: Red Alert in the browser

Branch `spike/web`, based on commit `ce83b59`.

## Ticket 1: Native build (phase 0 gate)

Goal: build Red Alert natively in WSL Ubuntu and run it with the demo data, as a known-good baseline before the WebAssembly work.

### Environment

| | |
|---|---|
| OS | Ubuntu 26.04.1 LTS on WSL2 (kernel 6.6.87.2), WSLg for display and sound |
| Compiler | g++ 15.2.0 |
| CMake | 4.2.3, "Unix Makefiles" generator (Ninja is not installed) |
| SDL2 | libsdl2-dev 2.32.10 |
| OpenAL | libopenal-dev 1.25.1 (openal-soft) |
| Game data | Red Alert demo, `MAIN.MIX` and `REDALERT.MIX`, in `~/ra-data/demo` |

### Build commands

Run from the repo root.

```sh
# Configure: generate Makefiles into build/, Red Alert only.
cmake -S . -B build -DBUILD_VANILLATD=OFF

# Compile with 16 parallel jobs. Takes about 30 seconds here.
cmake --build build -j16
```

Result: `build/vanillara`. The `build/` directory is ignored by git.

### Run commands

One-time setup: tell the game where the data is, and to run in a window. This file lives outside the repo.

```sh
mkdir -p ~/.config/vanilla-conquer/vanillara
cat > ~/.config/vanilla-conquer/vanillara/redalert.ini <<'EOF'
[Paths]
DataPath=/home/mikem93/ra-data/demo

[Video]
Windowed=yes
WindowWidth=1280
WindowHeight=800

[Mouse]
RawInput=no
EOF
```

`RawInput=no` fixes the inverted mouse described under Problems.

Then, from the repo root:

```sh
./build/vanillara
```

The game reads the `.MIX` files in place. It writes its settings and saved games into `~/.config/vanilla-conquer/vanillara/`, never into the repo or the data folder.

### What I did

1. Checked the toolchain, WSLg, and the demo data (read-only).
2. Read `common/paths.cpp` to find how the game locates its data: a `[Paths] DataPath=` entry in `redalert.ini`, looked up in the per-user config folder.
3. Configured and built the `VanillaRA` target only. No source, README or CMake files were changed.
4. Created the config file above.
5. Smoke test: `timeout 20 ./build/vanillara` was still running when the timer fired (exit code 124), with no crash.
6. Interactive play test by the owner (results below).

### Decisions

- **Acceptance changed from "start a skirmish" to "start the first demo campaign mission and play about a minute (units move, sound plays, no crash)".** Reason: the demo data contains 3 campaign missions and no skirmish maps. The skirmish map list is built from `MISSIONS.PKT` and loose `.MPR` files (`SessionClass::Read_Scenario_Descriptions`, `redalert/session.cpp`), and the demo has neither. Meeting the original wording would have meant adding a map file, which the owner ruled out.
- **Red Alert only.** `-DBUILD_VANILLATD=OFF` skips Tiberian Dawn, which is out of scope and halves the compile.
- **Plain CMake instead of the CI presets.** The presets need Ninja, which is not installed. Nothing was installed for this ticket.
- **Data located through the config file, not by copying or symlinking.** Keeps both the repo and `~/ra-data` untouched.
- **Windowed mode.** The game defaults to fullscreen, which is awkward under WSLg.

### Problems

None blocked the build. Things worth knowing:

- **Mouse inverted on both axes in the first play test** (left/right and up/down), which made the game hard to control. With its default `RawInput=yes` the game asks SDL for relative mouse movements and steers its own cursor from them (`Move_Video_Mouse`, `common/video_sdl2.cpp`). WSLg has to emulate that mode, which is the suspected cause. Fix: `[Mouse] RawInput=no` in the config file, so the game follows the normal pointer position. Config only, no source change. Confirmed by the owner in the second play test.
- **Three compiler warnings in original game code**, each a possible small buffer overrun. Not fixed, since source changes are out of scope. They are candidates for trouble in the WebAssembly build:
  - `redalert/house.h:991`: loop reads past the end of `BQuantity` (iteration 84).
  - `redalert/score.cpp:1663`: `sprintf` may write one byte past its buffer.
  - `redalert/sendfile.cpp:582`: `strcpy` of 13 bytes into a 12-byte buffer.
- **Sound log noise.** On start, OpenAL prints `Failed to create PipeWire event context` and two `pw.conf` lines. WSL has no PipeWire; OpenAL then falls back to PulseAudio, which WSLg provides.
- **Configure warnings, all harmless:** CMake policy CMP0183 notice at `CMakeLists.txt:62` (that line also has a stray comma after `BUILD_REMASTERTD`), `clang-format` not found (only needed for the `format` target), ImageMagick not found (only needed for the app icon).
- **No skirmish with demo data**, see Decisions.

### Acceptance results

Session 1 (default settings, windowed), as reported by the owner:

| Check | Result |
|---|---|
| Game launches | Yes |
| Main menu appears | Yes |
| First demo campaign mission starts | Yes |
| Units move | Yes |
| Sound plays | Yes |
| Mouse | Inverted on both axes, hard to control |
| Clean exit | Yes, exit code 0 |

Session 2 (with `RawInput=no`): the owner reported the mouse working correctly. Exit code 0.

Result: the revised acceptance is met. The game launches, reaches the main menu, starts the first demo campaign mission, units move and sound plays. The owner confirmed no crashes or errors in either session; both exited with code 0 and their logs contain only the PipeWire notice.
