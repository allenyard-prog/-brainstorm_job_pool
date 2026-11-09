export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export async function api(
  path,
  { method = "GET", body, signal, publicRequest = false } = {},
) {
  let response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      signal,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "OFFLINE",
      "Cannot reach the backend. Check that the service is running and try again.",
    );
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !publicRequest)
      window.dispatchEvent(new Event("gather:session-expired"));
    throw new ApiError(
      response.status,
      result?.error?.code ?? "REQUEST_FAILED",
      result?.error?.message ?? "The request could not be completed.",
      result?.error?.details,
    );
  }
  return result;
}
export function queryString(values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}
export const isActive = (status) =>
  ["queued", "starting", "running", "stop_requested"].includes(status);
export const canRetry = (status) =>
  ["stopped", "failed", "attention_required", "interrupted"].includes(status);
export function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function dateLabel(value) {
  if (!value) return "—";
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
export function mergeEvents(previous, incoming) {
  return [
    ...new Map(
      [...previous, ...incoming].map((event) => [event.id, event]),
    ).values(),
  ]
    .sort((a, b) => a.id - b.id)
    .slice(-500);
}
