import {
	createClientForModel,
	getProviderForModel,
	findModelData,
	type AllModels,
	type ModelData,
} from "@mariozechner/lemmy";
import type {
	AnthropicConfig,
	OpenAIConfig,
	GoogleConfig,
	AnthropicAskOptions,
	OpenAIAskOptions,
	GoogleAskOptions,
	ChatClient,
} from "@mariozechner/lemmy";
import type {
	Provider,
	BridgeConfig,
	ProviderClientInfo,
	CapabilityValidationResult,
	ProviderConfig,
} from "../types.js";

import type { MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/messages/messages.js";

/**
 * Create provider-agnostic client for a given model
 */
export async function createProviderClient(config: BridgeConfig): Promise<ProviderClientInfo> {
	const modelData = findModelData(config.model);
	let provider: Provider;
	let client: ChatClient;

	// If a provider is explicitly configured, use it first
	if (config.provider) {
		provider = config.provider;
		const providerConfig = buildProviderConfig(provider, config);

		// Create client directly using lemmy's provider factories
		switch (provider) {
			case "openai": {
				const { lemmy } = await import("@mariozechner/lemmy");
				client = lemmy.openai(providerConfig as OpenAIConfig);
				break;
			}
			case "google": {
				const { lemmy } = await import("@mariozechner/lemmy");
				client = lemmy.google(providerConfig as GoogleConfig);
				break;
			}
			case "anthropic": {
				const { lemmy } = await import("@mariozechner/lemmy");
				client = lemmy.anthropic(providerConfig as AnthropicConfig);
				break;
			}
			default:
				const _exhaustiveCheck: never = provider;
				throw new Error(`Unsupported provider: ${_exhaustiveCheck}`);
		}
	} else if (modelData) {
		// Fall back to known model - use standard approach
		provider = getProviderForModel(config.model as AllModels) as Provider;
		const providerConfig = buildProviderConfig(provider, config);
		client = createClientForModel(config.model as AllModels, providerConfig);
	} else {
		// No provider configured and unknown model
		throw new Error(
			`No provider specified and model '${config.model}' is not recognized. Please specify a provider.`,
		);
	}

	return {
		client,
		provider,
		model: config.model,
		modelData: modelData || null, // null for unknown models
	};
}

/**
 * Build provider-specific configuration from bridge config
 */
function buildProviderConfig(provider: Provider, config: BridgeConfig): ProviderConfig {
	const baseConfig = {
		model: config.model,
		apiKey: config.apiKey || getDefaultApiKey(provider),
		...(config.baseURL && { baseURL: config.baseURL }),
		...(config.maxRetries && { maxRetries: config.maxRetries }),
	};

	switch (provider) {
		case "anthropic":
			return baseConfig as AnthropicConfig;
		case "openai":
			return baseConfig as OpenAIConfig;
		case "google":
			return baseConfig as GoogleConfig;
		default:
			// TypeScript exhaustiveness check
			const _exhaustiveCheck: never = provider;
			throw new Error(`Unsupported provider: ${_exhaustiveCheck}`);
	}
}

/**
 * Get default API key environment variable for provider
 */
function getDefaultApiKey(provider: Provider): string {
	switch (provider) {
		case "anthropic":
			const anthropicKey = process.env["ANTHROPIC_API_KEY"];
			if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY environment variable is required");
			return anthropicKey;
		case "openai":
			const openaiKey = process.env["OPENAI_API_KEY"];
			if (!openaiKey) throw new Error("OPENAI_API_KEY environment variable is required");
			return openaiKey;
		case "google":
			const googleKey = process.env["GOOGLE_API_KEY"];
			if (!googleKey) throw new Error("GOOGLE_API_KEY environment variable is required");
			return googleKey;
		default:
			// TypeScript exhaustiveness check
			const _exhaustiveCheck: never = provider;
			throw new Error(`Unsupported provider: ${_exhaustiveCheck}`);
	}
}

/**
 * Validate model capabilities against request requirements
 */
export function validateCapabilities(
	modelData: ModelData,
	anthropicRequest: MessageCreateParamsBase,
	logger?: { log: (msg: string) => void },
): CapabilityValidationResult {
	const warnings: string[] = [];
	const adjustments: CapabilityValidationResult["adjustments"] = {};

	// Check output token limits
	if (anthropicRequest.max_tokens && anthropicRequest.max_tokens > modelData.maxOutputTokens) {
		warnings.push(
			`Requested max_tokens (${anthropicRequest.max_tokens}) exceeds model limit (${modelData.maxOutputTokens}). Will be clamped to model maximum.`,
		);
		adjustments.maxOutputTokens = modelData.maxOutputTokens;
		logger?.log(`⚠️  Max tokens clamped: ${anthropicRequest.max_tokens} → ${modelData.maxOutputTokens}`);
	}

	// Check tool support
	if (anthropicRequest.tools && anthropicRequest.tools.length > 0 && !modelData.supportsTools) {
		warnings.push(`Model ${anthropicRequest.model} does not support tools. Tool calls will be disabled.`);
		adjustments.toolsDisabled = true;
		logger?.log(`⚠️  Tools disabled for model without tool support`);
	}

	// Check image support (scan through messages for images)
	const hasImages = anthropicRequest.messages?.some((msg) =>
		Array.isArray(msg.content) ? msg.content.some((block: { type?: string }) => block.type === "image") : false,
	);

	if (hasImages && !modelData.supportsImageInput) {
		warnings.push(`Model ${anthropicRequest.model} does not support image input. Images will be ignored.`);
		adjustments.imagesIgnored = true;
		logger?.log(`⚠️  Images ignored for model without image support`);
	}

	return {
		valid: warnings.length === 0,
		warnings,
		adjustments,
	};
}

/**
 * Convert thinking parameters based on provider type
 */
export function convertThinkingParameters(
	provider: Provider,
	anthropicRequest: MessageCreateParamsBase,
): AnthropicAskOptions | OpenAIAskOptions | GoogleAskOptions {
	const baseOptions = {
		maxOutputTokens: anthropicRequest.max_tokens,
	};

	switch (provider) {
		case "anthropic":
			return {
				...baseOptions,
				// Anthropic uses the same thinking parameters
				...(anthropicRequest.thinking?.type == "enabled" && {
					thinkingEnabled: true,
				}),
				...(anthropicRequest.thinking?.type == "enabled" &&
					anthropicRequest.thinking.budget_tokens !== undefined && {
						maxThinkingTokens: anthropicRequest.thinking.budget_tokens,
					}),
			} as AnthropicAskOptions;

		case "google":
			const options: GoogleAskOptions = {
				...baseOptions,
				// Google uses includeThoughts for thinking
				...(anthropicRequest.thinking?.type == "enabled" && {
					includeThoughts: true,
				}),
				...(anthropicRequest.thinking?.type == "enabled" &&
					anthropicRequest.thinking.budget_tokens !== undefined && {
						thinkingBudget: anthropicRequest.thinking.budget_tokens,
					}),
			};
			return options;

		case "openai":
			return {
				...baseOptions,
				...(anthropicRequest.thinking?.type == "enabled" && {
					reasoningEffort: "medium" as const,
				}),
			} as OpenAIAskOptions;

		default:
			// TypeScript exhaustiveness check
			const _exhaustiveCheck: never = provider;
			throw new Error(`Unsupported provider: ${_exhaustiveCheck}`);
	}
}
