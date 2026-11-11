import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Modal, ErrorNotice, Loading } from './components.jsx';

export default function AssignmentConfirmation({ action, filters, onClose, onSuccess }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const controllerRef = useRef(null);
  const savingRef = useRef(false);
  const assign = action === 'assign';
  const loadPreview = useCallback(async (controller) => {
    setLoading(true);
    setPreview(null);
    setError(null);
    try {
      const value = await api('/jobs/assignment-preview', {
        method: 'POST', body: { action, filters }, signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(value);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [action, filters]);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void loadPreview(controller);
    return () => controller.abort();
  }, [loadPreview]);

  async function confirm(event) {
    event.preventDefault();
    if (savingRef.current || loading || error || !preview?.total) return;
    const controller = controllerRef.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setNotice('');
    try {
      const result = await api(`/jobs/${action}`, {
        method: 'POST', body: { ...filters, previewFingerprint: preview.fingerprint },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) onSuccess(result);
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure.code === 'ASSIGNMENT_PREVIEW_CHANGED') {
          setNotice('The affected jobs changed. Review the refreshed counts and confirm again.');
          await loadPreview(controller);
        } else {
          setError(failure);
          setPreview(null);
        }
      }
    } finally {
      savingRef.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  const close = () => { if (!savingRef.current) onClose(); };
  return (
    <Modal title={assign ? 'Assign jobs' : 'Unassign jobs'} onClose={close} closeDisabled={saving}>
      <form className="form-stack assignment-confirmation" onSubmit={confirm} aria-busy={loading || saving}>
        <p>This affects all matching jobs across every filtered page. Only currently {assign ? 'unassigned' : 'assigned'} jobs will change.</p>
        {notice && <div className="notice" role="status">{notice}</div>}
        <ErrorNotice error={error} />
        {loading ? <Loading text="Counting affected jobs…" /> : preview && <>
          <p className="assignment-total"><strong>{preview.total.toLocaleString()} {preview.total === 1 ? 'job' : 'jobs'}</strong> to {action}</p>
          {preview.total ? <div className="assignment-profile-list">
            <table aria-label="Affected jobs by profile">
              <thead><tr><th scope="col">Profile</th><th scope="col">Jobs</th></tr></thead>
              <tbody>{preview.profiles.map((profile) => <tr key={profile.connectionId ?? 'imported'}>
                <th scope="row"><strong>{profile.personName || profile.label}</strong>{profile.personName && <small>{profile.label}</small>}</th>
                <td>{profile.count.toLocaleString()}</td>
              </tr>)}</tbody>
            </table>
          </div> : <p>No {assign ? 'unassigned' : 'assigned'} jobs match the current filters.</p>}
        </>}
        {error && <button type="button" className="text-button" disabled={saving || loading} onClick={() => {
          setNotice('');
          void loadPreview(controllerRef.current);
        }}>Refresh counts</button>}
        <div className="modal-actions">
          <button type="button" className="button subtle" autoFocus disabled={saving} onClick={close}>Cancel</button>
          <button type="submit" className="button primary" disabled={loading || saving || !!error || !preview?.total}>
            {saving ? (assign ? 'Assigning…' : 'Unassigning…') : (assign ? 'Confirm assignment' : 'Confirm unassignment')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
