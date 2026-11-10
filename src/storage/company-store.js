import { randomUUID } from "node:crypto";
import { Store } from "./database.js";
import { ServiceError, notFound } from "../service/errors.js";
import { companySortFields, listSorting } from './list-sorting.js';
import { readListPage } from './list-pagination.js';
import {
  companyNameKey,
  extractCompany,
  mergeCompanyDetails,
} from "./company-normalize.js";

const now = () => new Date().toISOString();
const syncDto = (row) =>
  row
    ? {
        id: row.id,
        status: row.status,
        total: row.total,
        processed: row.processed,
        created: row.created,
        updated: row.updated,
        linked: row.linked,
        skipped: row.skipped,
        warnings: row.warnings,
        queuedAt: row.queued_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        error: row.error
          ? { code: "COMPANY_SYNC_ERROR", message: row.error }
          : null,
      }
    : null;
const companyDto = (row) => ({
  id: row.id,
  name: row.name,
  websiteUrl: row.website_url,
  domain: row.domain,
  location: row.location,
  industry: row.industry,
  isBlacklisted: Boolean(row.is_blacklisted),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastSyncedAt: row.last_synced_at,
  jobCount: row.job_count ?? 0,
  assignedCount: row.assigned_count ?? 0,
  markedAppliedCount: row.applied_count ?? 0,
});
const columnText = (value) =>
  value == null
    ? null
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

export class CompanyStore extends Store {
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  enqueueCompanySync(userId) {
    return this.transaction(() => {
      const active = this.db
        .prepare(
          "SELECT id FROM company_syncs WHERE user_id=? AND status IN ('queued','running')",
        )
        .get(userId);
      if (active)
        throw new ServiceError(
          409,
          "COMPANY_SYNC_EXISTS",
          "A company synchronization is already queued or running.",
          { syncId: active.id },
        );
      const snapshot = this.db
        .prepare(
          "SELECT count(*) AS total,coalesce(max(id),0) AS max FROM jobs WHERE user_id=?",
        )
        .get(userId);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO company_syncs(id,user_id,status,total,max_job_id,queued_at) VALUES(?,?,'queued',?,?,?)",
        )
        .run(id, userId, snapshot.total, snapshot.max, now());
      return this.getCompanySync(userId, id);
    });
  }
  getCompanySync(userId, id) {
    const row = this.db
      .prepare("SELECT * FROM company_syncs WHERE user_id=? AND id=?")
      .get(userId, id);
    if (!row) throw notFound();
    return syncDto(row);
  }
  latestCompanySync(userId) {
    return syncDto(
      this.db
        .prepare(
          "SELECT * FROM company_syncs WHERE user_id=? ORDER BY queued_at DESC,rowid DESC LIMIT 1",
        )
        .get(userId),
    );
  }
  recoverCompanySyncs() {
    return this.db
      .prepare(
        "UPDATE company_syncs SET status='interrupted',ended_at=?,error='Synchronization was interrupted. Start another sync to reconcile remaining jobs.' WHERE status='running'",
      )
      .run(now()).changes;
  }
  claimCompanySync() {
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT id FROM company_syncs WHERE status='running'")
          .get()
      )
        return null;
      const row = this.db
        .prepare(
          "SELECT * FROM company_syncs WHERE status='queued' ORDER BY queued_at,rowid LIMIT 1",
        )
        .get();
      if (!row) return null;
      this.db
        .prepare(
          "UPDATE company_syncs SET status='running',started_at=? WHERE id=?",
        )
        .run(now(), row.id);
      return { id: row.id, userId: row.user_id };
    });
  }
  finishCompanySync(id, status = "failed") {
    if (!["failed", "interrupted"].includes(status))
      throw new Error("Invalid sync termination.");
    this.db
      .prepare(
        "UPDATE company_syncs SET status=?,ended_at=?,error=? WHERE id=? AND status='running'",
      )
      .run(
        status,
        now(),
        status === "interrupted"
          ? "Synchronization was interrupted. Committed progress has been preserved."
          : "Company synchronization failed. Committed progress has been preserved.",
        id,
      );
  }
  companyIdentifiers(userId, companyId) {
    return this.db
      .prepare(
        "SELECT kind,namespace,value FROM company_identifiers WHERE user_id=? AND company_id=?",
      )
      .all(userId, companyId);
  }
  compatibleIdentifiers(left, right) {
    const sourceConflict = left.some(
      (a) =>
        a.kind === "source" &&
        right.some(
          (b) =>
            b.kind === "source" &&
            b.namespace === a.namespace &&
            b.value !== a.value,
        ),
    );
    const sharedSource = left.some(
      (a) =>
        a.kind === "source" &&
        right.some(
          (b) =>
            b.kind === "source" &&
            b.namespace === a.namespace &&
            b.value === a.value,
        ),
    );
    const leftDomains = left.filter((key) => key.kind === "domain"),
      rightDomains = right.filter((key) => key.kind === "domain");
    return (
      !sourceConflict &&
      (sharedSource ||
        !leftDomains.length ||
        !rightDomains.length ||
        leftDomains.some((a) => rightDomains.some((b) => b.value === a.value)))
    );
  }
  mergeCompanies(userId, ids) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b),
      targetId = sorted[0];
    let target = this.db
      .prepare("SELECT * FROM companies WHERE id=? AND user_id=?")
      .get(targetId, userId);
    for (const id of sorted.slice(1)) {
      const other = this.db
        .prepare("SELECT * FROM companies WHERE id=? AND user_id=?")
        .get(id, userId);
      let details = JSON.parse(target.details_json),
        times = JSON.parse(target.field_times_json);
      // Replay leaves with their original timestamps, preserving the newest value per field.
      const otherDetails = JSON.parse(other.details_json),
        otherTimes = JSON.parse(other.field_times_json);
      function visit(value, prefix = "", branch = []) {
        for (const [key, item] of Object.entries(value)) {
          const field = prefix ? `${prefix}.${key}` : key,
            keys = [...branch, key];
          if (item && typeof item === "object" && !Array.isArray(item)) {
            visit(item, field, keys);
            continue;
          }
          let incoming = item;
          for (const segment of [...keys].reverse())
            incoming = { [segment]: incoming };
          ({ details, times } = mergeCompanyDetails(
            details,
            incoming,
            times,
            otherTimes[field] ?? other.updated_at,
          ));
        }
      }
      visit(otherDetails);
      this.db
        .prepare(
          "UPDATE companies SET is_blacklisted=? WHERE id=? AND user_id=?",
        )
        .run(
          Number(Boolean(target.is_blacklisted || other.is_blacklisted)),
          targetId,
          userId,
        );
      this.writeCompany(targetId, details, times, target.last_sync_id, now());
      this.db
        .prepare(
          "UPDATE jobs SET company_id=? WHERE company_id=? AND user_id=?",
        )
        .run(targetId, id, userId);
      const identifiers = this.companyIdentifiers(userId, id);
      this.db
        .prepare(
          "DELETE FROM company_identifiers WHERE company_id=? AND user_id=?",
        )
        .run(id, userId);
      for (const identifier of identifiers)
        this.addCompanyIdentifier(userId, targetId, identifier);
      this.db
        .prepare("DELETE FROM companies WHERE id=? AND user_id=?")
        .run(id, userId);
      target = this.db
        .prepare("SELECT * FROM companies WHERE id=?")
        .get(targetId);
    }
    return targetId;
  }
  addCompanyIdentifier(userId, companyId, { kind, namespace, value }) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO company_identifiers(company_id,user_id,kind,namespace,value) VALUES(?,?,?,?,?)",
      )
      .run(companyId, userId, kind, namespace, value);
  }
  writeCompany(id, details, times, syncId, timestamp) {
    this.db
      .prepare(
        "UPDATE companies SET name=?,normalized_name=?,website_url=?,domain=?,location=?,industry=?,details_json=?,field_times_json=?,updated_at=?,last_synced_at=?,last_sync_id=? WHERE id=?",
      )
      .run(
        details.name,
        companyNameKey(details.name),
        details.website ?? null,
        details.domain ?? null,
        columnText(details.location),
        columnText(details.industry),
        JSON.stringify(details),
        JSON.stringify(times),
        timestamp,
        timestamp,
        syncId,
        id,
      );
  }
  syncCompanyJob(sync, job) {
    const incoming = extractCompany(job);
    if (!incoming) {
      this.db
        .prepare("UPDATE jobs SET company_id=NULL WHERE id=? AND user_id=?")
        .run(job.id, sync.user_id);
      return { linked: 0, skipped: 1, warnings: 0 };
    }
    let warning = false;
    const strong = incoming.identifiers.filter((key) => key.kind !== "name");
    const matches = [];
    for (const key of strong) {
      const row = this.db
        .prepare(
          "SELECT company_id FROM company_identifiers WHERE user_id=? AND kind=? AND namespace=? AND value=?",
        )
        .get(sync.user_id, key.kind, key.namespace, key.value);
      if (row) matches.push(row.company_id);
      if (key.kind === "domain")
        matches.push(
          ...this.db
            .prepare("SELECT id FROM companies WHERE user_id=? AND domain=?")
            .all(sync.user_id, key.value)
            .map((company) => company.id),
        );
    }
    const candidates = [...new Set(matches)];
    if (
      !strong.some((key) => key.kind === "source") &&
      candidates.some((a) =>
        candidates.some(
          (b) =>
            a !== b &&
            !this.compatibleIdentifiers(
              this.companyIdentifiers(sync.user_id, a),
              this.companyIdentifiers(sync.user_id, b),
            ),
        ),
      )
    ) {
      this.db
        .prepare("UPDATE jobs SET company_id=NULL WHERE id=? AND user_id=?")
        .run(job.id, sync.user_id);
      return { linked: 0, skipped: 1, warnings: 1 };
    }
    let id = null;
    for (const candidate of candidates) {
      const identifiers = this.companyIdentifiers(sync.user_id, candidate);
      if (!this.compatibleIdentifiers(identifiers, strong)) {
        warning = true;
        continue;
      }
      if (id == null) id = candidate;
      else if (
        this.compatibleIdentifiers(
          this.companyIdentifiers(sync.user_id, id),
          identifiers,
        )
      )
        id = this.mergeCompanies(sync.user_id, [id, candidate]);
      else warning = true;
    }
    const names = incoming.identifiers.filter((key) => key.kind === "name");
    const nameMatches = names.length
      ? this.db
          .prepare(
            "SELECT DISTINCT company_id FROM company_identifiers WHERE user_id=? AND kind='name' AND value=? ORDER BY company_id",
          )
          .all(sync.user_id, names[0].value)
          .map((row) => row.company_id)
      : [];
    if (id == null && !strong.length && nameMatches.length > 1) {
      this.db
        .prepare("UPDATE jobs SET company_id=NULL WHERE id=? AND user_id=?")
        .run(job.id, sync.user_id);
      return { linked: 0, skipped: 1, warnings: 1 };
    }
    const compatibleNames = nameMatches.filter((candidate) =>
      this.compatibleIdentifiers(
        this.companyIdentifiers(sync.user_id, candidate),
        strong,
      ),
    );
    if (id == null && compatibleNames.length === 1) id = compatibleNames[0];
    else if (id == null && compatibleNames.length > 1) {
      // Only evidence with strong identity can merge multiple name-only records.
      if (
        strong.length &&
        compatibleNames.every(
          (candidate) =>
            !this.companyIdentifiers(sync.user_id, candidate).some(
              (key) => key.kind !== "name",
            ),
        )
      )
        id = this.mergeCompanies(sync.user_id, compatibleNames);
      else {
        warning = true;
        return { linked: 0, skipped: 1, warnings: 1 };
      }
    }
    if (id != null) {
      for (const provisional of compatibleNames) {
        if (
          provisional !== id &&
          !this.companyIdentifiers(sync.user_id, provisional).some(
            (key) => key.kind !== "name",
          )
        )
          id = this.mergeCompanies(sync.user_id, [id, provisional]);
      }
    }
    if (nameMatches.some((candidate) => !compatibleNames.includes(candidate)))
      warning = true;
    if (id == null) {
      const timestamp = now();
      id = Number(
        this.db
          .prepare(
            "INSERT INTO companies(user_id,name,normalized_name,details_json,created_at,updated_at,last_synced_at,created_sync_id,last_sync_id) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
          )
          .get(
            sync.user_id,
            incoming.name,
            companyNameKey(incoming.name),
            "{}",
            timestamp,
            timestamp,
            timestamp,
            sync.id,
            sync.id,
          ).id,
      );
    }
    for (const identifier of incoming.identifiers) {
      if (identifier.kind !== "name") {
        const owner = this.db
          .prepare(
            "SELECT company_id FROM company_identifiers WHERE user_id=? AND kind=? AND namespace=? AND value=?",
          )
          .get(
            sync.user_id,
            identifier.kind,
            identifier.namespace,
            identifier.value,
          );
        if (owner && owner.company_id !== id) {
          warning = true;
          continue;
        }
      }
      this.addCompanyIdentifier(sync.user_id, id, identifier);
    }
    const row = this.db
      .prepare("SELECT * FROM companies WHERE id=? AND user_id=?")
      .get(id, sync.user_id);
    const data = {
      ...incoming.details,
      name: incoming.details.name || row.name,
    };
    const { details, times } = mergeCompanyDetails(
      JSON.parse(row.details_json),
      data,
      JSON.parse(row.field_times_json),
      job.last_scraped_at,
    );
    this.writeCompany(id, details, times, sync.id, now());
    this.db
      .prepare("UPDATE jobs SET company_id=? WHERE id=? AND user_id=?")
      .run(id, job.id, sync.user_id);
    return { linked: 1, skipped: 0, warnings: warning ? 1 : 0 };
  }
  processCompanySyncBatch(id, limit = 100) {
    return this.transaction(() => {
      const sync = this.db
        .prepare("SELECT * FROM company_syncs WHERE id=? AND status='running'")
        .get(id);
      if (!sync) throw new Error("Company sync is not running.");
      const jobs = this.db
        .prepare(
          "SELECT id,site,company,last_scraped_at,CASE WHEN json_type(details_json,'$.company')='object' THEN json_extract(details_json,'$.company') ELSE '{}' END AS company_json FROM jobs WHERE user_id=? AND id>? AND id<=? ORDER BY id LIMIT ?",
        )
        .all(
          sync.user_id,
          sync.cursor,
          sync.max_job_id,
          Math.min(100, Math.max(1, limit)),
        );
      const counters = { linked: 0, skipped: 0, warnings: 0 };
      for (const job of jobs) {
        const result = this.syncCompanyJob(sync, job);
        for (const key of Object.keys(counters)) counters[key] += result[key];
      }
      const touches = this.db
        .prepare(
          "SELECT count(*) AS total,coalesce(sum(created_sync_id=?),0) AS created FROM companies WHERE user_id=? AND last_sync_id=?",
        )
        .get(id, sync.user_id, id);
      const processed = sync.processed + jobs.length;
      const completed = processed >= sync.total || !jobs.length;
      this.db
        .prepare(
          "UPDATE company_syncs SET cursor=?,processed=?,created=?,updated=?,linked=linked+?,skipped=skipped+?,warnings=warnings+?,status=?,ended_at=? WHERE id=?",
        )
        .run(
          jobs.at(-1)?.id ?? sync.cursor,
          processed,
          touches.created,
          touches.total - touches.created,
          counters.linked,
          counters.skipped,
          counters.warnings,
          completed ? "completed" : "running",
          completed ? now() : null,
          id,
        );
      return this.getCompanySync(sync.user_id, id);
    });
  }
  listCompanies(userId, { cursor, limit = 20, page, q, connectionId, sortBy, sortOrder } = {}) {
    const sorting = listSorting('companies', companySortFields, { cursor, sortBy, sortOrder });
    const clauses = ["c.user_id=?", sorting.where],
      params = [userId, ...sorting.params];
    if (q) {
      clauses.push("c.normalized_name LIKE ? ESCAPE '\\'");
      params.push(`%${companyNameKey(q).replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (connectionId) {
      clauses.push(
        "EXISTS(SELECT 1 FROM jobs j WHERE j.company_id=c.id AND j.user_id=? AND j.connection_id=?)",
      );
      params.push(userId, connectionId);
    }
    // Counts are computed from current job states; assignments and tracking do not need another sync.
    const counts = `SELECT company_id,count(*) AS job_count,sum(assigned_at IS NOT NULL) AS assigned_count,sum(p.state='mark_confirmed') AS applied_count FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE j.user_id=? ${connectionId ? "AND j.connection_id=?" : ""} GROUP BY company_id`;
    const { rows, metadata } = readListPage(this.db, { page, limit, cursor },
      () => this.db.prepare(`SELECT count(*) AS total FROM companies c WHERE ${clauses.join(' AND ')}`).get(...params).total,
      (size, offset) => this.db
      .prepare(
        `SELECT c.id,c.name,c.website_url,c.domain,c.location,c.industry,c.is_blacklisted,c.created_at,c.updated_at,c.last_synced_at,coalesce(n.job_count,0) AS job_count,coalesce(n.assigned_count,0) AS assigned_count,coalesce(n.applied_count,0) AS applied_count,${sorting.expression} AS sort_value FROM companies c LEFT JOIN (${counts}) n ON n.company_id=c.id WHERE ${clauses.join(" AND ")} ORDER BY ${sorting.order} LIMIT ? OFFSET ?`,
      )
      .all(
        userId,
        ...(connectionId ? [connectionId] : []),
        ...params,
        size, offset,
      ));
    const items = rows.slice(0, limit).map(companyDto);
    return {
      items,
      ...metadata,
      nextCursor:
        rows.length > limit
          ? sorting.cursor(rows[limit - 1])
          : null,
    };
  }
  setCompanyBlacklist(userId, id, isBlacklisted) {
    if (typeof isBlacklisted !== "boolean")
      throw new ServiceError(
        400,
        "INVALID_BLACKLIST_VALUE",
        "isBlacklisted must be a boolean.",
      );
    return this.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE companies SET is_blacklisted=? WHERE id=? AND user_id=?",
        )
        .run(Number(isBlacklisted), id, userId);
      if (!result.changes) throw notFound();
      const { details, ...summary } = this.companyDetail(userId, id);
      return summary;
    });
  }
  companyDetail(userId, id) {
    const row = this.db
      .prepare("SELECT * FROM companies WHERE user_id=? AND id=?")
      .get(userId, id);
    if (!row) throw notFound();
    const counts = this.db
      .prepare(
        "SELECT count(*) AS job_count,coalesce(sum(assigned_at IS NOT NULL),0) AS assigned_count,coalesce(sum(p.state='mark_confirmed'),0) AS applied_count FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE j.user_id=? AND j.company_id=?",
      )
      .get(userId, id);
    return {
      ...companyDto({ ...row, ...counts }),
      details: JSON.parse(row.details_json),
    };
  }
}

export const companyRpcMethods = [
  "enqueueCompanySync",
  "getCompanySync",
  "latestCompanySync",
  "recoverCompanySyncs",
  "claimCompanySync",
  "finishCompanySync",
  "processCompanySyncBatch",
  "listCompanies",
  "companyDetail",
  "setCompanyBlacklist",
];
