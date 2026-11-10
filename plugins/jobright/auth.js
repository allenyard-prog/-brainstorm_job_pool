import { AuthenticationError, SystemicError } from "../../src/core/errors.js";
import {
  navigateJobright,
  waitForJobright,
  withPageCancellation,
} from "./navigation.js";

export const origin = (context) =>
  context.config.baseUrl ?? "https://jobright.ai";

// Server-rendered SIGN IN can be visible before React attaches its handler.
// Only activate this dialog trigger again; never retry credential submission.
export async function openSignInDialog(context) {
  const timeout = Math.max(1, Number(context.config?.timeout ?? 30000));
  const deadline = Math.min(context.deadline ?? Infinity, Date.now() + timeout);
  const maxAttempts = Math.max(1, Math.min(30, Math.ceil(timeout / 2000)));
  const window = Math.ceil(timeout / maxAttempts);
  for (
    let attempt = 0;
    attempt < maxAttempts && Date.now() < deadline;
    attempt++
  ) {
    context.signal?.throwIfAborted();
    // A partial dialog can still be loading its fields. Do not click through
    // it or toggle it closed while waiting for those controls.
    const modalVisible =
      (await context.page.locator(".ant-modal:visible").count()) > 0;
    if (!modalVisible) {
      try {
        await withPageCancellation(context, () =>
          context.page
            .getByRole("button", { name: /^sign in$/i })
            .first()
            .click({
              noWaitAfter: true,
              timeout: Math.max(1, Math.min(2000, deadline - Date.now())),
            }),
        );
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error.name !== "TimeoutError") throw error;
      }
    }
    try {
      return await waitForJobright(
        { ...context, deadline: Math.min(deadline, Date.now() + window) },
        "credentials",
      );
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error.code !== "JOBRIGHT_CONTROLS_TIMEOUT") throw error;
    }
  }
  context.signal?.throwIfAborted();
  throw new SystemicError(
    "Jobright’s SIGN IN dialog did not become interactive before the timeout. No credentials were submitted. Retry when the page finishes loading, or authenticate with a visible browser.",
  );
}

export async function authenticate(context) {
  const { page, credentials, recorder, signal } = context;
  signal?.throwIfAborted();
  recorder?.action("authentication");
  let state = await navigateJobright(
    context,
    context.hasSession ? `${origin(context)}/jobs/recommend` : origin(context),
    { kind: "entry" },
  );
  if (state === "sign_in") {
    state = await openSignInDialog(context);
  }
  if (state === "credentials") {
    if (!credentials?.email || !credentials?.password)
      throw new AuthenticationError(
        "This Jobright session needs sign-in. Authenticate the profile before collecting jobs.",
      );
    const modal = page.locator(".ant-modal:visible").last();
    await withPageCancellation(context, async () => {
      await modal
        .getByPlaceholder("Email", { exact: true })
        .fill(credentials.email);
      await modal
        .getByPlaceholder("Password", { exact: true })
        .fill(credentials.password);
      // Submit credentials once. Only page reads are eligible for retries.
      await modal
        .getByRole("button", { name: /^sign in$/i })
        .click({ noWaitAfter: true });
    });
    await waitForJobright(context, "login");
  }
  if (!new URL(page.url()).pathname.startsWith("/jobs/recommend"))
    await navigateJobright(context, `${origin(context)}/jobs/recommend`);
  else await waitForJobright(context);
  signal?.throwIfAborted();
  await context.saveSession();
  context.log?.("authenticated");
}
