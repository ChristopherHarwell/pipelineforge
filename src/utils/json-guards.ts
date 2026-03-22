// ── JSON Type Guards ────────────────────────────────────────────────

/**
 * Type guard for non-null JSON objects. Replaces the repeated
 * `parsed !== null && typeof parsed === "object"` + `as Record<string, unknown>` pattern.
 *
 * @param value - Unknown value to check
 * @returns true if value is a non-null, non-array object
 */
export function isJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Safely extract a string field from a JSON object.
 *
 * @param obj - The object to extract from
 * @param key - The field name
 * @returns The string value if present and a string, undefined otherwise
 */
export function getStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value: unknown = obj[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Safely extract a nested object field from a JSON object.
 *
 * @param obj - The object to extract from
 * @param key - The field name
 * @returns The nested object if present and an object, undefined otherwise
 */
export function getNestedObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value: unknown = obj[key];
  return isJsonObject(value) ? value : undefined;
}
