import { randomUUID } from "node:crypto";
import { CompanyStore } from "./company-store.js";
import { ServiceError, notFound } from "../service/errors.js";

export const profileTitleDto = (row) => ({
  id: row.id,
  title: row.title,
  isArchived: Boolean(row.is_archived),
});
export function personName(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 200)
    throw new ServiceError(
      400,
      "INVALID_PERSON_NAME",
      "Person name must be at most 200 characters.",
    );
  return value.trim().replace(/\s+/gu, " ") || null;
}
function titleName(value) {
  if (typeof value !== "string")
    throw new ServiceError(
      400,
      "INVALID_TITLE",
      "Enter a specialization title.",
    );
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 100)
    throw new ServiceError(
      400,
      "INVALID_TITLE",
      "Specialization titles must contain 1–100 characters.",
    );
  return name;
}
function titleConflict(error) {
  if (/UNIQUE constraint failed: profile_titles\./.test(error.message))
    throw new ServiceError(
      409,
      "TITLE_EXISTS",
      "This profile already has that specialization. Restore it if it is archived.",
    );
  throw error;
}

export class ProfileStore extends CompanyStore {
  profileTitles(userId, connectionId) {
    return this.db
      .prepare(
        "SELECT * FROM profile_titles WHERE user_id=? AND connection_id=? ORDER BY is_archived,normalized_title,id",
      )
      .all(userId, connectionId)
      .map(profileTitleDto);
  }
  updateConnectionProfile(userId, id, input) {
    this.getConnection(userId, id);
    this.db
      .prepare(
        "UPDATE connections SET person_name=?,updated_at=? WHERE id=? AND user_id=?",
      )
      .run(personName(input.personName), new Date().toISOString(), id, userId);
    return this.connectionSummary(this.getConnection(userId, id));
  }
  createProfileTitle(userId, connectionId, input) {
    return this.transaction(() => {
      this.getConnection(userId, connectionId);
      const title = titleName(input.title),
        id = randomUUID(),
        date = new Date().toISOString();
      try {
        this.db
          .prepare(
            "INSERT INTO profile_titles(id,user_id,connection_id,title,normalized_title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            userId,
            connectionId,
            title,
            title.toLowerCase(),
            date,
            date,
          );
      } catch (error) {
        titleConflict(error);
      }
      return { id, title, isArchived: false };
    });
  }
  updateProfileTitle(userId, connectionId, id, input) {
    return this.transaction(() => {
      this.getConnection(userId, connectionId);
      const row = this.db
        .prepare(
          "SELECT * FROM profile_titles WHERE id=? AND user_id=? AND connection_id=?",
        )
        .get(id, userId, connectionId);
      if (!row) throw notFound();
      const title = Object.hasOwn(input, "title")
        ? titleName(input.title)
        : row.title;
      if (
        Object.hasOwn(input, "isArchived") &&
        typeof input.isArchived !== "boolean"
      )
        throw new ServiceError(
          400,
          "INVALID_ARCHIVE_VALUE",
          "isArchived must be a boolean.",
        );
      const archived =
        input.isArchived === undefined
          ? row.is_archived
          : Number(input.isArchived);
      try {
        this.db
          .prepare(
            "UPDATE profile_titles SET title=?,normalized_title=?,is_archived=?,updated_at=? WHERE id=? AND user_id=? AND connection_id=?",
          )
          .run(
            title,
            title.toLowerCase(),
            archived,
            new Date().toISOString(),
            id,
            userId,
            connectionId,
          );
      } catch (error) {
        titleConflict(error);
      }
      return { id, title, isArchived: Boolean(archived) };
    });
  }
  setPreferredTitle(userId, jobId, preferredTitleId) {
    return this.transaction(() => {
      const job = this.db
        .prepare(
          "SELECT id,connection_id,preferred_title_id FROM jobs WHERE id=? AND user_id=?",
        )
        .get(jobId, userId);
      if (!job) throw notFound();
      if (preferredTitleId !== null) {
        const title = this.db
          .prepare(
            "SELECT id,is_archived FROM profile_titles WHERE id=? AND user_id=? AND connection_id=?",
          )
          .get(preferredTitleId, userId, job.connection_id);
        if (!title) throw notFound();
        if (title.is_archived && job.preferred_title_id !== preferredTitleId)
          throw new ServiceError(
            409,
            "TITLE_ARCHIVED",
            "This specialization was archived. Choose an active title or clear the selection.",
          );
      }
      this.db
        .prepare(
          "UPDATE jobs SET preferred_title_id=? WHERE id=? AND user_id=?",
        )
        .run(preferredTitleId, jobId, userId);
      return this.jobSummary(userId, jobId);
    });
  }
}
export const profileRpcMethods = [
  "updateConnectionProfile",
  "createProfileTitle",
  "updateProfileTitle",
  "setPreferredTitle",
];
