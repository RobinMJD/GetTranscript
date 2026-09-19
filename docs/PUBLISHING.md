# Publishing GetTranscript

The release structure follows QuickPIM++ and UseMyCurrentAccount++: one browser-neutral ZIP, an exact version tag, validation before publication, independently retryable publishers, and separate reporting of submission and public availability.

## First publication

1. Approve the GetTranscript name, public repository destination, listing copy, screenshots, privacy policy and support contact.
2. Create the public repository and enable private vulnerability reporting.
3. Create **new** Chrome and Edge listings. Record publisher/product identifiers only in an ignored `PUBLISHING_RUNBOOK.local.md` and protected GitHub environment secrets.
4. Publish a stable public privacy-policy URL and verify it resolves before completing the Store forms.
5. Configure `chrome-web-store` and `edge-addons` GitHub environments with review gates as appropriate. Keep Store publishers disabled until their new identities are verified.
6. Set repository variables `CHROME_PUBLISH_ENABLED=true` and `EDGE_PUBLISH_ENABLED=true` only when those listings are ready.

Never copy the other extensions’ Store IDs into GetTranscript. Existing personal developer credentials may be reusable only through their authorized publisher accounts, but no credentials are copied into source or ZIP files.

## Every release

1. Update `package.json`, root package-lock version fields, `public/manifest.json`, README and help-page version.
2. Run `npm ci`, `npm run verify`, `npm run test:browser`, `npm audit --audit-level=low`, and `npm run package:stores`.
3. Inspect the popup at 400 × 600 and confirm the current Store screenshots contain fictional data. Test a real supported meeting separately, including speaker matching and file readability.
4. Stage explicit source paths, commit, and push `main`. Create and push the matching `vX.Y.Z` tag.
5. The release workflow checks exact tag identity and ancestry, repeats validation, creates the package once and passes the same bytes to all enabled publishers.
6. Verify the GitHub release asset hash, the Chrome submission status, and the Edge operation status. “Pending review” and “accepted for certification” do not mean public availability.
7. Verify the public Store versions after review and record the result in the local runbook.

## Configuration names

Chrome environment secrets:

`CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET`, `CHROME_WEBSTORE_REFRESH_TOKEN`, `CHROME_WEBSTORE_PUBLISHER_ID`, `CHROME_WEBSTORE_EXTENSION_ID`.

Edge environment secrets:

`EDGE_ADDONS_CLIENT_ID`, `EDGE_ADDONS_API_KEY`, `EDGE_ADDONS_PRODUCT_ID`.

The workflow supplies ZIP paths. Store credentials are never needed for local builds or normal extension use.

## Recovery

Rerun the release workflow with the existing tag and `publish_target` set to `github`, `chrome` or `edge`. The GitHub publisher compares existing package bytes and refuses to overwrite a different asset. A failed upload must not be reported as a successful submission. A pending Chrome review is left intact; cancel it separately only when intentionally replacing that review.

Store APIs generally update existing products. Initial listing creation, support/contact details and declarations remain a separate first-publication step.

## Reference documentation

- [Chrome extension scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/api)
- [Microsoft Edge Add-ons API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api)
- [WebVTT voice annotations](https://www.w3.org/TR/webvtt1/)
