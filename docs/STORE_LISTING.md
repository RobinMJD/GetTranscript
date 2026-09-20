# Store listing source

Name: **GetTranscript — Video Transcript Exporter**

Short description:

> Export video transcripts as VTT, SRT, text, Markdown or JSON. Preserve available speaker names. Processed locally on click.

## Full description

Keep the conversation in a format you can use.

GetTranscript exports captions already available on a video page. Open the extension, choose a format, and download. The detected caption language appears automatically; a language selector is shown only when multiple tracks are available. Choose WebVTT for caption tools, SRT for video editors, plain text or Markdown for notes, and JSON for structured processing.

On supported Microsoft Stream pages, GetTranscript matches the meeting’s speaker labels to the captions using their text and timestamps. It preserves existing VTT voice tags on other supported players. Unmatched captions remain unnamed.

Everything is processed locally. There is no developer server, analytics, account registration or AI processing. Close the popup whenever you like: reading and exports continue, and reopening restores the result and download status. Per-tab results are kept in temporary browser memory until Refresh or tab close; browser restart or extension reload also clears them. Only export preferences are stored persistently. The extension requests temporary access to the tab you select, rather than permanent access to every website.

Requirements: a readable caption track in a supported HTML5 player, or a standard Microsoft Stream recording page hosted on SharePoint. Caption languages are discovered from the supported player without a language whitelist. The interface is in English; captions retain their original language and text direction. For embedded videos, open the original player page. For pages without captions, GetTranscript cannot generate a transcript from audio. Live caption sources may expose only a rolling window.

GetTranscript is independent of Microsoft and Google. Export only content you are authorized to keep.

## Permission justifications

- **activeTab:** read the current video only after the user opens the extension.
- **scripting:** retrieve native caption cues, page-created caption blobs and transcript speaker labels from the selected tab.
- **downloads:** save the user’s chosen transcript file and verify completion.
- **storage:** remember output format and speaker display preferences locally, and retain per-tab jobs, transcripts and download status in temporary in-memory session storage. Refresh or closing the source tab clears that tab’s cached result.

Single purpose: export available video captions and transcript labels into user-selected local text formats.

Remote code: none. All executable code is included in the package.

Data use: page title, captions and speaker names are processed locally for the export functionality. Do not declare that no data is accessed: it is accessed, but not collected by the developer or transmitted for processing. Complete Store privacy disclosures consistently with PRIVACY.md and the current form wording.

Disclose website content, personal communications and personally identifiable information (speaker names). These categories are processed locally, with no developer collection or cloud processing.

## Reviewer test instructions

No extension account, payment or developer credentials are required. Open https://iandevlin.github.io/mdn/video-player-with-captions/video-with-captions.html in Microsoft Edge, then open GetTranscript. Select English, German or Spanish and download VTT, SRT, text, Markdown or JSON. This public sample exposes 14 cues per language and has no speaker labels, so the speaker option is unavailable as expected. Close and reopen the popup during reading or after downloading to verify that it reconnects to the same result. Refresh starts a new scan; closing the video tab clears the session. For the Stream adapter, open a SharePoint-hosted recording with a readable caption track and transcript panel using your own authorized Microsoft account. Speaker matching uses structural metadata and locale-aware numeric timestamps; missing or ambiguous names remain unnamed. The extension cannot generate captions from audio or provide access to recordings the user cannot open.

## Listing maintenance

Update the existing Edge product with the verified release ZIP. Keep Chrome submission deferred until publisher sign-in is completed. Use the verified developer/support contact and public privacy-policy URL, review declarations, and use screenshots containing only fictional meeting content. Add actual Store links and official badges to the README after the listings exist. Do not reuse another extension’s product ID.

## Public links

- Homepage: https://github.com/RobinMJD/GetTranscript
- Support: https://github.com/RobinMJD/GetTranscript/issues
- Privacy policy: https://github.com/RobinMJD/GetTranscript/blob/main/PRIVACY.md
- Screenshot: `docs/images/store-1280x800.png` (fictional meeting content)
- Logo: `public/icons/icon128.png`
