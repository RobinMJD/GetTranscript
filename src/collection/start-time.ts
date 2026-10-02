/** User-entered custom starts support clock notation or numeric seconds. */
export function parseStartTime(value: string): number | null {
  const text = value.trim().normalize("NFKC");
  let seconds: number;
  const clock = /^(\d{1,3}):([0-5]\d):([0-5]\d)(?:[.,](\d{1,3}))?$/.exec(text);
  if (clock) {
    seconds =
      +clock[1] * 3600 +
      +clock[2] * 60 +
      +clock[3] +
      (clock[4] ? +clock[4].padEnd(3, "0") / 1000 : 0);
  } else if (/^\d+(?:[.,]\d{1,3})?$/.test(text)) {
    seconds = Number(text.replace(",", "."));
  } else return null;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 360000
    ? seconds
    : null;
}
