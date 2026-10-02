# Store listing source

Name: **GetTranscript — Video Transcript Exporter**

Short description:

> Export video transcripts as VTT, SRT, text, Markdown or JSON. Preserve available speaker names. Processed locally on click.

## Full description

Keep the conversation in a format you can use.

GetTranscript exports captions already available on a video page. Open the extension, choose a format, and download. The detected caption language appears automatically; a language selector is shown only when multiple tracks are available. Choose WebVTT for caption tools, SRT for video editors, plain text or Markdown for notes, and JSON for structured processing.

On supported Microsoft Stream pages, GetTranscript matches the meeting’s speaker labels to the captions using their text and timestamps. It preserves existing VTT voice tags on other supported players. Unmatched captions remain unnamed.

Meeting split into several recordings? Open More options → Combine recordings. Add up to 20 links from the same website, arrange the parts and choose one combined transcript or a ZIP of separate files. Find links on source offers Stream links already present on the page; it does not guess filenames. Speaker names are matched separately for each part.

Join recordings end to end using their full video durations, set start times to preserve known gaps, or keep each part’s original times in Markdown, text and JSON. Separate files always retain original timestamps. Different caption languages require an explicit choice for combined exports; no translation is performed. Markdown, text and JSON can include links back to the recordings.

Reading visits each recording in your open source tab, then restores its starting page and player state when you have not navigated elsewhere. Keep that tab open. Close the popup or workspace whenever you like: reading and exports continue, and reopening restores progress and download status. Pause and continue collection, or retry a failed part. Long transcript rows are collected in resumable chunks.

Everything is processed locally. There is no developer server, analytics, account registration or AI processing. Results, recording links and progress checkpoints stay in temporary browser session memory. Refresh replaces cached results; source-tab close, browser restart or extension reload clears them. Only export preferences are stored persistently. The extension uses temporary access to the source tab without permanent access to every website.

Requirements: a readable caption track in a supported HTML5 player, or a standard Microsoft Stream recording page hosted on SharePoint. Caption languages are discovered from the supported player without a language whitelist. The interface is in English; captions retain their original language and text direction. For embedded videos, open the original player page. For pages without captions, GetTranscript cannot generate a transcript from audio. Live caption sources may expose only a rolling window.

GetTranscript is independent of Microsoft and Google. Export only content you are authorized to keep.

## Permission justifications

- **activeTab:** access the source tab after the user opens the extension, including user-selected recordings on the same origin during a collection.
- **scripting:** retrieve native caption cues, page-created caption blobs, media duration, exposed recording links and transcript speaker labels; remember and restore player state in the selected tab.
- **downloads:** save the user’s chosen transcript file and verify completion.
- **storage:** remember output format and speaker display preferences locally; retain per-tab results, recording collections, source URLs, progress checkpoints and download status in temporary in-memory session storage. Refresh replaces cached content; closing the source tab clears its results and collection.

Single purpose: export available video captions and transcript labels into user-selected local text formats.

Remote code: none. All executable code is included in the package.

Data use: page titles, recording URLs, durations, captions and speaker names are processed locally for export. Do not declare that no data is accessed: it is accessed, but not collected by the developer or transmitted for processing. Complete Store privacy disclosures consistently with PRIVACY.md and the current form wording.

Disclose website content, personal communications and personally identifiable information (speaker names). These categories are processed locally, with no developer collection or cloud processing.

## Reviewer test instructions

No extension account, payment or developer credentials are required. Open https://iandevlin.github.io/mdn/video-player-with-captions/video-with-captions.html in Chrome or Microsoft Edge, then open GetTranscript. Select English, German or Spanish and download VTT, SRT, text, Markdown or JSON. This public sample exposes 14 cues per language and has no speaker labels, so the speaker option is unavailable as expected. Close and reopen the popup during reading or after downloading to verify that it reconnects to the same result. Refresh starts a new scan; closing the video tab clears the session. For the Stream adapter, open a SharePoint-hosted recording with a readable caption track and transcript panel using your own authorized Microsoft account. Speaker matching uses structural metadata and locale-aware numeric timestamps; missing or ambiguous names remain unnamed. The extension cannot generate captions from audio or provide access to recordings the user cannot open.

For multipart review, use two recordings that your own account can open on the same SharePoint origin. Open the first, select **More options → Combine recordings**, add the second link, confirm order and select **Read recordings**. The source tab visits both and returns to its starting page; keep it open. Close and reopen the workspace to check retained results, or Pause and Continue a longer collection. Export combined Markdown and VTT, then separate SRT files as a ZIP. Verify full-duration offsets, per-part names, and original timestamps in the ZIP. In Advanced options, try custom starts, original-time Markdown/TXT/JSON, recording links and explicit mixed-language consent. Combined JSON uses schema version 2. Refresh collection retains its queue and options while clearing captured content. Closing the source tab clears all its temporary collection data.

## Listing maintenance

Update the existing Chrome and Edge products with the same verified release ZIP. Chrome v1.2.0 was verified as Published - public in the publisher dashboard on October 3, 2026. Verify current dashboard status before recording a new publication result. The v1.3.0 copy here is prepared listing content, not evidence of submission. Use the verified developer/support contact and public privacy-policy URL, review declarations, and use screenshots containing only fictional meeting content. Add actual Store links and official badges to the README after the listings exist. Do not reuse another extension’s product ID.

## Public links

- Homepage: https://github.com/RobinMJD/GetTranscript
- Support: https://github.com/RobinMJD/GetTranscript/issues
- Privacy policy: https://github.com/RobinMJD/GetTranscript/blob/main/PRIVACY.md
- Screenshot: `docs/images/store-1280x800.png` (fictional meeting content)
- Collection screenshot: `docs/images/store-collection-1280x800.png` (fictional meeting, actual workspace at 1280 × 800)
- Small promo tile: `docs/images/store-promo-440x280.png` (source: `scripts/store-promo.svg`)
- Logo: `public/icons/icon128.png`
