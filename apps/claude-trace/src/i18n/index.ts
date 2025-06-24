import fs from "fs";
import path from "path";

// Supported languages
export type SupportedLanguage = "en" | "es" | "ja";

// Translation keys interface for type safety
export interface TranslationKeys {
	cli: {
		title: string;
		description: string;
		usage: string;
		options: string;
		modes: string;
		examples: string;
		output: string;
		migration: string;
		help: {
			extractToken: string;
			generateHtml: string;
			index: string;
			runWith: string;
			includeAllRequests: string;
			noOpen: string;
			helpFlag: string;
		};
		modeLabels: {
			interactiveLogging: string;
			tokenExtraction: string;
			htmlGeneration: string;
			indexing: string;
		};
		messages: {
			startingClaude: string;
			logsLocation: string;
			trafficLogger: string;
			claudeSessionCompleted: string;
			claudeTerminated: string;
			claudeExited: string;
			receivedSignal: string;
			shutdownMessage: string;
			openingBrowser: string;
		};
		errors: {
			claudeNotFound: string;
			claudeLocalNotFound: string;
			installClaude: string;
			interceptorNotFound: string;
			errorStartingClaude: string;
			unexpectedError: string;
			missingInputFile: string;
			usageGenerateHtml: string;
			tokenTimeout: string;
			tokenNotFound: string;
		};
	};
	htmlGenerator: {
		errors: {
			frontendNotBuilt: string;
		};
	};
}

class I18nManager {
	private currentLanguage: SupportedLanguage = "en";
	private translations: Map<SupportedLanguage, TranslationKeys> = new Map();
	private translationsDir: string;

	constructor() {
		this.translationsDir = path.join(__dirname, "translations");
		this.loadTranslations();
		this.detectLanguage();
	}

	private loadTranslations(): void {
		const supportedLanguages: SupportedLanguage[] = ["en", "es", "ja"];
		
		for (const lang of supportedLanguages) {
			try {
				const filePath = path.join(this.translationsDir, `${lang}.json`);
				if (fs.existsSync(filePath)) {
					const content = fs.readFileSync(filePath, "utf-8");
					const translations = JSON.parse(content) as TranslationKeys;
					this.translations.set(lang, translations);
				}
			} catch (error) {
				// Fall back to English if translation loading fails
				console.warn(`Failed to load translations for ${lang}:`, error);
			}
		}
	}

	private detectLanguage(): void {
		// Check environment variable first
		const envLang = process.env.CLAUDE_TRACE_LANG as SupportedLanguage;
		if (envLang && this.translations.has(envLang)) {
			this.currentLanguage = envLang;
			return;
		}

		// Fall back to system locale detection
		const systemLang = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || "";
		
		if (systemLang.startsWith("es")) {
			this.currentLanguage = "es";
		} else if (systemLang.startsWith("ja")) {
			this.currentLanguage = "ja";
		} else {
			this.currentLanguage = "en";
		}

		// Ensure we have translations for the detected language
		if (!this.translations.has(this.currentLanguage)) {
			this.currentLanguage = "en";
		}
	}

	public setLanguage(language: SupportedLanguage): void {
		if (this.translations.has(language)) {
			this.currentLanguage = language;
		} else {
			console.warn(`Language ${language} not available, falling back to English`);
			this.currentLanguage = "en";
		}
	}

	public getCurrentLanguage(): SupportedLanguage {
		return this.currentLanguage;
	}

	public t(key: string): string {
		const translations = this.translations.get(this.currentLanguage);
		if (!translations) {
			return this.getFallbackTranslation(key);
		}

		return this.getNestedValue(translations, key) || this.getFallbackTranslation(key);
	}

	private getNestedValue(obj: any, path: string): string | undefined {
		return path.split('.').reduce((current, key) => current?.[key], obj);
	}

	private getFallbackTranslation(key: string): string {
		const englishTranslations = this.translations.get("en");
		if (englishTranslations) {
			const value = this.getNestedValue(englishTranslations, key);
			if (value) return value;
		}
		
		// If all else fails, return the key itself
		return `[${key}]`;
	}
}

// Create singleton instance
const i18n = new I18nManager();

// Export the translation function
export const t = (key: string): string => i18n.t(key);

// Export language management functions
export const setLanguage = (language: SupportedLanguage): void => i18n.setLanguage(language);
export const getCurrentLanguage = (): SupportedLanguage => i18n.getCurrentLanguage();