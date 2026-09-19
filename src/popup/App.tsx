import { useEffect, useMemo, useState } from "react";
import {
  captureActiveTab,
  prepareTranscript,
  saveDownload,
} from "../lib/browser";
import { exportTranscript, filename, timestamp } from "../lib/transcript";
import {
  FORMATS,
  type Format,
  type PageCapture,
  type ExportOptions,
} from "../lib/types";
import { Icon } from "./Icon";
import { demoCapture } from "./demo";
const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
const friendlyError = (error: unknown) =>
  error instanceof Error &&
  !/https?:\/\/|token|script|permission/i.test(error.message)
    ? error.message
    : "This page could not be read. Open the original video page, turn captions on, and try again.";
export function App() {
  const [capture, setCapture] = useState<PageCapture | null>(null),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<Format>("vtt"),
    [speakers, setSpeakers] = useState(true),
    [visibleNames, setVisibleNames] = useState(false),
    [prefsReady, setPrefsReady] = useState(false);
  const parsed = useMemo(() => {
    if (!capture || !key) return { transcript: null, error: "" };
    try {
      return { transcript: prepareTranscript(capture, key), error: "" };
    } catch (e) {
      return { transcript: null, error: friendlyError(e) };
    }
  }, [capture, key]);
  const transcript = parsed.transcript;
  const names = [
    ...new Set(
      transcript?.cues.flatMap((c) => (c.speaker ? [c.speaker] : [])) || [],
    ),
  ];
  async function refresh() {
    setBusy(true);
    setError("");
    setStatus("");
    setCapture(null);
    try {
      const result = demo
        ? structuredClone(demoCapture)
        : await captureActiveTab();
      setCapture(result);
      setKey(result.tracks[0]?.key || "");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
    if (demo) {
      setPrefsReady(true);
      return;
    }
    void chrome.storage.local
      .get("preferences")
      .then(({ preferences }) => {
        const p = preferences as Partial<ExportOptions> | undefined;
        if (p) {
          if (FORMATS.some((f) => f.value === p.format)) setFormat(p.format!);
          if (typeof p.speakers === "boolean") setSpeakers(p.speakers);
          if (typeof p.visibleNames === "boolean")
            setVisibleNames(p.visibleNames);
        }
        setPrefsReady(true);
      })
      .catch(() => setPrefsReady(true));
  }, []);
  useEffect(() => {
    setStatus("");
    if (prefsReady && !demo)
      void chrome.storage.local
        .set({ preferences: { format, speakers, visibleNames } })
        .catch(() =>
          setStatus("Preferences could not be saved for the next visit."),
        );
  }, [format, speakers, visibleNames, prefsReady]);
  async function download() {
    if (!transcript) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const output = exportTranscript(transcript, {
        format,
        speakers,
        visibleNames,
      });
      const name = filename(transcript.title, transcript.language, format);
      if (demo) {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(
          new Blob([output.text], { type: output.mime }),
        );
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      } else await saveDownload(output.text, output.mime, name);
      setStatus("Saved to your browser’s downloads.");
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }
  function help() {
    if (demo) window.open("/help.html", "_blank", "noopener");
    else void chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
  }
  const formatInfo = FORMATS.find((f) => f.value === format)!;
  return (
    <div className="shell">
      <header>
        <div className="brand-mark">
          <Icon name="file" size={30} />
        </div>
        <div className="brand">
          <h1>GetTranscript</h1>
          <p>Transcripts, ready to keep.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh transcript"
          onClick={() => void refresh()}
          disabled={busy || saving}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <main aria-busy={busy}>
        {busy ? (
          <section className="empty" role="status">
            <div className="loader" />
            <h2>Reading this page…</h2>
            <p>Finding captions and matching speaker names.</p>
            <p className="subtle">
              Keep this popup open. Longer meetings can take a few seconds.
            </p>
          </section>
        ) : (
          <>
            {capture && (
              <>
                <section className="source">
                  <Icon name="video" size={30} />
                  <div>
                    <h2 title={capture.title}>{capture.title}</h2>
                    <p>{capture.provider}</p>
                  </div>
                </section>
                {transcript && (
                  <div className="metadata">
                    <span>
                      {transcript.cues.length.toLocaleString()}{" "}
                      {transcript.cues.length === 1 ? "caption" : "captions"}
                    </span>
                    <span>
                      {names.length
                        ? `${names.length} ${names.length === 1 ? "speaker" : "speakers"}`
                        : "No speaker labels"}
                    </span>
                  </div>
                )}
              </>
            )}
            {!transcript && !error && !parsed.error && (
              <section className="empty">
                <Icon name="file" size={34} />
                <h2>No captions found yet</h2>
                <p>
                  Turn captions on in the video, then refresh GetTranscript.
                </p>
                <p className="subtle">
                  Embedded video? Open its original page first.
                </p>
              </section>
            )}
            {transcript && (
              <>
                <label className="field">
                  Language
                  <select
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setStatus("");
                    }}
                  >
                    {capture!.tracks.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label || t.language || "Captions"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Format
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as Format)}
                  >
                    {FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-help">{formatInfo.help}</span>
                </label>
                <label className="toggle-row">
                  <span>
                    <strong>Include speaker names</strong>
                    <small>
                      {names.length
                        ? "Use the labels provided by the meeting"
                        : "This page does not provide matched names"}
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={speakers}
                    disabled={!names.length}
                    onChange={(e) => setSpeakers(e.target.checked)}
                  />
                </label>
                {format === "vtt" && (
                  <label className="toggle-row compact">
                    <strong>Show names in captions</strong>
                    <input
                      role="switch"
                      type="checkbox"
                      checked={visibleNames}
                      disabled={!speakers || !names.length}
                      onChange={(e) => setVisibleNames(e.target.checked)}
                    />
                  </label>
                )}
                {transcript.warnings.map((w, i) => (
                  <p className="notice" key={i}>
                    <Icon name="alert" size={16} />
                    <span>{w}</span>
                  </p>
                ))}
                <section className="preview">
                  <h2>Preview</h2>
                  {transcript.cues.slice(0, 2).map((c, i) => (
                    <div className="preview-row" key={i}>
                      <time>
                        {timestamp(c.start).split(".")[0].replace(/^00:/, "")}
                      </time>
                      <div>
                        {speakers && c.speaker && <strong>{c.speaker}</strong>}
                        <p>{c.text}</p>
                      </div>
                    </div>
                  ))}
                </section>
              </>
            )}
          </>
        )}
        {(error || parsed.error) && (
          <p className="notice error" role="alert">
            <Icon name="alert" />
            <span>{error || parsed.error}</span>
          </p>
        )}
      </main>
      <footer>
        {status && (
          <p className="save-status" role="status">
            {status}
          </p>
        )}
        <button
          className="primary"
          onClick={() => void download()}
          disabled={!transcript || busy || saving}
        >
          <Icon name="download" />
          {saving ? "Saving…" : `Download ${format.toUpperCase()}`}
        </button>
        <div className="footer-meta">
          <span>
            <Icon name="shield" size={17} />
            Processed on this device
          </span>
          <button className="text-button" onClick={help}>
            Help
          </button>
        </div>
      </footer>
    </div>
  );
}
