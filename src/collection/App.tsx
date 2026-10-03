import { useEffect, useRef, useState } from "react";
import {
  collectionKey,
  canonicalSource,
  defaultCollectionOptions,
  type CollectionOptions,
  type RecordingCollection,
  type RecordingPart,
} from "../lib/collection";
import { FORMATS, type Format } from "../lib/types";
import { timestamp } from "../lib/transcript";
import { Icon } from "../popup/Icon";
import { createDemoCollection } from "./demo";
import { parseStartTime } from "./start-time";

const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
const sourceId = Number(
  new URLSearchParams(location.search).get("tabId") ?? -1,
);
type Candidate = { url: string; title: string };
type Action =
  | "get"
  | "add"
  | "remove"
  | "move"
  | "options"
  | "part"
  | "start"
  | "pause"
  | "reset"
  | "download"
  | "retry"
  | "discover";
type Request = {
  target: "collection";
  action: Action;
  tabId: number;
  urls?: string[];
  partId?: string;
  direction?: -1 | 1;
  options?: CollectionOptions;
  selectedTrack?: string;
  offset?: number;
  title?: string;
};
type Reply =
  | { collection: RecordingCollection; candidates?: Candidate[] }
  | { error: string };
const clock = (n: number) => timestamp(n).replace(/\.000$/, "");
const durationLabel = (n?: number) =>
  n !== undefined && Number.isFinite(n) ? clock(n) : "Duration not available";
const selected = (p: RecordingPart) =>
  p.tracks.find((t) => t.key === p.selectedTrack);

function OffsetField({
  part,
  disabled,
  onChange,
  onValidityChange,
}: {
  part: RecordingPart;
  disabled: boolean;
  onChange: (seconds: number) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [value, setValue] = useState(
    part.offset === undefined ? "" : clock(part.offset),
  );
  const [invalid, setInvalid] = useState(false);
  const reportValidity = useRef(onValidityChange);
  reportValidity.current = onValidityChange;
  useEffect(() => {
    setValue(part.offset === undefined ? "" : clock(part.offset));
    setInvalid(false);
    reportValidity.current(true);
    // A discarded draft must not keep blocking export after its field is hidden.
    return () => reportValidity.current(true);
  }, [part.id, part.offset]);
  const commit = () => {
    const seconds = parseStartTime(value);
    const valid = seconds !== null;
    setInvalid(!valid);
    onValidityChange(valid);
    if (seconds !== null) {
      setValue(clock(seconds));
      if (seconds !== part.offset) onChange(seconds);
    }
  };
  return (
    <label className="offset-field">
      Start in combined timeline
      <input
        aria-label={`Start time for ${part.title}`}
        aria-describedby={`offset-help-${part.id}`}
        aria-invalid={invalid || undefined}
        type="text"
        placeholder="04:00:00.000"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          const valid = parseStartTime(e.target.value) !== null;
          onValidityChange(valid);
          if (invalid) setInvalid(!valid);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <small
        id={`offset-help-${part.id}`}
        className={invalid ? "invalid-time" : ""}
        role={invalid ? "alert" : undefined}
      >
        {invalid
          ? "Enter HH:MM:SS or seconds, between 0 and 100 hours."
          : "HH:MM:SS or seconds"}
      </small>
    </label>
  );
}

export function App() {
  const [collection, setCollection] = useState<RecordingCollection | null>(
    () => (demo ? createDemoCollection() : null),
  );
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const [pending, setPending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [links, setLinks] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [previewId, setPreviewId] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [invalidOffsets, setInvalidOffsets] = useState<string[]>([]);
  const current = useRef<RecordingCollection | null>(collection);
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const optimisticOptions = useRef<CollectionOptions | null>(null);
  const pendingCommands = useRef(0);
  const received = useRef<RecordingCollection | null>(collection);
  const options = collection?.options || defaultCollectionOptions;
  const reading = collection?.phase === "reading";
  const saving = collection?.download === "saving";
  const locked = pending || reading || saving || closed || !!collection?.busy;
  const optionsLocked = pending || saving || closed;
  const parts = collection?.parts || [];
  const ready = parts.filter((p) => p.status === "ready");
  const complete = parts.length > 0 && ready.length === parts.length;
  const hasErrors = parts.some((p) => p.status === "error");
  const previewPart = ready.find((p) => p.id === previewId) || ready[0];
  const previewTrack = previewPart && selected(previewPart);
  const languages = new Set(
    ready.map(
      (p) =>
        (selected(p)?.language || "").trim().replace(/_/g, "-").toLowerCase() ||
        "und",
    ),
  );
  const localSubtitles =
    options.mode === "combined" &&
    options.timeline === "local" &&
    (options.format === "vtt" || options.format === "srt");
  const mixedBlocked =
    options.mode === "combined" &&
    languages.size > 1 &&
    !options.allowMixedLanguages;
  const missingDuration =
    options.mode === "combined" &&
    options.timeline !== "local" &&
    parts
      .slice(0, -1)
      .some(
        (p) =>
          p.status === "ready" &&
          (p.duration === undefined || !Number.isFinite(p.duration)),
      );
  const totalDuration =
    parts.length && parts.every((p) => p.duration !== undefined)
      ? parts.reduce((n, p) => n + (p.duration || 0), 0)
      : undefined;
  const invalidStart =
    options.mode === "combined" &&
    options.timeline === "custom" &&
    invalidOffsets.some((id) => parts.some((p) => p.id === id));
  const activePart = parts.findIndex((part) => part.status === "reading");
  const progressTitle =
    collection?.activity === "restoring"
      ? "Restoring the source video…"
      : collection?.busy && collection.phase === "paused"
        ? collection.activity === "waiting"
          ? "Canceling the queued read…"
          : "Pausing the current recording…"
        : reading && collection?.activity === "waiting"
          ? "Waiting for the current page read…"
          : reading && collection?.activity === "opening"
            ? `Opening recording ${Math.max(0, activePart) + 1} of ${parts.length}…`
            : reading && activePart >= 0
              ? `Reading part ${activePart + 1} of ${parts.length}`
              : reading
                ? "Preparing recordings…"
                : complete
                  ? "All recordings are ready"
                  : collection?.phase === "paused"
                    ? "Reading paused"
                    : `${ready.length} of ${parts.length} recordings ready`;
  const canDownload =
    complete &&
    !locked &&
    !localSubtitles &&
    !mixedBlocked &&
    !missingDuration &&
    !invalidStart;

  function apply(state: RecordingCollection) {
    const old = current.current;
    if (state.tabId !== sourceId && !demo) return;
    if (
      old &&
      old.generation === state.generation &&
      state.revision < old.revision
    )
      return;
    received.current = state;
    const visible = optimisticOptions.current
      ? { ...state, options: optimisticOptions.current }
      : state;
    current.current = visible;
    setCollection(visible);
  }
  function request(
    action: Action,
    data: Omit<Partial<Request>, "action" | "target" | "tabId"> = {},
  ) {
    const blocksControls = action !== "part";
    if (blocksControls) {
      pendingCommands.current++;
      setPending(true);
    }
    const next = serial.current.then(async () => {
      try {
        if (demo) {
          const old = current.current!;
          let state = {
            ...old,
            revision: old.revision + 1,
            error: "",
            download: "idle" as RecordingCollection["download"],
          };
          if (action === "options" && data.options)
            state.options = data.options;
          if (action === "remove")
            state.parts = old.parts.filter((p) => p.id !== data.partId);
          if (action === "move") {
            state.parts = [...old.parts];
            const i = state.parts.findIndex((p) => p.id === data.partId);
            const j = i + (data.direction || 0);
            if (j >= 0 && j < state.parts.length)
              [state.parts[i], state.parts[j]] = [
                state.parts[j],
                state.parts[i],
              ];
          }
          if (action === "part")
            state.parts = old.parts.map((p) =>
              p.id === data.partId
                ? {
                    ...p,
                    ...(data.offset !== undefined
                      ? { offset: data.offset }
                      : {}),
                    ...(data.selectedTrack
                      ? { selectedTrack: data.selectedTrack }
                      : {}),
                  }
                : p,
            );
          if (action === "download") state.download = "complete";
          if (action === "discover")
            setDiscoveryMessage(
              "No additional links were found on this page. Paste links below to add recordings.",
            );
          if (optimisticOptions.current === data.options)
            optimisticOptions.current = null;
          apply(state);
          setError("");
          return true;
        }
        const reply: Reply = await chrome.runtime.sendMessage({
          target: "collection",
          action,
          tabId: sourceId,
          ...data,
        });
        if (!reply || "error" in reply)
          throw new Error(
            reply?.error ||
              "Could not reconnect to GetTranscript. Reload this workspace to try again.",
          );
        if (optimisticOptions.current === data.options)
          optimisticOptions.current = null;
        apply(reply.collection);
        setError("");
        if (action === "discover") {
          const found = (reply.candidates || []).filter(
            (c) =>
              !reply.collection.parts.some(
                (p) => canonicalSource(p.url) === canonicalSource(c.url),
              ),
          );
          setCandidates(found);
          setChosen(found.map((c) => c.url));
          setDiscoveryMessage(
            found.length
              ? "Choose the recordings to add. Review their order before reading."
              : "No additional links were found on this page. Paste links below to add recordings.",
          );
        }
        return true;
      } catch (e) {
        if (optimisticOptions.current === data.options) {
          optimisticOptions.current = null;
          if (received.current) apply(received.current);
        }
        setError(
          e instanceof Error
            ? e.message
            : "Something went wrong. Please try again.",
        );
        return false;
      }
    });
    serial.current = next;
    void next.finally(() => {
      if (blocksControls) {
        pendingCommands.current--;
        setPending(pendingCommands.current > 0);
      }
    });
    return next;
  }
  useEffect(() => {
    if (demo) return;
    if (!Number.isInteger(sourceId) || sourceId < 0) {
      setError(
        "Open GetTranscript on a video page, then choose More options → Combine recordings.",
      );
      return;
    }
    const changed = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== "session") return;
      const change = changes[collectionKey(sourceId)];
      if (!change) return;
      if (change.newValue) apply(change.newValue as RecordingCollection);
      else if (change.oldValue) {
        setClosed(true);
        setCollection(null);
        current.current = null;
      }
    };
    const removed = (id: number) => {
      if (id === sourceId) {
        setClosed(true);
        setCollection(null);
        current.current = null;
      }
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    void request("get");
    return () => {
      chrome.storage.onChanged.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
    };
  }, []);
  function changeOptions(change: Partial<CollectionOptions>) {
    const next = { ...(current.current?.options || options), ...change };
    optimisticOptions.current = next;
    if (current.current) {
      current.current = { ...current.current, options: next, download: "idle" };
      setCollection(current.current);
    }
    void request("options", { options: next });
  }
  async function addLinks(urls: string[]) {
    if (await request("add", { urls })) {
      setLinks("");
      setCandidates([]);
      setChosen([]);
      setAddOpen(false);
      setDiscoveryMessage("");
    }
  }
  const downloadLabel = `Download ${options.mode === "individual" ? `ZIP (${parts.length} files)` : options.format.toUpperCase()}`;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="brand-mark">
          <Icon name="file" size={26} />
        </div>
        <div className="brand">
          <strong>GetTranscript</strong>
          <span>Transcripts, ready to keep.</span>
        </div>
        <a
          className="help-link"
          href="help.html"
          target="_blank"
          rel="noreferrer"
        >
          Help <Icon name="external" size={15} />
        </a>
      </header>
      <main className="workspace-main">
        <div className="intro">
          <div>
            <p className="eyebrow">ONE MEETING, EVERY PART</p>
            <h1>Combine recordings</h1>
            <p>Bring a long conversation back together.</p>
          </div>
          <div className="local-badge">
            <Icon name="shield" size={17} /> Processed on your device
          </div>
        </div>
        {closed ? (
          <section className="empty-state">
            <Icon name="video" size={36} />
            <h2>The source video tab was closed</h2>
            <p>
              This collection has been cleared. Open a recording and choose
              Combine recordings in GetTranscript to start again.
            </p>
          </section>
        ) : !collection ? (
          <section className="empty-state" aria-busy={!error}>
            {error ? (
              <>
                <Icon name="alert" size={32} />
                <h2>Open a recording to begin</h2>
                <p role="alert">{error}</p>
              </>
            ) : (
              <>
                <div className="loader" />
                <h2>Opening your collection…</h2>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="workspace-grid">
              <section
                className="card recordings-card"
                aria-labelledby="recordings-heading"
              >
                <div className="card-header">
                  <div>
                    <h2 id="recordings-heading">
                      Recordings <span className="count">{parts.length}</span>
                    </h2>
                    <p>Read in this order. Reorder when needed.</p>
                  </div>
                  <button
                    className="secondary small"
                    aria-expanded={addOpen}
                    aria-controls="add-recordings"
                    disabled={locked || parts.length >= 20}
                    onClick={() => setAddOpen(!addOpen)}
                  >
                    <Icon name={addOpen ? "close" : "plus"} size={17} />
                    {addOpen ? "Close" : "Add recordings"}
                  </button>
                </div>
                {addOpen && (
                  <section id="add-recordings" className="add-panel">
                    <label htmlFor="recording-links">
                      Paste recording links
                    </label>
                    <p>
                      One link per line, from the same site as your source
                      video.
                    </p>
                    <textarea
                      id="recording-links"
                      rows={4}
                      placeholder="https://…/stream.aspx?id=…"
                      value={links}
                      onChange={(e) => setLinks(e.target.value)}
                      disabled={locked}
                    />
                    <div className="add-actions">
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => void request("discover")}
                      >
                        <Icon name="search" size={16} /> Find links on source
                        page
                      </button>
                      <button
                        className="secondary small"
                        disabled={locked || !links.trim()}
                        onClick={() =>
                          void addLinks(
                            links
                              .split(/\r?\n/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                          )
                        }
                      >
                        Add links
                      </button>
                    </div>
                    {discoveryMessage && (
                      <p className="discovery-message" role="status">
                        {discoveryMessage}
                      </p>
                    )}
                    {candidates.length > 0 && (
                      <div className="candidates">
                        {candidates.map((c) => (
                          <label key={c.url}>
                            <input
                              type="checkbox"
                              checked={chosen.includes(c.url)}
                              onChange={(e) =>
                                setChosen(
                                  e.target.checked
                                    ? [...chosen, c.url]
                                    : chosen.filter((url) => url !== c.url),
                                )
                              }
                            />
                            <span dir="auto">{c.title}</span>
                          </label>
                        ))}
                        <button
                          className="secondary small"
                          disabled={!chosen.length || locked}
                          onClick={() => void addLinks(chosen)}
                        >
                          Add selected recordings
                        </button>
                      </div>
                    )}
                  </section>
                )}
                <ol className="part-list">
                  {parts.map((part, i) => {
                    const track = selected(part);
                    return (
                      <li className={`part ${part.status}`} key={part.id}>
                        <div className="part-top">
                          <span
                            className="part-number"
                            aria-label={`Part ${i + 1}`}
                          >
                            {part.status === "reading" ? (
                              <span className="loader small-loader" />
                            ) : (
                              i + 1
                            )}
                          </span>
                          <div className="part-main">
                            <h3 title={part.title} dir="auto">
                              {part.title}
                            </h3>
                            <div className="part-meta">
                              <span>
                                <Icon name="clock" size={13} />
                                {durationLabel(part.duration)}
                              </span>
                              {track && (
                                <span dir="auto">
                                  {track.label ||
                                    track.language ||
                                    "Language not specified"}
                                </span>
                              )}
                              {track && (
                                <span>
                                  {track.transcript.cues.length.toLocaleString()}{" "}
                                  captions
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="part-actions">
                            <button
                              className="icon-button"
                              title={`Move part ${i + 1} up`}
                              aria-label={`Move part ${i + 1} up`}
                              disabled={locked || i === 0}
                              onClick={() =>
                                void request("move", {
                                  partId: part.id,
                                  direction: -1,
                                })
                              }
                            >
                              <Icon name="up" size={16} />
                            </button>
                            <button
                              className="icon-button"
                              title={`Move part ${i + 1} down`}
                              aria-label={`Move part ${i + 1} down`}
                              disabled={locked || i === parts.length - 1}
                              onClick={() =>
                                void request("move", {
                                  partId: part.id,
                                  direction: 1,
                                })
                              }
                            >
                              <Icon name="down" size={16} />
                            </button>
                            <button
                              className="icon-button remove-button"
                              title={`Remove part ${i + 1}`}
                              aria-label={`Remove part ${i + 1}`}
                              disabled={locked}
                              onClick={() =>
                                void request("remove", { partId: part.id })
                              }
                            >
                              <Icon name="close" size={16} />
                            </button>
                          </div>
                        </div>
                        <div className="part-bottom">
                          <span className={`status-badge ${part.status}`}>
                            {part.status === "ready" ? (
                              <>
                                <Icon name="check" size={13} /> Ready
                              </>
                            ) : part.status === "reading" ? (
                              "Reading captions and speakers…"
                            ) : part.status === "error" ? (
                              "Needs attention"
                            ) : (
                              "Waiting to read"
                            )}
                          </span>
                          {part.status === "error" && (
                            <button
                              className="text-button"
                              disabled={locked}
                              onClick={() =>
                                void request("retry", { partId: part.id })
                              }
                            >
                              Retry this part
                            </button>
                          )}
                          {part.tracks.length > 1 && (
                            <label className="track-choice">
                              Language
                              <select
                                aria-label={`Language for part ${i + 1}`}
                                dir="auto"
                                value={part.selectedTrack}
                                disabled={locked}
                                onChange={(e) =>
                                  void request("part", {
                                    partId: part.id,
                                    selectedTrack: e.target.value,
                                  })
                                }
                              >
                                {part.tracks.map((t) => (
                                  <option key={t.key} value={t.key}>
                                    {t.label || t.language || "Captions"}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                        {part.error && (
                          <p className="part-error" role="alert">
                            {part.error}
                          </p>
                        )}
                        {track?.transcript.warnings.map((warning, wi) => (
                          <p className="part-warning" key={wi}>
                            {warning}
                          </p>
                        ))}
                      </li>
                    );
                  })}
                </ol>
                {!parts.length && (
                  <div className="no-parts">
                    <Icon name="video" size={30} />
                    <p>Add recording links to build your collection.</p>
                  </div>
                )}
                <div className="collection-progress">
                  <div>
                    <strong>{progressTitle}</strong>
                    <p>
                      {collection.activity === "restoring"
                        ? "Returning your video tab to its starting page and position."
                        : reading && collection.activity === "waiting"
                          ? "You can choose your export options or pause while the page finishes its current read."
                          : reading
                            ? "You can close this workspace. Reading will continue."
                            : totalDuration !== undefined
                              ? `${durationLabel(totalDuration)} of recorded video`
                              : "Each recording keeps its own speakers and captions."}
                    </p>
                  </div>
                  {reading ? (
                    <button
                      className="secondary small"
                      disabled={pending || complete}
                      onClick={() => void request("pause")}
                    >
                      <Icon name="pause" size={16} />
                      Pause
                    </button>
                  ) : !complete && parts.length > 0 ? (
                    <button
                      className="primary small"
                      disabled={
                        locked ||
                        (hasErrors &&
                          !parts.some((p) => p.status === "pending"))
                      }
                      onClick={() => void request("start")}
                    >
                      <Icon name="video" size={16} />
                      {collection.phase === "paused"
                        ? "Continue reading"
                        : "Read recordings"}
                    </button>
                  ) : null}
                </div>
                <p className="source-note">
                  <Icon name="video" size={16} />
                  <span>
                    Keep your source video tab open. Reading visits each
                    recording in that tab, then restores the starting page.
                  </span>
                </p>
              </section>
              <aside className="export-column">
                <section
                  className="card export-card"
                  aria-labelledby="export-heading"
                >
                  <div className="card-header">
                    <div>
                      <h2 id="export-heading">Your transcript</h2>
                      <p>Choose how you want to keep it.</p>
                    </div>
                  </div>
                  <div className="export-controls">
                    <label className="field">
                      Export
                      <select
                        aria-label="Export"
                        value={options.mode}
                        disabled={optionsLocked}
                        onChange={(e) =>
                          changeOptions({
                            mode: e.target.value as CollectionOptions["mode"],
                          })
                        }
                      >
                        <option value="combined">
                          One combined transcript
                        </option>
                        <option value="individual">
                          Separate files (.zip)
                        </option>
                      </select>
                    </label>
                    <label className="field">
                      Format
                      <select
                        aria-label="Format"
                        value={options.format}
                        disabled={optionsLocked}
                        onChange={(e) =>
                          changeOptions({ format: e.target.value as Format })
                        }
                      >
                        {FORMATS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="field-help">
                      {options.mode === "individual"
                        ? "Each file uses its recording’s original timestamps."
                        : options.timeline === "local"
                          ? "Recording sections with original timestamps."
                          : options.timeline === "custom"
                            ? "One timeline using your chosen start times."
                            : "One timeline, with each part placed after the previous video."}
                    </p>
                    {(reading || collection.busy) && (
                      <p className="field-help options-hint">
                        You can change export options while recordings are being
                        read.
                      </p>
                    )}
                    <details className="advanced">
                      <summary>
                        <Icon name="settings" size={17} />
                        Advanced options
                        <Icon name="down" size={16} />
                      </summary>
                      <div className="advanced-content">
                        <label className="field">
                          Timeline
                          <select
                            aria-label="Timeline"
                            value={options.timeline}
                            disabled={
                              optionsLocked || options.mode === "individual"
                            }
                            onChange={(e) =>
                              changeOptions({
                                timeline: e.target
                                  .value as CollectionOptions["timeline"],
                              })
                            }
                          >
                            <option value="continuous">Join end to end</option>
                            <option value="custom">Set start times</option>
                            <option value="local">
                              Keep each part’s original times
                            </option>
                          </select>
                        </label>
                        <p className="field-help">
                          {options.timeline === "continuous"
                            ? "Uses full video durations, including silence. This does not reconstruct pauses between recordings."
                            : options.timeline === "custom"
                              ? "Enter each part’s start time, relative to the beginning of your combined timeline. Parts must not overlap."
                              : "Available for Markdown, text and JSON. For subtitles, choose separate files."}
                        </p>
                        {options.timeline === "custom" &&
                          options.mode === "combined" && (
                            <div className="offsets">
                              {parts.map((p, i) => (
                                <div key={p.id}>
                                  <strong>Part {i + 1}</strong>
                                  <OffsetField
                                    part={p}
                                    disabled={locked}
                                    onValidityChange={(valid) =>
                                      setInvalidOffsets((old) =>
                                        valid
                                          ? old.includes(p.id)
                                            ? old.filter((id) => id !== p.id)
                                            : old
                                          : old.includes(p.id)
                                            ? old
                                            : [...old, p.id],
                                      )
                                    }
                                    onChange={(offset) =>
                                      void request("part", {
                                        partId: p.id,
                                        offset,
                                      })
                                    }
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={options.speakers}
                            disabled={optionsLocked}
                            onChange={(e) =>
                              changeOptions({ speakers: e.target.checked })
                            }
                          />
                          <span>
                            Include speaker names
                            <small>
                              Only names supplied by the recordings.
                            </small>
                          </span>
                        </label>
                        {options.format === "vtt" && (
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={options.visibleNames}
                              disabled={optionsLocked || !options.speakers}
                              onChange={(e) =>
                                changeOptions({
                                  visibleNames: e.target.checked,
                                })
                              }
                            />
                            <span>Show names in captions</span>
                          </label>
                        )}
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={options.includeSources}
                            disabled={
                              optionsLocked ||
                              options.mode === "individual" ||
                              ["vtt", "srt"].includes(options.format)
                            }
                            onChange={(e) =>
                              changeOptions({
                                includeSources: e.target.checked,
                              })
                            }
                          />
                          <span>
                            Include links to recordings
                            <small>In Markdown, text and JSON exports.</small>
                          </span>
                        </label>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={options.allowMixedLanguages}
                            disabled={
                              optionsLocked || options.mode === "individual"
                            }
                            onChange={(e) =>
                              changeOptions({
                                allowMixedLanguages: e.target.checked,
                              })
                            }
                          />
                          <span>
                            Allow different languages
                            <small>
                              Keep the original text. No translation.
                            </small>
                          </span>
                        </label>
                        <div className="reset-area">
                          {resetOpen ? (
                            <>
                              <p>
                                Clear collected captions? Recording links, order
                                and export options are kept.
                              </p>
                              <button
                                className="secondary small"
                                disabled={locked}
                                onClick={() => {
                                  setResetOpen(false);
                                  void request("reset");
                                }}
                              >
                                Refresh collection
                              </button>
                              <button
                                className="text-button"
                                onClick={() => setResetOpen(false)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="text-button"
                              disabled={locked}
                              onClick={() => setResetOpen(true)}
                            >
                              <Icon name="refresh" size={15} />
                              Refresh collection
                            </button>
                          )}
                        </div>
                      </div>
                    </details>
                    {localSubtitles && (
                      <p className="notice" role="alert">
                        VTT and SRT need a continuous timeline. Choose another
                        timeline or separate files.
                      </p>
                    )}
                    {mixedBlocked && (
                      <p className="notice" role="alert">
                        These recordings use different languages. Choose
                        matching tracks, export separate files, or allow
                        different languages in Advanced options.
                      </p>
                    )}
                    {missingDuration && (
                      <p className="notice" role="alert">
                        A video duration is missing. Export separate files or
                        use original times with Markdown, text or JSON.
                      </p>
                    )}
                    <button
                      className="primary download-button"
                      disabled={!canDownload}
                      onClick={() => void request("download")}
                    >
                      <Icon name="download" size={20} />
                      {saving ? "Saving…" : downloadLabel}
                    </button>
                    {collection.download === "complete" ? (
                      <p className="download-status" role="status">
                        <Icon name="check" size={15} />
                        Saved to your browser’s downloads.
                      </p>
                    ) : (
                      !complete && (
                        <p className="download-hint">
                          Read every part to enable export. A failed part is
                          never silently skipped.
                        </p>
                      )
                    )}
                  </div>
                </section>
                {previewTrack && (
                  <section className="card preview-card">
                    <div className="card-header">
                      <div>
                        <h2>Preview</h2>
                        <p>Original recording times</p>
                      </div>
                      {ready.length > 1 && (
                        <select
                          aria-label="Preview recording"
                          className="preview-select"
                          value={previewPart!.id}
                          onChange={(e) => setPreviewId(e.target.value)}
                        >
                          {ready.map((p) => (
                            <option key={p.id} value={p.id}>
                              Part{" "}
                              {parts.findIndex((item) => item.id === p.id) + 1}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div
                      className="preview"
                      tabIndex={0}
                      aria-label="Transcript preview"
                    >
                      {previewTrack.transcript.cues
                        .slice(0, 8)
                        .map((cue, i) => (
                          <div className="preview-row" key={`${cue.id}-${i}`}>
                            <time>{clock(cue.start)}</time>
                            <div dir="auto">
                              {options.speakers && cue.speaker && (
                                <strong>{cue.speaker}</strong>
                              )}
                              <p>{cue.text}</p>
                            </div>
                          </div>
                        ))}
                    </div>
                  </section>
                )}
              </aside>
            </div>
            {(error ||
              (collection.phase === "paused" && collection.busy
                ? ""
                : collection.error)) && (
              <p className="page-error" role="alert">
                <Icon name="alert" size={18} />
                <span>{error || collection.error}</span>
              </p>
            )}
          </>
        )}
        <footer className="workspace-footer">
          <span>No upload. No account. Your captions stay on this device.</span>
          <span>Temporary results clear when the source tab closes.</span>
        </footer>
      </main>
    </div>
  );
}
