import { describe, expect, it } from "vitest";
import { parseStartTime } from "../src/collection/start-time";
describe("custom recording start time", () => {
  it("reads hours, minutes, seconds and milliseconds without losing long meeting times", () => {
    expect(parseStartTime("04:02:00")).toBe(14520);
    expect(parseStartTime("13:04:05.125")).toBe(47045.125);
    expect(parseStartTime("00:00:00.5")).toBe(0.5);
    expect(parseStartTime("100:00:00")).toBe(360000);
    expect(parseStartTime("０４:０２:００")).toBe(14520);
  });
  it("accepts numeric seconds and decimal comma input", () => {
    expect(parseStartTime(" 14520 ")).toBe(14520);
    expect(parseStartTime("14400.125")).toBe(14400.125);
    expect(parseStartTime("04:02:00,125")).toBe(14520.125);
    expect(parseStartTime("0")).toBe(0);
  });
  it("rejects ambiguous clocks, overflow, negative times and invalid numbers", () => {
    for (const text of [
      "",
      " ",
      "04:02",
      "04:60:00",
      "04:02:60",
      "-1",
      "NaN",
      "1e3",
      "100:00:00.001",
      "360001",
      "12.0001",
      "04:02:00.0001",
    ])
      expect(parseStartTime(text)).toBeNull();
  });
});
