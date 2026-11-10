// Derived search values only; original source metadata remains untouched.
export function calendarDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(
      text,
    );
  if (!match) return null;
  const day = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(day.valueOf()) &&
    day.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}
function score(value, maximum = 100) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum
    ? number
    : null;
}
function uniqueScore(values, maximum = 100) {
  if (!values.length) return null;
  const parsed = values.map((value) => score(value, maximum));
  return parsed.every((value) => value !== null) && new Set(parsed).size === 1
    ? parsed[0]
    : null;
}
const labels = {
  total:
    /^(?:total(?: match)?|overall(?: match)?|match score|(?:good|strong|fair|weak) match|match)$/i,
  skill: /^skills?(?: match)?$/i,
  industry: /^industry(?: match| experience)?$/i,
};
function chartScore(charts, kind) {
  const candidates = (Array.isArray(charts) ? charts : []).filter((chart) => {
    const label = String(chart?.text ?? "")
      .replace(/\b\d+(?:\.\d+)?\s*%?/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return labels[kind].test(label);
  });
  return uniqueScore(candidates.map((chart) => chart.value));
}
function recommendationScore(matching, kind, feature) {
  const candidates = (
    Array.isArray(matching.recommendations) ? matching.recommendations : []
  ).filter(
    (item) =>
      item?.featureName === feature ||
      (!item?.featureName &&
        labels[kind].test(String(item?.displayName ?? "").trim())),
  );
  if (!candidates.length) return chartScore(matching.charts, kind);
  const value = uniqueScore(
    candidates.map((item) => item.score),
    1,
  );
  if (value === null) return null;
  // Shift the source decimal rather than introducing multiplication artifacts
  // such as 0.58 * 100 === 57.99999999999999 at an inclusive boundary.
  const [coefficient, exponent = "0"] = String(value).split("e");
  return Number(`${coefficient}e${Number(exponent) + 2}`);
}
export function jobFilterValues(details) {
  const matching = details?.matching ?? {};
  return {
    postedDate: calendarDate(details?.postedAt),
    totalMatch:
      matching.score == null
        ? chartScore(matching.charts, "total")
        : score(matching.score),
    skillMatch: recommendationScore(matching, "skill", "q_job_skill_match"),
    industryMatch: recommendationScore(
      matching,
      "industry",
      "q_industry_match",
    ),
  };
}

export const filterColumns = [
  "posted_date",
  "match_total_score",
  "match_skill_score",
  "match_industry_score",
];
export function migrateJobFilters(db) {
  db.exec(`ALTER TABLE jobs ADD COLUMN posted_date TEXT;
    ALTER TABLE jobs ADD COLUMN match_total_score REAL CHECK(match_total_score BETWEEN 0 AND 100);
    ALTER TABLE jobs ADD COLUMN match_skill_score REAL CHECK(match_skill_score BETWEEN 0 AND 100);
    ALTER TABLE jobs ADD COLUMN match_industry_score REAL CHECK(match_industry_score BETWEEN 0 AND 100);`);
  const update = db.prepare(
    "UPDATE jobs SET posted_date=?,match_total_score=?,match_skill_score=?,match_industry_score=? WHERE id=?",
  );
  for (const row of db.prepare("SELECT id,details_json FROM jobs").all()) {
    const values = jobFilterValues(JSON.parse(row.details_json));
    update.run(
      values.postedDate,
      values.totalMatch,
      values.skillMatch,
      values.industryMatch,
      row.id,
    );
  }
  for (const column of [...filterColumns, "first_seen_at"])
    db.exec(`CREATE INDEX jobs_filter_${column} ON jobs(user_id,${column},id)`);
}

export function isRevertedChatSchema(db) {
  const expected = {
    chat_conversations: ["id", "user_id", "title", "created_at", "updated_at"],
    chat_turns: [
      "id",
      "conversation_id",
      "user_id",
      "client_request_id",
      "question",
      "status",
      "phase",
      "queued_at",
      "started_at",
      "ended_at",
      "result_json",
      "error_code",
      "error",
    ],
    chat_messages: [
      "id",
      "conversation_id",
      "user_id",
      "turn_id",
      "role",
      "content",
      "created_at",
    ],
  };
  const jobs = new Set(
    db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((row) => row.name),
  );
  if (
    ![
      "scope_key",
      "user_id",
      "connection_id",
      "details_json",
      "first_seen_at",
      "assigned_at",
      "company_id",
    ].every((column) => jobs.has(column)) ||
    filterColumns.some((column) => jobs.has(column))
  )
    return false;
  return (
    Object.entries(expected).every(([table, columns]) => {
      const actual = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      return (
        actual.length === columns.length &&
        columns.every((column, index) => actual[index] === column)
      );
    }) &&
    !!db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='companies'",
      )
      .get()
  );
}
