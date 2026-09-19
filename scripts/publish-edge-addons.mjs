// Adapted from UseMyCurrentAccount++; see PUBLISHER_LICENSE.txt.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE_ADDONS_API_BASE =
  "https://api.addons.microsoftedge.microsoft.com/v1";
const REQUIRED_ENV = [
  "EDGE_ADDONS_CLIENT_ID",
  "EDGE_ADDONS_API_KEY",
  "EDGE_ADDONS_PRODUCT_ID",
  "EDGE_ADDONS_ZIP",
];
const DEFAULT_CERTIFICATION_NOTES =
  "GetTranscript exports captions exposed by the user-selected video page into local VTT, SRT, text, Markdown and JSON files. It preserves available speaker labels, has no developer backend or telemetry, stores only local preferences, and runs only on user action.";

export function getMissingEdgeAddonsConfig(env = process.env) {
  return REQUIRED_ENV.filter((key) => !String(env[key] || "").trim());
}

export function normalizeEdgeCredential(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, "")
    .trim();
}

export function readEdgeAddonsConfig(env = process.env) {
  return {
    clientId: normalizeEdgeCredential(env.EDGE_ADDONS_CLIENT_ID),
    apiKey: normalizeEdgeCredential(env.EDGE_ADDONS_API_KEY),
    productId: normalizeEdgeCredential(env.EDGE_ADDONS_PRODUCT_ID),
    zipPath: String(env.EDGE_ADDONS_ZIP || "").trim(),
    certificationNotes: String(
      env.EDGE_ADDONS_CERTIFICATION_NOTES || DEFAULT_CERTIFICATION_NOTES,
    ).trim(),
    pollAttempts: readPositiveInteger(env.EDGE_ADDONS_POLL_ATTEMPTS, 40),
    pollIntervalMs: readPositiveInteger(
      env.EDGE_ADDONS_POLL_INTERVAL_MS,
      15_000,
    ),
  };
}

export function buildEdgeAddonsEndpoints(productId) {
  const productBase = `${EDGE_ADDONS_API_BASE}/products/${encodeURIComponent(productId)}`;
  return {
    uploadUrl: `${productBase}/submissions/draft/package`,
    uploadStatusUrl: (operationId) =>
      `${productBase}/submissions/draft/package/operations/${encodeURIComponent(operationId)}`,
    publishUrl: `${productBase}/submissions`,
    publishStatusUrl: (operationId) =>
      `${productBase}/submissions/operations/${encodeURIComponent(operationId)}`,
  };
}

export function extractEdgeOperationId(location) {
  const value = String(location || "")
    .trim()
    .replace(/\/+$/, "");
  if (!value) return "";
  return decodeURIComponent(value.split("/").pop() || "");
}

export function getEdgeOperationStatus(payload) {
  return typeof payload?.status === "string"
    ? payload.status.toLowerCase()
    : "";
}

export function sanitizeEdgeAddonsMessage(value) {
  return String(value || "")
    .replace(
      /(Authorization:\s*(?:ApiKey|Bearer)\s+)[^\s"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:apiKey|api_key|access_token|client_secret)"\s*:\s*")[^"]+(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret)=)[^\s&]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4_000);
}

async function main() {
  const missing = getMissingEdgeAddonsConfig();
  if (missing.length) {
    throw new Error(
      `Missing required Microsoft Edge Add-ons configuration: ${missing.join(", ")}.`,
    );
  }
  const config = readEdgeAddonsConfig();
  if (!existsSync(config.zipPath)) {
    throw new Error(`Microsoft Edge Add-ons ZIP not found: ${config.zipPath}`);
  }

  const endpoints = buildEdgeAddonsEndpoints(config.productId);
  const headers = {
    Authorization: `ApiKey ${config.apiKey}`,
    "X-ClientID": config.clientId,
  };
  console.log(
    `Uploading ${basename(config.zipPath)} to Microsoft Edge Add-ons...`,
  );
  const uploadOperation = await startOperation(endpoints.uploadUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip" },
    body: readFileSync(config.zipPath),
  });
  await pollOperation(
    endpoints.uploadStatusUrl(uploadOperation),
    headers,
    config.pollAttempts,
    config.pollIntervalMs,
    "package upload",
  );

  console.log("Submitting Microsoft Edge Add-ons update for certification...");
  const publishOperation = await startOperation(endpoints.publishUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    body: config.certificationNotes,
  });
  await pollOperation(
    endpoints.publishStatusUrl(publishOperation),
    headers,
    config.pollAttempts,
    config.pollIntervalMs,
    "submission",
  );
  console.log(
    `Microsoft Edge Add-ons submission accepted for ${basename(config.zipPath)}.`,
  );
}

async function startOperation(url, init) {
  const response = await fetch(url, init);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Microsoft Edge Add-ons API request failed (${response.status}): ${sanitizeEdgeAddonsMessage(responseText)}`,
    );
  }
  const operationId = extractEdgeOperationId(response.headers.get("location"));
  if (!operationId) {
    throw new Error(
      "Microsoft Edge Add-ons API did not return an operation ID.",
    );
  }
  return operationId;
}

async function pollOperation(url, headers, attempts, intervalMs, label) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await delay(intervalMs);
    const response = await fetch(url, { method: "GET", headers });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Microsoft Edge Add-ons ${label} status failed (${response.status}): ${sanitizeEdgeAddonsMessage(responseText)}`,
      );
    }
    const payload = safeJson(responseText);
    const status = getEdgeOperationStatus(payload);
    if (status === "succeeded") return payload;
    if (status === "failed") {
      throw new Error(
        `Microsoft Edge Add-ons ${label} failed: ${sanitizeEdgeAddonsMessage(JSON.stringify(payload))}`,
      );
    }
    if (status !== "inprogress") {
      throw new Error(
        `Microsoft Edge Add-ons ${label} returned an unknown status: ${sanitizeEdgeAddonsMessage(responseText)}`,
      );
    }
    console.log(
      `Microsoft Edge Add-ons ${label} is processing (${attempt}/${attempts})...`,
    );
  }
  throw new Error(
    `Microsoft Edge Add-ons ${label} did not finish before the polling timeout.`,
  );
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { raw: sanitizeEdgeAddonsMessage(value) };
  }
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      sanitizeEdgeAddonsMessage(
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
  });
}
