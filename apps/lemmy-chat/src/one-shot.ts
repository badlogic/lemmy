import { SearchConversation, resolveSearchMode, type SearchMode } from "./search.js";
import { loadDefaultsConfig } from "./defaults.js";
import { Attachment, createClientForModel, ProviderConfigMap } from "@mariozechner/lemmy";

export async function runOneShot(
	provider: string,
	message: string,
	config: ProviderConfigMap[keyof ProviderConfigMap],
	attachments: Attachment[] = [],
	searchMode: SearchMode = resolveSearchMode(undefined, loadDefaultsConfig().search),
): Promise<void> {
	// Config is already validated and built by the caller

	console.log(`🤖 Using ${provider}/${config.model}`);
	if (config.apiKey) {
		console.log(`🔑 API key: ${config.apiKey.slice(0, 8)}...`);
	}
	if (attachments.length > 0) {
		console.log(`🖼️  Attached ${attachments.length} image(s)`);
	}

	// Create client and context
	const client = createClientForModel(config.model, config);
	const context = new SearchConversation(searchMode);

	// Set up streaming callbacks
	let hasThinking = false;
	let isFirstNormalChunk = true;

	const onThinkingChunk = (chunk: string) => {
		hasThinking = true;
		// Output thinking in gray
		process.stdout.write(`\x1b[90m${chunk}\x1b[0m`);
	};

	const onChunk = (chunk: string) => {
		// Add separator before first normal output if there was thinking
		if (hasThinking && isFirstNormalChunk) {
			process.stdout.write("\n\n");
			isFirstNormalChunk = false;
		}
		process.stdout.write(chunk);
	};

	// Make request
	console.log(`\n💬 You: ${message}`);
	console.log(`\n🤖 ${provider}:`);

	// Use AskInput format if we have attachments, otherwise use simple string
	const askInput = attachments.length > 0 ? { content: message, attachments } : message;

	const result = await context.ask(client, askInput, {
		...config.defaults,
		context,
		onThinkingChunk,
		onChunk,
	});

	if (result.type === "success") {
		// If we weren't streaming, show the content (this shouldn't happen with our setup)
		if (!result.message.content && !hasThinking) {
			console.log(result.message.content || "");
		}

		console.log(`\n\n📊 Tokens: ${result.tokens.input} in, ${result.tokens.output} out`);
		console.log(`💰 Cost: $${result.cost.toFixed(6)}`);

		// Check if thinking was available but not shown
		if (result.message.thinking && !hasThinking) {
			console.log(`💭 Thinking was available but not streamed. Use --thinkingEnabled to see it.`);
		}
	} else {
		throw new Error(result.error.message);
	}
}
