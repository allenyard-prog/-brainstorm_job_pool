export const scoreRanges = [
  ["totalMatch", "Total match"],
  ["skillMatch", "Skill match"],
  ["industryMatch", "Industry match"],
];
export const drawerKeys = [
  "excludeBlacklistedCompanies",
  "company",
  "companyId",
  "postedFrom",
  "postedTo",
  "registeredFrom",
  "registeredTo",
  "connectionId",
  "site",
  "status",
  "collectedFrom",
  "collectedTo",
  ...scoreRanges.flatMap(([key]) => [key + "Min", key + "Max"]),
];
export const jobFilterKeys = ["q", ...drawerKeys];
export function readJobFilters(params) {
  return Object.fromEntries(
    jobFilterKeys.map((key) => [
      key,
      key === "excludeBlacklistedCompanies" && params.get(key) === "false"
        ? ""
        : (params.get(key) ?? ""),
    ]),
  );
}
export function localDay(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.valueOf())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function validDay(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function localDayBound(value, end = false) {
  if (!value) return "";
  if (!validDay(value)) throw new Error("Choose a valid calendar date.");
  const [year, month, day] = value.split("-").map(Number),
    date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (end) {
    date.setDate(date.getDate() + 1);
    date.setTime(date.valueOf() - 1);
  }
  return date.toISOString();
}
export function filterDraft(filters) {
  return {
    ...filters,
    registeredFrom: localDay(filters.registeredFrom),
    registeredTo: localDay(filters.registeredTo),
  };
}
export function validateDraft(draft) {
  const errors = {};
  for (const [key, label] of [
    ["posted", "Posted"],
    ["registered", "Registered"],
  ]) {
    const from = draft[key + "From"],
      to = draft[key + "To"];
    if (
      (from && !validDay(from)) ||
      (to && !validDay(to)) ||
      (from && to && from > to)
    )
      errors[key] =
        `${label} dates must be valid, with from before or equal to to.`;
  }
  for (const [key, label] of scoreRanges) {
    const min = draft[key + "Min"],
      max = draft[key + "Max"];
    if (
      [min, max].some(
        (value) =>
          value !== "" &&
          value != null &&
          (!Number.isFinite(Number(value)) ||
            Number(value) < 0 ||
            Number(value) > 100),
      ) ||
      (min !== "" && max !== "" && Number(min) > Number(max))
    )
      errors[key] =
        `${label} must be between 0 and 100, with minimum no greater than maximum.`;
  }
  return errors;
}
export function appliedDraft(draft) {
  return {
    ...Object.fromEntries(drawerKeys.map((key) => [key, draft[key] ?? ""])),
    company: draft.company.trim(),
    registeredFrom: localDayBound(draft.registeredFrom),
    registeredTo: localDayBound(draft.registeredTo, true),
  };
}
export function jobFilterBody(filters) {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [
        key,
        key === "excludeBlacklistedCompanies"
          ? value === "true"
            ? true
            : value === "false"
              ? false
              : value
          : scoreRanges.some(
                ([prefix]) => key === prefix + "Min" || key === prefix + "Max",
              )
            ? Number(value)
            : value,
      ]),
  );
}
const range = (from, to) =>
  from && to ? `${from} – ${to}` : from ? `From ${from}` : `Up to ${to}`;
export function filterChips(filters, profiles = [], sites = []) {
  const chips = [];
  const add = (keys, label, value) => {
    if (keys.some((key) => filters[key] !== "" && filters[key] != null))
      chips.push({ keys, label, value });
  };
  if (
    filters.excludeBlacklistedCompanies === "true" ||
    filters.excludeBlacklistedCompanies === true
  )
    add(["excludeBlacklistedCompanies"], "Blacklist", "Excluded");
  add(["company"], "Company", filters.company);
  add(["companyId"], "Company directory", `#${filters.companyId}`);
  add(
    ["postedFrom", "postedTo"],
    "Posted",
    range(filters.postedFrom, filters.postedTo),
  );
  add(
    ["registeredFrom", "registeredTo"],
    "Registered",
    range(localDay(filters.registeredFrom), localDay(filters.registeredTo)),
  );
  for (const [key, label] of scoreRanges)
    add(
      [key + "Min", key + "Max"],
      label,
      range(filters[key + "Min"], filters[key + "Max"]),
    );
  add(
    ["connectionId"],
    "Profile",
    profiles.find((profile) => profile.id === filters.connectionId)?.label ??
      filters.connectionId,
  );
  add(
    ["site"],
    "Website",
    sites.find((site) => site.id === filters.site)?.name ?? filters.site,
  );
  const statuses = {
    available: "Available (unassigned)",
    assigned: "Assigned",
    saved: "Saved",
    mark_pending: "Update unconfirmed",
    mark_confirmed: "Marked applied",
  };
  add(["status"], "Tracking", statuses[filters.status] ?? filters.status);
  add(
    ["collectedFrom", "collectedTo"],
    "Last refreshed",
    range(filters.collectedFrom, filters.collectedTo),
  );
  return chips;
}
