# GetTranscript privacy policy

Effective September 20, 2026. Version 1.2.0.

GetTranscript runs locally in your browser. It has no developer-operated service, analytics, advertising or account system. The developer does not receive your transcripts.

## What the extension accesses

When you open GetTranscript, temporary active-tab access permits it to inspect the current video page, its readable caption tracks and its transcript panel. This may include the page title, caption language, spoken text, timestamps and existing speaker labels. Same-origin embedded documents may be inspected as part of that page.

Referenced caption resources may be fetched directly from their existing host. Same-origin requests use the browser’s existing authentication; cross-origin requests do not include credentials. GetTranscript does not collect, store or export authentication cookies or tokens, and it does not create a separate Microsoft application.

## Storage and sharing

Transcript content, selected caption track, export options and download status are held per tab in `chrome.storage.session`, the browser’s temporary in-memory extension storage. A background worker continues a user-requested scan or export when the popup closes. Reopening the popup restores the same job or result. No transcript history is saved to persistent extension storage. Selecting Download saves the chosen text file through the browser download manager. Downloaded files and browser download history remain under your control.

Only export format and the two speaker display preferences are stored in `chrome.storage.local`. They are not synchronized by GetTranscript. There is no transcript history database.

GetTranscript does not send your content to an AI provider, the developer or another cloud processing service. It does not sell data.

Store data-use disclosures cover locally processed website content, personal communications in meeting transcripts, and personally identifiable information such as speaker names. These disclosures describe what the extension accesses, not data received by the developer. GetTranscript uses this data solely for its transcript-export purpose and complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. It does not use or transfer data for advertising, creditworthiness or lending.

## Controls and deletion

You choose when to open the extension and when to download. Refresh replaces the current tab’s cached result; closing that source tab clears its session. Navigating within the same tab retains the prior result until Refresh. Browser restart, extension reload/update or disabling the extension also clears temporary sessions. Delete downloaded files through your operating system and clear download history in the browser if desired. Removing the extension removes its local preferences according to your browser’s extension storage lifecycle.

## Permissions

- `activeTab`: temporary access to the page you select through the extension toolbar.
- `scripting`: read captions and transcript labels in the page’s execution context.
- `downloads`: save a chosen export and confirm its download state.
- `storage`: remember export preferences locally and retain active per-tab jobs/results in temporary session memory.

No persistent host permissions, cookie permission, browsing-history permission or debugger permission are requested.

## Support and privacy contact

For questions, use the [project support page](https://github.com/RobinMJD/GetTranscript/issues). Do not include transcript content, credentials or private meeting links in a public issue. Report sensitive security concerns through [private vulnerability reporting](https://github.com/RobinMJD/GetTranscript/security/advisories/new).
