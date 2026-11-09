import { describe, it, expect, vi } from "vitest";
import { api, safeLink, dateLabel, mergeEvents } from "../api.js";

describe("API boundaries and metadata helpers", () => {
  it("sends cookie-authenticated JSON once and exposes duplicate run conflicts", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "RUN_EXISTS",
              message: "Already queued",
              details: { runId: "existing" },
            },
          }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      api("/runs", { method: "POST", body: { readOnly: true } }),
    ).rejects.toMatchObject({ status: 409, details: { runId: "existing" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      method: "POST",
      body: '{"readOnly":true}',
    });
  });
  it("allows only absolute HTTP(S) external links and preserves source dates", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,bad",
      "/relative",
      "file:///private",
    ])
      expect(safeLink(value)).toBeNull();
    expect(safeLink("https://company.test/jobs")).toBe(
      "https://company.test/jobs",
    );
    expect(dateLabel("2 days ago")).toBe("2 days ago");
    expect(dateLabel("2026-11-08 12:00:00")).toBe("2026-11-08 12:00:00");
  });
  it("deduplicates and bounds event history", () => {
    const entries = Array.from({ length: 600 }, (_, id) => ({ id }));
    const result = mergeEvents(entries.slice(0, 300), entries.slice(200));
    expect(result).toHaveLength(500);
    expect(result[0].id).toBe(100);
    expect(result.at(-1).id).toBe(599);
  });
});
