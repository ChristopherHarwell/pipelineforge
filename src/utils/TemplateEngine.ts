// ── Template Engine ─────────────────────────────────────────────────
// Inspired by roundtable Chain CRD's Go template output injection.
// Renders {{ .variable }} placeholders with nested path resolution.

export class TemplateEngine {
  /**
   * Render a template string with {{ .variable }} substitution.
   * Supports nested access: {{ .Steps.implement-ticket.outputs.branch }}
   *
   * @param template - Template string with {{ .path }} placeholders
   * @param variables - Variable map for substitution
   * @returns Rendered string
   */
  render(template: string, variables: Record<string, unknown>): string {
    return template.replace(
      /\{\{\s*\.([a-zA-Z0-9_./-]+)\s*\}\}/g,
      (_match: string, path: string): string => {
        const value: unknown = this.resolvePath(variables, path);
        return value !== undefined ? String(value) : `{{ .${path} }}`;
      },
    );
  }

  /**
   * Resolve a dot-separated path against a nested object.
   *
   * @param obj - Root object to traverse
   * @param path - Dot-separated path (e.g., "Steps.qa-review.outputs.report")
   * @returns The resolved value, or undefined if path doesn't exist
   */
  private resolvePath(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    return path.split(".").reduce(
      (current: unknown, key: string): unknown =>
        isJsonObject(current)
          ? current[key]
          : undefined,
      obj as unknown,
    );
  }
}
