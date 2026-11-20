# Changelog

All notable changes to the browser version that players will notice. Newest first.

## [Unreleased]

### Changed
- The page title, search description and tagline now say "Red Alert in your browser" instead of naming Vanilla Conquer.

## [0.2.2] - 2026-11-20

### Fixed
- Music now plays for every player in multiplayer, and the lobby chat box no longer disappears, when the game is not the window you last clicked. The game now only pauses its music when its tab is hidden or its window is minimised.

## [0.2.1] - 2026-11-17

### Added
- The game now plays inside the page, so the room panel, help tabs and links stay in view while you play.
- A changelog page, linked from the header.
- Cookieless visit counts with Cloudflare Web Analytics.
- Anonymous multiplayer counters (rooms created, rooms joined, matches started). Numbers only, with no addresses, room codes or player details.

### Changed
- The game only takes keyboard input after you click it, so typing a room code no longer reaches the game, and the arrow keys and Space no longer scroll the page while you play.
- Updated privacy note, which now mentions the visit counts.

## [0.2.0] - 2026-11-17

### Added
- Information tabs (how to play, controls, browser support, FAQ) and about tabs (about, credits, licence and privacy).
- A favicon based on the radar logo.

### Changed
- Redesigned home page.
- Fonts are served from this site, so the page makes no requests to font services.

## [0.1.0] - 2026-11-17

### Added
- First public release: play Red Alert skirmish against the AI in a desktop browser.
- Private multiplayer rooms: create a room and send the link to a friend.
- The game data downloads once and is stored in your browser, or you can use your own game files. Files are checked before use, and your own files are never uploaded.
- Licence and privacy notices.

### Fixed
- The page no longer freezes while the game runs.
- The intro movie is skipped, so it can no longer hang the game.
- Fixed a crash when a damaged unit picked up certain crates.
- Fixed a hang at the start of a skirmish when music couldn't play.
- Fullscreen shows the game at a sharp, centred size instead of a black screen.
- Single-player games hold while the tab is hidden and carry on when you come back.
