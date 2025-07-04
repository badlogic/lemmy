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

import type {
	MessageCreateParamsBase,
	ThinkingConfigEnabled,
	ThinkingBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

// Add debug logging wrapper for clients
function wrapClientWithLogging(client: ChatClient, provider: Provider, debug: boolean): ChatClient {
	if (!debug) return client;

	return {
		...client,
		ask: async (...args: Parameters<ChatClient["ask"]>) => {
			const request = args[0];
			const config = (client as any).config || {};

			// For OpenAI provider, the request will be transformed internally
			// so we just log what we're sending to the lemmy client
			if (provider === "openai") {
				console.debug(`[${provider}] Sending request to lemmy client:`, {
					model: config.model,
					baseURL: config.baseURL,
					request: JSON.stringify(request, null, 2),
				});
			} else {
				const fullUrl = config.baseURL?.endsWith("/completions")
					? config.baseURL
					: `${config.baseURL}/chat/completions`;

				// Generate curl command for easy debugging
				const curlCommand = [
					"curl",
					"-X POST",
					`"${fullUrl}"`,
					'-H "Content-Type: application/json"',
					`-H "Authorization: Bearer ${config.apiKey || "YOUR_API_KEY"}"`,
					`-d '${JSON.stringify(request)}'`,
				].join(" \\\n  ");

				console.debug(`[${provider}] Request as curl command:\n${curlCommand}`);

				console.debug(`[${provider}] Request details:`, {
					baseURL: config.baseURL,
					fullUrl,
					headers: {
						Authorization: "Bearer " + (config.apiKey ? "***" + config.apiKey.slice(-4) : "undefined"),
						"Content-Type": "application/json",
					},
					body: JSON.stringify(request, null, 2),
				});
			}

			try {
				const response = await client.ask(...args);
				console.debug(`[${provider}] Response:`, JSON.stringify(response, null, 2));
				return response;
			} catch (error) {
				console.debug(`[${provider}] Error:`, error);
				throw error;
			}
		},
	};
}

/**
 * Create provider-agnostic client for a given model
 */
export async function createProviderClient(config: BridgeConfig): Promise<ProviderClientInfo> {
	let provider: Provider;
	let client: ChatClient;

	// If proxy provider is specified, use it directly without model registry lookup
	if (config.provider === "proxy") {
		provider = "proxy";
		const providerConfig = buildProviderConfig(provider, config);

		// Create OpenAI-compatible client for proxy
		const { lemmy } = await import("@mariozechner/lemmy");
		const baseURL = providerConfig.baseURL?.endsWith("/completions")
			? providerConfig.baseURL
			: providerConfig.baseURL?.endsWith("/v1/chat")
				? `${providerConfig.baseURL}/completions`
				: providerConfig.baseURL?.endsWith("/v1")
					? `${providerConfig.baseURL}/chat/completions`
					: `${providerConfig.baseURL}/v1/chat/completions`;

		console.debug(`[${provider}] Setting up client with baseURL:`, baseURL);

		client = lemmy.openai({
			...(providerConfig as OpenAIConfig),
			baseURL,
		});

		// Wrap the client to handle Anthropic-style tool parsing and request transformation
		client = {
			...client,
			ask: async (options: any) => {
				// Transform request to OpenAI format
				const contentBlocks = Array.isArray(options.content)
					? options.content
					: [{ type: "text", text: options.content }];

				const openaiRequest: any = {
					model: options.model || config.model,
					messages: [
						{
							role: "user",
							content:
								contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
									? contentBlocks[0].text
									: contentBlocks,
						},
					],
					stream: false,
					max_tokens: options.maxOutputTokens || 512,
					temperature: options.temperature || 0.7,
				};

				// Handle tool results if present
				if (options.toolResults && Array.isArray(options.toolResults)) {
					// Ensure content is an array before pushing tool results
					if (typeof openaiRequest.messages[0].content === "string") {
						openaiRequest.messages[0].content = [{ type: "text", text: openaiRequest.messages[0].content }];
					}
					// Add tool results to the content array of the first message
					openaiRequest.messages[0].content.push(
						...options.toolResults.map((result: any) => ({
							type: "tool_result",
							tool_use_id: result.toolCallId,
							content: result.content,
						})),
					);
				}

				// Parse tools in Anthropic style before sending to OpenAI-compatible API
				if (options.tools) {
					openaiRequest.tools = options.tools.map((tool: any) => ({
						type: "function",
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.input_schema,
						},
					}));
				}

				// Handle thinking parameters
				if (options.thinking?.type === "enabled") {
					// Add thinking configuration to root request
					openaiRequest.thinking = {
						type: "enabled",
						budget_tokens: options.thinking.budget_tokens,
					} as ThinkingConfigEnabled;

					// Add thinking block to each message's content
					openaiRequest.messages = openaiRequest.messages.map((msg: any) => {
						const content = Array.isArray(msg.content)
							? msg.content
							: [
									{
										type: "text",
										text: msg.content,
									},
								];

						// Add thinking block to content
						const thinkingBlock: ThinkingBlock = {
							type: "thinking",
							thinking: "",
							signature: "",
						};
						content.push(thinkingBlock);

						return {
							...msg,
							content,
						};
					});
				}

				// Log the request
				if (config.debug) {
					const fullUrl = config.baseURL?.endsWith("/completions")
						? config.baseURL
						: `${config.baseURL}/chat/completions`;

					// Generate curl command for easy debugging
					const curlCommand = [
						"curl",
						"-X POST",
						`"${fullUrl}"`,
						'-H "Content-Type: application/json"',
						`-H "Authorization: Bearer ${config.apiKey || "YOUR_API_KEY"}"`,
						`-d '${JSON.stringify(openaiRequest)}'`,
					].join(" \\\n  ");

					console.debug(`[${provider}] Request as curl command:\n${curlCommand}`);

					console.debug(`[${provider}] Request details:`, {
						baseURL: config.baseURL,
						fullUrl,
						headers: {
							Authorization: "Bearer " + (config.apiKey ? "***" + config.apiKey.slice(-4) : "undefined"),
							"Content-Type": "application/json",
						},
						body: JSON.stringify(openaiRequest, null, 2),
					});
				}

				const response = await client.ask(openaiRequest);
				console.debug(`[${provider}] Response:`, JSON.stringify(response, null, 2));
				return response;
			},
		};
	} else {
		// For known models, use the registry
		const modelData = findModelData(config.model);

		if (modelData) {
			// Known model - use standard approach
			provider = getProviderForModel(config.model as AllModels) as Provider;
			const providerConfig = buildProviderConfig(provider, config);
			client = createClientForModel(config.model as AllModels, providerConfig);
		} else {
			// Unknown model - use the configured provider directly
			provider = config.provider;
			const providerConfig = buildProviderConfig(provider, config);

			// Create client directly using lemmy's provider factories
			switch (provider) {
				case "openai": {
					const { lemmy } = await import("@mariozechner/lemmy");
					// For custom baseURL, pass it directly without modification
					client = lemmy.openai({
						...(providerConfig as OpenAIConfig),
						// Keep the user's baseURL exactly as provided
						baseURL: config.baseURL,
					});
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
		}
	}

	// Wrap all clients with debug logging if debug mode is enabled
	// Skip for proxy provider as it has its own logging
	if (provider !== "proxy") {
		client = wrapClientWithLogging(client, provider, config.debug || false);
	}

	return {
		client,
		provider,
		model: config.model,
		modelData: findModelData(config.model) || null,
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
		case "proxy":
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
		case "proxy":
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
 * Validate thinking parameters
 */
function validateThinkingParameters(thinking: ThinkingConfigEnabled | undefined): void {
	if (!thinking) return;

	if (thinking.type !== "enabled") {
		throw new Error("Invalid thinking type. Only 'enabled' is supported.");
	}

	if (thinking.budget_tokens !== undefined) {
		if (typeof thinking.budget_tokens !== "number" || thinking.budget_tokens < 1024) {
			throw new Error("Invalid thinking budget_tokens. Must be a number >= 1024.");
		}
	}
}

/**
 * Convert thinking parameters based on provider type
 */
export function convertThinkingParameters(thinking: ThinkingConfigEnabled | undefined, provider: Provider) {
	if (!thinking) {
		return undefined;
	}

	// Validate thinking parameters
	if (thinking.type !== "enabled") {
		throw new Error('Invalid thinking configuration: type must be "enabled"');
	}

	if (typeof thinking.budget_tokens !== "number" || thinking.budget_tokens < 1024) {
		throw new Error("Invalid thinking configuration: budget_tokens must be a number >= 1024");
	}

	// Convert based on provider
	switch (provider) {
		case "anthropic":
			return {
				type: "enabled",
				budget_tokens: thinking.budget_tokens,
			};
		case "google":
			return {
				includeThoughts: true,
				thinkingBudget: thinking.budget_tokens,
			};
		case "openai":
			return {
				reasoningEffort: "high",
			};
		case "proxy":
			return {
				thinking: {
					type: "enabled",
					budget_tokens: thinking.budget_tokens,
				},
			};
		default:
			return undefined;
	}
}
