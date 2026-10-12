import { AppError } from "../../shared/contracts";

export function makeError(
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): AppError {
  return { code, message, retryable, details };
}

/** Removes any key that looks like a secret from an object for safe logging. */
export function redact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/secret|key|token|password|authorization/i.test(k)) {
      out[k] = "***";
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
