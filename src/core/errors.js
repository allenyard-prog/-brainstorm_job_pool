export class AuthenticationError extends Error {}
export class UnsupportedError extends Error {}
export class UncertainWriteError extends Error {}
export class SystemicError extends Error {}
export const throwIfStopped = signal => signal?.throwIfAborted();
export async function delay(ms, signal) {
  if (signal?.aborted) return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
