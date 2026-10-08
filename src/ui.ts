import type { SelectionInfo, SearchQuery, Result, InsertImage } from "./shared";
declare const __API_URL__: string;
const API = __API_URL__;
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const send = (message: unknown) =>
  parent.postMessage({ pluginMessage: message }, "*");
let selection: SelectionInfo = { kind: "invalid", count: 0, label: "" };
let key = "";
let installationId = "";
let recordedOpen = false;
let working = false;
let inserting = false;
let selectionRevision = 0;
let queryRevision = 0;
let pendingAutoSearch = false;
let autoSearchTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSelectionSearch() {
  clearTimeout(autoSearchTimer);
  pendingAutoSearch = selection.kind !== "invalid" && !!key && !inserting;
  if (!pendingAutoSearch) return;
  autoSearchTimer = setTimeout(() => {
    if (!working && pendingAutoSearch) startSearch();
  }, 300);
}
let requestId = 0;
let controller: AbortController | null = null;
let results: Result[] = [];
const chosen = new Set<string>();
const urls: string[] = [];
function status(message: string, error = false) {
  el("status").textContent = message;
  el("status").dataset.error = String(error);
}
function controls() {
  el("empty").hidden = !key || working || pendingAutoSearch || results.length > 0;
  el("empty").textContent = selection.kind === "invalid"
    ? selection.count > 0 ? selection.label : "Select an image, text layers, or sticky notes to find images."
    : !key ? "Connect to Taste to find images for your selection."
    : "No matching images found. Try a different selection.";
  el<HTMLButtonElement>("insert").disabled =
    working || pendingAutoSearch || !chosen.size;
  el("insert").textContent = chosen.size
    ? `Insert ${chosen.size} image${chosen.size === 1 ? "" : "s"}`
    : "Insert images";
  el("selection-count").textContent = `${chosen.size} selected`;
  el<HTMLButtonElement>("clear").disabled = working || !chosen.size;
  document
    .querySelectorAll<HTMLInputElement>(".checkbox__box")
    .forEach((input) => {
      input.disabled = working || input.dataset.loaded !== "true" || (chosen.size >= 24 && !input.checked);
    });
  el<HTMLButtonElement>("connect").disabled = working;
  el<HTMLInputElement>("token").disabled = working;
}
function settings(open: boolean) {
  el("settings").hidden = !open;

}
async function api(path: string, init: RequestInit = {}, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(API + path, {
      ...init,
      signal: signal ?? AbortSignal.timeout(90000),
      headers: { ...init.headers, Authorization: `Bearer ${key}`, ...(installationId ? { "X-Taste-Installation": installationId } : {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw Object.assign(new Error(
      "Taste is taking longer than expected. Check your connection and try again.",
    ), { retryable: true });
  }
  if (!response.ok) {
    if (response.status === 401) {
      key = "";
      pendingAutoSearch = false;
      clearTimeout(autoSearchTimer);
      resetResults();
      settings(true);
      send({ type: "save-connection", endpoint: API, key: "" });
      throw new Error("Access key not accepted. Enter a new key to reconnect.");
    }
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : "";
    } catch {}
    throw Object.assign(new Error(detail || `Taste returned an error (${response.status}).`), {
      retryable: [502, 503, 504].includes(response.status),
    });
  }
  return response;
}
// Only check readiness during a user operation; never poll an idle plugin.
async function ready(signal = AbortSignal.timeout(120000)) {
  const phrases = [
    "Giving the server a gentle nudge…",
    "A fresh start means loading the image model into memory.",
    "CLIP is what connects your words and images to the library.",
    "The reference index joins the model in memory for quick searches.",
    "Once ready, Taste stays awake for three hours after the last use.",
    "Still waiting for the server. Your search will continue automatically.",
  ];
  let index = 0;
  const rotate = () => {
    el("startup").hidden = false;
    el("startup-message").textContent = phrases[Math.min(index++, phrases.length - 1)];
    el("status").hidden = true;
    timer = setTimeout(rotate, 5000);
  };
  let timer = setTimeout(rotate, 1200);
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        await api("/health", {}, AbortSignal.any([signal, AbortSignal.timeout(25000)]));
        return;
      } catch (error) {
        if (signal.aborted || attempt >= 3 || !(error as Error & { retryable?: boolean }).retryable)
          throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
      }
    }
  } finally {
    clearTimeout(timer);
    el("startup").hidden = true;
    el("status").hidden = false;
  }
}
// Figma's sandbox may expose getRandomValues without the secure-context-only
// randomUUID API. Analytics must never prevent the plugin from starting.
function usageId(): string {
  try {
    if (typeof crypto === "undefined" || !crypto) return "";
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  } catch {
    return "";
  }
}
function trackUsage(kind: "open" | "insert", count = 1) {
  if (!key || !installationId) return;
  const eventId = usageId();
  if (!eventId) return;
  // Best effort: counts must never delay the plugin or change its connection state.
  void fetch(API + "/usage/events", {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Taste-Installation": installationId },
    body: JSON.stringify({ kind, count, event_id: eventId }),
  }).catch(() => {});
}
el("endpoint").textContent = API;
async function connect() {
  key = el<HTMLInputElement>("token").value.trim();
  if (!key) {
    status("Enter your team access key.", true);
    return;
  }
  working = true;
  controls();
  status("Connecting…");
  try {
    await ready();
    settings(false);
    if (!recordedOpen) { trackUsage("open"); recordedOpen = true; }
    send({ type: "save-connection", endpoint: API, key });
    status("");
  } catch (e) {
    key = "";
    settings(true);
    status((e as Error).message, true);
  } finally {
    working = false;
    scheduleSelectionSearch();
    controls();
  }
}
el("connect").onclick = connect;
function resetResults() {
  nextPage = null;
  pageLoading = false;
  previewsLoading = false;
  moreObserver?.disconnect();
  el("more").hidden = true;
  el("more").textContent = "Load more";
  chosen.clear();
  results = [];
  for (const url of urls) URL.revokeObjectURL(url);
  urls.length = 0;
  el("grid").replaceChildren();
}
function startSearch() {
  if (working || !key || selection.kind === "invalid") return;
  clearTimeout(autoSearchTimer);
  pendingAutoSearch = false;
  queryRevision = selectionRevision;
  working = true;
  controller?.abort();
  controller = new AbortController();
  requestId++;
  resetResults();
  el("empty").hidden = true;
  status("Reading selection…");
  controls();
  send({ type: "query", requestId });
}
async function search(query: SearchQuery, id: number) {
  const revision = queryRevision;
  const signal = AbortSignal.any([
    controller!.signal,
    AbortSignal.timeout(150000),
  ]);
  try {
    await ready(signal);
    if (id !== requestId || revision !== selectionRevision) return;
    status(
      query.kind !== "text"
        ? "Finding visually similar images…"
        : "Finding images for your selected text…",
    );
    let response: Response;
    if (query.kind === "reference") {
      response = await api("/search/reference", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: query.id, paginate: true }),
      }, signal);
    } else if (query.kind === "image") {
      const form = new FormData();
      form.append("paginate", "true");
      if (query.excludeId) form.append("exclude_id", query.excludeId);
      form.append(
        "image",
        new Blob([new Uint8Array(query.bytes)], { type: "image/png" }),
        "selection.png",
      );
      response = await api(
        "/search/image",
        { method: "POST", body: form },
        signal,
      );
    } else
      response = await api(
        "/search/text",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: query.texts, limit: 24, paginate: true }),
        },
        signal,
      );
    const data = await response.json();
    if (id !== requestId || revision !== selectionRevision) return;
    results = data.results;
    nextPage = data.next ?? null;

    status("");
    appendCards(data.results, id, revision, signal);
  } catch (e) {
    if (id === requestId && revision === selectionRevision)
      status((e as Error).message, true);
  } finally {
    if (id === requestId) {
      working = false;
      if (pendingAutoSearch) scheduleSelectionSearch();
      controls();
    }
  }
}
type PageCursor = { search_id: string; offset: number };
let nextPage: PageCursor | null = null;
let pageLoading = false;
let previewsLoading = false;
let moreObserver: IntersectionObserver | undefined;
function watchMore() {
  el("more").hidden = !nextPage;
  el<HTMLButtonElement>("more").disabled = pageLoading || previewsLoading;
  moreObserver?.disconnect();
  if (nextPage && !pageLoading && !previewsLoading && typeof IntersectionObserver !== "undefined") {
    moreObserver = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: el("scroll-area"), rootMargin: "400px" });
    moreObserver.observe(el("more"));
  }
}
async function loadMore() {
  if (!nextPage || pageLoading || previewsLoading || working || pendingAutoSearch) return;
  const id = requestId, revision = selectionRevision, cursor = nextPage;
  const signal = AbortSignal.any([controller!.signal, AbortSignal.timeout(90000)]);
  pageLoading = true;
  moreObserver?.disconnect();
  el<HTMLButtonElement>("more").disabled = true;
  el("more").textContent = "Loading more…";
  try {
    const data = await (await api(`/search/page?search_id=${encodeURIComponent(cursor.search_id)}&offset=${cursor.offset}`, {}, signal)).json();
    if (id !== requestId || revision !== selectionRevision) return;
    nextPage = data.next ?? null;
    results.push(...data.results);
    appendCards(data.results, id, revision, signal);
  } catch (error) {
    if (id !== requestId || revision !== selectionRevision) return;
    // Keep existing results and selections usable; retry only on a click.
    el("more").textContent = "Retry loading more";
    el("more").title = (error as Error).message;
    return;
  } finally {
    if (id === requestId && revision === selectionRevision) {
      pageLoading = false;
      el<HTMLButtonElement>("more").disabled = previewsLoading;
    }
  }
  el("more").textContent = "Load more";
  watchMore();
}
el("more").onclick = loadMore;
function appendCards(batch: Result[], id: number, revision: number, signal: AbortSignal) {
    // Bounded downloads keep the service responsive and preserve ranked card order.
    const cards = batch.map((result) => {
      const card = document.createElement("div");
      card.className = "card checkbox";
      card.title = result.cluster;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "checkbox__box";
      checkbox.id = `result-${result.id}`;
      checkbox.disabled = true;
      checkbox.dataset.loaded = "false";
      const label = document.createElement("label");
      label.className = "checkbox__label";
      label.htmlFor = checkbox.id;
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.onload = () => {
        // Lazy decoding can happen long after the download's timeout elapsed.
        if (id !== requestId || revision !== selectionRevision) return;
        checkbox.dataset.loaded = "true";
        controls();
      };
      img.onerror = () => { img.alt = "Preview unavailable"; };
      checkbox.setAttribute("aria-label", result.name);
      label.append(img);
      card.append(checkbox, label);
      checkbox.onchange = () => {
        if (checkbox.checked) chosen.add(result.id);
        else chosen.delete(result.id);
        controls();
      };
      el("grid").append(card);
      return { result, img };
    });
    let cursor = 0;
    // Thumbnails load independently; they must not hold the search/insertion lock.
    previewsLoading = true;
    void Promise.all(
      Array.from({ length: 4 }, async () => {
        while (cursor < cards.length) {
          if (signal.aborted || id !== requestId || revision !== selectionRevision) return;
          const { result, img } = cards[cursor++];
          try {
            const blob = await (
              await api(
                `/images/${encodeURIComponent(result.id)}?size=320`,
                {},
                signal,
              )
            ).blob();
            if (signal.aborted || id !== requestId || revision !== selectionRevision) return;
            const url = URL.createObjectURL(blob);
            urls.push(url);
            img.src = url;
          } catch (error) {
            if (signal.aborted || id !== requestId || revision !== selectionRevision) return;
            img.alt = "Preview unavailable";
            console.warn(
              "Thumbnail unavailable",
              result.id,
              (error as Error).message,
            );
          }
        }
      }),
    ).finally(() => {
      if (id !== requestId || revision !== selectionRevision) return;
      previewsLoading = false;
      watchMore();
    });
}
el("clear").onclick = () => {
  if (working) return;
  chosen.clear();
  document
    .querySelectorAll<HTMLInputElement>(".checkbox__box")
    .forEach((input) => {
      input.checked = false;
    });
  controls();
};
el("insert").onclick = async () => {
  inserting = true;
  clearTimeout(autoSearchTimer);
  pendingAutoSearch = false;
  working = true;
  controls();
  status("Preparing images…");
  try {
    const images: InsertImage[] = [];
    if (chosen.size) await ready();
    for (const result of results.filter((r) => chosen.has(r.id))) {
      const bytes = new Uint8Array(
        await (
          await api(`/images/${encodeURIComponent(result.id)}?size=4096`)
        ).arrayBuffer(),
      );
      images.push({ id: result.id, name: result.name, bytes });
    }
    status("Placing images on the canvas…");
    send({ type: "insert", images });
  } catch (e) {
    inserting = false;
    working = false;
    controls();
    status((e as Error).message, true);
  }
};
window.onmessage = (event) => {
  // Figma relays sandbox messages into the iframe; their source is not
  // guaranteed to be window.parent (unlike our browser preview harness).
  const message = event.data?.pluginMessage;
  if (!message || typeof message !== "object") return;
  if (message.type === "connection") {
    installationId = typeof message.installationId === "string" && /^[a-f0-9-]{36}$/.test(message.installationId)
      ? message.installationId : usageId();
    if (installationId && installationId !== message.installationId) send({ type: "save-installation", id: installationId });
    if (message.key) {
      el<HTMLInputElement>("token").value = message.key;
      void connect();
    } else {
      settings(true);
      controls();
    }
  }
  if (message.type === "selection") {
    selection = message.selection;
    selectionRevision++;
    if (!inserting) resetResults();
    scheduleSelectionSearch();
    if (!working) status("");
    controls();
  }
  if (message.type === "query" && message.requestId === requestId)
    void search(message.query, message.requestId);
  if (message.type === "error") {
    if (message.requestId && message.requestId !== requestId) return;
    working = false;
    inserting = false;
    if (pendingAutoSearch) scheduleSelectionSearch();
    controls();
    status(message.message, true);
  }
  if (message.type === "inserted") {
    trackUsage("insert", message.count);
    inserting = false;
    working = false;
    controls();
    el("clear").click();
    controls();
    status(
      `Added ${message.count} image${message.count === 1 ? "" : "s"} to canvas.`,
    );
    // Selection events can arrive while insertion suppresses automatic search.
    // Read the final selection again now that insertion has finished.
    send({ type: "ready" });
  }
};
settings(false);
controls();
send({ type: "ready" });
send({ type: "load-connection", endpoint: API });
