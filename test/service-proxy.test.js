import test from "node:test";
import assert from "node:assert/strict";
import { apiProxy } from "../web/vite.config.js";

test("development proxy rewrites only its trusted frontend Origin", () => {
  const options = apiProxy("http://127.0.0.1:3999");
  let handler;
  options.configure({
    on: (name, callback) => {
      if (name === "proxyReq") handler = callback;
    },
  });
  const headers = {};
  handler(
    {
      setHeader: (name, value) => {
        headers[name] = value;
      },
    },
    { headers: { origin: "http://127.0.0.1:5173" } },
  );
  assert.equal(headers.origin, "http://127.0.0.1:3999");
  let replaced = false;
  handler(
    {
      setHeader: () => {
        replaced = true;
      },
    },
    { headers: { origin: "https://untrusted.test" } },
  );
  assert.equal(replaced, false);
  assert.throws(() => apiProxy("https://external.test"));
});
