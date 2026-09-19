# Store listing source

Name: **GetTranscript — Video Transcript Exporter**

Short description:

> Export video transcripts as VTT, SRT, text, Markdown or JSON. Preserve available speaker names. Processed locally on click.

## Full description

Keep the conversation in a format you can use.

GetTranscript exports captions already available on a video page. Open the extension, select a language and format, and download. Choose WebVTT for caption tools, SRT for video editors, plain text or Markdown for notes, and JSON for structured processing.

On supported Microsoft Stream pages, GetTranscript matches the meeting’s speaker labels to the captions using their text and timestamps. It preserves existing VTT voice tags on other supported players. Unmatched captions remain unnamed.

Everything is processed locally. There is no developer server, analytics, account registration or AI processing. Only your export preferences are stored. The extension requests temporary access to the tab you select, rather than permanent access to every website.

Requirements: a readable caption track in a supported HTML5 player, or a standard Microsoft Stream recording page hosted on SharePoint. The Stream speaker adapter supports English and French transcript timestamp labels. For embedded videos, open the original player page. For pages without captions, GetTranscript cannot generate a transcript from audio. Live caption sources may expose only a rolling window.

GetTranscript is independent of Microsoft and Google. Export only content you are authorized to keep.

## Permission justifications

- **activeTab:** read the current video only after the user opens the extension.
- **scripting:** retrieve native caption cues, page-created caption blobs and transcript speaker labels from the selected tab.
- **downloads:** save the user’s chosen transcript file and verify completion.
- **storage:** remember the output format and speaker display preferences locally. No transcript text is stored here.

Single purpose: export available video captions and transcript labels into user-selected local text formats.

Remote code: none. All executable code is included in the package.

Data use: page title, captions and speaker names are processed locally for the export functionality. Do not declare that no data is accessed: it is accessed, but not collected by the developer or transmitted for processing. Complete Store privacy disclosures consistently with PRIVACY.md and the current form wording.

## First-listing requirements

Before public submission, set the verified developer/support contact and public privacy-policy URL, create new Chrome and Edge product listings, review their declarations, upload the shared package, and use screenshots containing only fictional meeting content. Add actual Store links and official badges to the README after the listings exist. Do not reuse another extension’s product ID.

## Public links

- Homepage: https://github.com/RobinMJD/GetTranscript
- Support: https://github.com/RobinMJD/GetTranscript/issues
- Privacy policy: https://github.com/RobinMJD/GetTranscript/blob/main/PRIVACY.md
- Screenshot: `docs/images/store-1280x800.png` (fictional meeting content)
- Logo: `public/icons/icon128.png`
