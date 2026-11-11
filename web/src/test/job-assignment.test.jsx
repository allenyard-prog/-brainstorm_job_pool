import { it, expect } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockBackend, renderApp, alice, profile, job } from './helpers.jsx';

const fingerprint = 'a'.repeat(64);
const preview = {
  total: 27, fingerprint,
  profiles: [
    { connectionId: profile.id, personName: 'Daniel Zhang', label: profile.label, count: 22 },
    { connectionId: 'profile-b', personName: null, label: 'second@provider.test', count: 4 },
    { connectionId: null, personName: null, label: 'Imported account', count: 1 },
  ],
};
const calls = (backend, resource) => backend.fetch.mock.calls.filter(([path]) => path === `/api/v1/jobs/${resource}`);
async function open(user, action = 'assign') {
  const trigger = await screen.findByRole('button', { name: action === 'assign' ? 'Assign all Jobs' : 'Unassign jobs', exact: true });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  const dialog = screen.getByRole('dialog', { name: action === 'assign' ? 'Assign jobs' : 'Unassign jobs' });
  const confirm = within(dialog).getByRole('button', { name: action === 'assign' ? 'Confirm assignment' : 'Confirm unassignment' });
  return { dialog, confirm };
}

it('previews all filtered pages by profile and Cancel never sends an assignment', async () => {
  const backend = mockBackend(alice, { '/jobs/assignment-preview': ({ json }) => json(preview) });
  renderApp('/jobs?q=Engineer&company=Example&sortBy=company&sortOrder=asc&page=2&pageSize=10&totalMatchMin=0&excludeBlacklistedCompanies=true');
  const user = userEvent.setup();
  const { dialog, confirm } = await open(user);
  await waitFor(() => expect(confirm).toBeEnabled());
  const rows = within(dialog).getAllByRole('row');
  expect(rows).toHaveLength(4);
  expect(rows[1]).toHaveTextContent('Daniel Zhang');
  expect(rows[1]).toHaveTextContent(profile.label);
  expect(rows[1]).toHaveTextContent('22');
  expect(rows[2]).toHaveTextContent('second@provider.test');
  expect(rows[3]).toHaveTextContent('Imported account');
  expect(within(dialog).getByText('27 jobs')).toBeInTheDocument();
  expect(JSON.parse(calls(backend, 'assignment-preview')[0][1].body)).toEqual({ action: 'assign', filters: {
    q: 'Engineer', company: 'Example', totalMatchMin: 0, excludeBlacklistedCompanies: true,
  } });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(calls(backend, 'assign')).toHaveLength(0);
});

it('confirms unassignment with the fingerprint and refreshes filtered jobs on page one', async () => {
  const backend = mockBackend(alice, {
    '/jobs/assignment-preview': ({ json }) => json(preview),
    '/jobs/unassign': ({ json }) => json({ unassignedCount: 27 }),
  });
  renderApp('/jobs?q=Engineer&status=assigned&page=3&pageSize=10&sortBy=company&sortOrder=asc');
  const user = userEvent.setup();
  const { confirm } = await open(user, 'unassign');
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(calls(backend, 'unassign')).toHaveLength(0);
  await user.click(confirm);
  await screen.findByText('27 jobs unassigned.');
  expect(JSON.parse(calls(backend, 'unassign')[0][1].body)).toEqual({ q: 'Engineer', status: 'assigned', previewFingerprint: fingerprint });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => expect(new URL(backend.fetch.mock.calls.filter(([path]) => path.startsWith('/api/v1/jobs?')).at(-1)[0], 'http://fixture.test').searchParams.get('page')).toBe('1'));
  const query = new URL(backend.fetch.mock.calls.filter(([path]) => path.startsWith('/api/v1/jobs?')).at(-1)[0], 'http://fixture.test');
  expect(query.searchParams.get('page')).toBe('1');
  expect(query.searchParams.get('limit')).toBe('10');
  expect(query.searchParams.get('q')).toBe('Engineer');
  expect(query.searchParams.get('status')).toBe('assigned');
  expect(query.searchParams.get('sortBy')).toBe('company');
  expect(query.searchParams.get('sortOrder')).toBe('asc');
});

it('refreshes stale counts and requires another explicit confirmation without retrying the write', async () => {
  let previews = 0, writes = 0;
  const next = { total: 28, fingerprint: 'b'.repeat(64), profiles: [{ ...preview.profiles[0], count: 28 }] };
  const backend = mockBackend(alice, {
    '/jobs/assignment-preview': ({ json }) => json(previews++ ? next : preview),
    '/jobs/assign': ({ json }) => ++writes === 1 ? json({ error: { code: 'ASSIGNMENT_PREVIEW_CHANGED', message: 'Changed' } }, 409) : json({ assignedCount: 28 }),
  });
  renderApp('/jobs');
  const user = userEvent.setup();
  const { confirm } = await open(user);
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await screen.findByText('28 jobs');
  expect(screen.getByText(/Review the refreshed counts and confirm again/)).toBeInTheDocument();
  expect(calls(backend, 'assign')).toHaveLength(1);
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await screen.findByText('28 jobs assigned.');
  expect(JSON.parse(calls(backend, 'assign')[1][1].body).previewFingerprint).toBe(next.fingerprint);
});

it('shows zero affected jobs for incompatible filters and disables confirmation', async () => {
  const backend = mockBackend(alice, { '/jobs/assignment-preview': ({ json }) => json({ total: 0, profiles: [], fingerprint }) });
  renderApp('/jobs?status=available');
  const { dialog, confirm } = await open(userEvent.setup(), 'unassign');
  await screen.findByText('No assigned jobs match the current filters.');
  expect(confirm).toBeDisabled();
  fireEvent.submit(dialog.querySelector('form'));
  expect(calls(backend, 'unassign')).toHaveLength(0);
});

it('surfaces preview and mutation failures and refreshes counts only on request', async () => {
  let previews = 0;
  const backend = mockBackend(alice, {
    '/jobs/assignment-preview': ({ json }) => ++previews === 1 ? json({ error: { code: 'DATABASE_ERROR', message: 'Counts unavailable' } }, 503) : json(preview),
    '/jobs/assign': ({ json }) => json({ error: { code: 'DATABASE_ERROR', message: 'Could not save' } }, 500),
  });
  renderApp('/jobs');
  const user = userEvent.setup();
  const { dialog, confirm } = await open(user);
  await screen.findByText('Counts unavailable');
  expect(confirm).toBeDisabled();
  expect(calls(backend, 'assignment-preview')).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: 'Refresh counts' }));
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await screen.findByText('Could not save');
  expect(confirm).toBeDisabled();
  expect(calls(backend, 'assign')).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
});

it('locks controls during a pending write and prevents duplicate submissions or dismissal', async () => {
  let release;
  const backend = mockBackend(alice, {
    '/jobs/assignment-preview': ({ json }) => json(preview),
    '/jobs/assign': ({ json }) => new Promise(resolve => { release = () => resolve(json({ assignedCount: 27 })); }),
  });
  renderApp('/jobs');
  const user = userEvent.setup();
  const { dialog, confirm } = await open(user);
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  fireEvent.submit(dialog.querySelector('form'));
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(dialog).toBeInTheDocument();
  expect(calls(backend, 'assign')).toHaveLength(1);
  release();
  await screen.findByText('27 jobs assigned.');
});

it('allows cancellation while preview counts are loading and aborts the read', async () => {
  const backend = mockBackend(alice, { '/jobs/assignment-preview': () => new Promise(() => {}) });
  renderApp('/jobs');
  const user = userEvent.setup();
  const { dialog, confirm } = await open(user);
  expect(confirm).toBeDisabled();
  await screen.findByText('Counting affected jobs…');
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(calls(backend, 'assignment-preview')[0][1].signal.aborted).toBe(true);
  expect(calls(backend, 'assign')).toHaveLength(0);
});
