import { ServiceError } from "../service/errors.js";

// Count and read share a short WAL read snapshot, without reserving a write lock.
// Cursor callers retain their existing contract; numbered callers can jump directly.
export function readListPage(db, { page, limit, cursor }, count, read) {
  if (page === undefined) return { rows: read(limit + 1, 0), metadata: {} };
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || cursor)
    throw new ServiceError(
      400,
      "INVALID_PAGINATION",
      "Choose a positive page number without a cursor.",
    );
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ServiceError(
      400,
      "INVALID_PAGINATION",
      "Page size must be between 1 and 100.",
    );
  db.exec("BEGIN");
  try {
    const total = count(),
      totalPages = Math.max(1, Math.ceil(total / limit));
    const current = Math.min(page, totalPages);
    const rows = read(limit + 1, (current - 1) * limit);
    db.exec("COMMIT");
    return {
      rows,
      metadata: { total, page: current, pageSize: limit, totalPages },
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
