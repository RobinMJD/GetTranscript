# Architecture

## Flow

Toolbar popup → temporary active tab → self-contained MAIN-world collector → validated transcript model → exact speaker matching → selected serializer → browser download manager.

The popup has no background worker because collection and conversion are initiated by the user and short lived. A download uses a data URL, so its bytes do not depend on a popup-owned object URL remaining alive after the popup closes. The popup reports completion only after `chrome.downloads` returns a completed state.

`collectPage` is self-contained because `chrome.scripting.executeScript` serializes the function. No imported functions or lexical module state may be referenced from its body. Keep this invariant when refactoring and validate the production build through the loaded-extension suite.

## Caption sources

Native HTML media tracks are inspected in the main document and accessible same-origin frames. A readable referenced WebVTT track is preferred; loaded native cues are the fallback. Disabled tracks can briefly enter hidden mode to load their captions, and their original mode is restored. Stream may first need its existing caption menu to instantiate a blob track.

The collector does not derive alternate network endpoints, request cookie access or perform cryptographic extraction. It reads track resources referenced by the DOM and existing transcript labels.

## Speaker matching

Stream subtitle IDs identify fragments of a larger utterance. Fragments with the same utterance ID are grouped and their text is concatenated. A name is assigned only if one unused transcript row has exactly matching Unicode-normalized text, ignoring whitespace, and a displayed start time within the same whole second. This handles overlapping speakers without nearest-neighbor guesses.

Virtualized transcript rows are collected by traversing the scroll container in overlapping increments. Expected row count and coverage are checked. The previous scroll position and panel state are restored in `finally` blocks. Missing or changed page structures produce a clear limit rather than a silently complete result.

Generic VTT voice tags are retained when a cue has one unambiguous voice. Multi-voice captions remain unattributed rather than being assigned to one of their speakers.

## Formats

The internal model uses seconds as finite numbers and plain Unicode text. VTT uses escaped text and standard voice annotations. SRT uses decimal commas and visible speaker prefixes. TXT and Markdown include timestamps; JSON documents the time unit and schema version.

## UI design

The design uses a white surface, navy text, blue accents, a light blue source strip and small consistent outline icons. The primary button and privacy footer remain visible at Chromium’s 400 × 600 popup size. Long titles, errors and previews scroll within the content region. System fonts avoid remote requests.

The generated visual concept was adapted to the 600-pixel popup height by reducing spacing while keeping the same content order and controls. Development fixtures use fictional names. Source code is separated into collection, conversion, browser APIs and UI modules.
