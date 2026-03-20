// ── Type Utilities ──────────────────────────────────────────────────
// Shared utility types for PipelineForge. Nominal types, branded
// types, and common type aliases live here.

/**
 * A Promise that resolves to void — used for async operations that
 * produce no meaningful return value (cleanup, fire-and-forget sends).
 *
 * Provides a semantic name at call sites so `Promise<void>` doesn't
 * blend in with `Promise<string>` or `Promise<T>` in signatures.
 */
export type VoidPromise = Promise<void>;

/**
 * Make selected keys of T optional while keeping the rest required.
 *
 * @example
 * type UserUpdate = PartialBy<User, "email" | "avatar">;
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Brand a type with a unique symbol tag for nominal typing.
 * Prevents structural compatibility between semantically different types.
 *
 * @example
 * type UserId = Owned<string>;
 * type TeamId = Owned<string>;
 * // UserId is not assignable to TeamId despite both wrapping string
 */
export type Owned<T> = T & { readonly __owned: unique symbol };

/**
 * Recursively mark all properties as readonly.
 *
 * @example
 * type FrozenConfig = DeepReadonly<Config>;
 */
export type DeepReadonly<T> = T extends Function
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
