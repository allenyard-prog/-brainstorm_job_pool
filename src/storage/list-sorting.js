import { ServiceError } from "../service/errors.js";

const text = (expression) => [
  `lower(nullif(trim(${expression}),''))`,
  "string",
];
const number = (expression) => [expression, "number"];
export const jobSortFields = {
  id: number("j.id"),
  title: text("j.title"),
  company: text("j.company"),
  profile: text(
    "coalesce(nullif(connection.person_name,''),connection.label,j.site)",
  ),
  preferredTitle: text("preferred.title"),
  tracking: text(
    "CASE WHEN j.assigned_at IS NOT NULL THEN 'Assigned' WHEN p.state='saved' THEN 'Saved' WHEN p.state='mark_confirmed' THEN 'Marked applied' WHEN p.state='mark_pending' THEN 'Update unconfirmed' END",
  ),
  postedDate: text("j.posted_date"),
  firstSeenAt: text("j.first_seen_at"),
  lastScrapedAt: text("j.last_scraped_at"),
  totalMatch: number("j.match_total_score"),
  skillMatch: number("j.match_skill_score"),
  industryMatch: number("j.match_industry_score"),
};
export const companySortFields = {
  id: number("c.id"),
  name: text("c.name"),
  domain: text("c.domain"),
  location: text("c.location"),
  industry: text("c.industry"),
  jobCount: number("coalesce(n.job_count,0)"),
  assignedCount: number("coalesce(n.assigned_count,0)"),
  markedAppliedCount: number("coalesce(n.applied_count,0)"),
  isBlacklisted: number("c.is_blacklisted"),
};

// Only static expressions in these maps can enter SQL. Cursor values remain bound parameters.
export function listSorting(
  resource,
  fields,
  { sortBy = "id", sortOrder = "desc", cursor } = {},
) {
  if (!Object.hasOwn(fields, sortBy) || !["asc", "desc"].includes(sortOrder))
    throw new ServiceError(
      400,
      "INVALID_SORT",
      "Choose a supported sort column and direction.",
    );
  const [expression, type] = fields[sortBy];
  const id = fields.id[0],
    direction = sortOrder.toUpperCase(),
    comparison = sortOrder === "asc" ? ">" : "<";
  let after = null;
  const invalid = () =>
    new ServiceError(
      400,
      "INVALID_CURSOR",
      "Invalid pagination cursor, or its sort order has changed. Return to the first page.",
    );
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString();
      // Preserve existing newest-first links and export cursors.
      if (/^\d+$/.test(decoded) && sortBy === "id" && sortOrder === "desc")
        after = { id: Number(decoded), value: Number(decoded) };
      else {
        after = JSON.parse(decoded);
        if (
          after?.v !== 1 ||
          after.resource !== resource ||
          after.sortBy !== sortBy ||
          after.sortOrder !== sortOrder
        )
          throw invalid();
      }
      if (
        !Number.isSafeInteger(after.id) ||
        after.id < 1 ||
        (after.value !== null &&
          (typeof after.value !== type ||
            (type === "number" && !Number.isFinite(after.value))))
      )
        throw invalid();
    } catch {
      throw invalid();
    }
  }
  let where = "1=1",
    params = [];
  if (after) {
    if (sortBy === "id") {
      where = `${id}${comparison}?`;
      params = [after.id];
    } else if (after.value === null) {
      where = `(${expression} IS NULL AND ${id}${comparison}?)`;
      params = [after.id];
    } else {
      where = `(${expression}${comparison}? OR (${expression}=? AND ${id}${comparison}?) OR ${expression} IS NULL)`;
      params = [after.value, after.value, after.id];
    }
  }
  return {
    expression,
    where,
    params,
    order:
      sortBy === "id"
        ? `${id} ${direction}`
        : `(${expression} IS NULL) ASC,${expression} ${direction},${id} ${direction}`,
    cursor(row) {
      if (sortBy === "id" && sortOrder === "desc")
        return Buffer.from(String(row.id)).toString("base64url");
      return Buffer.from(
        JSON.stringify({
          v: 1,
          resource,
          sortBy,
          sortOrder,
          id: row.id,
          value: row.sort_value,
        }),
      ).toString("base64url");
    },
  };
}
