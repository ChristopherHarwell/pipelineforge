import { describe, it, expect } from "vitest";
import { TemplateEngine } from "@utils/TemplateEngine.ts";

// ===========================================================================
// TemplateEngine
// ===========================================================================

describe("TemplateEngine", () => {
  const engine: TemplateEngine = new TemplateEngine();

  // ── Simple variable substitution ────────────────────────────────────

  describe("— simple variable substitution", () => {
    it("should replace a single variable", () => {
      const result: string = engine.render(
        "Hello {{ .name }}!",
        { name: "World" },
      );
      expect(result).toBe("Hello World!");
    });

    it("should replace multiple variables", () => {
      const result: string = engine.render(
        "{{ .greeting }} {{ .name }}!",
        { greeting: "Hi", name: "Christopher" },
      );
      expect(result).toBe("Hi Christopher!");
    });

    it("should handle variables with no spaces around dots", () => {
      const result: string = engine.render(
        "{{.name}}",
        { name: "test" },
      );
      expect(result).toBe("test");
    });

    it("should preserve unresolved variables", () => {
      const result: string = engine.render(
        "{{ .missing }}",
        {},
      );
      expect(result).toBe("{{ .missing }}");
    });
  });

  // ── Nested path resolution ──────────────────────────────────────────

  describe("— nested path resolution", () => {
    it("should resolve a two-level path", () => {
      const result: string = engine.render(
        "{{ .Steps.build }}",
        { Steps: { build: "success" } },
      );
      expect(result).toBe("success");
    });

    it("should resolve a three-level path", () => {
      const result: string = engine.render(
        "{{ .Steps.implement-ticket.outputs.branch }}",
        {
          Steps: {
            "implement-ticket": {
              outputs: { branch: "feature/auth" },
            },
          },
        },
      );
      expect(result).toBe("feature/auth");
    });

    it("should preserve unresolved nested paths", () => {
      const result: string = engine.render(
        "{{ .Steps.missing.output }}",
        { Steps: {} },
      );
      expect(result).toBe("{{ .Steps.missing.output }}");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("— edge cases", () => {
    it("should handle empty template", () => {
      const result: string = engine.render("", {});
      expect(result).toBe("");
    });

    it("should handle template with no variables", () => {
      const result: string = engine.render(
        "No variables here",
        { unused: "value" },
      );
      expect(result).toBe("No variables here");
    });

    it("should handle numeric values", () => {
      const result: string = engine.render(
        "Instance {{ .instance }} of {{ .total }}",
        { instance: 3, total: 6 },
      );
      expect(result).toBe("Instance 3 of 6");
    });

    it("should handle null values in path", () => {
      const result: string = engine.render(
        "{{ .obj.key }}",
        { obj: null },
      );
      expect(result).toBe("{{ .obj.key }}");
    });
  });
});
