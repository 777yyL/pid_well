// Two preparation workers feed bounded model consumers; backpressure bounds evidence.
export async function runEvidencePipeline<T, P>(
  inputs: T[],
  signal: AbortSignal,
  prepare: (input: T, signal: AbortSignal) => Promise<P | null>,
  consume: (batch: P[], signal: AbortSignal) => Promise<void>,
  options = { batchSize: 5, concurrency: 1 },
) {
  const control = new AbortController();
  const combined = AbortSignal.any([signal, control.signal]);
  const queue: P[] = [];
  let cursor = 0,
    active = Math.min(2, inputs.length),
    fatal: unknown;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const resolve of listeners) resolve();
    listeners.clear();
  };
  const changed = () => new Promise<void>((resolve) => listeners.add(resolve));
  combined.addEventListener("abort", notify);
  const workers = Array.from({ length: active }, async () => {
    try {
      while (cursor < inputs.length) {
        while (queue.length >= options.batchSize * 2) {
          combined.throwIfAborted();
          await changed();
        }
        combined.throwIfAborted();
        const index = cursor++;
        if (index >= inputs.length) break;
        const packet = await prepare(inputs[index], combined);
        combined.throwIfAborted();
        if (packet !== null) queue.push(packet);
        notify();
      }
    } catch (error) {
      fatal ??= error;
      control.abort();
    } finally {
      active--;
      notify();
    }
  });
  const consumers = Array.from({ length: options.concurrency }, async () => {
    try {
      while (active || queue.length) {
        if (fatal) throw fatal;
        combined.throwIfAborted();
        if (queue.length >= options.batchSize || (!active && queue.length)) {
          const batch = queue.splice(0, options.batchSize);
          notify();
          await consume(batch, combined);
        } else await changed();
      }
      if (fatal) throw fatal;
      combined.throwIfAborted();
    } catch (error) {
      fatal ??= error;
      control.abort();
      throw error;
    }
  });
  try {
    const results = await Promise.allSettled(consumers);
    if (fatal) throw fatal;
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  } finally {
    control.abort();
    notify();
    await Promise.allSettled(workers);
    combined.removeEventListener("abort", notify);
  }
}
