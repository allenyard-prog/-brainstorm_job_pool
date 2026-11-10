import { setImmediate } from "node:timers/promises";

// Local database maintenance is separate from scraper capacity and account locks.
// Each batch is one bounded database-thread RPC, yielding to queued API reads.
export class CompanySyncCoordinator {
  constructor(db) {
    this.db = db;
    this.started = false;
    this.closing = false;
    this.requested = false;
    this.task = null;
    this.activeId = null;
    this.lastError = null;
  }
  async start() {
    if (this.started) return;
    await this.db.call("recoverCompanySyncs");
    this.started = true;
    this.wake();
  }
  wake() {
    this.requested = true;
    if (!this.started || this.closing || this.task) return;
    this.task = this.drain()
      .catch((error) => {
        this.lastError = error;
      })
      .finally(() => {
        this.task = null;
        if (this.requested && !this.closing) this.wake();
      });
  }
  async drain() {
    while (!this.closing) {
      this.requested = false;
      const sync = await this.db.call("claimCompanySync");
      if (!sync) return;
      this.activeId = sync.id;
      try {
        let status = "running";
        while (!this.closing && status === "running") {
          const progress = await this.db.call(
            "processCompanySyncBatch",
            sync.id,
            100,
          );
          status = progress.status;
          await setImmediate();
        }
        if (this.closing && status === "running")
          await this.db.call("finishCompanySync", sync.id, "interrupted");
      } catch (error) {
        this.lastError = error;
        await this.db.call("finishCompanySync", sync.id, "failed");
      } finally {
        this.activeId = null;
      }
    }
  }
  async close() {
    this.closing = true;
    await this.task;
  }
}
