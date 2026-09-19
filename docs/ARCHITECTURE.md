# Architecture

## Flow

Toolbar popup → temporary active tab → self-contained MAIN-world collector → validated transcript model → exact speaker matching → selected serializer → browser download manager.

The popup has no background worker because collection and conversion are initiated by the user and short lived. A download uses a data URL, so its bytes do not depend on a popup-owned object URL remaining alive after the popup closes. The popup reports completion only after `chrome.downloads` returns a completed state.

`collectPage` is self-contained because `chrome.scripting.executeScript` serializes the function. No imported functions or lexical module state may be referenced from its body. Keep this invariant when refactoring and validate the production build through the loaded-extension suite.

## Caption sources

Native HTML media tracks are inspected in the main document and accessible same-origin frames. A readable referenced WebVTT track is preferred; loaded native cues are the fallback. Disabled tracks can briefly enter hidden mode to load their captions, and their original mode is restored. Stream may first need its existing caption menu to instantiate each language’s blob track. Caption choices are matched to native track metadata, including lazily mounted menus. Selection, track modes and menu visibility are restored.

The collector does not derive alternate network endpoints, request cookie access or perform cryptographic extraction. It reads track resources referenced by the DOM and existing transcript labels.

## Speaker matching

`SpeakerRow` carries separate resolved speaker names and numeric start times. Numeric header timestamps are preferred. Unicode decimal digits are normalized; localized accessibility durations use unit forms derived from the document locale and numeric reference rows. There is no English/French label parser. Structural control IDs and icon shapes locate Stream controls independently of translated button text.

Stream subtitle IDs identify fragments of a larger utterance. Fragments with the same utterance ID are grouped and their text is concatenated. A name is assigned only if one unused transcript row has exactly matching Unicode-normalized text, ignoring whitespace, and a displayed start time within the same whole second. This handles overlapping speakers without nearest-neighbor guesses.

Virtualized transcript rows are collected by traversing the scroll container in overlapping increments. Expected row count and coverage are checked. The previous scroll position and panel state are restored in `finally` blocks. Missing or changed page structures produce a clear limit rather than a silently complete result.

Generic VTT voice tags are retained when a cue has one unambiguous voice. Multi-voice captions remain unattributed rather than being assigned to one of their speakers.

## Formats

The internal model uses seconds as finite numbers and plain Unicode text. VTT uses escaped text and standard voice annotations. SRT uses decimal commas and visible speaker prefixes. TXT and Markdown include timestamps; JSON documents the time unit and schema version. Markdown puts two spaces and a newline after each bold timestamp/speaker header, producing a hard line break within the same paragraph; exactly one blank line separates cue blocks, following [CommonMark hard line breaks](https://commonmark.org/help/tutorial/03-paragraphs.html).

## UI design

The popup document and root use a consistent 520px width. Height follows content up to 560px, with no forced empty space in loading or unavailable states. Language and format sit side by side. The preview scrolls within 160px; Download and the privacy/Help footer remain accessible. Long labels wrap or stay within their controls, and multilingual titles and captions use automatic text direction. Restricted browser and Store pages explain that a video page must be opened.

The white surface, navy text, blue accents and system fonts keep the interface focused and avoid remote requests. Store artwork uses the same development popup with fictional meeting content. Real toolbar tests complement the tab-rendered extension suite because Chromium sizes these surfaces differently.
