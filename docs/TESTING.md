# Test the local GetTranscript build

Use this route to try v1.3.1 before authorizing any Store submission. Loading an unpacked extension installs it only in your browser; it does not publish it.

## Install in Chrome or Edge

1. Use the supplied `GetTranscript-Test-1.3.1` folder in Downloads, or extract `gettranscript-v1.3.1-unpacked.zip` and keep its `GetTranscript-Test-1.3.1` folder. Select this folder directly: it contains `manifest.json`, `index.html` and `background.js`. If building from source, run `npm ci`, `npm run build` and `npm run package:dev` to produce the development package.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. Temporarily turn off the Store-installed GetTranscript copy so the two identical toolbar icons do not cause confusion. Keep it installed.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder from step 1. Check that the extension card shows **GetTranscript — Test build** and version **1.3.1**. Pin this local copy to the toolbar if useful.
4. Open the actual recording page in the same browser profile where you can already watch it. Click the local GetTranscript icon on that video tab to grant access.

These are the browsers’ documented local installation flows: [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading).

Keep the unpacked folder in place while testing. For a replacement build, update that folder, click **Reload** on its extension card, then reopen GetTranscript on the video tab. Reloading the extension clears its temporary results.

## Try your split recording

Open the first recording, choose **More options → Combine recordings**, and add the other recording links with **Add recordings**. Confirm their order and choose **Read recordings**. Keep the source video tab open; the collection uses it to visit the parts and returns to its starting page afterward. You can close the popup or workspace while reading.

**Format** and **Export** remain editable during reading. Use **Advanced options** for custom start times, original recording times, speaker names and source links. Custom times accept `04:02:00`, `04:02:00.125` or seconds such as `14520`.

## Acceptance checks

| Check                         | Expected result                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold Stream page              | Reload the recording with its Transcript panel closed and captions off, then open GetTranscript. Available captions load without requiring you to open the panel first. If the page cannot expose captions, it reports that limitation instead of claiming an empty transcript is complete.                                                                                           |
| Source tab in the background  | Keep the collection workspace active while it reads the video tab. Compare each part’s caption count, last caption time and named-speaker coverage with a foreground read. The direct metadata path should agree. A player that only exposes speaker rows in a visible panel must show an explicit incomplete-speaker warning; it must not invent names or remain stuck indefinitely. |
| Immediate Pause               | Start a collection while the popup is still reading its source, then click Pause immediately. The queued collection pauses promptly, without navigating the source tab. You can select VTT and Continue later.                                                                                                                                                                        |
| Active Pause and Continue     | Pause after a part starts reading, then Continue. Progress is preserved; the result includes the full set of captions available from each selected recording.                                                                                                                                                                                                                         |
| Three-part export             | Download combined Markdown and VTT, then separate SRT files. All three parts appear in order; the separate files arrive in one ZIP. Combined timing advances by full video durations, including silence. Separate files retain original timestamps.                                                                                                                                   |
| Speaker and language accuracy | Spot-check the first and last named cues in each part against the recording. Native names remain intact; unmatched cues remain unnamed. Changes of spoken language within or between parts preserve the original text and never block combination. A Caption track selector appears only if a player supplies separate tracks.                                                        |
| Reopen and reset              | Closing/reopening the popup or workspace preserves progress, format and results. Refresh collection clears captured content but keeps its links/order/options. Closing the source video tab clears the collection.                                                                                                                                                                    |

A caption count or speaker count alone is not proof of completeness: check the last caption time and a few cues near each part’s end. Record whether a test used a fresh page, whether the video tab stayed visible, the per-part counts, and any warning. If the foreground and background results differ, keep both exported files for comparison; the meeting text need not be pasted into an issue.

## Finish testing

Turn off or remove the unpacked test copy, then re-enable the Store copy. Store publication is a separate step after the local result has been accepted.
