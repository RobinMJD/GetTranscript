import { describe, it, expect } from "vitest";
import {
  parseVtt,
  exportTranscript,
  filename,
  matchSpeakers,
  parseSpeakerLabel,
  timestamp,
  validateCues,
} from "../src/lib/transcript";
import type { Transcript, Format } from "../src/lib/types";
const raw =
  "WEBVTT\r\n\r\nmeeting/1-0\r\n00:00:09.651 --> 00:00:11.000\r\nHello &amp; welcome.\r\n\r\nmeeting/1-1\r\n00:00:11.000 --> 00:00:14.091\r\nLet’s begin.\r\n\r\nmeeting/2-0\r\n00:00:12.020 --> 00:00:12.500\r\nYes.\r\n";
const rows = [
  {
    index: 1,
    label: "Alex Morgan 0 minutes 9 seconds",
    text: "Hello & welcome. Let’s begin.",
  },
  { index: 2, label: "Jordan Lee 0 minutes 12 seconds", text: "Yes." },
];
const transcript: Transcript = {
  title: "Weekly sync",
  language: "en",
  provider: "HTML5 video",
  cues: matchSpeakers(parseVtt(raw), rows).cues,
  warnings: [],
};
describe("captions and speaker attribution", () => {
  it("matches split utterances exactly, including overlapping speakers", () => {
    const r = matchSpeakers(parseVtt(raw), rows);
    expect(r.matched).toBe(3);
    expect(r.cues.map((c) => c.speaker)).toEqual([
      "Alex Morgan",
      "Alex Morgan",
      "Jordan Lee",
    ]);
    expect(r.cues[1].end).toBe(14.091);
  });
  it("refuses ambiguous speaker candidates", () => {
    const r = matchSpeakers(parseVtt(raw), [
      ...rows,
      { ...rows[0], index: 3, label: "Casey 0 minutes 9 seconds" },
    ]);
    expect(r.cues[0].speaker).toBeUndefined();
    expect(r.cues[2].speaker).toBe("Jordan Lee");
  });
  it("refuses mismatched text or timing instead of guessing", () => {
    expect(
      matchSpeakers(parseVtt(raw), [{ ...rows[0], text: "Different text" }])
        .matched,
    ).toBe(0);
    expect(
      matchSpeakers(parseVtt(raw), [
        { ...rows[0], label: "Alex 0 minutes 8 seconds" },
      ]).matched,
    ).toBe(0);
  });
  it.each([
    "Alex 16 minutes",
    "Alex 16 minutes 0 seconds",
    "Alex 16 minutes 0 secondes",
  ])("handles omitted zero seconds and French: %s", (label) =>
    expect(parseSpeakerLabel(label)).toEqual({ name: "Alex", time: 960 }),
  );
  it("rejects unsupported label formats", () =>
    expect(parseSpeakerLabel("Unknown without time")).toBeUndefined());
  it("reads voice tags, annotations, BOM and minute-only timestamps", () => {
    const c = parseVtt(
      "\uFEFFWEBVTT\n\nNOTE metadata\nignore this\n\n1\n00:09.010 --> 00:10.000 align:start\n<v Alex>A &lt;tag&gt;</v>\n",
    );
    expect(c[0]).toMatchObject({
      speaker: "Alex",
      text: "A <tag>",
      start: 9.01,
    });
  });
  it("keeps multiple voices unattributed", () =>
    expect(
      parseVtt(
        "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Alex>Hi</v><v Jordan>Hello</v>",
      )[0].speaker,
    ).toBeUndefined());
  it("rejects encrypted, invalid, nonfinite and reversed caption data", () => {
    expect(() => parseVtt("binary")).toThrow();
    expect(() => parseVtt("WEBVTT\n\n00:90.000 --> 00:99.000\nHi")).toThrow();
    expect(() =>
      validateCues([{ id: "1", start: NaN, end: 3, text: "Hi" }]),
    ).toThrow();
    expect(() =>
      validateCues([{ id: "1", start: 5, end: 3, text: "Hi" }]),
    ).toThrow();
  });
  it("does not discard literal angle brackets on export", () => {
    const t = {
      ...transcript,
      cues: parseVtt(
        "WEBVTT\n\n00:00.000 --> 00:01.000\nA &lt;tag&gt; &amp; B",
      ),
    };
    const result = exportTranscript(t, {
      format: "vtt",
      speakers: true,
      visibleNames: false,
    });
    expect(parseVtt(result.text)[0].text).toBe("A <tag> & B");
  });
});
describe("export formats", () => {
  it.each<Format>(["vtt", "srt", "txt", "md", "json"])(
    "exports %s with unicode and speaker names",
    (format) => {
      const result = exportTranscript(transcript, {
        format,
        speakers: true,
        visibleNames: false,
      });
      expect(result.text).toContain("Alex Morgan");
      expect(result.text).toContain("Let’s begin.");
      expect(result.mime).toBeTruthy();
    },
  );
  it("round trips VTT timings, text and names", () => {
    const exported = exportTranscript(transcript, {
      format: "vtt",
      speakers: true,
      visibleNames: false,
    });
    expect(parseVtt(exported.text)).toEqual(transcript.cues);
  });
  it("uses decimal commas, continuous numbering and visible names in SRT", () => {
    const s = exportTranscript(transcript, {
      format: "srt",
      speakers: true,
      visibleNames: false,
    }).text;
    expect(s).toContain(
      "1\n00:00:09,651 --> 00:00:11,000\nAlex Morgan: Hello &amp; welcome.",
    );
    expect(s).toContain("3\n");
  });
  it("can display names in VTT text", () =>
    expect(
      exportTranscript(transcript, {
        format: "vtt",
        speakers: true,
        visibleNames: true,
      }).text,
    ).toContain("<v Alex Morgan>Alex Morgan:"));
  it("removes speaker names from every format when switched off", () => {
    for (const format of ["vtt", "srt", "txt", "md", "json"] as Format[])
      expect(
        exportTranscript(transcript, {
          format,
          speakers: false,
          visibleNames: true,
        }).text,
      ).not.toContain("Alex Morgan");
  });
  it("preserves seconds as numbers in JSON", () => {
    const data = JSON.parse(
      exportTranscript(transcript, {
        format: "json",
        speakers: true,
        visibleNames: false,
      }).text,
    );
    expect(data.timeUnit).toBe("seconds");
    expect(data.cues[0].start).toBe(9.651);
  });
  it("escapes Markdown links and HTML", () => {
    const t = {
      ...transcript,
      title: "<img src=x>",
      cues: [{ id: "1", start: 0, end: 1, text: "[click](bad) <script>" }],
    };
    const out = exportTranscript(t, {
      format: "md",
      speakers: true,
      visibleNames: false,
    }).text;
    expect(out).toContain("\\[click\\]");
    expect(out).toContain("\\<script\\>");
  });
  it("rounds millisecond carry without invalid timestamps", () =>
    expect(timestamp(59.9996)).toBe("00:01:00.000"));
  it("creates portable filenames without path traversal or bidi characters", () => {
    expect(filename("../../CON<>:/meeting\u202e", "fr/FR", "vtt")).toBe(
      "CON meeting.fr FR.vtt",
    );
    expect(filename("CON", "en", "srt")).toBe("Transcript CON.en.srt");
    expect(filename("", "en", "vtt")).toBe("Transcript.en.vtt");
  });
});
