# Architecture

## Flow

Toolbar popup → per-tab background session → temporary active tab → self-contained MAIN-world collector → validated transcript model → exact speaker matching → selected serializer → browser download manager.

An MV3 service worker owns collection and export. `chrome.storage.session` holds each tab’s job, result, selected track, options and download status; extension views subscribe to changes and reconnect without launching duplicate work. Worker suspension retains completed sessions. A bounded API heartbeat runs only during a user-requested operation. Interrupted single-page scans report their interruption; multipart scans retain a checkpoint and resume on request.

Short state transactions are serialized. Each scan has a generation token; stale completions cannot recreate closed-tab data. Refresh replaces the current tab’s session, and `tabs.onRemoved` deletes its session, collection and checkpoint. Reopening the popup compares canonical recording identity so navigation cannot reuse another recording’s cached captions. Browser restart or extension reload/update clears session storage. Quota exhaustion is reported without silently evicting other tabs. Export preferences alone use persistent `storage.local`; no permissions were added.

A download uses a data URL independent of the view lifetime. Its ID is stored in the session and completion is reconciled through `downloads.onChanged` and on reopening, including completion before the ID was stored. The UI reports success only after `chrome.downloads` confirms completion. Background messages are accepted only from the corresponding packaged popup or collection page, with request fields validated; page scripts cannot invoke them.

`collectPage` is self-contained because `chrome.scripting.executeScript` serializes the function. No imported functions or lexical module state may be referenced from its body. Keep this invariant when refactoring and validate the production build through the loaded-extension suite.

## Caption sources

Native HTML media tracks are inspected in the main document and accessible same-origin frames. A readable referenced WebVTT track is preferred; loaded native cues are the fallback. Disabled tracks can briefly enter hidden mode to load their captions, and their original mode is restored. Stream may first need its existing caption menu to instantiate each language’s blob track. Caption choices are matched to native track metadata, including lazily mounted menus. Selection, track modes and menu visibility are restored.

The collector does not derive alternate network endpoints, request cookie access or perform cryptographic extraction. It reads track resources referenced by the DOM and existing transcript labels.

## Recording collections

The popup’s More options opens a separate `collection.html` workspace bound to the source tab. A collection has up to 20 ordered parts, each with its own source identity, duration, caption tracks, selected track, status and optional timeline offset. Users paste same-origin links or select candidates from exposed same-origin Stream anchors. Filename patterns are never used to invent recording links or determine order.

Collection jobs navigate the already authorized source tab through the selected recordings. Navigation and capture identities are checked before associating content with a part. The starting page and available player state (position, pause, volume, mute and speed) are restored after reading unless the user navigated elsewhere. Per-tab exclusive work prevents a popup scan from manipulating controls during collection. Opening the workspace can reuse a completed popup capture only when its source identity matches. Closing the workspace leaves work running; Pause stops between chunks, Continue resumes its temporary checkpoint, and Retry targets a failed part. Refresh collection retains links, order, title and options while clearing captured content, checkpoints and download status.

Completed parts retain prepared captions and verified names. The current raw capture/checkpoint is temporary and is discarded after preparing that part. Collections have a 6 MB serialized storage guard, leaving room for progress and other tabs; browser session-storage quota failures are reported without deleting unrelated results. Closing the source tab clears the collection even if its workspace remains open. No transcript or recording-link database is written to persistent storage.

## Speaker matching

`SpeakerRow` carries separate resolved speaker names and numeric start times. Numeric header timestamps are preferred. Unicode decimal digits are normalized; localized accessibility durations use unit forms derived from the document locale and numeric reference rows. There is no English/French label parser. Structural control IDs and icon shapes locate Stream controls independently of translated button text.

Stream subtitle IDs identify fragments of a larger utterance. Fragments with the same utterance ID are grouped and their text is concatenated. A name is assigned only if one unused transcript row has exactly matching Unicode-normalized text, ignoring whitespace, and a displayed start time within the same whole second. This handles overlapping speakers without nearest-neighbor guesses.

Virtualized transcript rows are collected in overlapping scroll increments, in chunks with an 18-second work deadline and a shared restoration allowance. The cursor carries source identity, next scroll position and learned locale metadata. `captureTab` merges rows by index, rejects conflicting content, retains tracks once and can report checkpoints to its caller. Each active invocation shares a 10-minute budget across chunks; an explicit resume starts a fresh active budget. Speaker traversal stops at 50,000 rows or 5 million row-text characters, with smaller per-chunk text budgets. Expected row count and coverage are checked; this measures speaker-label coverage, not proof that a live caption feed contains an entire meeting. Scroll and panel state are restored in `finally` blocks. Missing structures or limits produce explicit incomplete-coverage information.

Speaker matching runs separately for each recording and selected language before timelines are combined. Cue IDs are namespaced for collection exports, so IDs and row indexes reused by another part cannot cross-assign speakers.

Generic VTT voice tags are retained when a cue has one unambiguous voice. Multi-voice captions remain unattributed rather than being assigned to one of their speakers.

## Formats

The internal model uses seconds as finite numbers and plain Unicode text. VTT uses escaped text and standard voice annotations. SRT uses decimal commas and visible speaker prefixes. TXT and Markdown include timestamps; JSON documents the time unit and schema version. Markdown puts two spaces and a newline after each bold timestamp/speaker header, producing a hard line break within the same paragraph; exactly one blank line separates cue blocks, following [CommonMark hard line breaks](https://commonmark.org/help/tutorial/03-paragraphs.html).

Collections export one file in any format or a ZIP of individual files. End-to-end offsets use full media durations, including trailing silence; caption end times and filenames do not determine offsets. Custom starts preserve user-supplied gaps and reject overlaps. Original-time combined exports are limited to Markdown, TXT and JSON; separate VTT/SRT files keep local times. Combined languages must match unless the user explicitly enables different languages. Every part must be ready or explicitly removed.

Combined Markdown/TXT contain recording sections and optionally source links. Combined JSON uses `schemaVersion: 2`, with per-part IDs, order, duration, language, optional source URL, warnings, local cue timings and timeline offset. Single-recording and individual JSON remain schema version 1. Selected collection exports are bounded to 50,000 cues and 5 million text characters; the download layer also bounds serialized output size.

## UI design

The popup document and root use a consistent 520px width. Height follows content up to 560px, with no forced empty space in loading or unavailable states. Detected language and format sit side by side. A single track is shown as muted, noninteractive information; two or more tracks expose a selector. The preview scrolls within 160px; Download and the privacy/Help footer remain accessible. Long labels wrap or stay within their controls, and multilingual titles and captions use automatic text direction. Restricted browser and Store pages explain that a video page must be opened.

The white surface, navy text, blue accents and system fonts keep the interface focused and avoid remote requests. Store artwork uses the same development popup with fictional meeting content. Real toolbar tests complement the tab-rendered extension suite because Chromium sizes these surfaces differently.
