import { createHash } from 'node:crypto';
import { ServiceError } from '../service/errors.js';
import { jobWhere } from './job-filters.js';

// A single SELECT gives previews a consistent read snapshot. Confirmations call
// this inside BEGIN IMMEDIATE, so comparison and update share one write lock.
export function assignmentSelection(db, userId, action, filters = {}) {
  if (!['assign', 'unassign'].includes(action))
    throw new ServiceError(400, 'INVALID_ASSIGNMENT_ACTION', 'Choose assign or unassign.');
  const selection = jobWhere(userId, filters);
  const where = `${selection.where} AND j.assigned_at IS ${action === 'assign' ? '' : 'NOT '}NULL`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([userId, action, Object.entries(filters).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))]));
  const groups = new Map();
  let total = 0;
  const rows = db.prepare(`SELECT j.id,j.assigned_at,j.connection_id,c.person_name,c.label
    FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key
    LEFT JOIN connections c ON c.id=j.connection_id AND c.user_id=j.user_id
    WHERE ${where} ORDER BY j.id`).iterate(...selection.params);
  for (const row of rows) {
    hash.update(JSON.stringify([row.id, row.assigned_at, row.connection_id]));
    const key = row.connection_id;
    if (!groups.has(key)) groups.set(key, {
      connectionId: key, personName: row.person_name ?? null,
      label: row.label ?? 'Imported account', count: 0,
    });
    groups.get(key).count++;
    total++;
  }
  const profiles = [...groups.values()].sort((a, b) =>
    (a.personName || a.label).localeCompare(b.personName || b.label) ||
    a.label.localeCompare(b.label) || (a.connectionId ?? '').localeCompare(b.connectionId ?? ''));
  return { where, params: selection.params, preview: { total, profiles, fingerprint: hash.digest('hex') } };
}

export function changeAssignment(store, userId, action, { previewFingerprint, ...filters } = {}) {
  return store.transaction(() => {
    const { where, params, preview } = assignmentSelection(store.db, userId, action, filters);
    if (previewFingerprint !== undefined && previewFingerprint !== preview.fingerprint)
      throw new ServiceError(409, 'ASSIGNMENT_PREVIEW_CHANGED', 'The affected jobs changed. Review the refreshed counts and confirm again.');
    const result = store.db.prepare(`UPDATE jobs SET assigned_at=? WHERE id IN (
      SELECT j.id FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE ${where})`)
      .run(action === 'assign' ? new Date().toISOString() : null, ...params);
    return { [action === 'assign' ? 'assignedCount' : 'unassignedCount']: Number(result.changes) };
  });
}
