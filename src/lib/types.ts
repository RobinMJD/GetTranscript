export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
}
export interface SpeakerRow {
  index: number;
  speaker?: string;
  start?: number;
  text: string;
}
export interface RawTrack {
  key: string;
  label: string;
  language: string;
  vtt?: string;
  cues?: Cue[];
  textFormat?: "plain";
}
export interface RowCursor {
  sourceUrl: string;
  nextScrollTop: number;
  expectedRows: number;
  startedAt?: number;
  speakerNames?: string[];
  timeUnits?: [string, number][];
  ambiguousUnits?: string[];
}
export interface PageCapture {
  title: string;
  provider: string;
  tracks: RawTrack[];
  rows: SpeakerRow[];
  expectedRows: number;
  completeRows: boolean;
  warnings: string[];
  sourceUrl?: string;
  duration?: number;
  linkedRecordings?: { url: string; title: string }[];
  rowCursor?: RowCursor;
}
export interface Transcript {
  title: string;
  provider: string;
  language: string;
  cues: Cue[];
  warnings: string[];
}
export type Format = "vtt" | "srt" | "txt" | "md" | "json";
export interface ExportOptions {
  format: Format;
  speakers: boolean;
  visibleNames: boolean;
}
export const FORMATS: { value: Format; label: string; help: string }[] = [
  {
    value: "vtt",
    label: "WebVTT (.vtt)",
    help: "Timed captions for video players",
  },
  {
    value: "srt",
    label: "SubRip (.srt)",
    help: "Subtitles for video editors and players",
  },
  {
    value: "txt",
    label: "Plain text (.txt)",
    help: "A readable transcript with timestamps",
  },
  {
    value: "md",
    label: "Markdown (.md)",
    help: "Meeting notes for your documents",
  },
  {
    value: "json",
    label: "JSON (.json)",
    help: "Structured text, timings and speaker names",
  },
];
