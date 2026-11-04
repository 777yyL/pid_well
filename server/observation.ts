// Redact credentials before persistence as well as when serving historical logs.
export function redactObservation(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[\w-]{12,}/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactObservation);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactObservation(entry),
      ]),
    );
  return value;
}
