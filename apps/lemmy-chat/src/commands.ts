import { resolveSearchMode } from "./search.js";
import { Command } from "commander";
import {
	AnthropicModelData,
	OpenAIModelData,
	GoogleModelData,
	ModelToProvider,
	Attachment,
	CLIENT_CONFIG_SCHEMAS,
} from "@mariozechner/lemmy";
import type { ProviderConfigMap as CoreProviderConfigMap } from "@mariozechner/lemmy";
import {
	createCompleteModelsCommand,
	createCompleteProviderCommands,
	type CLIApplicationConfig,
	type CommandGenerationConfig,
	type ModelValidationConfig,
	getValidProviders,
	validateProvider,
} from "@mariozechner/lemmy-cli-args";
import {
	saveDefaults,
	loadDefaults,
	loadDefaultsConfig,
	saveDefaultsConfig,
	setDefaultProvider,
	clearDefaults,
	DEFAULTS_FILE,
	getProviderConfig,
	getDefaultProviderConfig,
} from "./defaults.js";
import { runOneShot } from "./one-shot.js";
import { loadImageAttachment } from "./images.js";
import { runTUIChat } from "./chat.js";

function formatModelInfo(modelId: string, modelData: any): string {
	const contextWindow = modelData.contextWindow || 0;
	const maxOutput = modelData.maxOutputTokens || 0;
	const pricing = modelData.pricing;

	let info = `${modelId}`;

	// Add capability indicators
	const capabilities: string[] = [];
	if (modelData.supportsTools) capabilities.push("🔧 tools");
	if (modelData.supportsImageInput) capabilities.push("🖼️  images");
	if (capabilities.length > 0) {
		info += ` (${capabilities.join(", ")})`;
	}

	// Add context/output info
	if (contextWindow > 0 || maxOutput > 0) {
		const contextStr = contextWindow > 0 ? `${contextWindow.toLocaleString()}` : "?";
		const outputStr = maxOutput > 0 ? `${maxOutput.toLocaleString()}` : "?";
		info += `\n    Context: ${contextStr} tokens, Max output: ${outputStr} tokens`;
	}

	// Add pricing info
	if (pricing) {
		const inputPrice = pricing.inputPerMillion;
		const outputPrice = pricing.outputPerMillion;
		info += `\n    Pricing: $${inputPrice}/M input, $${outputPrice}/M output`;
	}

	return info;
}

// Configuration for lemmy-cli-args complete commands
const cliConfig: CLIApplicationConfig = {
	commandConfig: {
		schemas: CLIENT_CONFIG_SCHEMAS,
		optionalApiKey: true, // Allow API key from environment
		excludeFields: [], // Don't exclude any fields
	},
	modelConfig: {
		allowUnknownModels: true,
		modelRegistries: {
			anthropic: AnthropicModelData,
			openai: OpenAIModelData,
			google: GoogleModelData,
		},
		modelToProvider: ModelToProvider,
	},
	formatModelInfo,
};

// Execute action for provider commands
async function executeProviderAction(
	provider: string,
	message: string,
	options: any,
	attachments: any[] = [],
): Promise<void> {
	// Handle image attachments
	const allAttachments: Attachment[] = [...attachments];

	if (options.image) {
		try {
			const attachment = loadImageAttachment(options.image);
			allAttachments.push(attachment);
		} catch (error) {
			console.error(
				`❌ Failed to load image ${options.image}:`,
				error instanceof Error ? error.message : String(error),
			);
			process.exit(1);
		}
	}

	if (options.images && Array.isArray(options.images)) {
		for (const imagePath of options.images) {
			try {
				const attachment = loadImageAttachment(imagePath);
				allAttachments.push(attachment);
			} catch (error) {
				console.error(
					`❌ Failed to load image ${imagePath}:`,
					error instanceof Error ? error.message : String(error),
				);
				process.exit(1);
			}
		}
	}

	// Use centralized config building
	const config = getProviderConfig(provider as keyof CoreProviderConfigMap, options, options.apiKey);

	await runOneShot(
		provider,
		message,
		config,
		allAttachments,
		resolveSearchMode(options.search, loadDefaultsConfig().search),
	);
}

export function createModelsCommand(): Command {
	return createCompleteModelsCommand(cliConfig);
}

export function createOneShotCommand(provider: string): Command {
	const commands = createCompleteProviderCommands(cliConfig, executeProviderAction);
	const command = commands[provider];
	if (!command) {
		throw new Error(`No command available for provider: ${provider}`);
	}
	// These client fields are not part of CLIENT_CONFIG_SCHEMAS' ask-option schemas.
	command.option("-m, --model <model>", "Model to use");
	command.option("--apiKey <key>", "API key (or use environment variables)");
	command.option("--search <mode>", "Web search: parallel (default) or off");
	return command;
}

export function createDefaultsCommand(): Command {
	const command = new Command("defaults");
	command.description("Set default arguments for lemmy-chat");

	command.argument("[args...]", "Default arguments to save (e.g., anthropic -m claude-opus-4-20250514)");

	command.option("-s, --show", "Show current defaults");
	command.option("-c, --clear", "Clear saved defaults");
	command.option("--default-provider <provider>", "Set the default provider");
	command.option("--search <mode>", "Save web search: parallel or off");

	// Allow unknown options to be captured as arguments
	command.allowUnknownOption();

	command.action((args: string[], options: any) => {
		if (options.search !== undefined) {
			const config = loadDefaultsConfig();
			config.search = resolveSearchMode(options.search);
			saveDefaultsConfig(config);
			console.log(`Web search: ${config.search}`);
			if (args.length === 0) return;
		}
		if (options.show) {
			const config = loadDefaultsConfig();
			console.log(`Web search: ${resolveSearchMode(undefined, config.search)}`);
			if (Object.keys(config.providers).length === 0) {
				console.log("No defaults set.");
				console.log("\nSet defaults with:");
				console.log("  lemmy-chat defaults anthropic -m claude-sonnet-4-20250514 --thinkingEnabled");
				console.log("  lemmy-chat defaults openai -m o4-mini --reasoningEffort medium");
				console.log("  lemmy-chat defaults --default-provider anthropic");
			} else {
				console.log("Current defaults:");
				console.log(`Default provider: ${config.defaultProvider || "none"}`);
				console.log();

				for (const [provider, settings] of Object.entries(config.providers)) {
					console.log(`📋 ${provider.toUpperCase()}:`);
					if (settings.model) {
						console.log(`  Model: ${settings.model}`);
					}
					for (const [key, value] of Object.entries(settings)) {
						if (key === "model") continue;
						if (key === "defaults" && typeof value === "object" && value !== null) {
							// Show defaults in a nested format
							for (const [defaultKey, defaultValue] of Object.entries(value)) {
								console.log(`  ${defaultKey}: ${defaultValue}`);
							}
						} else {
							console.log(`  ${key}: ${value}`);
						}
					}
					console.log();
				}
				console.log(`Stored in: ${DEFAULTS_FILE}`);
			}
			return;
		}

		if (options.defaultProvider) {
			const validProviders = getValidProviders();
			if (!validateProvider(options.defaultProvider, validProviders)) {
				console.error(
					`❌ Invalid provider: ${options.defaultProvider}. Valid providers: ${validProviders.join(", ")}`,
				);
				process.exit(1);
			}
			setDefaultProvider(options.defaultProvider);
			console.log(`✅ Set default provider to: ${options.defaultProvider}`);
			return;
		}

		if (options.clear) {
			clearDefaults();
			console.log("✅ Defaults cleared");
			return;
		}

		if (args.length === 0) {
			console.log("Usage:");
			console.log("  lemmy-chat defaults <provider> [options...]           # Set provider defaults");
			console.log("  lemmy-chat defaults --default-provider <provider>    # Set default provider");
			console.log("  lemmy-chat defaults --show                           # Show current defaults");
			console.log("  lemmy-chat defaults --clear                          # Clear all defaults");
			console.log("\nExamples:");
			console.log("  lemmy-chat defaults anthropic -m claude-3-5-sonnet-latest --thinkingEnabled");
			console.log("  lemmy-chat defaults openai -m o4-mini --reasoningEffort medium");
			console.log("  lemmy-chat defaults google -m gemini-2.0-flash --projectId my-project");
			console.log("  lemmy-chat defaults --default-provider anthropic");
			return;
		}

		// Validate that first arg is a valid provider using lemmy-cli-args validation
		const provider = args[0];
		const validProviders = getValidProviders();
		if (!provider || !validateProvider(provider, validProviders)) {
			console.error(`❌ Invalid provider: ${provider}. Valid providers: ${validProviders.join(", ")}`);
			process.exit(1);
		}

		saveDefaults(args);
		console.log("✅ Defaults saved:");
		console.log(`   lemmy-chat ${args.join(" ")}`);
		console.log(`\nNow you can run: lemmy-chat "your message"`);
		console.log(`Stored in: ${DEFAULTS_FILE}`);
	});

	return command;
}

export function createChatCommand(): Command {
	const command = new Command("chat");
	command.description("Interactive chat mode with TUI interface");

	// Use manual options since this is a special command that needs to work without a specific provider
	command.option("-p, --provider <provider>", "Provider to use (anthropic, openai, google)");
	command.option("-m, --model <model>", "Model to use");
	command.option("--apiKey <key>", "API key (or use environment variables)");
	command.option("--simulate-input <inputs...>", "Simulate input sequences for testing");
	command.option("--search <mode>", "Web search: parallel (default) or off");

	// Add common options that work across providers
	command.option("--thinkingEnabled", "Enable thinking for supported models");
	command.option("--temperature <number>", "Temperature for generation", parseFloat);
	command.option("--maxOutputTokens <number>", "Maximum output tokens", parseInt);
	command.option("--maxThinkingTokens <number>", "Maximum thinking tokens", parseInt);

	command.action(async (options) => {
		try {
			// Determine provider - use from options or defaults
			let provider = options.provider;
			if (!provider) {
				const defaultConfig = getDefaultProviderConfig();
				if (defaultConfig) {
					provider = defaultConfig.provider;
				} else {
					console.error("❌ No provider specified and no defaults set.");
					console.error("Either use -p/--provider flag or set defaults first:");
					console.error("  lemmy-chat defaults anthropic -m claude-sonnet-4-20250514");
					process.exit(1);
				}
			}

			// Use centralized config building
			const config = getProviderConfig(provider as keyof CoreProviderConfigMap, options, options.apiKey);

			// Pass the built config to TUI chat
			await runTUIChat(
				provider,
				config,
				options.simulateInput,
				resolveSearchMode(options.search, loadDefaultsConfig().search),
			);
		} catch (error) {
			console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	});

	return command;
}
