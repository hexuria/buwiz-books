export type StableIdempotencyIntent = {
  fingerprint: string;
  idempotencyKey: string;
};

type IntentRef = {
  current: StableIdempotencyIntent | null;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * Reuse one caller-generated key for the same UI mutation intent. React Query
 * retries and rapid repeat clicks receive the same key; editing any payload
 * field creates a new intent/key instead of reusing a key with new content.
 */
export function withStableIdempotencyKey<T extends Record<string, unknown>>(
  intentRef: IntentRef,
  payload: T,
): T & { idempotencyKey: string } {
  const fingerprint = JSON.stringify(canonicalize(payload));
  if (intentRef.current?.fingerprint !== fingerprint) {
    intentRef.current = {
      fingerprint,
      idempotencyKey: crypto.randomUUID(),
    };
  }
  return { ...payload, idempotencyKey: intentRef.current.idempotencyKey };
}

export function clearStableIdempotencyKey(
  intentRef: IntentRef,
  completedKey: string | undefined,
): void {
  if (completedKey && intentRef.current?.idempotencyKey === completedKey) {
    intentRef.current = null;
  }
}
