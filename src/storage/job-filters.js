import { ServiceError } from "../service/errors.js";
import { calendarDate } from "./job-filter-values.js";

export function jobWhere(
  userId,
  {
    site,
    connectionId,
    companyId,
    company,
    q,
    status,
    collectedFrom,
    collectedTo,
    registeredFrom,
    registeredTo,
    postedFrom,
    postedTo,
    availableOnly = false,
    excludeBlacklistedCompanies = false,
    ...scores
  } = {},
) {
  const clauses = ["j.user_id=?"],
    params = [userId];
  const from = collectedFrom ? new Date(collectedFrom) : null,
    to = collectedTo ? new Date(collectedTo) : null;
  if (
    (from && !Number.isFinite(from.valueOf())) ||
    (to && !Number.isFinite(to.valueOf())) ||
    (from && to && from > to)
  ) {
    throw new ServiceError(
      400,
      "INVALID_TIME_RANGE",
      "Collected from must be before or equal to collected to.",
    );
  }
  if (from) {
    clauses.push("j.last_scraped_at>=?");
    params.push(from.toISOString());
  }
  if (to) {
    clauses.push("j.last_scraped_at<=?");
    params.push(to.toISOString());
  }
  const first = registeredFrom ? new Date(registeredFrom) : null,
    last = registeredTo ? new Date(registeredTo) : null;
  if (
    (first &&
      (!Number.isFinite(first.valueOf()) || !calendarDate(registeredFrom))) ||
    (last &&
      (!Number.isFinite(last.valueOf()) || !calendarDate(registeredTo))) ||
    (first && last && first > last)
  )
    throw new ServiceError(
      400,
      "INVALID_FILTER_RANGE",
      "Registered from must be before or equal to registered to.",
    );
  if (first) {
    clauses.push("j.first_seen_at>=?");
    params.push(first.toISOString());
  }
  if (last) {
    clauses.push("j.first_seen_at<=?");
    params.push(last.toISOString());
  }
  if (
    (postedFrom && calendarDate(postedFrom) !== postedFrom) ||
    (postedTo && calendarDate(postedTo) !== postedTo) ||
    (postedFrom && postedTo && postedFrom > postedTo)
  )
    throw new ServiceError(
      400,
      "INVALID_FILTER_RANGE",
      "Posted dates must be valid calendar dates with from before or equal to to.",
    );
  if (postedFrom) {
    clauses.push("j.posted_date>=?");
    params.push(postedFrom);
  }
  if (postedTo) {
    clauses.push("j.posted_date<=?");
    params.push(postedTo);
  }
  for (const [prefix, column, label] of [
    ["totalMatch", "match_total_score", "Total match"],
    ["skillMatch", "match_skill_score", "Skill match"],
    ["industryMatch", "match_industry_score", "Industry match"],
  ]) {
    const min = scores[`${prefix}Min`],
      max = scores[`${prefix}Max`];
    const hasMin = min !== undefined && min !== null && min !== "",
      hasMax = max !== undefined && max !== null && max !== "";
    if (
      (hasMin &&
        (!Number.isFinite(Number(min)) ||
          Number(min) < 0 ||
          Number(min) > 100)) ||
      (hasMax &&
        (!Number.isFinite(Number(max)) ||
          Number(max) < 0 ||
          Number(max) > 100)) ||
      (hasMin && hasMax && Number(min) > Number(max))
    )
      throw new ServiceError(
        400,
        "INVALID_FILTER_RANGE",
        `${label} must be between 0 and 100, with minimum no greater than maximum.`,
      );
    if (hasMin) {
      clauses.push(`j.${column}>=?`);
      params.push(Number(min));
    }
    if (hasMax) {
      clauses.push(`j.${column}<=?`);
      params.push(Number(max));
    }
  }
  if (site) {
    clauses.push("j.site=?");
    params.push(site);
  }
  if (connectionId) {
    clauses.push("j.connection_id=?");
    params.push(connectionId);
  }
  if (companyId) {
    clauses.push("j.company_id=?");
    params.push(companyId);
  }
  if (company?.trim()) {
    clauses.push("j.company LIKE ? ESCAPE '\\'");
    params.push(`%${company.trim().replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (q) {
    clauses.push(
      "(j.title LIKE ? ESCAPE '\\' OR j.company LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(pattern, pattern);
  }
  if (status === "assigned") clauses.push("j.assigned_at IS NOT NULL");
  else if (status) {
    clauses.push("j.assigned_at IS NULL");
    if (status !== "available") {
      clauses.push("p.state=?");
      params.push(status);
    }
  }
  if (availableOnly) clauses.push("j.assigned_at IS NULL");
  if (excludeBlacklistedCompanies === true)
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM companies blacklist WHERE blacklist.id=j.company_id AND blacklist.user_id=j.user_id AND blacklist.is_blacklisted=1)",
    );
  return { where: clauses.join(" AND "), params };
}
