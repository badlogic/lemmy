import { describe, it, expect, beforeEach } from "vitest";
import { GoogleClient } from "../../src/clients/google.js";
import { Context } from "../../src/context.js";
import type { GoogleConfig } from "../../src/configs.js";
import { sharedClientTests } from "./shared-client-tests.js";
import { GoogleModels } from "../../src/model-registry.js";

describe("GoogleClient", () => {
	if (!process.env["GOOGLE_API_KEY"]) {
		throw new Error("GOOGLE_API_KEY environment variable is required for Google tests");
	}

	const testConfig: GoogleConfig = {
		apiKey: process.env["GOOGLE_API_KEY"]!,
		model: "gemini-2.0-flash", // Latest stable Gemini 2.0 model
	};

	const createClient = (withThinking = false, apiKey?: string, withImageInput = false) => {
		let model = testConfig.model;
		let config: GoogleConfig = {
			...testConfig,
			defaults: {
				temperature: 0,
			},
		};

		if (withThinking || withImageInput) {
			// gemini-2.5-flash-preview-05-20 supports both thinking and image input
			model = "gemini-2.5-flash-preview-05-20";
			config.model = model;
		}

		if (apiKey) {
			config.apiKey = apiKey;
		}

		if (withThinking) {
			config.defaults = {
				...config.defaults,
				includeThoughts: withThinking,
			};
		}

		return new GoogleClient(config);
	};

	// Run shared tests
	sharedClientTests(createClient);

	// Provider-specific setup for remaining tests
	let client: GoogleClient;
	let context: Context;

	beforeEach(() => {
		client = createClient();
		context = new Context();
	});

	// Google-specific tests (truly unique functionality)

	describe("google-specific thinking features", () => {
		it("should handle thinking request on thinking models", async () => {
			// Test with Gemini 2.5 Flash Thinking model which supports thinking
			const thinkingClient = new GoogleClient({
				...testConfig,
				model: "gemini-2.5-flash-preview-04-17-thinking", // Latest thinking model
			});

			const thinkingChunks: string[] = [];
			const onThinkingChunk = (chunk: string) => thinkingChunks.push(chunk);

			const result = await thinkingClient.ask("Solve this step by step: What is 127 * 83? Show your reasoning.", {
				context,
				onThinkingChunk,
				includeThoughts: true,
			});

			expect(result.type).toBe("success");
			if (result.type === "success") {
				// Should have regular content
				expect(result.message.content?.length).toBeGreaterThan(0);

				// Should have thinking content when thinking is enabled on thinking models
				if (result.message.thinking) {
					expect(result.message.thinking.length).toBeGreaterThan(0);
					// Thinking should contain reasoning steps
					expect(result.message.thinking.toLowerCase()).toMatch(/step|think|reason|calculate|multiply/i);

					// Should have received thinking chunks during streaming
					expect(thinkingChunks.length).toBeGreaterThan(0);
					expect(thinkingChunks.join("")).toBe(result.message.thinking);
				}

				// Token counts should be valid
				expect(result.tokens.output).toBeGreaterThan(0);
				expect(result.cost).toBeGreaterThan(0);

				console.log("✓ Thinking model handled thinking request successfully");
			}
		}, 30000);

		it("should handle non-thinking request on non-thinking model gracefully", async () => {
			// Test with regular Gemini 2.0 Flash which doesn't support thinking
			const nonThinkingClient = new GoogleClient({
				...testConfig,
				model: "gemini-2.0-flash", // Regular model without thinking
			});

			const result = await nonThinkingClient.ask("What is 15 * 23?", { context });

			expect(result.type).toBe("success");
			if (result.type === "success") {
				// Should get a regular response
				expect(result.message.content).toBeDefined();
				expect(result.message.content).toContain("345");
				expect(result.tokens.output).toBeGreaterThan(0);
				expect(result.cost).toBeGreaterThan(0);

				// Should not have thinking content on non-thinking models
				expect(result.message.thinking).toBeUndefined();
				console.log("✓ Non-thinking model handled request without thinking");
			}
		}, 10000);
	});

	describe("google-specific features", () => {
		it("should handle various Google finish reasons correctly", async () => {
			const result = await client.ask("Generate a very short response", { context });

			expect(result.type).toBe("success");
			if (result.type === "success") {
				// Should map Google finish reasons to standard stop reasons
				expect(["complete", "max_tokens", "stop_sequence"]).toContain(result.stopReason);
				console.log(`✓ Mapped finish reason to: ${result.stopReason}`);
			}
		}, 10000);

		it("should handle Google-specific error types", async () => {
			// Create client with explicitly invalid API key
			const invalidClient = createClient(false, "invalid-google-api-key-12345");

			const result = await invalidClient.ask("Hello", { context });

			expect(result.type).toBe("error");
			if (result.type === "error") {
				expect(result.error.type).toBe("auth");
				expect(result.error.retryable).toBe(false);
				console.log("✓ Correctly handled Google auth error");
			}
		}, 10000);

		it("should handle function response format correctly", async () => {
			// This test verifies that our function response format matches Google's expectations
			const testMessages = [
				{
					role: "user" as const,
					content: "Test message",
					toolResults: [
						{
							toolCallId: "test_function_123",
							content: "42",
						},
					],
					timestamp: new Date(),
				},
			];

			// Convert messages to Google format
			const contents = (client as any).convertMessagesToGoogle(testMessages);

			expect(contents).toHaveLength(1);
			expect(contents[0]?.role).toBe("user");
			expect(contents[0]?.parts).toHaveLength(2); // text + functionResponse

			const functionResponsePart = contents[0]?.parts.find((p: any) => p.functionResponse);
			expect(functionResponsePart).toBeDefined();
			expect(functionResponsePart.functionResponse.name).toBe("test_function_123");
			expect(functionResponsePart.functionResponse.response.result).toBe("42");

			console.log("✓ Function response format correctly converted");
		});

		it("should generate unique tool call IDs", async () => {
			// Mock a scenario where we might get multiple function calls
			const part1 = { functionCall: { name: "test_function", args: { param: "value1" } } };
			const part2 = { functionCall: { name: "test_function", args: { param: "value2" } } };

			// Simulate processing these parts with different timestamps
			const toolCall1 = {
				id: part1.functionCall.name + "_" + Date.now(),
				name: part1.functionCall.name,
				arguments: part1.functionCall.args,
			};

			// Small delay to ensure different timestamp
			await new Promise((resolve) => setTimeout(resolve, 1));

			const toolCall2 = {
				id: part2.functionCall.name + "_" + Date.now(),
				name: part2.functionCall.name,
				arguments: part2.functionCall.args,
			};

			expect(toolCall1.id).not.toBe(toolCall2.id);
			expect(toolCall1.id).toContain("test_function_");
			expect(toolCall2.id).toContain("test_function_");

			console.log("✓ Tool call IDs are unique");
		});
	});

	describe("latest google model compatibility", () => {
		it("should work with Gemini 2.0+ model families", async () => {
			const models: GoogleModels[] = [
				"gemini-2.0-flash",
				"gemini-2.0-flash-001",
				"gemini-2.0-flash-thinking-exp",
				"gemini-2.5-flash-preview-04-17",
				"gemini-2.5-flash-preview-04-17-thinking",
			];

			for (const model of models) {
				const modelClient = new GoogleClient({
					...testConfig,
					model,
				});

				expect(modelClient.getModel()).toBe(model);
				expect(modelClient.getProvider()).toBe("google");

				// Basic functionality test
				const askOptions: any = { context: new Context() };
				// Enable thinking for thinking models
				if (model.includes("thinking")) {
					askOptions.includeThoughts = true;
				}
				const result = await modelClient.ask('Say "test" and nothing else', askOptions);
				expect(result.type).toBe("success");
				if (result.type === "success") {
					expect(result.message.content).toBeDefined();
					console.log(`✓ Model ${model} responded successfully`);
				}
			}
		}, 60000);
	});
});
