import {
  defaultCollectionOptions,
  type RecordingCollection,
} from "../lib/collection";
export function createDemoCollection(): RecordingCollection {
  return {
    tabId: 0,
    generation: "demo",
    revision: 1,
    sourceUrl: "https://example.com/recording-1",
    title: "Project planning workshop",
    phase: "ready",
    error: "",
    options: { ...defaultCollectionOptions, format: "md" },
    download: "idle",
    downloadIds: [],
    parts: [0, 1, 2].map((i) => ({
      id: `part-${i}`,
      url: `https://example.com/recording-${i + 1}`,
      title: `Project planning workshop${i ? ` — recording ${i + 1}` : ""}`,
      duration: [14398.35, 14402.8, 6254.65][i],
      offset: [0, 14398.35, 28801.15][i],
      selectedTrack: "en",
      status: "ready",
      error: "",
      tracks: [
        {
          key: "en",
          label: "English",
          language: "en",
          transcript: {
            title: "Project planning workshop",
            provider: "Microsoft Stream",
            language: "en",
            warnings: [],
            cues: [
              {
                id: "1",
                start: 9.651,
                end: 14.091,
                speaker: "Alex Morgan",
                text: "Let’s bring together the next steps from today’s workshop.",
              },
              {
                id: "2",
                start: 16.731,
                end: 20.527,
                speaker: "Jordan Lee",
                text: "The first milestone is ready. We can begin the review on Monday.",
              },
              {
                id: "3",
                start: 21,
                end: 27,
                speaker: "Casey Chen",
                text: "I’ll share the notes with the team after this call.",
              },
            ],
          },
        },
      ],
    })),
  };
}
