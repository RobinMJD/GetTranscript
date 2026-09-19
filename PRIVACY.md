# CueKit privacy policy

Effective September 19, 2026. Version 1.0.0.

CueKit runs locally in your browser. It has no developer-operated service, analytics, advertising or account system. The developer does not receive your transcripts.

## What the extension accesses

When you open CueKit, temporary active-tab access permits it to inspect the current video page, its readable caption tracks and its transcript panel. This may include the page title, caption language, spoken text, timestamps and existing speaker labels. Same-origin embedded documents may be inspected as part of that page.

Referenced caption resources may be fetched directly from their existing host. Same-origin requests use the browser’s existing authentication; cross-origin requests do not include credentials. CueKit does not collect, store or export authentication cookies or tokens, and it does not create a separate Microsoft application.

## Storage and sharing

Transcript content stays in the popup’s memory during use. Closing the popup discards that extension-side copy. Selecting Download saves the chosen text file through the browser download manager. Downloaded files and browser download history remain under your control.

Only export format and the two speaker display preferences are stored in `chrome.storage.local`. They are not synchronized by CueKit. There is no transcript history database.

CueKit does not send your content to an AI provider, the developer or another cloud processing service. It does not sell data.

## Controls and deletion

You choose when to open the extension and when to download. Delete downloaded files through your operating system and clear download history in the browser if desired. Removing the extension removes its local preferences according to your browser’s extension storage lifecycle.

## Permissions

- `activeTab`: temporary access to the page you select through the extension toolbar.
- `scripting`: read captions and transcript labels in the page’s execution context.
- `downloads`: save a chosen export and confirm its download state.
- `storage`: remember export preferences locally.

No persistent host permissions, cookie permission, browsing-history permission or debugger permission are requested.

## Support

For a Store release, use the verified support contact in its official listing or the project’s GitHub issue tracker. Do not attach private transcripts or authentication material to a public issue. Store publication must include a verified support destination before it is submitted.
