import type { PageCapture } from "../lib/types";
export const demoCapture: PageCapture = {
  title: "Weekly project sync",
  provider: "Microsoft Stream",
  tracks: [
    {
      key: "en",
      label: "English",
      language: "en",
      cues: [
        {
          id: "1",
          start: 9,
          end: 14,
          text: "Let’s start with the project updates.",
          speaker: "Alex Morgan",
        },
        {
          id: "2",
          start: 16,
          end: 21,
          text: "The first milestone is ready to review.",
          speaker: "Jordan Lee",
        },
        {
          id: "3",
          start: 22,
          end: 27,
          text: "I will share the next steps after this meeting.",
          speaker: "Alex Morgan",
        },
      ],
    },
    {
      key: "fr",
      label: "French",
      language: "fr",
      cues: [
        {
          id: "1",
          start: 9,
          end: 14,
          text: "Commençons par les nouvelles du projet.",
          speaker: "Alex Morgan",
        },
      ],
    },
  ],
  rows: [],
  expectedRows: 0,
  completeRows: true,
  warnings: [],
};
