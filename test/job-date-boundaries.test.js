import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("registered day bounds include complete local days across DST changes", () => {
  const script = `import {localDayBound,localDay} from './web/src/job-filters.js';console.log(JSON.stringify(['2026-03-08','2026-11-01'].map(day=>({day,start:localDayBound(day),end:localDayBound(day,true),restored:localDay(localDayBound(day))}))));`;
  const rows = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.deepEqual(rows, [
    {
      day: "2026-03-08",
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T03:59:59.999Z",
      restored: "2026-03-08",
    },
    {
      day: "2026-11-01",
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T04:59:59.999Z",
      restored: "2026-11-01",
    },
  ]);
});
