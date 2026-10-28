export function deadline(ms: number, fetchImpl: typeof fetch = fetch, parent?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('execution_timeout')), ms);
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  const request: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    const original = init?.signal || (input instanceof Request ? input.signal : undefined);
    const rejectRedirect = init?.redirect === 'error' || (input instanceof Request && input.redirect === 'error');
    const response = await fetchImpl(input, { ...init, ...(rejectRedirect ? { redirect: 'manual' as const } : {}),
      signal: original ? AbortSignal.any([signal, original]) : signal });
    if (rejectRedirect && response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Unexpected upstream redirect');
    }
    return response;
  };
  const sleep = async (wait: number) => {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', abort); resolve(); };
      const id = setTimeout(done, wait);
      const abort = () => { clearTimeout(id); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  return { signal, fetch: request, sleep, close: () => clearTimeout(timer) };
}
