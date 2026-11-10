const text = (value) => (typeof value === "string" ? value.trim() : null);
const content = (value) =>
  typeof value === "string" && value.trim() ? value : null;
export const companyNameKey = (value) =>
  text(value)?.normalize("NFKC").toLowerCase().replace(/\s+/g, " ") ?? "";
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const excludedDomain =
  /(^|\.)(jobright\.ai|linkedin\.com|crunchbase\.com|facebook\.com|twitter\.com|x\.com|indeed\.com|glassdoor\.com)$/;

export function companyWebsite(value) {
  try {
    const url = new URL(value);
    const domain = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      excludedDomain.test(domain)
    )
      return null;
    return { url: url.href, domain };
  } catch {
    return null;
  }
}

export function extractCompany(job) {
  const source = record(JSON.parse(job.company_json ?? "{}"));
  const name =
    text(source.companyName) || text(source.name) || text(job.company);
  const website = companyWebsite(
    source.companyURL ?? source.websiteUrl ?? source.website,
  );
  const rawId = source.companyId;
  const sourceId =
    (typeof rawId === "string" && rawId.trim()) ||
    (typeof rawId === "number" && Number.isFinite(rawId)
      ? String(rawId)
      : null);
  if (!name && !website && !sourceId) return null;
  const identifiers = [];
  if (sourceId)
    identifiers.push({ kind: "source", namespace: job.site, value: sourceId });
  if (website)
    identifiers.push({ kind: "domain", namespace: "", value: website.domain });
  if (name)
    identifiers.push({
      kind: "name",
      namespace: "",
      value: companyNameKey(name),
    });
  return {
    name: name || website?.domain || `Company ${sourceId}`,
    identifiers,
    details: {
      name,
      website: website?.url,
      domain: website?.domain,
      description:
        content(source.companyDesc) ||
        content(source.description) ||
        content(source.text),
      location:
        source.companyLocation ?? source.location ?? source.headquarters,
      industry: source.companyIndustry ?? source.industry ?? source.industries,
      size: source.companySize ?? source.size,
      founded: source.companyFoundYear ?? source.founded,
      funding: source.fundraisingCurrentStage ?? source.funding,
      links: source.links ?? source.pressReferences,
      sourceMetadata: source,
    },
  };
}

// Field-level collection timestamps prevent an older, later-ID job from overwriting
// newer metadata. Empty fields never erase useful information from another transport.
export function mergeCompanyDetails(
  previous,
  incoming,
  previousTimes,
  timestamp,
) {
  const output = structuredClone(previous),
    times = { ...previousTimes };
  const newest = (field) =>
    Object.entries(times).reduce(
      (latest, [key, time]) =>
        key === field || key.startsWith(`${field}.`)
          ? time > latest
            ? time
            : latest
          : latest,
      "",
    );
  function merge(target, values, prefix = "", floor = "") {
    for (const [key, value] of Object.entries(values)) {
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        value == null ||
        (typeof value === "string" && !value.trim())
      )
        continue;
      const field = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        if (!value.length) continue;
      } else if (typeof value === "object") {
        if (!Object.keys(value).length) continue;
        if (
          !target[key] ||
          typeof target[key] !== "object" ||
          Array.isArray(target[key])
        ) {
          if (timestamp < floor || timestamp < newest(field)) continue;
          if (target[key] !== undefined) times[field] = timestamp;
          target[key] = {};
        }
        const barrier =
          times[field] && times[field] > floor ? times[field] : floor;
        merge(target[key], value, field, barrier);
        continue;
      }
      if (timestamp >= floor && timestamp >= newest(field)) {
        target[key] = value;
        for (const key of Object.keys(times))
          if (key.startsWith(`${field}.`)) delete times[key];
        times[field] = timestamp;
      }
    }
  }
  merge(output, incoming);
  return { details: output, times };
}
