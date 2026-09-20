# Security model

GetTranscript reads content exposed to the signed-in page. It does not change server-side permissions, disable controls, intercept credentials, invoke a remote transcription service or decrypt protected network traffic. Export only material you are authorized to retain.

The page is an untrusted input boundary. The collector runs in MAIN world to read native text tracks and page-created caption blobs; it receives no privileged extension objects or secrets. Its result is parsed and validated before display or download. React renders labels as text, caption markup is decoded as text, output formats escape their own syntax, and filenames discard path separators, control characters, reserved device names and bidirectional control marks.

There are bounded cue, text, frame, track, response-size and collection-time limits. Ambiguous or mismatched speaker labels are never assigned. Existing cue timing is retained, including overlaps. A failure leaves unmatched cues unnamed or prevents export; it does not invent success.

The manifest grants only `activeTab`, `scripting`, `downloads` and `storage`. No content scripts run continuously. No externally connectable messaging is exposed. The background worker accepts job messages only from its own popup URL and validates tab IDs and export options. Transcripts are cached only in trusted-context session memory, cleared on Refresh, tab close or browser/extension restart; only export preferences use persistent local storage. The extension page CSP permits packaged scripts only and blocks remote connections. Page-local caption fetches are restricted to referenced HTTP(S) and blob track URLs and use normal browser CORS and authentication rules.

Tests use intercepted fictional pages and a separate temporary browser profile. Fixture-only host permissions and test keys never enter the distributable package. Real meeting captures used for acceptance must stay outside the repository.

## Reporting

Report security issues through [GitHub private vulnerability reporting](https://github.com/RobinMJD/GetTranscript/security/advisories/new). Do not put credentials, private transcripts or private meeting URLs into a public issue.
