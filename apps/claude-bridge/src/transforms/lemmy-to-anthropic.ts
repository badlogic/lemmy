import type { AskResult } from "@mariozechner/lemmy";

/**
 * Create Anthropic-compatible SSE stream from lemmy AskResult
 */
export function createAnthropicSSE(askResult: AskResult, model: string): ReadableStream<Uint8Array> {
	const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

	return new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const writeEvent = (eventType: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			if (askResult.type !== "success") {
				const errorMessage = askResult.error?.message || JSON.stringify(askResult.error) || "Request failed";
				writeEvent("error", {
					type: "error",
					error: { type: "internal_server_error", message: errorMessage },
				});
				controller.close();
				return;
			}

			// Start message
			writeEvent("message_start", {
				type: "message_start",
				message: {
					id: messageId,
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: askResult.tokens?.input || 0, output_tokens: 0 },
				},
			});

			let blockIndex = 0;

			// Thinking
			if (askResult.message.thinking) {
				writeEvent("content_block_start", {
					type: "content_block_start",
					index: blockIndex,
					content_block: { type: "thinking" },
				});
				const thinking = askResult.message.thinking;
				for (let i = 0; i < thinking.length; i += 50) {
					writeEvent("content_block_delta", {
						type: "content_block_delta",
						index: blockIndex,
						delta: { type: "thinking_delta", thinking: thinking.slice(i, i + 50) },
					});
				}
				writeEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
				blockIndex++;
			}

			// Text content
			if (askResult.message.content) {
				writeEvent("content_block_start", {
					type: "content_block_start",
					index: blockIndex,
					content_block: { type: "text", text: "" },
				});
				const content = askResult.message.content;
				for (let i = 0; i < content.length; i += 50) {
					writeEvent("content_block_delta", {
						type: "content_block_delta",
						index: blockIndex,
						delta: { type: "text_delta", text: content.slice(i, i + 50) },
					});
				}
				writeEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
				blockIndex++;
			}

			// Tool calls
			if (askResult.message.toolCalls?.length) {
				for (const toolCall of askResult.message.toolCalls) {
					writeEvent("content_block_start", {
						type: "content_block_start",
						index: blockIndex,
						content_block: { type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.arguments },
					});
					const argsJson = JSON.stringify(toolCall.arguments);
					for (let i = 0; i < argsJson.length; i += 50) {
						writeEvent("content_block_delta", {
							type: "content_block_delta",
							index: blockIndex,
							delta: { type: "input_json_delta", partial_json: argsJson.slice(i, i + 50) },
						});
					}
					writeEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
					blockIndex++;
				}
			}

			// End message
			const stopReason = askResult.message.toolCalls?.length ? "tool_use" : "end_turn";
			writeEvent("message_delta", {
				type: "message_delta",
				delta: { stop_reason: stopReason, stop_sequence: null },
				usage: { output_tokens: askResult.tokens?.output || 0 },
			});
			writeEvent("message_stop", { type: "message_stop" });

			controller.close();
		},
	});
}
