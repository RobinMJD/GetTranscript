# Security model

GetTranscript reads content exposed to the signed-in page. It does not change server-side permissions, disable controls, intercept credentials, invoke a remote transcription service or decrypt protected network traffic. Export only material you are authorized to retain.

The page is an untrusted input boundary. The collector runs in MAIN world to read native text tracks and page-created caption blobs; it receives no privileged extension objects or secrets. Its result is parsed and validated before display or download. React renders labels as text, caption markup is decoded as text, output formats escape their own syntax, and filenames discard path separators, control characters, reserved device names and bidirectional control marks.

There are bounded cue, text, frame, track, response-size and collection-time limits. Virtualized transcript rows are collected in resumable chunks with an 18-second work deadline; each active capture invocation has a 10-minute budget, renewed when a paused capture is explicitly resumed. Rows and selected collection exports are bounded to 50,000 entries and 5 million text characters, with additional serialized-output and temporary-storage guards. Ambiguous or mismatched speaker labels are never assigned. A failure leaves unmatched cues unnamed or prevents export; it does not invent success.

Recording collections accept at most 20 user-selected same-origin links. Exposed Stream anchors are candidates for user selection; the extension does not enumerate filenames or silently add presumed meeting parts. URLs are validated, credentials in URLs are rejected, and canonical source identities prevent duplicate parts or reuse of another recording’s cached captions. Navigation targets and chunk identities are checked, and conflicting rows stop capture. Single-page and multipart work share a per-tab lease so they cannot manipulate the same player concurrently.

Speakers are resolved within each part before combining. Original cue times are retained in individual exports; combined timelines use full media durations or explicit user offsets, never guessed filename times or caption ends. Custom starts reject overlapping parts. Differing caption languages need explicit user consent for a combined export. All parts must finish or be explicitly removed before export. Combined JSON schema version 2 retains each part’s local cue timings and offset.

The manifest grants only `activeTab`, `scripting`, `downloads` and `storage`; multipart collection adds no permissions. It navigates the authorized source tab among same-origin recordings, then restores its starting page and available playback state unless the user navigated elsewhere. No content scripts run continuously. No externally connectable messaging is exposed. The background worker accepts job messages only from its corresponding packaged popup or collection-page URL and validates tab IDs and request options.

Transcripts, recording URLs, queue state and resumable checkpoints are cached only in trusted-context `storage.session`. Refresh replaces captured content, source-tab close clears its sessions and collection, and browser/extension restart clears all temporary state. Collection refresh retains its selected links and options for a fresh read. Only export preferences use persistent local storage. No transcript database is created. The extension page CSP permits packaged scripts only and blocks remote connections. Page-local caption fetches are restricted to referenced HTTP(S) and blob track URLs and use normal browser CORS and authentication rules.

Tests use intercepted fictional pages and a separate temporary browser profile. Fixture-only host permissions and test keys never enter the distributable package. Real meeting captures used for acceptance must stay outside the repository.

## Reporting

Report security issues through [GitHub private vulnerability reporting](https://github.com/RobinMJD/GetTranscript/security/advisories/new). Do not put credentials, private transcripts or private meeting URLs into a public issue.
