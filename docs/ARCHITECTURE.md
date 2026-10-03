# Architecture

## Flow

Toolbar popup → per-tab background session → temporary active tab → self-contained MAIN-world collector → validated transcript model → native speaker names or exact panel matching → selected serializer → browser download manager.

The v1.3.1 build is undergoing local sideload testing. User approval is required before Store upload, release tagging or public publication.

An MV3 service worker owns collection and export. `chrome.storage.session` holds each tab’s job, result, selected track, options and download status; extension views subscribe to changes and reconnect without launching duplicate work. Worker suspension retains completed sessions. A bounded API heartbeat runs only during a user-requested operation. Interrupted single-page scans report their interruption; multipart scans retain a checkpoint and resume on request.

Short state transactions are serialized. Each scan has a generation token; stale completions cannot recreate closed-tab data. Refresh replaces the current tab’s session, and `tabs.onRemoved` deletes its session, collection and checkpoint. Reopening the popup compares canonical recording identity so navigation cannot reuse another recording’s cached captions. Browser restart or extension reload/update clears session storage. Quota exhaustion is reported without silently evicting other tabs. Export preferences alone use persistent `storage.local`; no permissions were added.

A download uses a data URL independent of the view lifetime. Its ID is stored in the session and completion is reconciled through `downloads.onChanged` and on reopening, including completion before the ID was stored. The UI reports success only after `chrome.downloads` confirms completion. Background messages are accepted only from the corresponding packaged popup or collection page, with request fields validated; page scripts cannot invoke them.

`collectStreamPage` and `collectPage` are self-contained because `chrome.scripting.executeScript` serializes each function. No imported functions or lexical module state may be referenced from their bodies. Keep this invariant when refactoring and validate the production build through the loaded-extension suite.

## Caption sources

On SharePoint Stream pages, `collectStreamPage` first validates the current page's `g_fileInfo[".spItemUrl"]` as an exact same-origin drive/item endpoint. It requests v2.1 item metadata expanded with `media/transcripts`, then reads the visible transcript IDs through `media/transcripts/{id}/streamContent` in JSON format. It never follows `temporaryDownloadUrl`, decrypts a payload or enumerates neighboring files. Requests, response bytes, cue counts, text sizes and source identity are bounded and validated; only sanitized caption data is returned.

Requests first use normal same-origin credentials and an existing `tempauth` query value, if the item URL supplies one. If the endpoint returns 401, a short-lived fetch observer can reuse an Authorization or x-authorization Bearer header already issued by the player for that same origin and drive/item. A structural transcript control may be opened to let the player request its transcript. The same endpoint is retried with that credential; a 403 does not trigger an authentication retry. Credentials stay within the invocation, are never returned or stored, and the observer and changed panel state are restored in `finally`. No cookie API or additional extension permission is used.

Structured entries provide native per-cue speaker names and numeric times parsed from offsets with up to seven fractional digits. Metadata video duration is converted from milliseconds to seconds. A missing track language can be derived from one spoken language; multiple spoken languages remain a single `und` track labeled “Spoken languages.” This path needs no virtualized transcript scrolling. Unsupported or inaccessible structured data falls back to the normal player collector.

The player collector inspects native HTML media tracks in the main document and accessible same-origin frames. A readable referenced WebVTT track is preferred; loaded native cues are the fallback. Disabled tracks can briefly enter hidden mode to load their captions, and their original mode is restored. Stream may first need its existing caption menu to instantiate each language’s blob track. Caption choices are matched to native track metadata, including lazily mounted menus. Selection, track modes and menu visibility are restored.

## Recording collections

The popup’s More options opens a separate `collection.html` workspace bound to the source tab. A collection has up to 20 ordered parts, each with its own source identity, duration, caption tracks, selected track, status and optional timeline offset. Users paste same-origin links or select candidates from exposed same-origin Stream anchors. Filename patterns are never used to invent recording links or determine order.

Collection jobs navigate the already authorized source tab through the selected recordings. Navigation and capture identities are checked before associating content with a part. The starting page and available player state (position, pause, volume, mute and speed) are restored after reading unless the user navigated elsewhere. Per-tab exclusive work prevents a popup scan from manipulating controls during collection. Opening the workspace can reuse a completed popup capture only when its source identity matches. Closing the workspace leaves work running; Pause stops between chunks, Continue resumes its temporary checkpoint, and Retry targets a failed part. Refresh collection retains links, order, title and options while clearing captured content, checkpoints and download status.

Queued tab leases are abortable. Pausing a collection that is waiting behind a popup scan settles that queued operation without waiting for the scan or allowing canceled navigation to run later. The lease of the active operation remains intact. Per-run tokens guard job registration and cleanup, so an older canceled run cannot clear the busy state of a newer run. Cleanup also handles cancellation before collection execution begins.

Collection progress distinguishes waiting for a tab lease, opening a recording, reading captions and restoring the starting page. New collections inherit saved popup export format and speaker preferences. Export-format changes can be saved while extraction is running; they update output choices without restarting collection or modifying its source order. Downloads remain gated on completed parts and valid timing/language choices.

Completed parts retain prepared captions and verified names. The current raw capture/checkpoint is temporary and is discarded after preparing that part. Collections have a 6 MB serialized storage guard, leaving room for progress and other tabs; browser session-storage quota failures are reported without deleting unrelated results. Closing the source tab clears the collection even if its workspace remains open. No transcript or recording-link database is written to persistent storage.

## Speaker matching

Native structured Stream speaker names are retained on their own cues, without inferring identity from a speaker ID or matching a different entry. Missing display names remain unnamed. The following row-matching logic applies to the player fallback.

`SpeakerRow` carries separate resolved speaker names and numeric start times. Numeric header timestamps are preferred. Unicode decimal digits are normalized; localized accessibility durations use unit forms derived from the document locale and numeric reference rows. There is no English/French label parser. Structural control IDs and icon shapes locate Stream controls independently of translated button text.

Stream subtitle IDs identify fragments of a larger utterance. Fragments with the same utterance ID are grouped and their text is concatenated. A name is assigned only if one unused transcript row has exactly matching Unicode-normalized text, ignoring whitespace, and a displayed start time within the same whole second. This handles overlapping speakers without nearest-neighbor guesses.

Virtualized transcript rows are collected in overlapping scroll increments, in chunks with an 18-second work deadline and a shared restoration allowance. Closed transcript controls are opened when necessary. The cursor carries source identity, next scroll position and learned locale metadata. `captureTab` merges rows by index, rejects conflicting content, retains tracks once and can report checkpoints to its caller. Each active invocation shares a 10-minute budget across chunks; an explicit resume starts a fresh active budget. Speaker traversal stops at 50,000 rows or 5 million row-text characters, with smaller per-chunk text budgets. Expected row count and coverage are checked; this measures speaker-label coverage, not proof that a live caption feed contains an entire meeting. Some players stop rendering new rows in hidden tabs; stalled or partial coverage is reported explicitly. Scroll and panel state are restored in `finally` blocks. Missing structures or limits produce explicit incomplete-coverage information.

Speaker matching runs separately for each recording and selected language before timelines are combined. Cue IDs are namespaced for collection exports, so IDs and row indexes reused by another part cannot cross-assign speakers.

Generic VTT voice tags are retained when a cue has one unambiguous voice. Multi-voice captions remain unattributed rather than being assigned to one of their speakers.

## Formats

The internal model uses seconds as finite numbers and plain Unicode text. VTT uses escaped text and standard voice annotations. SRT uses decimal commas and visible speaker prefixes. TXT and Markdown include timestamps; JSON documents the time unit and schema version. Markdown puts two spaces and a newline after each bold timestamp/speaker header, producing a hard line break within the same paragraph; exactly one blank line separates cue blocks, following [CommonMark hard line breaks](https://commonmark.org/help/tutorial/03-paragraphs.html).

Collections export one file in any format or a ZIP of individual files. End-to-end offsets use full media durations, including trailing silence; caption end times and filenames do not determine offsets. Custom starts preserve user-supplied gaps and reject overlaps. Original-time combined exports are limited to Markdown, TXT and JSON; separate VTT/SRT files keep local times. Combined languages must match unless the user explicitly enables different languages. Every part must be ready or explicitly removed.

Combined Markdown/TXT contain recording sections and optionally source links. Combined JSON uses `schemaVersion: 2`, with per-part IDs, order, duration, language, optional source URL, warnings, local cue timings and timeline offset. Single-recording and individual JSON remain schema version 1. Selected collection exports are bounded to 50,000 cues and 5 million text characters; the download layer also bounds serialized output size.

## UI design

The popup document and root use a consistent 520px width. Height follows content up to 560px, with no forced empty space in loading or unavailable states. Detected language and format sit side by side. A single track is shown as muted, noninteractive information; two or more tracks expose a selector. The preview scrolls within 160px; Download and the privacy/Help footer remain accessible. Long labels wrap or stay within their controls, and multilingual titles and captions use automatic text direction. Restricted browser and Store pages explain that a video page must be opened.

The white surface, navy text, blue accents and system fonts keep the interface focused and avoid remote requests. Store artwork uses the same development popup with fictional meeting content. Real toolbar tests complement the tab-rendered extension suite because Chromium sizes these surfaces differently.
