import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	Context,
	findModelData,
	toAskInput,
	validateAndExecute,
	type AskInput,
	type AskOptions,
	type AskResult,
	type ChatClient,
	type ExecuteToolResult,
	type StreamingCallbacks,
	type ToolCall,
	type ToolDefinition,
} from "@mariozechner/lemmy";
import { z } from "zod";

export type SearchMode = "parallel" | "off";

export function resolveSearchMode(override: unknown, saved: unknown = undefined): SearchMode {
	const mode = override === undefined ? (saved === undefined ? "parallel" : saved) : override;
	if (mode !== "parallel" && mode !== "off") {
		throw new Error("Search must be 'parallel' or 'off'");
	}
	return mode;
}

export const SEARCH_ENDPOINT = "https://search.parallel.ai/mcp";
export const SEARCH_USER_AGENT = "lemmy-chat/0.1.0";

const searchSchema = z.object({
	objective: z.string().min(1).describe("The specific information to find on the web"),
	search_queries: z.array(z.string().min(1)).min(1).max(5).describe("Short, related search queries"),
});
const fetchSchema = z.object({
	urls: z
		.array(
			z
				.string()
				.url()
				.refine((url) => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS URL"),
		)
		.min(1)
		.max(5),
	objective: z.string().max(200).optional().describe("What to extract from the pages"),
});

/** One bounded MCP connection per call; the conversation ID is supplied separately. */
async function callParallel(
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	timeout: number,
): Promise<string> {
	signal?.throwIfAborted();
	const transport = new StreamableHTTPClientTransport(new URL(SEARCH_ENDPOINT), {
		requestInit: { headers: { "User-Agent": SEARCH_USER_AGENT } },
	});
	const client = new Client({ name: "lemmy-chat", version: "0.1.0" }, { capabilities: {} });
	let timedOut = false;
	const cancel = () => {
		void transport.close();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		cancel();
	}, timeout);
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		// SDK 1.12's getter permits undefined while Transport's optional field does not.
		await client.connect(transport as Transport, { timeout });
		const available = await client.listTools(undefined, { timeout });
		if (!available.tools.some((tool) => tool.name === name)) {
			throw new Error(`Parallel does not advertise ${name}`);
		}
		const result = CallToolResultSchema.parse(
			await client.callTool({ name, arguments: args }, undefined, { timeout }),
		);
		const text = result.content.map((item) => (item.type === "text" ? item.text : JSON.stringify(item))).join("\n\n");
		if (result.isError) throw new Error(text || "Parallel returned a tool error");
		if (!text) throw new Error("Parallel returned no content");
		return text;
	} catch (error) {
		if (signal?.aborted) throw new Error("Web search cancelled");
		if (timedOut) throw new Error("Web search timed out");
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		await client.close();
	}
}

type SearchAskOptions = AskOptions & StreamingCallbacks & { toolChoice?: string | undefined };

/** App-owned conversation, including transient tools and their anonymous identity. */
export class SearchConversation extends Context {
	private sessionId = randomUUID();
	private searchTools: ToolDefinition[] = [];
	private asking = false;

	constructor(
		private searchMode: SearchMode = "parallel",
		private timeout = 15000,
	) {
		super();
	}

	override clear(): void {
		if (this.asking) throw new Error("Wait for the current turn before clearing the conversation");
		super.clear();
		this.sessionId = randomUUID();
	}

	override listTools(): ToolDefinition[] {
		return [...super.listTools(), ...this.searchTools.filter((tool) => !super.getTool(tool.name))];
	}

	override async executeTool(call: ToolCall): Promise<ExecuteToolResult> {
		// Explicitly registered tools always win over the built-in search tools.
		const tool = !super.getTool(call.name) && this.searchTools.find((candidate) => candidate.name === call.name);
		return tool ? validateAndExecute(tool, call) : super.executeTool(call);
	}

	async ask(client: ChatClient, input: string | AskInput, options: SearchAskOptions = {}): Promise<AskResult> {
		if (this.asking) throw new Error("A conversation can only process one turn at a time");
		this.asking = true;
		const model = client.getModel();
		const enabled =
			this.searchMode !== "off" && options.toolChoice !== "none" && findModelData(model)?.supportsTools !== false;
		const sessionId = this.sessionId;
		if (enabled) {
			const call = (name: string, args: Record<string, unknown>) =>
				callParallel(
					name,
					{ ...args, session_id: sessionId, model_name: model },
					options.abortSignal,
					this.timeout,
				);
			this.searchTools = [
				{
					name: "WebSearch",
					description: "Search the web for current information and source URLs using Parallel.",
					schema: searchSchema,
					execute: (args) => call("web_search", searchSchema.parse(args)),
				},
				{
					name: "WebFetch",
					description: "Read public web pages. Prefer search excerpts when they already answer the question.",
					schema: fetchSchema,
					execute: (args) => call("web_fetch", fetchSchema.parse(args)),
				},
			];
		}
		try {
			let next = input;
			let inputTokens = 0;
			let outputTokens = 0;
			let cost = 0;
			for (let round = 0; round < 8; round++) {
				options.abortSignal?.throwIfAborted();
				const result = await client.ask(next, { ...options, context: this });
				if (result.type !== "success") return result;
				inputTokens += result.tokens.input;
				outputTokens += result.tokens.output;
				cost += result.cost;
				if (result.stopReason !== "tool_call" || !result.message.toolCalls?.length) {
					return { ...result, tokens: { input: inputTokens, output: outputTokens }, cost };
				}
				const results = await this.executeTools(result.message.toolCalls);
				next = toAskInput(results);
				if (options.abortSignal?.aborted || round === 7) {
					// Keep every tool call paired even when this turn stops before another model request.
					this.addMessage({ role: "user", timestamp: new Date(), ...next });
					options.abortSignal?.throwIfAborted();
				}
			}
			throw new Error("Stopped after eight tool rounds; narrow the question and try again");
		} finally {
			this.searchTools = [];
			this.asking = false;
		}
	}
}
