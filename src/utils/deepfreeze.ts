// ── DeepReadonly ─────────────────────────────────────────────────────
// Recursive readonly type — covers primitives, objects, arrays, maps,
// sets, and functions. Every branch resolves to DeepReadonly so the
// return type is always frozen regardless of input shape.

export type DeepReadonly<T> = T extends Function
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends ReadonlySet<infer U>
        ? ReadonlySet<DeepReadonly<U>>
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : Readonly<T>;

// ── Deep Freeze ─────────────────────────────────────────────────────

/**
 * Recursively freeze a value and all nested properties.
 * Returns `DeepReadonly<T>` so the compiler enforces immutability
 * at every level — no separate `Readonly<>` wrapper needed.
 * Works on any type: primitives pass through as `Readonly<T>`,
 * objects and arrays are frozen recursively.
 *
 * @param value - The value to deep freeze
 * @returns The same value, deeply frozen at compile time and runtime
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value === null || value === undefined || typeof value !== "object") {
    return value as DeepReadonly<T>;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value as DeepReadonly<T>;
}
