/** Optional network smoke: a scripted model drives the real conversation/MCP caller. */
import assert from "node:assert/strict";
import type { AskInput, AskResult, ChatClient, ToolCall } from "@mariozechner/lemmy";
import { SearchConversation, SEARCH_ENDPOINT, SEARCH_USER_AGENT } from "../src/search.js";

const observed: Array<{ method: string; status: number; body: string }> = [];
const actualFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	assert.equal(String(url), SEARCH_ENDPOINT);
	assert.equal(new Headers(init?.headers).get("User-Agent"), SEARCH_USER_AGENT);
	assert.equal(new Headers(init?.headers).has("Authorization"), false);
	const response = await actualFetch(url, init);
	const request = init?.body ? (JSON.parse(String(init.body)) as { method: string }) : { method: "GET" };
	observed.push({ method: request.method, status: response.status, body: await response.clone().text() });
	return response;
};

let turn = 0;
const consumed: string[] = [];
const client: ChatClient = {
	getModel: () => "gpt-4o",
	getProvider: () => "openai",
	ask: async (input: string | AskInput): Promise<AskResult> => {
		if (typeof input !== "string") {
			const text = input.toolResults?.map((result) => result.content).join("\n") ?? "";
			consumed.push(text);
			if (text.startsWith("Error:")) throw new Error(text);
			assert.match(text, /https?:\/\//);
		}
		const calls: ToolCall[][] = [
			[
				{
					id: "live-search",
					name: "WebSearch",
					arguments: {
						objective: "Find the official Model Context Protocol documentation",
						search_queries: ["official Model Context Protocol documentation"],
					},
				},
			],
			[
				{
					id: "live-fetch",
					name: "WebFetch",
					arguments: {
						urls: ["https://modelcontextprotocol.io/introduction"],
						objective: "What is the Model Context Protocol?",
					},
				},
			],
		];
		const toolCalls = calls[turn++];
		return {
			type: "success",
			stopReason: toolCalls ? "tool_call" : "complete",
			message: {
				role: "assistant",
				timestamp: new Date(),
				provider: "openai",
				model: "gpt-4o",
				took: 0,
				usage: { input: 0, output: 0 },
				...(toolCalls ? { toolCalls } : { content: "Live sources consumed by scripted model." }),
			},
			tokens: { input: 0, output: 0 },
			cost: 0,
		};
	},
};
try {
	await new SearchConversation().ask(client, "Find and read the official MCP introduction");
	console.log(JSON.stringify({ status: "passed", model: "scripted", observed, consumed }, null, 2));
} catch (error) {
	console.log(
		JSON.stringify({ status: "failed", model: "scripted", error: String(error), observed, consumed }, null, 2),
	);
	process.exitCode = 1;
} finally {
	globalThis.fetch = actualFetch;
}
