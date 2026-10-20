import type { SearchMode } from "./search.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { z } from "zod";
import {
	CLIENT_CONFIG_SCHEMAS,
	ProviderSchema,
	getDefaultApiKeyEnvVar,
	type ProviderConfigMap as CoreProviderConfigMap,
} from "@mariozechner/lemmy";

export const DEFAULTS_DIR = join(homedir(), ".lemmy-chat");
export const DEFAULTS_FILE = join(DEFAULTS_DIR, "defaults.json");

// Get provider schemas dynamically from CLIENT_CONFIG_SCHEMAS
const BASE_SCHEMA = CLIENT_CONFIG_SCHEMAS.base;
const PROVIDER_SCHEMAS = Object.fromEntries(
	Object.entries(CLIENT_CONFIG_SCHEMAS).filter(([key]) => key !== "base"),
) as Omit<typeof CLIENT_CONFIG_SCHEMAS, "base">;

// Get the full config schemas by merging base + provider + adding back apiKey
function getFullConfigSchemas() {
	const schemas: Record<string, z.ZodObject<any>> = {};

	for (const [provider, providerSchema] of Object.entries(PROVIDER_SCHEMAS)) {
		// Create a schema that includes apiKey (required), model (required), and all other fields
		const baseWithApiKey = BASE_SCHEMA.extend({
			apiKey: z.string(),
			model: z.string(),
		});

		schemas[provider] = baseWithApiKey.merge(
			providerSchema.extend({
				defaults: providerSchema.optional(),
			}),
		);
	}

	return schemas;
}

const FULL_CONFIG_SCHEMAS = getFullConfigSchemas();

// Types inferred from schemas
export type ProviderConfigMap = {
	[K in keyof typeof PROVIDER_SCHEMAS]: z.infer<(typeof FULL_CONFIG_SCHEMAS)[K]>;
};

export type AnyProviderConfig = ProviderConfigMap[keyof ProviderConfigMap];

export interface DefaultsConfig {
	search?: SearchMode;
	defaultProvider?: string;
	providers: {
		[provider: string]: any; // We'll validate with schemas instead of types
	};
}

export function ensureDefaultsDir(): void {
	if (!existsSync(DEFAULTS_DIR)) {
		mkdirSync(DEFAULTS_DIR, { recursive: true });
	}
}

export function loadDefaultsConfig(): DefaultsConfig {
	if (!existsSync(DEFAULTS_FILE)) {
		return { providers: {} };
	}

	try {
		const content = readFileSync(DEFAULTS_FILE, "utf8");
		const parsed = JSON.parse(content);

		return {
			defaultProvider: parsed.defaultProvider,
			...(parsed.search !== undefined ? { search: parsed.search } : {}),
			providers: parsed.providers || {},
		};
	} catch (error) {
		console.warn(`Warning: Could not load defaults from ${DEFAULTS_FILE}:`, error);
		return { providers: {} };
	}
}

export function saveDefaultsConfig(config: DefaultsConfig): void {
	ensureDefaultsDir();
	writeFileSync(DEFAULTS_FILE, JSON.stringify(config, null, 2));
}

export function saveProviderConfig(provider: string, rawConfig: Record<string, any>): void {
	if (!(provider in FULL_CONFIG_SCHEMAS)) {
		throw new Error(
			`Invalid provider: ${provider}. Available providers: ${Object.keys(FULL_CONFIG_SCHEMAS).join(", ")}`,
		);
	}

	const schema = FULL_CONFIG_SCHEMAS[provider]!;

	// Separate client config from ask options
	// Client fields: model, apiKey, baseURL, maxRetries, organization, projectId
	const clientFields = new Set(["model", "apiKey", "baseURL", "maxRetries", "organization", "projectId"]);

	const clientConfig: Record<string, any> = {};
	const askDefaults: Record<string, any> = {};

	for (const [key, value] of Object.entries(rawConfig)) {
		if (clientFields.has(key)) {
			clientConfig[key] = value;
		} else {
			askDefaults[key] = value;
		}
	}

	// Add defaults field if we have ask options
	if (Object.keys(askDefaults).length > 0) {
		clientConfig["defaults"] = askDefaults;
	}

	// Validate the structured config
	const result = schema.safeParse(clientConfig);

	if (!result.success) {
		console.error(`❌ Configuration validation errors for ${provider}:`);
		for (const issue of result.error.issues) {
			console.error(`  ${issue.path.join(".")}: ${issue.message}`);
		}
		throw new Error(`Invalid configuration for ${provider}`);
	}

	const config = loadDefaultsConfig();
	config.providers[provider] = result.data;

	// Set as default provider if no default is set
	if (!config.defaultProvider) {
		config.defaultProvider = provider;
	}

	saveDefaultsConfig(config);
}

export function getProviderConfig<T extends keyof CoreProviderConfigMap>(
	provider: T,
	cliOptions: Record<string, unknown> = {},
	runtimeApiKey?: string,
): CoreProviderConfigMap[T] {
	// Validate provider
	const providerResult = ProviderSchema.safeParse(provider);
	if (!providerResult.success) {
		throw new Error(`Invalid provider: ${provider}. Valid providers: ${ProviderSchema.options.join(", ")}`);
	}
	const validatedProvider = providerResult.data;

	// Load default config
	const config = loadDefaultsConfig();
	const providerDefaults = config.providers[provider] || {};

	// Merge CLI options into defaults.defaults (CLI takes precedence)
	const defaults = providerDefaults.defaults || {};
	const mergedDefaults = {
		...defaults,
		...cliOptions, // CLI options override defaults
	};

	// Build the client config with merged defaults
	const clientConfig = {
		...providerDefaults,
		defaults: mergedDefaults,
	};
	// Client options belong on the client, rather than inside per-request defaults.
	for (const field of ["model", "baseURL", "maxRetries", "organization", "projectId"]) {
		if (cliOptions[field] !== undefined) clientConfig[field] = cliOptions[field];
	}

	// Handle API key priority: runtime > stored > environment
	if (runtimeApiKey) {
		clientConfig.apiKey = runtimeApiKey;
	} else if (!clientConfig.apiKey) {
		const envApiKey = process.env[getDefaultApiKeyEnvVar(validatedProvider)];
		if (envApiKey) {
			clientConfig.apiKey = envApiKey;
		}
	}

	// Validate the final config against the schema
	const schema = FULL_CONFIG_SCHEMAS[provider];
	if (!schema) {
		throw new Error(`No schema found for provider: ${provider}`);
	}
	const result = schema.safeParse(clientConfig);

	if (!result.success) {
		console.error(`❌ Configuration validation errors for ${provider}:`);
		for (const issue of result.error.issues) {
			console.error(`  ${issue.path.join(".")}: ${issue.message}`);
		}
		throw new Error(`Invalid configuration for ${provider}`);
	}

	return result.data as CoreProviderConfigMap[T];
}

export function setDefaultProvider(provider: string): void {
	if (!(provider in FULL_CONFIG_SCHEMAS)) {
		throw new Error(
			`Invalid provider: ${provider}. Available providers: ${Object.keys(FULL_CONFIG_SCHEMAS).join(", ")}`,
		);
	}
	const config = loadDefaultsConfig();
	config.defaultProvider = provider;
	saveDefaultsConfig(config);
}

export function getProviderDefaults(provider: string): any {
	const config = loadDefaultsConfig();
	return config.providers[provider];
}

// Parse CLI arguments into structured config
export function parseArgsToConfig(args: string[]): { provider: string; config: Record<string, any> } {
	if (args.length === 0) {
		throw new Error("No arguments provided");
	}

	const provider = args[0];
	if (!provider || !(provider in FULL_CONFIG_SCHEMAS)) {
		throw new Error(
			`Invalid provider: ${provider}. Available providers: ${Object.keys(FULL_CONFIG_SCHEMAS).join(", ")}`,
		);
	}

	const rawConfig: Record<string, any> = {};

	// Parse CLI args
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "-m" && i + 1 < args.length) {
			const model = args[i + 1];
			if (model) {
				rawConfig["model"] = model;
			}
			i++;
		} else if (arg.startsWith("--")) {
			const optName = arg.slice(2);

			if (i + 1 < args.length && !args[i + 1]?.startsWith("-")) {
				const value = args[i + 1];
				if (value) {
					rawConfig[optName] = parseValue(value);
				}
				i++;
			} else {
				rawConfig[optName] = true;
			}
		}
	}

	return { provider, config: rawConfig };
}

// Convert stored config back to CLI args format (for legacy compatibility)
export function configToArgs(provider: string, config: any): string[] {
	const args: string[] = [provider];

	if (config.model) {
		args.push("-m", config.model);
	}

	// Add other config options
	for (const [key, value] of Object.entries(config)) {
		if (key === "model") continue;

		if (key === "defaults" && typeof value === "object" && value) {
			// Flatten defaults
			for (const [defaultKey, defaultValue] of Object.entries(value)) {
				if (typeof defaultValue === "boolean" && defaultValue) {
					args.push(`--${defaultKey}`);
				} else if (defaultValue !== undefined && defaultValue !== null) {
					args.push(`--${defaultKey}`, String(defaultValue));
				}
			}
		} else if (typeof value === "boolean" && value) {
			args.push(`--${key}`);
		} else if (value !== undefined && value !== null) {
			args.push(`--${key}`, String(value));
		}
	}

	return args;
}

// Helper to parse string values to appropriate types
function parseValue(value: string): any {
	if (value.toLowerCase() === "true") return true;
	if (value.toLowerCase() === "false") return false;
	const num = Number(value);
	if (!isNaN(num)) return num;
	return value;
}

// Get default provider and config in structured format
export function getDefaultProviderConfig(): {
	provider: keyof CoreProviderConfigMap;
	config: CoreProviderConfigMap[keyof CoreProviderConfigMap];
} | null {
	const config = loadDefaultsConfig();
	if (!config.defaultProvider || !config.providers[config.defaultProvider]) {
		return null;
	}

	// Validate provider is known
	const providerResult = ProviderSchema.safeParse(config.defaultProvider);
	if (!providerResult.success) {
		console.warn(`Warning: Unknown provider ${config.defaultProvider}`);
		return null;
	}

	const provider = providerResult.data;

	try {
		// Use getProviderConfig which handles API key injection and validation
		const providerConfig = getProviderConfig(provider);
		return {
			provider,
			config: providerConfig,
		};
	} catch (error) {
		console.warn(`Warning: Invalid config for ${provider}:`, error instanceof Error ? error.message : String(error));
		return null;
	}
}

// Legacy compatibility functions
export function loadDefaults(): string[] {
	const defaultConfig = getDefaultProviderConfig();
	if (!defaultConfig) {
		return [];
	}

	return configToArgs(defaultConfig.provider, defaultConfig.config);
}

export function saveDefaults(args: string[]): void {
	const { provider, config } = parseArgsToConfig(args);
	saveProviderConfig(provider, config);
}

// Clear all defaults
export function clearDefaults(): void {
	if (existsSync(DEFAULTS_FILE)) {
		saveDefaultsConfig({ providers: {} });
	}
}

// Shared utility for provider validation and config building
export function buildProviderConfig(
	provider: string,
	options: Record<string, unknown>,
): {
	provider: keyof CoreProviderConfigMap;
	config: CoreProviderConfigMap[keyof CoreProviderConfigMap];
} {
	// Validate provider with schema
	const providerResult = ProviderSchema.safeParse(provider);
	if (!providerResult.success) {
		throw new Error(`Invalid provider: ${provider}. Valid providers: ${ProviderSchema.options.join(", ")}`);
	}

	const validatedProvider = providerResult.data;

	// Get API key from options or environment
	const apiKey = (options["apiKey"] as string) || process.env[getDefaultApiKeyEnvVar(validatedProvider)];
	if (!apiKey) {
		throw new Error(`No API key provided. Set ${getDefaultApiKeyEnvVar(validatedProvider)} or use --apiKey flag.`);
	}

	// Build config - separate client config from ask options
	const { image, images, ...cleanOptions } = options;

	const config: CoreProviderConfigMap[keyof CoreProviderConfigMap] = {
		model: options["model"] as string,
		apiKey,
		...cleanOptions,
	} as CoreProviderConfigMap[keyof CoreProviderConfigMap];

	return {
		provider: validatedProvider,
		config,
	};
}
