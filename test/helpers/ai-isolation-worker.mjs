import { ServiceStore } from "../../src/storage/service-store.js";

process.once("message", (message) => {
  const payload = message.payload;
  const store = new ServiceStore(payload.dbPath, {
    userId: payload.run.user_id,
    connectionId: payload.run.connection_id,
  });
  try {
    store.workerStarted(payload.run.id);
    store.addEvent(payload.run.id, "ai_isolation", {
      environmentHasKeys: [
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "DEEPSEEK_API_KEY",
        "ANTHROPIC_API_KEY",
      ].some((name) => Object.hasOwn(process.env, name)),
      payloadHasKeys: JSON.stringify(payload).includes("fixture-ai-secret"),
    });
    store.endRun(payload.run.id, "completed");
  } finally {
    store.close();
  }
  process.send({ type: "finished" }, () => process.disconnect());
});
process.send({ type: "ready" });
