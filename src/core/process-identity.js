import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const exec = promisify(execFile);
let selfIdentity;

// Signal zero is an existence/permission probe. It never terminates a process.
function existence(pid) {
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return error.code === "ESRCH" ? "exited" : "unknown";
  }
}

export async function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  if (existence(pid) === "exited") return { state: "exited" };
  try {
    if (process.platform === "win32") {
      const executable = join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      // pid is an integer; no lock content is interpolated as shell code.
      const script = `$ErrorActionPreference='Stop'; $item=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -ne $item -and $null -ne $item.CreationDate){ [PSCustomObject]@{startedAt=$item.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
      const result = await exec(
        executable,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 5000, maxBuffer: 16384 },
      );
      const value = JSON.parse(result.stdout.trim() || "null");
      if (value?.startedAt && Number.isFinite(Date.parse(value.startedAt)))
        return {
          state: "running",
          identity: `windows:${value.startedAt}`,
          startedAt: value.startedAt,
        };
    } else if (process.platform === "linux") {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const ticks = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19];
      if (/^\d+$/.test(ticks)) {
        let startedAt = null;
        try {
          const [{ stdout }, systemStat] = await Promise.all([
            exec("getconf", ["CLK_TCK"], { timeout: 2000, maxBuffer: 1024 }),
            readFile("/proc/stat", "utf8"),
          ]);
          const boot = Number(/^btime (\d+)$/m.exec(systemStat)?.[1]),
            hz = Number(stdout.trim());
          if (Number.isFinite(boot) && hz > 0)
            startedAt = new Date(
              (boot + Number(ticks) / hz) * 1000,
            ).toISOString();
        } catch {
          /* Exact boot/tick identity still protects new locks. */
        }
        return {
          state: "running",
          identity: `linux:${bootId.trim()}:${ticks}`,
          startedAt,
        };
      }
    } else {
      const { stdout } = await exec(
        "ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          timeout: 5000,
          maxBuffer: 4096,
          windowsHide: true,
        },
      );
      const started = Date.parse(stdout.trim() + " UTC");
      if (Number.isFinite(started)) {
        const startedAt = new Date(started).toISOString();
        return { state: "running", identity: `posix:${startedAt}`, startedAt };
      }
    }
  } catch {
    /* Access denied or unavailable metadata is not proof of an exited owner. */
  }
  return { state: existence(pid) === "exited" ? "exited" : "unknown" };
}

export function inspectSelf() {
  selfIdentity ??= inspectProcess(process.pid)
    .then((value) => {
      if (value.state !== "running" || !value.identity)
        throw new Error(
          "Unable to determine this runner’s process identity. Check local process-query permissions.",
        );
      return value;
    })
    .catch((error) => {
      selfIdentity = null;
      throw error;
    });
  return selfIdentity;
}
