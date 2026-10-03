# Test the local GetTranscript build

Use this route to try v1.3.1 before authorizing any Store submission. Loading an unpacked extension installs it only in your browser; it does not publish it.

## Install in Chrome or Edge

1. Use the supplied `GetTranscript-Test-1.3.1` folder in Downloads, or extract `gettranscript-v1.3.1-unpacked.zip` and keep its `GetTranscript-Test-1.3.1` folder. Select this folder directly: it contains `manifest.json`, `index.html` and `background.js`. If building from source, run `npm ci`, `npm run build` and `npm run package:dev` to produce the development package.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge. The Store copy can remain installed and enabled; use the local copy's distinct toolbar label and extension card to tell them apart.
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder from step 1. Check that the extension card shows **GetTranscript — Test build** and version **1.3.1 local test 3**. Pin this local copy to the toolbar if useful.
4. Open the actual recording page in the same browser profile where you can already watch it. Choose the toolbar or Extensions menu entry labeled **GetTranscript — Local test 3** to grant access. Open Combine recordings from that local copy; an existing workspace from the Store copy still runs its older version.

These are the browsers’ documented local installation flows: [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), [Microsoft Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading).

Keep the unpacked folder in place while testing. For a replacement build, update that folder, click **Reload** on its **GetTranscript — Test build** extension card, then reopen **GetTranscript — Local test 3** on the video tab. Reloading the extension clears its temporary results. Close an old Store-version Combine recordings workspace and open a fresh workspace from the local copy.

## Try your split recording

Open the first recording, choose **More options → Combine recordings**, and add the other recording links with **Add recordings**. Confirm their order and choose **Read recordings**. Keep the source video tab open; the collection uses it to visit the parts and returns to its starting page afterward. You can close the popup or workspace while reading.

**Format** and **Export** remain editable during reading. Use **Advanced options** for custom start times, original recording times, speaker names and source links. Custom times accept `04:02:00`, `04:02:00.125` or seconds such as `14520`.

Stream pages get up to 45 seconds to expose their player and captions. GetTranscript opens supported Transcript controls automatically, including controls that appear or become enabled late. If a part still needs attention, choose **Open recording**, open **Transcript** on that page, then return to the workspace and choose **Retry this part**. Retry reads the current recording in place instead of reloading it, so manually opened captions stay available. Other ready parts remain saved.

A timing warning can appear when captions end slightly after the recording's reported duration. Overhangs up to 5 seconds are allowed without trimming cues or changing the video duration and offsets. Larger differences block a shared timeline; refresh the recording or keep original timestamps, including separate VTT/SRT files.

## Acceptance checks

| Check                         | Expected result                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold Stream page              | Reload the recording with its Transcript panel closed and captions off, then open GetTranscript. Allow up to 45 seconds for a slow player and its captions. Supported Transcript controls open automatically. If captions remain unavailable, the part reports a recovery action rather than treating the recording as complete.                                                      |
| Failed-part recovery          | Choose Open recording on a failed part; the source tab comes to the foreground. Open Transcript, return to the collection, and retry. There is no extra reload of that recording, its captions become readable, and previously ready parts retain their captions and speakers.                                                                                                        |
| Source tab in the background  | Keep the collection workspace active while it reads the video tab. Compare each part’s caption count, last caption time and named-speaker coverage with a foreground read. The direct metadata path should agree. A player that only exposes speaker rows in a visible panel must show an explicit incomplete-speaker warning; it must not invent names or remain stuck indefinitely. |
| Immediate Pause               | Start a collection while the popup is still reading its source, then click Pause immediately. The queued collection pauses promptly, without navigating the source tab. You can select VTT and Continue later.                                                                                                                                                                        |
| Active Pause and Continue     | Pause after a part starts reading, then Continue. Progress is preserved; the result includes the full set of captions available from each selected recording.                                                                                                                                                                                                                         |
| Three-part export             | Download combined Markdown and VTT, then separate SRT files. All three parts appear in order; the separate files arrive in one ZIP. Combined timing advances by full video durations, including silence. Separate files retain original timestamps.                                                                                                                                   |
| Speaker and language accuracy | Spot-check the first and last named cues in each part against the recording. Native names remain intact; unmatched cues remain unnamed. Changes of spoken language within or between parts preserve the original text and never block combination. A Caption track selector appears only if a player supplies separate tracks.                                                        |
| Reopen and reset              | Closing/reopening the popup or workspace preserves progress, format and results. Refresh collection clears captured content but keeps its links/order/options. Closing the source video tab clears the collection.                                                                                                                                                                    |

A caption count or speaker count alone is not proof of completeness: check the last caption time and a few cues near each part’s end. Record whether a test used a fresh page, whether the video tab stayed visible, the per-part counts, and any warning. If the foreground and background results differ, keep both exported files for comparison; the meeting text need not be pasted into an issue.

Live local testing in signed-in Edge read all three recordings in the background without a manual Transcript click, producing 7,149 captions. The combined download exposed a 3.370-second caption overhang in the second part; the compatibility handling above addresses that case. The corrected combined VTT downloaded successfully and was compared with the separate-file ZIP: all 7,149 caption texts and speaker tags were preserved, start times were ordered, and offsets used the reported video durations. This verifies extraction and export for this recording; it does not establish the transcription accuracy of every spoken word or replace the remaining acceptance checks above.

## Finish testing

Turn off or remove the unpacked test copy when finished. If you temporarily disabled the Store copy, re-enable it. Store publication is a separate step after the local result has been accepted.
