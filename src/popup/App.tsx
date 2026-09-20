import { useEffect, useMemo, useRef, useState } from "react";
import { prepareTranscript } from "../lib/browser";
import {
  defaults,
  friendlyError,
  sessionKey,
  type SessionReply,
  type SessionRequest,
  type TabSession,
} from "../lib/session";
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
export function App() {
  const [session, setSession] = useState<TabSession | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const tabId = useRef<number | null>(null);
  const revision = useRef(-1);
  const editSequence = useRef(0);
  const pendingEdit = useRef<{
    key: string;
    options: ExportOptions;
    sequence: number;
  } | null>(null);
  const capture: PageCapture | null = session?.capture || null;
  const key = session?.key || "";
  const busy = !connectionError && (!session || session.phase === "reading");
  const saving = session?.download === "saving";
  const error = connectionError || session?.error || "";
  const restricted = session?.restricted || false;
  const status =
    session?.download === "complete"
      ? "Saved to your browser’s downloads."
      : "";
  const { format, speakers, visibleNames } = session?.options || defaults;
  function apply(state: TabSession) {
    if (state.tabId === tabId.current && state.revision >= revision.current) {
      revision.current = state.revision;
      setSession(
        pendingEdit.current
          ? {
              ...state,
              key: pendingEdit.current.key,
              options: pendingEdit.current.options,
            }
          : state,
      );
    }
  }
  async function request(message: SessionRequest, edit?: number) {
    try {
      const reply: SessionReply = await chrome.runtime.sendMessage(message);
      if (!reply || "error" in reply)
        throw new Error(
          reply?.error || "The extension could not reconnect. Try Refresh.",
        );
      if (pendingEdit.current?.sequence === edit) pendingEdit.current = null;
      setConnectionError("");
      apply(reply.session);
    } catch (e) {
      if (pendingEdit.current?.sequence === edit) pendingEdit.current = null;
      setConnectionError(friendlyError(e));
    }
  }
  async function refresh() {
    pendingEdit.current = null;
    if (demo) {
      const capture = structuredClone(demoCapture);
      setSession({
        tabId: 0,
        generation: "demo",
        revision: 0,
        phase: "ready",
        capture,
        key: capture.tracks[0]?.key || "",
        options: { ...defaults },
        error: "",
        restricted: false,
        download: "idle",
      });
    } else if (tabId.current !== null)
      await request({ action: "refresh", tabId: tabId.current });
  }
  useEffect(() => {
    if (demo) {
      void refresh();
      return;
    }
    let live = true;
    const changed = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "session" || tabId.current === null) return;
      const value = changes[sessionKey(tabId.current)]?.newValue as
        TabSession | undefined;
      if (live && value) apply(value);
    };
    chrome.storage.onChanged.addListener(changed);
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!live) return;
        if (tab?.id === undefined)
          throw new Error("Open a video tab, then open GetTranscript again.");
        tabId.current = tab.id;
        await request({ action: "get", tabId: tab.id });
      })
      .catch((e) => {
        if (live) setConnectionError(friendlyError(e));
      });
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  function change(options: Partial<ExportOptions> = {}, selectedKey = key) {
    if (!session || saving) return;
    const next = { ...session.options, ...options };
    if (demo)
      setSession({
        ...session,
        key: selectedKey,
        options: next,
        download: "idle",
        error: "",
      });
    else {
      const sequence = ++editSequence.current;
      pendingEdit.current = { key: selectedKey, options: next, sequence };
      setSession({
        ...session,
        key: selectedKey,
        options: next,
        download: "idle",
        error: "",
      });
      void request(
        {
          action: "update",
          tabId: session.tabId,
          key: selectedKey,
          options: next,
        },
        sequence,
      );
    }
  }
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
  async function download() {
    if (!transcript || !session) return;
    if (!demo) {
      await request({
        action: "download",
        tabId: session.tabId,
        key,
        options: session.options,
      });
      return;
    }
    const output = exportTranscript(transcript, session.options);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([output.text], { type: output.mime }),
    );
    link.download = filename(transcript.title, transcript.language, format);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    setSession({ ...session, download: "complete" });
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
          title="Refresh transcript"
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
              You can close this popup. Reading continues in the background.
            </p>
          </section>
        ) : (
          <>
            {capture && transcript && (
              <>
                <section className="source">
                  <Icon name="video" size={30} />
                  <div>
                    <h2 dir="auto" title={capture.title}>
                      {capture.title}
                    </h2>
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
                <div className="fields">
                  {capture!.tracks.length > 1 ? (
                    <label className="field">
                      Language
                      <select
                        id="language"
                        dir="auto"
                        value={key}
                        disabled={saving}
                        onChange={(e) => change({}, e.target.value)}
                      >
                        {capture!.tracks.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label || t.language || "Captions"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className="field">
                      <span id="language-label">Detected language</span>
                      <div
                        className="detected-language"
                        aria-labelledby="language-label"
                        dir="auto"
                        title={
                          capture!.tracks[0]?.label ||
                          capture!.tracks[0]?.language ||
                          "Not specified"
                        }
                      >
                        {capture!.tracks[0]?.label ||
                          capture!.tracks[0]?.language ||
                          "Not specified"}
                      </div>
                    </div>
                  )}
                  <label className="field">
                    Format
                    <select
                      id="format"
                      value={format}
                      disabled={saving}
                      onChange={(e) =>
                        change({ format: e.target.value as Format })
                      }
                    >
                      {FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="field-help">{formatInfo.help}</p>
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
                    disabled={saving || !names.length}
                    onChange={(e) => change({ speakers: e.target.checked })}
                  />
                </label>
                {format === "vtt" && (
                  <label className="toggle-row compact">
                    <strong>Show names in captions</strong>
                    <input
                      role="switch"
                      type="checkbox"
                      checked={visibleNames}
                      disabled={saving || !speakers || !names.length}
                      onChange={(e) =>
                        change({ visibleNames: e.target.checked })
                      }
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
                  <div
                    className="preview-content"
                    tabIndex={0}
                    aria-label="Transcript preview"
                  >
                    {transcript.cues.slice(0, 8).map((c, i) => (
                      <div className="preview-row" key={i}>
                        <time>
                          {timestamp(c.start).split(".")[0].replace(/^00:/, "")}
                        </time>
                        <div dir="auto">
                          {speakers && c.speaker && (
                            <strong>{c.speaker}</strong>
                          )}
                          <p>{c.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}
          </>
        )}
        {(error || parsed.error) &&
          !busy &&
          (transcript ? (
            <p className="notice error" role="alert">
              <Icon name="alert" />
              <span>{error || parsed.error}</span>
            </p>
          ) : (
            <section className="empty" role="alert">
              <Icon name={restricted ? "video" : "alert"} size={30} />
              <h2>
                {restricted ? "Open a video page" : "Unable to read this page"}
              </h2>
              <p>{error || parsed.error}</p>
            </section>
          ))}
      </main>
      <footer>
        {status && (
          <p className="save-status" role="status">
            {status}
          </p>
        )}
        {transcript && !busy && (
          <button
            className="primary"
            onClick={() => void download()}
            disabled={!transcript || busy || saving}
          >
            <Icon name="download" />
            {saving ? "Saving…" : `Download ${format.toUpperCase()}`}
          </button>
        )}
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
