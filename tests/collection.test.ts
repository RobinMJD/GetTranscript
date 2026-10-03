import { describe, expect, it } from "vitest";
import {
  canonicalSource,
  collectionOffsets,
  defaultCollectionOptions,
  exportCollection,
  newPart,
  partTimingWarning,
  prepareCollectionTracks,
  sourceUrl,
  type RecordingCollection,
  type RecordingPart,
} from "../src/lib/collection";
import { matchSpeakers, parseVtt } from "../src/lib/transcript";
import type { Format, PageCapture, SpeakerRow } from "../src/lib/types";

const base = "https://tenant.sharepoint.com";
const recording = (suffix = "") =>
  `${base}/personal/person/_layouts/15/stream.aspx?id=${encodeURIComponent(`/personal/person/Recordings/Meeting${suffix}.mp4`)}`;
function readyPart(index: number, language = "en-US"): RecordingPart {
  return {
    ...newPart(recording(index ? ` ${index}` : "")),
    id: `part-${index + 1}`,
    title: `Meeting ${index + 1}`,
    duration: index === 0 ? 18_000 : 14_400,
    selectedTrack: `track-${language}`,
    status: "ready",
    tracks: [
      {
        key: `track-${language}`,
        label: language,
        language,
        transcript: {
          title: `Meeting ${index + 1}`,
          language,
          provider: "Microsoft Stream",
          warnings: [],
          cues: [
            {
              id: "recording/1-0",
              start: 19.2,
              end: 21.6,
              text: `Caption ${index + 1} 日本語 مرحبًا.`,
              speaker: index ? "Alex" : "Jordan",
            },
          ],
        },
      },
    ],
  };
}
function collection(format: Format = "md"): RecordingCollection {
  return {
    tabId: 5,
    generation: "test",
    revision: 1,
    sourceUrl: recording(),
    title: "Long meeting",
    parts: [readyPart(0), readyPart(1), readyPart(2)],
    phase: "ready",
    error: "",
    options: { ...defaultCollectionOptions, format },
    download: "idle",
    downloadIds: [],
  };
}

describe("recording identities", () => {
  it("normalizes Stream links without conflating distinct recording parts", () => {
    expect(canonicalSource(recording() + "&referrer=Teams#player")).toBe(
      canonicalSource(recording() + "&referrerScenario=Browser"),
    );
    expect(canonicalSource(recording())).not.toBe(
      canonicalSource(recording(" 1")),
    );
    expect(canonicalSource(recording())).toBe(
      `${base}/personal/person/Recordings/Meeting.mp4`,
    );
  });
  it("keeps meaningful query parameters on generic players", () => {
    expect(canonicalSource("https://video.example/watch?id=1#caption")).toBe(
      "https://video.example/watch?id=1",
    );
    expect(canonicalSource("https://video.example/watch?id=2")).not.toBe(
      canonicalSource("https://video.example/watch?id=1"),
    );
  });
  it("does not decode literal percent characters twice", () => {
    const literal = `${base}/_layouts/15/stream.aspx?id=${encodeURIComponent("/Recording 20%20.mp4")}`;
    expect(canonicalSource(literal)).toBe(`${base}/Recording%2020%2520.mp4`);
    expect(newPart(literal).title).toBe("Recording 20%20");
  });
  it.each([
    "file:///tmp/video.mp4",
    "javascript:alert(1)",
    "https://user:password@example.com/video",
    "not a link",
  ])("rejects invalid or credential-bearing link %s", (url) => {
    expect(() => sourceUrl(url)).toThrow();
  });
  it("allows only the source tab origin for collection links", () => {
    expect(sourceUrl(recording(), base)).toContain(base);
    expect(() => sourceUrl("https://other.sharepoint.com/video", base)).toThrow(
      "same website",
    );
    expect(() => sourceUrl("http://tenant.sharepoint.com/video", base)).toThrow(
      "same website",
    );
  });
});

describe("collection timeline", () => {
  it("uses actual video durations, including all trailing silence", () => {
    expect(collectionOffsets(collection().parts, "continuous")).toEqual([
      0, 18_000, 32_400,
    ]);
    const cues = parseVtt(exportCollection(collection("vtt"))[0].text);
    expect(cues.map((cue) => cue.start)).toEqual([19.2, 18_019.2, 32_419.2]);
    expect(cues.map((cue) => cue.speaker)).toEqual(["Jordan", "Alex", "Alex"]);
    expect(new Set(cues.map((cue) => cue.id)).size).toBe(3);
  });
  it("never substitutes the last caption for an unknown video duration", () => {
    const input = collection();
    delete input.parts[0].duration;
    expect(() => exportCollection(input)).toThrow("actual video duration");
    input.options.timeline = "local";
    expect(exportCollection(input)[0].text).toContain("00:00:19.200");
    expect(exportCollection(input)[0].text).not.toContain("combined");
  });
  it("does not require the last part’s duration to position it", () => {
    const input = collection("srt");
    delete input.parts[2].duration;
    expect(exportCollection(input)[0].text).toContain("09:00:19,200");
  });
  it("preserves explicitly supplied gaps", () => {
    const input = collection("vtt");
    input.options.timeline = "custom";
    [0, 18_010, 32_460].forEach((offset, index) => {
      input.parts[index].offset = offset;
    });
    expect(parseVtt(exportCollection(input)[0].text)[2].start).toBe(32_479.2);
  });
  it.each([undefined, -1, NaN, Infinity])(
    "rejects invalid custom offsets %s",
    (offset) => {
      const input = collection();
      input.options.timeline = "custom";
      input.parts[0].offset = offset;
      expect(() => exportCollection(input)).toThrow("valid start offset");
    },
  );
  it("rejects media overlap even when captions would not overlap", () => {
    const input = collection("vtt");
    input.options.timeline = "custom";
    [0, 100, 32_400].forEach((offset, index) => {
      input.parts[index].offset = offset;
    });
    expect(() => exportCollection(input)).toThrow("overlaps");
  });
  it("rejects duration metadata that contradicts a caption", () => {
    const input = collection();
    input.parts[0].duration = 10;
    expect(() => exportCollection(input)).toThrow("outside its video duration");
  });
  it.each([5, 5.001])(
    "bounds caption overhang at five seconds: %s",
    (overhang) => {
      const input = collection("vtt");
      input.parts[0].duration = 100;
      input.parts[0].tracks[0].transcript.cues = [
        {
          id: "tail",
          start: 99,
          end: 100 + overhang,
          text: "Boundary caption",
        },
      ];
      if (overhang <= 5) {
        expect(parseVtt(exportCollection(input)[0].text)[0].end).toBe(105);
        expect(collectionOffsets(input.parts, "continuous")[1]).toBe(100);
      } else {
        expect(() => exportCollection(input)).toThrow("export separate files");
        input.options.mode = "individual";
        expect(parseVtt(exportCollection(input)[0].text)[0].end).toBe(105.001);
      }
    },
  );
  it.each<Format>(["vtt", "srt"])(
    "keeps interleaved boundary captions and media offsets in %s",
    (format) => {
      const input = collection(format);
      input.parts = input.parts.slice(0, 2);
      input.parts[0].duration = 100;
      input.parts[0].tracks[0].transcript.cues = [
        {
          id: "tail-a",
          start: 99,
          end: 103.4,
          text: "First tail",
          speaker: "Jordan",
        },
        {
          id: "tail-b",
          start: 102.4,
          end: 103.4,
          text: "Later tail",
          speaker: "Jordan",
        },
      ];
      input.parts[1].tracks[0].transcript.cues = [
        {
          id: "next",
          start: 0.5,
          end: 1.5,
          text: "Next recording",
          speaker: "Alex",
        },
      ];
      const before = JSON.stringify(input);
      const output = exportCollection(input)[0].text;
      const vtt =
        format === "vtt"
          ? output
          : "WEBVTT\n\n" +
            output.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
      const cues = parseVtt(vtt);
      expect(cues).toHaveLength(3);
      expect(cues.map((cue) => [cue.start, cue.end])).toEqual([
        [99, 103.4],
        [100.5, 101.5],
        [102.4, 103.4],
      ]);
      expect(cues.map((cue) => cue.text)).toEqual(
        format === "vtt"
          ? ["First tail", "Next recording", "Later tail"]
          : [
              "Jordan: First tail",
              "Alex: Next recording",
              "Jordan: Later tail",
            ],
      );
      expect(JSON.stringify(input)).toBe(before);
      expect(collectionOffsets(input.parts, "continuous")).toEqual([0, 100]);
      input.options.timeline = "custom";
      input.parts[0].offset = 0;
      input.parts[1].offset = 100;
      expect(exportCollection(input)[0].text).toBe(output);
      input.parts[1].offset = 99;
      expect(() => exportCollection(input)).toThrow(
        "overlaps the preceding recording",
      );
    },
  );
  it("reports timing drift for cached tracks without inventing a video duration", () => {
    const part = readyPart(0);
    part.duration = 20;
    expect(partTimingWarning(part)).toContain("1.600 seconds");
    part.duration = 21.6;
    expect(partTimingWarning(part)).toBeUndefined();
    delete part.duration;
    expect(partTimingWarning(part)).toBeUndefined();
  });
  it.each<Format>(["md", "txt", "json"])(
    "retains the overhang warning and original timing metadata in %s",
    (format) => {
      const input = collection(format);
      input.parts[0].duration = 20;
      const warning = partTimingWarning(input.parts[0])!;
      const output = exportCollection(input)[0].text;
      expect(output).toContain(warning);
      if (format === "json") {
        const data = JSON.parse(output);
        expect(data.parts[0].duration).toBe(20);
        expect(data.parts[0].warnings).toContain(warning);
        expect(data.parts[0].cues[0]).toMatchObject({ start: 19.2, end: 21.6 });
        expect(data.parts[1].offset).toBe(20);
      }
    },
  );
  it.each<Format>(["vtt", "srt"])(
    "rejects local timestamps in combined %s",
    (format) => {
      const input = collection(format);
      input.options.timeline = "local";
      expect(() => exportCollection(input)).toThrow("continuous timeline");
    },
  );
});

describe("collection exports", () => {
  it.each<Format>(["vtt", "srt", "md", "txt", "json"])(
    "exports all parts as %s with Unicode and speakers",
    (format) => {
      const result = exportCollection(collection(format));
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe(`Long meeting.en-US.${format}`);
      for (const text of [
        "Caption 1",
        "Caption 2",
        "Caption 3",
        "日本語 مرحبًا.",
        "Alex",
        "Jordan",
      ])
        expect(result[0].text).toContain(text);
    },
  );
  it("emits compact Markdown with part sections, source and both clocks", () => {
    const input = collection();
    input.title = "Notes [test]";
    input.parts = [readyPart(0)];
    input.parts[0].title = "Meeting <one>";
    expect(exportCollection(input)[0].text).toBe(
      `# Notes \\[test\\]\n\n## Part 1 · Meeting \\<one\\>\n\n[Open recording](<${sourceUrl(recording())}>)\n\n**00:00:19.200 combined · 00:00:19.200 recording · Jordan**  \nCaption 1 日本語 مرحبًا.\n`,
    );
  });
  it("provides local cues, numeric offsets and provenance in JSON v2", () => {
    const result = JSON.parse(exportCollection(collection("json"))[0].text);
    expect(result).toMatchObject({
      schemaVersion: 2,
      timeline: "continuous",
      timeUnit: "seconds",
    });
    expect(result.parts[1]).toMatchObject({
      order: 2,
      offset: 18_000,
      sourceUrl: sourceUrl(recording(" 1")),
      duration: 14_400,
    });
    expect(result.parts[1].cues[0]).toMatchObject({
      start: 19.2,
      originalId: "recording/1-0",
      speaker: "Alex",
    });
  });
  it("removes source URLs and speaker names when toggled off", () => {
    for (const format of ["vtt", "srt", "md", "txt", "json"] as Format[]) {
      const input = collection(format);
      input.options.includeSources = false;
      input.options.speakers = false;
      const output = exportCollection(input)[0].text;
      expect(output).not.toContain(base);
      expect(output).not.toContain("Jordan");
      expect(output).not.toContain("Alex");
    }
  });
  it.each<Format>(["vtt", "srt", "md", "txt", "json"])(
    "exports individual %s files with original timing and distinct filenames",
    (format) => {
      const input = collection(format);
      input.options.mode = "individual";
      input.options.timeline = "custom";
      for (const part of input.parts) {
        delete part.duration;
        part.title = "A".repeat(250);
      }
      const result = exportCollection(input);
      expect(result).toHaveLength(3);
      expect(new Set(result.map((item) => item.filename)).size).toBe(3);
      expect(result[1].text).toContain("Caption 2");
      expect(result[1].text).not.toContain("Caption 1");
      if (format === "vtt")
        expect(parseVtt(result[1].text)[0].start).toBe(19.2);
    },
  );
  it.each<Format>(["vtt", "srt", "md", "txt", "json"])(
    "combines different caption language tags without changing the original text in %s",
    (format) => {
      const input = collection(format);
      input.parts = [
        readyPart(0, "fr-FR"),
        readyPart(1, "en-US"),
        readyPart(2, "fr-FR"),
      ];
      const text = [
        "Bonjour à tous. 日本語 مرحبًا.",
        "Let's switch to English.",
        "Revenons au français.",
      ];
      input.parts.forEach((part, i) => {
        part.tracks[0].transcript.cues[0].text = text[i];
      });
      // Already saved collections may still contain the obsolete option.
      Object.assign(input.options, { allowMixedLanguages: false });
      const [combined] = exportCollection(input);
      expect(combined.filename).toBe(`Long meeting.mul.${format}`);
      for (const original of text) expect(combined.text).toContain(original);
      expect(combined.text.indexOf(text[0])).toBeLessThan(
        combined.text.indexOf(text[1]),
      );
      expect(combined.text.indexOf(text[1])).toBeLessThan(
        combined.text.indexOf(text[2]),
      );
      input.options.mode = "individual";
      const individual = exportCollection(input);
      expect(individual[1].filename).toContain(`.en-US.${format}`);
      for (let i = 0; i < text.length; i++)
        expect(individual[i].text).toContain(text[i]);
    },
  );
  it("does not silently skip failed, missing or duplicate parts", () => {
    const input = collection();
    input.parts[1].status = "error";
    expect(() => exportCollection(input)).toThrow("Every recording");
    input.parts[1].status = "ready";
    input.parts[1].selectedTrack = "missing";
    expect(() => exportCollection(input)).toThrow("available caption track");
    input.parts[1] = { ...readyPart(0), id: "different-id" };
    expect(() => exportCollection(input)).toThrow("same recording");
  });
  it("does not derive timing from the date embedded in recording filenames", () => {
    const input = collection("json");
    input.parts[1].title = "Meeting-20261002_095923";
    expect(JSON.parse(exportCollection(input)[0].text).parts[1].offset).toBe(
      18_000,
    );
  });
});

describe("track preparation and large speaker matching", () => {
  it("resolves each track independently and preserves native voice tags", () => {
    const capture: PageCapture = {
      title: "Meeting",
      provider: "Stream",
      expectedRows: 1,
      completeRows: true,
      warnings: [],
      rows: [{ index: 1, speaker: "Panel speaker", start: 1, text: "Hello" }],
      tracks: [
        {
          key: "en",
          language: "en",
          label: "English",
          vtt: "WEBVTT\n\n1\n00:01.000 --> 00:02.000\n<v Native>Hello</v>\n",
        },
        {
          key: "ja",
          language: "ja",
          label: "日本語",
          cues: [{ id: "1", start: 1, end: 2, text: "こんにちは" }],
        },
      ],
    };
    const tracks = prepareCollectionTracks(capture);
    expect(tracks[0].transcript.cues[0].speaker).toBe("Native");
    expect(tracks[1].transcript.cues[0].speaker).toBeUndefined();
    expect(tracks[1].label).toBe("日本語");
  });
  it("matches many repeated words by time without cross-attributing speakers", () => {
    const cues = Array.from({ length: 20_000 }, (_, i) => ({
      id: String(i),
      start: i * 2 + 0.6,
      end: i * 2 + 1,
      text: "Yes.",
    }));
    const rows: SpeakerRow[] = cues.map((cue, i) => ({
      index: i,
      start: i * 2,
      text: cue.text,
      speaker: `Speaker ${i % 4}`,
    }));
    const matched = matchSpeakers(cues, rows);
    expect(matched.matched).toBe(cues.length);
    expect(matched.cues.at(-1)?.speaker).toBe("Speaker 3");
  });
  it("keeps exact ambiguity and fractional boundary rejection rules", () => {
    const cues = [{ id: "1", start: 2, end: 3, text: "Yes." }];
    expect(
      matchSpeakers(cues, [
        { index: 1, start: 2.001, text: "Yes.", speaker: "A" },
      ]).matched,
    ).toBe(1);
    expect(
      matchSpeakers(cues, [
        { index: 1, start: 0.998, text: "Yes.", speaker: "A" },
      ]).matched,
    ).toBe(0);
    expect(
      matchSpeakers(cues, [
        { index: 1, start: 1.5, text: "Yes.", speaker: "A" },
        { index: 2, start: 1.99, text: "Yes.", speaker: "B" },
      ]).matched,
    ).toBe(0);
  });
});
