import { SearchConversation, resolveSearchMode, type SearchMode } from "./search.js";
import { loadDefaultsConfig } from "./defaults.js";
import {
	AssistantMessage,
	calculateTokenCost,
	Context,
	createClientForModel,
	getDefaultApiKeyEnvVar,
	getProviders,
	UserMessage,
	AnthropicModelData,
	OpenAIModelData,
	GoogleModelData,
	findModelData,
	AnthropicAskOptions,
	OpenAIAskOptions,
	GoogleAskOptions,
	AskOptions,
	Provider,
	ModelToProvider,
} from "@mariozechner/lemmy";
import type { ProviderConfigMap } from "@mariozechner/lemmy";
import {
	TUI,
	Container,
	TextComponent,
	TextEditor,
	CombinedAutocompleteProvider,
	type SlashCommand,
	logger,
} from "@mariozechner/lemmy-tui";
import { CLIENT_CONFIG_SCHEMAS } from "@mariozechner/lemmy";
import { getProviderConfig } from "./defaults.js";
import { loadFileAttachment } from "./images.js";
import chalk from "chalk";

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

function parseMessageWithAttachments(message: string): {
	content: string;
	attachments: any[];
	textFiles: Array<{ name: string; content: string }>;
} {
	const attachments: any[] = [];
	const textFiles: Array<{ name: string; content: string }> = [];

	// Find all @path patterns
	const filePattern = /@([^\s]+)/g;
	let match;
	const processedPaths = new Set<string>();

	while ((match = filePattern.exec(message)) !== null) {
		const filePath = match[1];

		// Skip if already processed or if filePath is undefined
		if (!filePath || processedPaths.has(filePath)) continue;
		processedPaths.add(filePath);

		try {
			const fileResult = loadFileAttachment(filePath);

			if (fileResult.type === "image") {
				attachments.push(fileResult.content);
			} else if (fileResult.type === "text") {
				const fileName = filePath.split("/").pop() || filePath;
				textFiles.push({
					name: fileName,
					content: fileResult.content as string,
				});
			}
		} catch (error) {
			logger.error("File attachment", `Failed to load ${filePath}`, error);
		}
	}

	// Remove file references from the message content
	const cleanContent = message.replace(/@[^\s]+/g, "").trim();

	return { content: cleanContent, attachments, textFiles };
}

const FILE_SYSTEM_INSTRUCTION = `Some user messages may contain attached files in the following format:

<attached-files>
<file name="filename.ext">
file content here
</file>
<file name="another.txt">
more content
</file>
</attached-files>

When you see this format, treat the file contents as part of the user's context and refer to them by filename when discussing them.`;

// Type mapping for provider-specific AskOptions
type ProviderAskOptions = {
	anthropic: AskOptions<AnthropicAskOptions>;
	openai: AskOptions<OpenAIAskOptions>;
	google: AskOptions<GoogleAskOptions>;
};

// Helper functions to extract schema information from Zod schemas
function getSchemaFields(
	schema: import("zod").ZodObject<any>,
): Record<string, { type: string; description?: string; values?: string[] }> {
	const fields: Record<string, { type: string; description?: string; values?: string[] }> = {};

	if (schema && schema._def && schema._def.shape) {
		for (const [key, fieldSchema] of Object.entries(schema._def.shape() as any)) {
			const field = fieldSchema as import("zod").ZodTypeAny;
			let type = "string";
			let values: string[] | undefined;

			if (field._def) {
				// Handle coerced types
				if (field._def.innerType) {
					const innerType = field._def.innerType._def.typeName;
					if (innerType === "ZodNumber") type = "number";
					else if (innerType === "ZodBoolean") type = "boolean";
				}
				// Handle direct types
				else if (field._def.typeName === "ZodNumber") type = "number";
				else if (field._def.typeName === "ZodBoolean") type = "boolean";
				else if (field._def.typeName === "ZodEnum") {
					type = "enum";
					values = field._def.values;
				} else if (field._def.typeName === "ZodArray") type = "string[]";
			}

			fields[key] = { type, ...(values && { values }) };
		}
	}

	return fields;
}

function hasSchemaField(schema: import("zod").ZodObject<any>, fieldName: string): boolean {
	return schema && schema._def && schema._def.shape && fieldName in schema._def.shape();
}

function parseAskOptions<T extends Provider>(
	currentOptions: Record<string, unknown>,
	provider: T,
	context: Context,
): ProviderAskOptions[T] {
	// Get Zod schemas for validation
	const baseSchema = CLIENT_CONFIG_SCHEMAS.base;
	const providerSchema = CLIENT_CONFIG_SCHEMAS[provider];

	// Merge schemas for validation
	const combinedSchema = baseSchema.merge(providerSchema);

	// Prepare options for validation - filter by provider prefix and strip prefixes
	const filteredOptions: Record<string, unknown> = { context };

	for (const [key, value] of Object.entries(currentOptions)) {
		// Remove provider: prefix if present
		const parts = key.split(":");
		const optionKey = parts.length > 1 && parts[1] ? parts[1] : key;

		// Skip model field as it's handled separately, and skip non-provider options for provider-specific keys
		if (optionKey === "model") continue;
		if (key.includes(":") && !key.startsWith(`${provider}:`)) continue;

		filteredOptions[optionKey] = value;
	}

	// Parse and validate with Zod
	const result = combinedSchema.safeParse(filteredOptions);

	if (result.success) {
		return result.data as ProviderAskOptions[T];
	} else {
		// Log validation errors but continue with fallback
		logger.debug("parseAskOptions", `Validation errors for ${provider}`, {
			errors: result.error.issues.map((issue: any) => ({
				path: issue.path.join("."),
				message: issue.message,
				received: issue.code === "invalid_type" ? issue.received : undefined,
			})),
		});

		// Return base options as fallback
		return { context } as ProviderAskOptions[T];
	}
}

export async function runTUIChat(
	provider: string,
	config: ProviderConfigMap[keyof ProviderConfigMap],
	simulateInput?: string[],
	searchMode: SearchMode = resolveSearchMode(undefined, loadDefaultsConfig().search),
): Promise<void> {
	// Config is already validated and built by the caller
	let model = config.model;

	// Create client and context
	let client = createClientForModel(model, config);
	const context = new SearchConversation(searchMode);

	// Create TUI components
	const tui = new TUI();

	// Enable debug logging
	logger.configure({
		enabled: true,
		logFile: "tui-debug.log",
		logLevel: "debug",
	});

	// Logo component
	const logoText = chalk.hex("#AC5A1F")(
		[
			"   ██╗     ███████╗███╗   ███╗███╗   ███╗██╗   ██╗",
			"   ██║     ██╔════╝████╗ ████║████╗ ████║╚██╗ ██╔╝",
			"   ██║     █████╗  ██╔████╔██║██╔████╔██║ ╚████╔╝",
			"   ██║     ██╔══╝  ██║╚██╔╝██║██║╚██╔╝██║  ╚██╔╝",
			"   ███████╗███████╗██║ ╚═╝ ██║██║ ╚═╝ ██║   ██║",
			"   ╚══════╝╚══════╝╚═╝     ╚═╝╚═╝     ╚═╝   ╚═╝",
		].join("\n"),
	);
	const logo = new TextComponent(logoText, { top: 1, bottom: 1 });

	// Header component
	const header = new TextComponent(chalk.yellow(`Chat with ${provider}/${model} | Type 'exit' to quit`), {
		left: 1,
		right: 1,
		bottom: 1,
	});

	// Messages container
	const messagesContainer = new Container(tui);

	// Status component for tokens/cost
	const statusComponent = new TextComponent(" Ready to chat...", { left: 1, right: 1 });

	// Input editor
	const inputEditor = new TextEditor();

	// Function to build commands for a specific provider
	function buildCommands(currentProvider: string): SlashCommand[] {
		// Get all available models for model command completions
		const allModels = {
			...AnthropicModelData,
			...OpenAIModelData,
			...GoogleModelData,
		};

		const commands: SlashCommand[] = [
			{ name: "exit", description: "Exit the chat" },
			{ name: "clear", description: "Clear the conversation" },
			{
				name: "model",
				description: "Show or set current model",
				getArgumentCompletions: (prefix: string) => {
					return Object.keys(allModels)
						.filter((modelName) => modelName.toLowerCase().includes(prefix.toLowerCase()))
						.map((modelName) => ({
							value: modelName,
							label: modelName,
							description: `Switch to ${modelName}`,
						}));
				},
			},
			{ name: "usage", description: "Show token usage and costs" },
			{ name: "system", description: "Set system prompt" },
			{ name: "help", description: "Show available commands" },
		];

		// Add provider-specific options from Zod schema
		const providerZodSchema = CLIENT_CONFIG_SCHEMAS[currentProvider as keyof typeof CLIENT_CONFIG_SCHEMAS];
		if (providerZodSchema) {
			const providerFields = getSchemaFields(providerZodSchema);
			for (const [key, fieldInfo] of Object.entries(providerFields)) {
				// Skip the model field as it's already set
				if (key === "model") continue;

				const commandName = `${currentProvider}:${key}`;
				let description = fieldInfo.description || "";

				// Add type/value hints to description
				if (fieldInfo.type === "boolean") {
					description += " (true/false)";
				} else if (fieldInfo.type === "enum" && fieldInfo.values) {
					description += ` (${fieldInfo.values.join("/")})`;
				} else if (fieldInfo.type === "number") {
					description += " (number)";
				}

				commands.push({
					name: commandName,
					description,
				});
			}
		}

		// Add base options that apply to all providers
		const baseZodSchema = CLIENT_CONFIG_SCHEMAS.base;
		const baseFields = getSchemaFields(baseZodSchema);
		for (const [key, fieldInfo] of Object.entries(baseFields)) {
			// Skip apiKey and baseURL as they're not typically changed at runtime
			if (key === "apiKey" || key === "baseURL") continue;

			let description = fieldInfo.description || "";
			if (fieldInfo.type === "number") {
				description += " (number)";
			}

			commands.push({
				name: key,
				description,
			});
		}

		return commands;
	}

	// Define available slash commands
	let commands = buildCommands(provider);

	// Set up autocomplete provider
	const autocompleteProvider = new CombinedAutocompleteProvider(commands);
	inputEditor.setAutocompleteProvider(autocompleteProvider);

	// Add components to TUI
	tui.addChild(logo);
	tui.addChild(header);
	tui.addChild(messagesContainer);
	tui.addChild(inputEditor);
	tui.addChild(statusComponent);

	// Set focus to input editor
	tui.setFocus(inputEditor);

	// Track conversation state
	let totalCost = 0;
	let isProcessing = false;

	// Store current ask options - initialize with current config
	let currentOptions: Record<string, unknown> = { ...config, ...config.defaults };
	delete currentOptions["apiKey"]; // Don't expose API key in options
	let animationInterval: NodeJS.Timeout | null = null;

	function startLoadingAnimation() {
		if (animationInterval) return; // Already animating

		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let frameIndex = 0;

		animationInterval = setInterval(() => {
			const spinner = frames[frameIndex % frames.length];
			statusComponent.setText(chalk.magenta(` ${spinner} Processing...`));
			tui.requestRender();
			frameIndex++;
		}, 100);
	}

	function stopLoadingAnimation() {
		if (animationInterval) {
			clearInterval(animationInterval);
			animationInterval = null;
		}
	}

	function updateStatus(message?: string) {
		// Don't update status if we're currently animating
		if (animationInterval) return;

		if (message) {
			statusComponent.setText(message);
		} else if (context.getMessages().length > 0) {
			const lastMsg = context.getLastMessage();
			if (lastMsg && lastMsg.role === "assistant") {
				const lastUsage = lastMsg.usage ? `↑${lastMsg.usage.input} ↓${lastMsg.usage.output}` : "";
				const lastCost = calculateTokenCost(lastMsg.model, lastMsg.usage);

				const totalUsage = `↑${context.getTokenUsage().input} ↓${context.getTokenUsage().output}`;
				const totalCost = context.getTotalCost();

				const statusInfo = ` Last: ${lastUsage} $${lastCost.toFixed(6)} | Total: ${totalUsage} $${totalCost.toFixed(6)}`;
				statusComponent.setText(chalk.italic(chalk.gray(statusInfo)));
			}
		} else {
			statusComponent.setText(chalk.italic(chalk.gray(" Ready to chat...")));
		}
		tui.requestRender();
	}

	function addMessage(message: UserMessage | AssistantMessage) {
		if (message.role === "assistant") {
			if (message.thinking) {
				const thinkingComponent = new TextComponent(chalk.dim.italic(`Thinking: ${message.thinking.trim()}`), {
					bottom: 1,
					left: 1,
					right: 1,
				});
				messagesContainer.addChild(thinkingComponent);
			}

			const messageComponent = new TextComponent(`Assistant: ${message.content?.trim() || ""}`, {
				bottom: 1,
				left: 1,
				right: 1,
			});
			messagesContainer.addChild(messageComponent);

			totalCost += calculateTokenCost(message.model, message.usage);
		} else {
			// Handle multiline content properly
			// Filter out empty lines at the end that might come from trailing newlines
			const allLines = message.content?.split("\n") || [""];
			const lines = allLines.filter((line, index) => {
				// Keep all non-empty lines and empty lines that aren't at the end
				return line !== "" || index < allLines.length - 1;
			});
			logger.debug("Chat", "Processing user message display", {
				originalContent: JSON.stringify(message.content),
				lines: lines,
				lineCount: lines.length,
			});

			// Always use padding for user messages
			const messageComponent = new TextComponent(chalk.green(`You: ${message.content}`), {
				bottom: 1,
				left: 1,
				right: 1,
			});
			messagesContainer.addChild(messageComponent);
		}

		updateStatus();
	}

	// Handle input submissions
	inputEditor.onSubmit = async (text: string) => {
		logger.debug("Chat", "Received submission", {
			originalText: JSON.stringify(text),
			trimmedText: JSON.stringify(text.trim()),
			lines: text.split("\n"),
		});
		const message = text.trim();

		if (message === "exit" || message === "quit") {
			console.log("\n👋 Goodbye!");
			tui.stop();
			process.exit(0);
		}

		// Check if it's a slash command
		if (message.startsWith("/")) {
			const parts = message.substring(1).split(" ");
			const commandName = parts[0];
			const commandValue = parts.slice(1).join(" ");

			if (commandName) {
				if (isProcessing && commandName !== "exit") {
					updateStatus("Wait for the current response before changing chat settings.");
					return;
				}
				executeCommand(commandName, commandValue);
			}
			return;
		}

		if (message === "" || isProcessing) {
			return;
		}

		isProcessing = true;
		startLoadingAnimation();

		try {
			// Parse message for file attachments
			const { content, attachments, textFiles } = parseMessageWithAttachments(message);

			// Build final message content
			let finalContent = content;
			if (textFiles.length > 0) {
				finalContent += "\n\n<attached-files>\n";
				for (const file of textFiles) {
					finalContent += `<file name="${file.name}">\n${file.content}\n</file>\n`;
				}
				finalContent += "</attached-files>";
			}

			// Add user message (show original message with @files in UI)
			addMessage({
				role: "user",
				content: message,
				timestamp: new Date(),
			});

			// Show attachment info if any
			if (attachments.length > 0 || textFiles.length > 0) {
				const attachmentInfo = [];
				if (attachments.length > 0) {
					attachmentInfo.push(`🖼️ ${attachments.length} image(s)`);
				}
				if (textFiles.length > 0) {
					attachmentInfo.push(`📄 ${textFiles.length} text file(s)`);
				}

				const attachmentComponent = new TextComponent(chalk.dim(`📎 Attached: ${attachmentInfo.join(", ")}`), {
					bottom: 1,
					left: 1,
					right: 1,
				});
				messagesContainer.addChild(attachmentComponent);
			}

			// Add system instruction about file format if we have text files
			if (textFiles.length > 0) {
				const currentSystemMessage = context.getSystemMessage();
				const newSystemMessage = currentSystemMessage
					? `${currentSystemMessage}\n\n${FILE_SYSTEM_INSTRUCTION}`
					: FILE_SYSTEM_INSTRUCTION;
				context.setSystemMessage(newSystemMessage);
			}

			// Make the API call with current options using schema-driven parsing
			const askOptions = parseAskOptions(currentOptions, provider as Provider, context);

			// Use AskInput format if we have attachments, otherwise use string
			const askInput = attachments.length > 0 ? { content: finalContent, attachments } : finalContent;

			const result = await context.ask(client, askInput, askOptions);

			if (result.type === "success") {
				addMessage(result.message);
				totalCost += result.cost;
			} else {
				const errorComponent = new TextComponent(`❌ Error: ${result.error.message}`, {
					bottom: 1,
					left: 1,
					right: 1,
				});
				messagesContainer.addChild(errorComponent);
				tui.requestRender();
			}
		} catch (error) {
			const errorComponent = new TextComponent(
				`❌ Error: ${error instanceof Error ? error.message : String(error)}`,
				{ bottom: 1, left: 1, right: 1 },
			);
			messagesContainer.addChild(errorComponent);
			tui.requestRender();
		} finally {
			stopLoadingAnimation();
			isProcessing = false;
			updateStatus();
		}
	};

	async function executeCommand(command: string, value?: string) {
		switch (command) {
			case "exit":
				console.log("\n👋 Goodbye!");
				tui.stop();
				process.exit(0);

			case "clear":
				// Clear all messages from the container
				messagesContainer.clear();

				// Clear context
				context.clear();
				totalCost = 0;
				updateStatus("Conversation cleared");
				break;

			case "model":
				if (value) {
					// User wants to set a new model
					const newModel = value.trim();
					const allModels = {
						...AnthropicModelData,
						...OpenAIModelData,
						...GoogleModelData,
					};

					if (allModels[newModel as keyof typeof allModels]) {
						try {
							// Determine new provider
							const newProvider = ModelToProvider[newModel as keyof typeof ModelToProvider];

							if (!newProvider) {
								throw new Error(`Could not determine provider for model: ${newModel}`);
							}

							// Get the correct API key for the new provider
							const newApiKey = process.env[getDefaultApiKeyEnvVar(newProvider as any)];
							if (!newApiKey) {
								throw new Error(
									`No API key found for ${newProvider}. Set ${getDefaultApiKeyEnvVar(newProvider as any)} environment variable.`,
								);
							}

							// Get provider-specific configuration in new structured format
							const newConfig: any = getProviderConfig(newProvider, {}, newApiKey);

							// Override with the new model
							newConfig.model = newModel;
							const newProviderZodSchema =
								CLIENT_CONFIG_SCHEMAS[newProvider as keyof typeof CLIENT_CONFIG_SCHEMAS];
							const baseZodSchema = CLIENT_CONFIG_SCHEMAS.base;

							// Add compatible provider-specific options
							if (newProviderZodSchema) {
								for (const [key, value] of Object.entries(currentOptions)) {
									if (key.startsWith(`${newProvider}:`)) {
										const optionKey = key.split(":")[1];
										if (optionKey && hasSchemaField(newProviderZodSchema, optionKey)) {
											newConfig[optionKey] = value;
										}
									}
								}
							}

							// Add compatible base options
							for (const [key, value] of Object.entries(currentOptions)) {
								if (hasSchemaField(baseZodSchema, key)) {
									newConfig[key] = value;
								}
							}

							// Create new client
							const newClient = createClientForModel(newModel, newConfig);

							// Update variables
							client = newClient;
							model = newModel;
							provider = newProvider;
							currentOptions = { ...newConfig, ...newConfig.defaults };

							// Update header
							header.setText(chalk.yellow(`Chat with ${provider}/${model} | Type 'exit' to quit`));

							// Update commands for new provider
							commands = buildCommands(provider);
							const newAutocompleteProvider = new CombinedAutocompleteProvider(commands);
							inputEditor.setAutocompleteProvider(newAutocompleteProvider);

							const confirmComponent = new TextComponent(
								chalk.green(`✓ Switched to model: ${provider}/${model}`),
								{
									bottom: 1,
									left: 1,
									right: 1,
								},
							);
							messagesContainer.addChild(confirmComponent);

							// Show any options that were removed due to incompatibility
							const removedOptions = Object.keys(currentOptions).filter(
								(key) =>
									!hasSchemaField(baseZodSchema, key) &&
									!hasSchemaField(newProviderZodSchema, key) &&
									(!key.startsWith(`${newProvider}:`) ||
										!hasSchemaField(newProviderZodSchema, key.split(":")[1] || "")),
							);

							if (removedOptions.length > 0) {
								const warningComponent = new TextComponent(
									chalk.yellow(`⚠️  Removed incompatible options: ${removedOptions.join(", ")}`),
									{ bottom: 1, left: 1, right: 1 },
								);
								messagesContainer.addChild(warningComponent);

								// Remove them from currentOptions
								for (const key of removedOptions) {
									delete currentOptions[key];
								}
							}
						} catch (error) {
							const errorComponent = new TextComponent(
								chalk.red(
									`❌ Failed to switch model: ${error instanceof Error ? error.message : String(error)}`,
								),
								{ bottom: 1, left: 1, right: 1 },
							);
							messagesContainer.addChild(errorComponent);
						}
					} else {
						// Invalid model
						const errorComponent = new TextComponent(chalk.red(`❌ Unknown model: ${newModel}`), {
							bottom: 1,
							left: 1,
							right: 1,
						});
						messagesContainer.addChild(errorComponent);
					}
				} else {
					// Show current model with full details
					const modelData = findModelData(model);
					if (modelData) {
						const fullInfo = formatModelInfo(model, modelData);
						const infoComponent = new TextComponent(chalk.cyan(`Current model:\n${fullInfo}`), {
							bottom: 1,
							left: 1,
							right: 1,
						});
						messagesContainer.addChild(infoComponent);
					} else {
						// Fallback if model data is not found
						const infoComponent = new TextComponent(chalk.cyan(`Current model: ${provider}/${model}`), {
							bottom: 1,
							left: 1,
							right: 1,
						});
						messagesContainer.addChild(infoComponent);
					}
				}
				break;

			case "usage":
				const usage = context.getTokenUsage();
				let usageText = chalk.cyan(
					`Total usage: ↑${usage.input} ↓${usage.output} tokens, $${totalCost.toFixed(6)}`,
				);

				// Add current options if any are set
				if (Object.keys(currentOptions).length > 0) {
					usageText += chalk.gray("\n\nActive options:");
					for (const [key, value] of Object.entries(currentOptions)) {
						usageText += chalk.gray(`\n  ${key}: ${JSON.stringify(value)}`);
					}
				}

				const usageComponent = new TextComponent(usageText, { bottom: 1, left: 1, right: 1 });
				messagesContainer.addChild(usageComponent);
				break;

			case "help":
				const helpText = commands.map((cmd) => `  /${cmd.name} - ${cmd.description}`).join("\n");
				const helpComponent = new TextComponent(chalk.cyan("Available commands:\n" + helpText), {
					bottom: 1,
					left: 1,
					right: 1,
				});
				messagesContainer.addChild(helpComponent);
				break;

			case "system":
				if (value) {
					// Set new system prompt
					const newSystemMessage = value.trim();
					context.setSystemMessage(newSystemMessage);

					const confirmComponent = new TextComponent(chalk.green(`✓ System prompt set`), {
						bottom: 1,
						left: 1,
						right: 1,
					});
					messagesContainer.addChild(confirmComponent);

					// Show the new system message
					const previewComponent = new TextComponent(chalk.gray(`Preview: ${newSystemMessage}`), {
						bottom: 1,
						left: 1,
						right: 1,
					});
					messagesContainer.addChild(previewComponent);
				} else {
					// Show current system prompt
					const currentSystemMessage = context.getSystemMessage();
					let systemText = chalk.cyan("Current system prompt:");
					if (currentSystemMessage) {
						systemText += chalk.gray(`\n\n${currentSystemMessage}`);
					} else {
						systemText += chalk.gray("\n\n(No system prompt set)");
					}
					systemText += chalk.yellow("\n\nTo set a new system prompt, use: /system <prompt>");

					const systemComponent = new TextComponent(systemText, {
						bottom: 1,
						left: 1,
						right: 1,
					});
					messagesContainer.addChild(systemComponent);
				}
				break;

			default:
				// Check if it's a provider-specific option or base option
				if (command.includes(":") || hasSchemaField(CLIENT_CONFIG_SCHEMAS.base, command)) {
					if (value) {
						// Parse and store the value
						let parsedValue: any = value;

						// Try to parse as boolean
						if (value.toLowerCase() === "true") {
							parsedValue = true;
						} else if (value.toLowerCase() === "false") {
							parsedValue = false;
						}
						// Try to parse as number
						else if (!isNaN(Number(value))) {
							parsedValue = Number(value);
						}

						currentOptions[command] = parsedValue;

						const confirmComponent = new TextComponent(chalk.green(`✓ Set ${command} to: ${parsedValue}`), {
							bottom: 1,
							left: 1,
							right: 1,
						});
						messagesContainer.addChild(confirmComponent);
					} else {
						// Show current value and prompt for new value
						const currentValue = currentOptions[command];
						const promptComponent = new TextComponent(
							chalk.yellow(
								`Current ${command}: ${currentValue ?? "not set"}\nUse /${command} <value> to set a new value`,
							),
							{ bottom: 1, left: 1, right: 1 },
						);
						messagesContainer.addChild(promptComponent);
					}
				} else {
					const errorComponent = new TextComponent(chalk.red(`Unknown command: /${command}`), {
						bottom: 1,
						left: 1,
						right: 1,
					});
					messagesContainer.addChild(errorComponent);
				}
		}
	}

	// Start the TUI
	tui.start();

	// Handle input simulation for testing
	if (simulateInput && Array.isArray(simulateInput)) {
		setTimeout(() => {
			let currentIndex = 0;

			const sendNextInput = () => {
				if (currentIndex >= simulateInput.length) {
					return;
				}

				const input = simulateInput[currentIndex];
				if (!input) return;

				// Convert special keywords to actual characters
				let actualInput = input;
				if (input === "TAB") actualInput = "\t";
				else if (input === "ENTER") actualInput = "\r";
				else if (input === "SPACE") actualInput = " ";
				else if (input === "ESC") actualInput = "\x1b";

				// Send input to the focused component
				if (inputEditor.handleInput) {
					inputEditor.handleInput(actualInput);
					tui.requestRender();
				}

				currentIndex++;

				// If this was ENTER, wait for processing to complete before sending next input
				if (input === "ENTER") {
					const waitForProcessing = () => {
						if (isProcessing) {
							setTimeout(waitForProcessing, 100);
						} else {
							// Wait a bit more after processing completes, then send next input
							setTimeout(sendNextInput, 500);
						}
					};
					waitForProcessing();
				} else {
					// For non-ENTER inputs, send next input after a short delay
					setTimeout(sendNextInput, 200);
				}
			};

			sendNextInput();
		}, 500); // Wait a bit for TUI to be ready
	}
}
