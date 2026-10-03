import type { Cue, PageCapture, RawTrack } from "../lib/types";

/** Self-contained: Chrome serializes this function into the page's MAIN world. */
export async function collectStreamPage(): Promise<PageCapture | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
  let cleanup = () => {};
  try {
    const record = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value);
    const canonical = (raw: string) => {
      const url = new URL(raw);
      const id = url.searchParams.get("id");
      if (!id || id.length > 12_000) throw new Error("Unsupported recording.");
      url.search = "";
      url.hash = "";
      url.searchParams.set("id", id);
      return url.href;
    };
    const page = new URL(location.href);
    if (
      page.protocol !== "https:" ||
      !/(^|\.)sharepoint\.(com|us|de|cn)$/i.test(page.hostname) ||
      !/\/_layouts\/15\/stream\.aspx$/i.test(page.pathname) ||
      page.username ||
      page.password
    )
      return undefined;
    const sourceUrl = canonical(page.href);
    const sameSource = () => {
      try {
        return canonical(location.href) === sourceUrl;
      } catch {
        return false;
      }
    };
    const waitUntil = async (ready: () => boolean, milliseconds: number) => {
      if (controller.signal.aborted || !sameSource()) return false;
      if (ready()) return true;
      return new Promise<boolean>((resolve) => {
        const deadline = Date.now() + milliseconds;
        let settled = false;
        let observer: MutationObserver | undefined;
        let polling: ReturnType<typeof setInterval> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          observer?.disconnect();
          clearInterval(polling);
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", stopped);
          resolve(value);
        };
        const stopped = () => finish(false);
        const check = () => {
          if (controller.signal.aborted || !sameSource()) return finish(false);
          if (ready()) return finish(true);
          if (Date.now() >= deadline) finish(false);
        };
        if (
          typeof MutationObserver !== "undefined" &&
          document.documentElement
        ) {
          observer = new MutationObserver(check);
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
          });
        }
        // Globals can be assigned without a DOM mutation. A small bounded sampler
        // complements the observer without depending on background rendering.
        polling = setInterval(check, 500);
        timer = setTimeout(stopped, milliseconds);
        controller.signal.addEventListener("abort", stopped, { once: true });
        check();
      });
    };
    const currentFileInfo = () =>
      (window as unknown as Record<string, unknown>).g_fileInfo;
    let fileInfo = currentFileInfo();
    if (
      (!record(fileInfo) || typeof fileInfo[".spItemUrl"] !== "string") &&
      typeof document !== "undefined"
    ) {
      await waitUntil(() => {
        fileInfo = currentFileInfo();
        return record(fileInfo) && typeof fileInfo[".spItemUrl"] === "string";
      }, 2000);
    }
    if (controller.signal.aborted || !sameSource()) return undefined;
    if (!record(fileInfo) || typeof fileInfo[".spItemUrl"] !== "string")
      return undefined;
    const item = new URL(fileInfo[".spItemUrl"], page.origin);
    if (
      item.origin !== page.origin ||
      item.username ||
      item.password ||
      item.href.length > 24_000 ||
      !/\/_api\/v2\.[01]\/drives\/[^/]+\/items\/[^/]+\/?$/.test(
        item.pathname,
      ) ||
      /%(?:2f|5c)|\\/i.test(item.pathname)
    )
      return undefined;
    // Use only the page's exact item endpoint. Never follow download URLs or
    // enumerate nearby recordings; authentication remains on this origin.
    item.pathname = item.pathname
      .replace("/_api/v2.0/", "/_api/v2.1/")
      .replace(/\/$/, "");
    const tempAuth = item.searchParams.get("tempauth");
    item.search = "";
    item.hash = "";
    if (tempAuth) item.searchParams.set("tempauth", tempAuth);

    // Some Stream sessions use an already-issued Bearer header instead of
    // cookies. Observe only this item's normal player requests for this read;
    // never persist a credential or send it outside the exact page origin.
    const originalFetch = window.fetch || fetch;
    const ownedFetch = Object.prototype.hasOwnProperty.call(window, "fetch");
    const identity = item.pathname.match(/\/drives\/([^/]+)\/items\/([^/]+)$/)!;
    let authorization = "";
    let observing = true;
    let receivedAuthorization: (() => void) | undefined;
    let openedButton: HTMLElement | undefined;
    let previousPanel: HTMLElement | undefined;
    const selected = (button: HTMLElement) =>
      ["aria-expanded", "aria-selected", "aria-pressed"].some(
        (name) => button.getAttribute(name) === "true",
      );
    const visibleRows = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[id^="entry-"] [id^="sub-entry-"]',
        ),
      ).some((row) => row.getClientRects().length > 0);
    const panelOpen = (button: HTMLElement) =>
      selected(button) ||
      (button.getAttribute("aria-controls") || "")
        .split(/\s+/)
        .filter(Boolean)
        .some((id) => {
          const panel = document.getElementById(id);
          return !!(
            panel &&
            !panel.hidden &&
            panel.getAttribute("aria-hidden") !== "true" &&
            panel.getClientRects().length
          );
        });
    const findTranscriptButton = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'button,[role="button"],[role="tab"],[role="menuitem"]',
        ),
      ).find(
        (element) =>
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-disabled") !== "true" &&
          (element.querySelector('[data-icon-name="SlideText"]') ||
            /transcript/i.test(element.getAttribute("aria-controls") || "") ||
            [
              element.id,
              element.getAttribute("data-automation-id"),
              element.getAttribute("data-testid"),
            ].some((id) =>
              /^(?:transcript(?:button|tab|toggle|menuitem)|(?:open|show|toggle)transcript)$/i.test(
                (id || "").replace(/[-_]/g, ""),
              ),
            )),
      );
    const observedFetch: typeof fetch = function (
      this: Window | undefined,
      input,
      init,
    ) {
      if (observing) {
        try {
          const request =
            typeof input === "object" && "url" in input ? input : undefined;
          const url = new URL(request ? request.url : String(input), page.href);
          const match = url.pathname.match(
            /\/_api(?:_cached)?\/v2\.[01]\/drives\/([^/]+)\/items\/([^/]+)(?:\/|$)/,
          );
          if (
            url.origin === page.origin &&
            !url.username &&
            !url.password &&
            match?.[1] === identity[1] &&
            match[2] === identity[2]
          ) {
            const headers = new Headers(init?.headers || request?.headers);
            const candidate =
              headers.get("authorization") ||
              headers.get("x-authorization") ||
              "";
            if (
              /^Bearer [^\s]+$/i.test(candidate) &&
              candidate.length <= 24_000
            ) {
              authorization = candidate;
              receivedAuthorization?.();
            }
          }
        } catch {
          /* Leave the player's request completely unchanged. */
        }
      }
      return originalFetch.call(this, input, init);
    };
    window.fetch = observedFetch;
    cleanup = () => {
      observing = false;
      authorization = "";
      receivedAuthorization = undefined;
      if (window.fetch === observedFetch) {
        if (ownedFetch) window.fetch = originalFetch;
        else delete (window as unknown as Record<string, unknown>).fetch;
      }
      if (!sameSource()) return;
      const currentButton = openedButton?.isConnected
        ? openedButton
        : openedButton
          ? findTranscriptButton()
          : undefined;
      if (currentButton && (panelOpen(currentButton) || visibleRows()))
        currentButton.click();
      if (previousPanel?.isConnected && !panelOpen(previousPanel))
        previousPanel.click();
    };
    const usePlayerAuthorization = async () => {
      if (authorization || controller.signal.aborted) return;
      let button = findTranscriptButton();
      if (!button)
        await waitUntil(() => {
          button = findTranscriptButton();
          return !!authorization || !!button;
        }, 2000);
      if (
        authorization ||
        !button ||
        controller.signal.aborted ||
        !sameSource()
      )
        return;
      const activation = button;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          receivedAuthorization = undefined;
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 4000);
        receivedAuthorization = finish;
        controller.signal.addEventListener("abort", finish, { once: true });
        if (!panelOpen(activation) && !visibleRows()) {
          previousPanel = Array.from(
            activation
              .closest('[role="menubar"],[role="tablist"],nav')
              ?.querySelectorAll<HTMLElement>(
                'button,[role="button"],[role="tab"]',
              ) || [],
          ).find((element) => element !== activation && panelOpen(element));
          openedButton = activation;
          activation.click();
        }
        if (authorization || controller.signal.aborted) finish();
      });
    };

    let responseBytes = 0;
    const readJson = async (url: URL, maxBytes: number): Promise<unknown> => {
      if (controller.signal.aborted || canonical(location.href) !== sourceUrl)
        throw new Error("Reading stopped.");
      const request = () =>
        originalFetch.call(window, url.href, {
          method: "GET",
          credentials: "include",
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          signal: controller.signal,
        });
      const initiallyAuthorized = !!authorization;
      let response = await request();
      if (response.status === 401 && !initiallyAuthorized) {
        await response.body?.cancel();
        await usePlayerAuthorization();
        if (authorization && !controller.signal.aborted)
          response = await request();
      }
      if (
        !response.ok ||
        (response.url &&
          (new URL(response.url).origin !== page.origin ||
            new URL(response.url).pathname !== url.pathname))
      )
        throw new Error("Transcript unavailable.");
      const declared = Number(response.headers.get("content-length"));
      if (declared > maxBytes || declared + responseBytes > 16_000_000)
        throw new Error("Transcript exceeds the size limit.");
      if (!response.body) throw new Error("Transcript unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const result = await reader.read();
          if (controller.signal.aborted) throw new Error("Reading stopped.");
          if (result.done) break;
          bytes += result.value.byteLength;
          responseBytes += result.value.byteLength;
          if (bytes > maxBytes || responseBytes > 16_000_000)
            throw new Error("Transcript exceeds the size limit.");
          text += decoder.decode(result.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (canonical(location.href) !== sourceUrl)
        throw new Error("The recording changed.");
      return JSON.parse(text);
    };
    const metadataUrl = new URL(item.href);
    metadataUrl.searchParams.set("$select", "name,video,media");
    metadataUrl.searchParams.set("$expand", "media/transcripts");
    const metadata = await readJson(metadataUrl, 1_000_000);
    if (
      !record(metadata) ||
      !record(metadata.media) ||
      !Array.isArray(metadata.media.transcripts) ||
      metadata.media.transcripts.length > 150
    )
      return undefined;
    const visible = metadata.media.transcripts.filter(
      (track) => record(track) && track.isVisible === true,
    );
    if (!visible.length || visible.length > 32) return undefined;
    visible.sort(
      (a, b) => Number(b.isDefault === true) - Number(a.isDefault === true),
    );
    const clean = (text: string) =>
      text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    const languageTag = (value: unknown): string | undefined => {
      if (typeof value !== "string" || !value || value.length > 100)
        return undefined;
      try {
        return Intl.getCanonicalLocales(value)[0];
      } catch {
        return undefined;
      }
    };
    const offset = (value: unknown): number | undefined => {
      if (typeof value !== "string") return undefined;
      const match = /^(\d{2,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,7}))?$/.exec(
        value,
      );
      if (!match) return undefined;
      const seconds =
        Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]) +
        Number(`0.${match[4] || "0"}`);
      return seconds <= 360_000 ? seconds : undefined;
    };
    let cueCount = 0;
    let textSize = 0;
    let unnamed = false;
    const trackIds = new Set<string>();
    const tracks: RawTrack[] = [];
    for (const transcript of visible) {
      const id = transcript.id;
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 1000 ||
        /[\/\\\u0000-\u001f]/.test(id) ||
        id === "." ||
        id === ".." ||
        trackIds.has(id)
      )
        return undefined;
      trackIds.add(id);
      const contentUrl = new URL(item.href);
      contentUrl.pathname += `/media/transcripts/${encodeURIComponent(id)}/streamContent`;
      contentUrl.searchParams.set("format", "json");
      contentUrl.searchParams.set("applyhighlights", "false");
      contentUrl.searchParams.set("applymediaedits", "false");
      const content = await readJson(contentUrl, 12_000_000);
      if (
        !record(content) ||
        !Array.isArray(content.entries) ||
        !content.entries.length ||
        content.entries.length + cueCount > 50_000
      )
        return undefined;
      const cues: Cue[] = [];
      const spokenLanguages = new Set<string>();
      for (const entry of content.entries) {
        if (
          !record(entry) ||
          typeof entry.text !== "string" ||
          entry.text.length > 100_000
        )
          return undefined;
        const start = offset(entry.startOffset);
        const end = offset(entry.endOffset);
        const text = clean(entry.text);
        if (start === undefined || end === undefined || end <= start || !text)
          return undefined;
        const speaker =
          typeof entry.speakerDisplayName === "string"
            ? clean(entry.speakerDisplayName).replace(/[\r\n<>]/g, " ")
            : undefined;
        if (speaker && speaker.length > 200) return undefined;
        const cueId =
          typeof entry.id === "string" && entry.id.length <= 1000
            ? clean(entry.id).replace(/[\r\n<>]/g, "")
            : String(cues.length + 1);
        textSize += text.length + cueId.length + (speaker?.length || 0);
        if (textSize > 5_000_000) return undefined;
        const spoken = languageTag(entry.spokenLanguageTag);
        if (spoken && spoken !== "und") spokenLanguages.add(spoken);
        if (!speaker) unnamed = true;
        cues.push({
          id: cueId || String(cues.length + 1),
          start,
          end,
          text,
          ...(speaker ? { speaker } : {}),
        });
      }
      cueCount += cues.length;
      const declaredLanguage = languageTag(transcript.languageTag);
      const language =
        declaredLanguage && declaredLanguage !== "und"
          ? declaredLanguage
          : spokenLanguages.size === 1
            ? [...spokenLanguages][0]
            : "und";
      const mixed = language === "und" && spokenLanguages.size > 1;
      let label =
        typeof transcript.displayName === "string"
          ? clean(transcript.displayName).slice(0, 1000)
          : "";
      if (mixed) label = "Spoken languages";
      else if (!label)
        label =
          language === "und"
            ? "Transcript"
            : new Intl.DisplayNames(["en"], { type: "language" }).of(
                language,
              ) || language;
      tracks.push({
        key: `stream:${tracks.length}`,
        label,
        language,
        cues,
        textFormat: "plain",
      });
    }
    const milliseconds = record(metadata.video)
      ? metadata.video.duration
      : undefined;
    const duration =
      typeof milliseconds === "number" &&
      Number.isFinite(milliseconds) &&
      milliseconds > 0 &&
      milliseconds <= 360_000_000
        ? milliseconds / 1000
        : undefined;
    if (controller.signal.aborted || canonical(location.href) !== sourceUrl)
      return undefined;
    return {
      title:
        (typeof metadata.name === "string"
          ? clean(metadata.name)
              .replace(/\.mp4$/i, "")
              .slice(0, 250)
          : "") || "Transcript",
      provider: "Microsoft Stream",
      sourceUrl,
      ...(duration ? { duration } : {}),
      tracks,
      rows: [],
      expectedRows: 0,
      completeRows: true,
      warnings: unnamed
        ? [
            "Some captions have no speaker name in the recording metadata. They remain unnamed.",
          ]
        : [],
    };
  } catch {
    // The regular player collector can handle unsupported or inaccessible APIs.
    // Never expose request URLs, authentication values, or response metadata.
    return undefined;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    try {
      cleanup();
    } catch {
      /* Navigation can remove the original controls. */
    }
  }
}
