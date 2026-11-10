import {
  AuthenticationError,
  SystemicError,
  UnsupportedError,
  delay,
} from "../../src/core/errors.js";

const timeoutFor = (context) =>
  Math.max(1, Number(context.config?.timeout ?? 30000));
const remaining = (context) =>
  Math.max(
    1,
    Math.min(timeoutFor(context), (context.deadline ?? Infinity) - Date.now()),
  );

// Close only this page on cancellation. Keep the HTTP cookie jar available for
// reconciliation of already-sent tracking updates; never retry those writes.
export async function withPageCancellation(context, operation) {
  const { signal, page } = context;
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => {
      void page.close({ runBeforeUnload: false }).catch(() => {});
      reject(signal.reason ?? new DOMException("Stopped.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal.aborted) abort();
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function pageState(kind) {
  const visible = (element) =>
    !!element &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  if (/just a moment|access denied|security verification/i.test(document.title))
    return "challenge";
  const account = visible(document.querySelector('a[href="/jobs/profile"]'));
  if (
    kind === "detail" &&
    visible(document.querySelector('[class*="jobDetailContent"] h1'))
  )
    return "ready";
  if (account && kind !== "detail") return "authenticated";
  if (
    kind === "login" &&
    [
      ...document.querySelectorAll(
        ".ant-message-error,.ant-form-item-explain-error",
      ),
    ].some(visible)
  )
    return "rejected";
  const password = [
    ...document.querySelectorAll(
      'input[type="password"],input[placeholder="Password"]',
    ),
  ].some(visible);
  const email = [
    ...document.querySelectorAll('input[placeholder="Email"]'),
  ].some(visible);
  if ((kind === "entry" || kind === "credentials") && password && email)
    return "credentials";
  const signIn = [...document.querySelectorAll('button,[role="button"]')].some(
    (element) =>
      visible(element) && /^sign\s*in$/i.test(element.textContent.trim()),
  );
  if (kind === "entry" && signIn) return "sign_in";
  if (!["entry", "credentials", "login"].includes(kind) && (password || signIn))
    return "expired";
  return false;
}

export async function waitForJobright(context, kind = "account") {
  try {
    const state = await withPageCancellation(context, async () => {
      const handle = await context.page.waitForFunction(pageState, kind, {
        timeout: remaining(context),
        polling: 100,
      });
      try {
        return await handle.jsonValue();
      } finally {
        await handle.dispose();
      }
    });
    if (state === "challenge")
      throw new AuthenticationError(
        "Jobright requires interactive verification. Authenticate this profile with a visible browser, then retry the run.",
      );
    if (state === "expired")
      throw new AuthenticationError(
        "The Jobright session expired. Authenticate this profile, then retry the run.",
      );
    if (state === "rejected")
      throw new AuthenticationError(
        "Jobright rejected the sign-in information.",
      );
    return state;
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error instanceof AuthenticationError) throw error;
    if (error.name === "TimeoutError")
      throw Object.assign(
        new SystemicError(
          "Jobright did not display the expected page controls before the timeout. Retry the run; if verification is required, authenticate this profile with a visible browser.",
        ),
        { code: "JOBRIGHT_CONTROLS_TIMEOUT" },
      );
    throw error;
  }
}

export async function navigateJobright(
  context,
  url,
  { kind = "account", timeout = timeoutFor(context) } = {},
) {
  const target = new URL(url);
  const expectedOrigin = new URL(
    context.config?.baseUrl ?? "https://jobright.ai",
  ).origin;
  if (target.origin !== expectedOrigin)
    throw new UnsupportedError(
      "The Jobright navigation target has an unexpected origin.",
    );
  const deadline = Math.min(context.deadline ?? Infinity, Date.now() + timeout);
  const bounded = { ...context, deadline };
  let attempts = 0,
    reason = "page not ready";
  for (; attempts < 3 && Date.now() < deadline; attempts++) {
    context.signal?.throwIfAborted();
    try {
      const response = await withPageCancellation(bounded, () =>
        context.page.goto(target.href, {
          waitUntil: "commit",
          timeout: Math.min(15000, remaining(bounded)),
        }),
      );
      const status = response?.status();
      if ([401, 403].includes(status))
        throw new AuthenticationError(
          `Jobright blocked access (HTTP ${status}). Authenticate this profile with a visible browser, then retry.`,
        );
      if (status === 429)
        throw new SystemicError(
          "Jobright rate limit reached. Wait before retrying this run.",
        );
      if (status >= 500)
        throw Object.assign(new Error(`HTTP ${status}`), {
          retryNavigation: true,
        });
      if (status >= 400)
        throw new UnsupportedError(
          `Jobright page ${target.pathname} returned HTTP ${status}.`,
        );
      if (new URL(context.page.url()).origin !== expectedOrigin)
        throw new AuthenticationError(
          "Jobright redirected to an unexpected sign-in origin. Authenticate with a visible browser.",
        );
      return await waitForJobright(bounded, kind);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (
        error instanceof AuthenticationError ||
        error instanceof UnsupportedError ||
        error instanceof SystemicError
      )
        throw error;
      const network =
        /net::ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)/.exec(
          error.message ?? "",
        );
      const retryable =
        error.retryNavigation || error.name === "TimeoutError" || !!network;
      reason = error.retryNavigation
        ? error.message
        : (network?.[0] ??
          (error.name === "TimeoutError"
            ? "document response timed out"
            : "navigation failed"));
      if (!retryable || context.page.isClosed() || attempts === 2) {
        attempts++;
        break;
      }
      context.log?.("navigation_retry", {
        path: target.pathname,
        attempt: attempts + 2,
        reason,
      });
      await delay(
        Math.min(500 * (attempts + 1), Math.max(0, deadline - Date.now())),
        context.signal,
      );
    }
  }
  context.signal?.throwIfAborted();
  throw new SystemicError(
    `Jobright navigation to ${target.pathname} failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (${reason}). Retry the run when Jobright is available.`,
  );
}
