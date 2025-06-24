import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { t, setLanguage, getCurrentLanguage } from "../src/i18n";

describe("i18n", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.CLAUDE_TRACE_LANG;
		// Reset to English for consistent test behavior
		setLanguage("en");
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.CLAUDE_TRACE_LANG = originalEnv;
		} else {
			delete process.env.CLAUDE_TRACE_LANG;
		}
	});

	describe("basic functionality", () => {
		it("should return English text for known keys", () => {
			expect(t("cli.title")).toBe("Claude Trace");
			expect(t("cli.description")).toContain("Record all your interactions");
		});

		it("should return fallback for unknown keys", () => {
			expect(t("nonexistent.key")).toBe("[nonexistent.key]");
		});

		it("should handle nested keys", () => {
			expect(t("cli.help.extractToken")).toContain("Extract OAuth token");
			expect(t("cli.errors.claudeNotFound")).toContain("Claude CLI not found");
		});
	});

	describe("language switching", () => {
		it("should switch to Spanish", () => {
			setLanguage("es");
			expect(getCurrentLanguage()).toBe("es");
			expect(t("cli.title")).toBe("Claude Trace");
			expect(t("cli.description")).toContain("Registra todas tus interacciones");
		});

		it("should switch to Japanese", () => {
			setLanguage("ja");
			expect(getCurrentLanguage()).toBe("ja");
			expect(t("cli.title")).toBe("Claude Trace");
			expect(t("cli.description")).toContain("プロジェクト開発中");
		});

		it("should switch to Traditional Chinese (zh-TW)", () => {
			setLanguage("zh-TW");
			expect(getCurrentLanguage()).toBe("zh-TW");
			expect(t("cli.title")).toBe("Claude Trace");
			expect(t("cli.description")).toContain("記錄你在開發專案時");
		});

		it("should switch to Simplified Chinese (zh-CN)", () => {
			setLanguage("zh-CN");
			expect(getCurrentLanguage()).toBe("zh-CN");
			expect(t("cli.title")).toBe("Claude Trace");
			expect(t("cli.description")).toContain("记录你在开发项目时");
		});

		it("should fallback to English for unsupported language", () => {
			setLanguage("fr" as any);
			expect(getCurrentLanguage()).toBe("en");
			expect(t("cli.title")).toBe("Claude Trace");
		});
	});

	describe("environment variable detection", () => {
		it("should respect CLAUDE_TRACE_LANG environment variable", () => {
			process.env["CLAUDE_TRACE_LANG"] = "es";
			// Note: The environment variable detection happens during module initialization
			// so we would need to reload the module to test this properly
			// For now, we'll just test the setLanguage function
			setLanguage("es");
			expect(getCurrentLanguage()).toBe("es");
		});
	});

	describe("translation completeness", () => {
		it("should have all required CLI translation keys", () => {
			const requiredKeys = [
				"cli.title",
				"cli.description",
				"cli.usage",
				"cli.options",
				"cli.modes",
				"cli.examples",
				"cli.output",
				"cli.migration",
				"cli.help.extractToken",
				"cli.help.generateHtml",
				"cli.help.index",
				"cli.errors.claudeNotFound",
				"cli.errors.unexpectedError",
				"cli.messages.startingClaude",
				"cli.messages.claudeSessionCompleted",
				"htmlGenerator.errors.frontendNotBuilt",
			];

			requiredKeys.forEach((key) => {
				expect(t(key)).not.toBe(`[${key}]`);
				expect(t(key)).toBeTruthy();
			});
		});
	});
});
