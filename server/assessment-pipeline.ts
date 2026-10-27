// Two retrieval workers feed one model consumer. Backpressure bounds prepared evidence.
export async function runEvidencePipeline<T, P>(
  inputs: T[],
  signal: AbortSignal,
  prepare: (input: T, signal: AbortSignal) => Promise<P | null>,
  consume: (batch: P[], signal: AbortSignal) => Promise<void>,
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
        while (queue.length >= 10) {
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
  try {
    while (active || queue.length) {
      if (fatal) throw fatal;
      combined.throwIfAborted();
      if (queue.length >= 5 || (!active && queue.length)) {
        const batch = queue.splice(0, 5);
        notify();
        await consume(batch, combined);
      } else await changed();
    }
    if (fatal) throw fatal;
    combined.throwIfAborted();
  } finally {
    control.abort();
    notify();
    await Promise.allSettled(workers);
    combined.removeEventListener("abort", notify);
  }
}
