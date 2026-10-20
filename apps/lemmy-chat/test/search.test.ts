import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { type AskInput, type AskResult, type ChatClient, type ToolCall } from "@mariozechner/lemmy";
import { z } from "zod";
import { SearchConversation, resolveSearchMode, SEARCH_ENDPOINT, SEARCH_USER_AGENT } from "../src/search.js";
import { createOneShotCommand } from "../src/commands.js";

// The model is scripted; the production conversation, dispatcher, SDK transport,
// request construction, and result consumption are exercised without credentials.
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Rpc = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
type Seen = { url: string; headers: Headers; rpc: Rpc };
function mcpFixture(handle?: (rpc: Rpc, init: RequestInit) => Promise<Response | undefined>) {
	const seen: Seen[] = [];
	globalThis.fetch = async (url, init = {}) => {
		assert.equal(String(url), SEARCH_ENDPOINT);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("User-Agent"), SEARCH_USER_AGENT);
		assert.equal(headers.has("Authorization"), false);
		const rpc = JSON.parse(String(init.body)) as Rpc;
		seen.push({ url: String(url), headers, rpc });
		const special = await handle?.(rpc, init);
		if (special) return special;
		if (rpc.id === undefined) return new Response(null, { status: 202 });
		let result: unknown;
		if (rpc.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			};
		} else if (rpc.method === "tools/list") {
			result = { tools: ["web_search", "web_fetch"].map((name) => ({ name, inputSchema: { type: "object" } })) };
		} else {
			assert.equal(rpc.method, "tools/call");
			result = {
				content: [
					{ type: "text", text: "Source https://example.com/news" },
					{ type: "text", text: "Current information." },
				],
			};
		}
		return reply(rpc, result);
	};
	return seen;
}
function reply(rpc: Rpc, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), {
		headers: { "Content-Type": "application/json" },
	});
}
const search: ToolCall = {
	id: "search-1",
	name: "WebSearch",
	arguments: { objective: "Find current news", search_queries: ["current news example"] },
};
const fetchPage: ToolCall = { id: "fetch-1", name: "WebFetch", arguments: { urls: ["https://example.com/news"] } };
function answer(calls?: ToolCall[]): AskResult {
	return {
		type: "success",
		stopReason: calls ? "tool_call" : "complete",
		message: {
			role: "assistant",
			timestamp: new Date(),
			provider: "openai",
			model: "gpt-4o",
			took: 1,
			content: calls ? "" : "A sourced answer",
			usage: { input: 1, output: 2 },
			...(calls ? { toolCalls: calls } : {}),
		},
		tokens: { input: 1, output: 2 },
		cost: 0.01,
	};
}
function scripted(steps: Array<ToolCall[] | ((input: string | AskInput) => void)>, model = "gpt-4o"): ChatClient {
	return {
		getModel: () => model,
		getProvider: () => "openai",
		ask: async (input, options) => {
			const step = steps.shift();
			assert.notEqual(step, undefined, "Unexpected model request");
			options?.context?.addMessage({
				role: "user",
				timestamp: new Date(),
				...(typeof input === "string" ? { content: input } : input),
			});
			if (typeof step === "function") step(input);
			const result = answer(Array.isArray(step) ? step : undefined);
			if (result.type === "success") options?.context?.addMessage(result.message);
			return result;
		},
	};
}
function content(input: string | AskInput): string {
	assert.equal(typeof input, "object");
	return (input as AskInput).toolResults?.[0]?.content ?? "";
}
const calls = (seen: Seen[]) => seen.filter((item) => item.rpc.method === "tools/call");

test("unconfigured search, saved off, explicit overrides, invalid choices", () => {
	assert.equal(resolveSearchMode(undefined), "parallel");
	assert.equal(resolveSearchMode(undefined, "off"), "off");
	assert.equal(resolveSearchMode("parallel", "off"), "parallel");
	assert.equal(resolveSearchMode("off", "parallel"), "off");
	assert.throws(() => resolveSearchMode("unknown"));
	assert.throws(() => resolveSearchMode(undefined, null));
});

test("search, fetch and follow-up use one conversation ID and feed complete results to the model", async () => {
	const seen = mcpFixture();
	const conversation = new SearchConversation();
	const result = await conversation.ask(
		scripted([
			[search],
			[fetchPage],
			(input) => {
				assert.match(content(input), /https:\/\/example.com\/news/);
				assert.match(content(input), /Current information/);
			},
		]),
		"Research current news",
	);
	assert.equal(result.type, "success");
	if (result.type === "success") {
		assert.deepEqual(result.tokens, { input: 3, output: 6 });
		assert.equal(result.cost, 0.03);
	}
	await conversation.ask(scripted([[search], () => {}]), "Follow up");
	assert.equal(calls(seen).length, 3);
	const ids = calls(seen).map((item) => item.rpc.params?.arguments?.["session_id"]);
	assert.equal(new Set(ids).size, 1);
	assert.match(String(ids[0]), /^[a-f0-9-]{36}$/);
	for (const item of calls(seen)) assert.equal(item.rpc.params?.arguments?.["model_name"], "gpt-4o");
	assert.deepEqual(calls(seen)[0]?.rpc.params?.arguments?.["search_queries"], search.arguments["search_queries"]);
	assert.deepEqual(calls(seen)[1]?.rpc.params?.arguments?.["urls"], ["https://example.com/news"]);
	assert.ok(seen.some((item) => item.rpc.method === "tools/list"));
});

test("interleaved conversations isolate IDs; clear starts a new identity", async () => {
	const seen = mcpFixture();
	const a = new SearchConversation();
	const b = new SearchConversation();
	const sharedClient = scripted([[search], [fetchPage], () => {}, () => {}]);
	await Promise.all([a.ask(sharedClient, "a"), b.ask(sharedClient, "b")]);
	const first = calls(seen).find((item) => item.rpc.params?.name === "web_search")?.rpc.params?.arguments?.[
		"session_id"
	];
	const second = calls(seen).find((item) => item.rpc.params?.name === "web_fetch")?.rpc.params?.arguments?.[
		"session_id"
	];
	assert.notEqual(first, second);
	await a.ask(scripted([[fetchPage], () => {}]), "follow up a");
	assert.equal(calls(seen).at(-1)?.rpc.params?.arguments?.["session_id"], first);
	a.clear();
	assert.equal(a.getMessages().length, 0);
	await a.ask(scripted([[search], () => {}]), "new a");
	assert.notEqual(calls(seen).at(-1)?.rpc.params?.arguments?.["session_id"], first);
});

test("clear cannot mix an active turn into a new conversation", async () => {
	let release = () => {};
	let started = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const seen = mcpFixture(async (rpc) => {
		if (rpc.method === "tools/call") {
			started();
			await gate;
		}
		return undefined;
	});
	const conversation = new SearchConversation();
	const active = conversation.ask(scripted([[search], [fetchPage], () => {}]), "Research");
	await entered;
	assert.throws(() => conversation.clear(), /current turn/);
	release();
	await active;
	const oldId = calls(seen)[0]?.rpc.params?.arguments?.["session_id"];
	assert.equal(calls(seen)[1]?.rpc.params?.arguments?.["session_id"], oldId);
	conversation.clear();
	await conversation.ask(scripted([[search], () => {}]), "New research");
	assert.notEqual(calls(seen).at(-1)?.rpc.params?.arguments?.["session_id"], oldId);
});

test("off, toolChoice none and a non-tool model never make search requests", async () => {
	const seen = mcpFixture();
	for (const [conversation, model, options] of [
		[new SearchConversation("off"), "gpt-4o", {}],
		[new SearchConversation(), "gpt-4o", { toolChoice: "none" }],
		[new SearchConversation(), "o1-mini", {}],
	] as const) {
		const client = scripted([() => {}], model);
		const ask = client.ask;
		client.ask = async (input, opts) => {
			assert.deepEqual(opts?.context?.listTools(), []);
			return ask(input, opts);
		};
		await conversation.ask(client, "No web access", options);
	}
	assert.equal(seen.length, 0);
});

test("explicit tools are preserved and invalid URLs fail before a network request", async () => {
	const seen = mcpFixture();
	const conversation = new SearchConversation();
	conversation.addTool({
		name: "WebSearch",
		description: "User's configured search",
		schema: z.object({ objective: z.string(), search_queries: z.array(z.string()) }),
		execute: async () => "custom result",
	});
	await conversation.ask(
		scripted([
			[search],
			(input) => {
				assert.equal(content(input), "custom result");
			},
		]),
		"Use saved tool",
	);
	assert.equal(seen.length, 0);
	await conversation.ask(
		scripted([
			[{ ...fetchPage, arguments: { urls: ["file:///etc/passwd"] } }],
			(input) => {
				assert.match(content(input), /Invalid arguments/);
			},
		]),
		"Invalid URL",
	);
	assert.equal(seen.length, 0);
});

test("tool errors and retry keep the same identity without falling back", async () => {
	let count = 0;
	const seen = mcpFixture(async (rpc) => {
		if (rpc.method === "tools/call" && count++ === 0)
			return reply(rpc, { isError: true, content: [{ type: "text", text: "Anonymous quota exceeded" }] });
		return undefined;
	});
	const client = scripted([[search], [search], () => {}]);
	const ask = client.ask;
	let n = 0;
	client.ask = async (input, opts) => {
		if (n++ === 1) assert.match(content(input), /Anonymous quota exceeded/);
		return ask(input, opts);
	};
	await new SearchConversation().ask(client, "Retry");
	assert.equal(calls(seen).length, 2);
	assert.equal(
		calls(seen)[0]?.rpc.params?.arguments?.["session_id"],
		calls(seen)[1]?.rpc.params?.arguments?.["session_id"],
	);
});

test("timeouts abort the HTTP request and become consumed tool errors", async () => {
	mcpFixture(async (rpc, init) => {
		if (rpc.method !== "tools/call") return undefined;
		return new Promise((_, reject) => {
			init.signal?.addEventListener("abort", () => reject(new Error("HTTP aborted")), { once: true });
		});
	});
	await new SearchConversation("parallel", 25).ask(
		scripted([
			[search],
			(input) => {
				assert.match(content(input), /timed out/);
			},
		]),
		"Timeout",
	);
});

test("cancellation closes HTTP and stops model follow-up while retaining paired tool results", async () => {
	const controller = new AbortController();
	mcpFixture(async (rpc, init) => {
		if (rpc.method !== "tools/call") return undefined;
		return new Promise((_, reject) => {
			init.signal?.addEventListener("abort", () => reject(new Error("HTTP aborted")), { once: true });
			setTimeout(() => controller.abort(), 1);
		});
	});
	const conversation = new SearchConversation();
	await assert.rejects(conversation.ask(scripted([[search]]), "Cancel", { abortSignal: controller.signal }), /abort/i);
	assert.ok(conversation.getLastMessage()?.role === "user");
	assert.match(JSON.stringify(conversation.getLastMessage()), /cancelled/);
	await assert.rejects(
		conversation.ask(scripted([]), "Already cancelled", { abortSignal: controller.signal }),
		/abort/i,
	);
});

test("malformed MCP data becomes a model-visible error", async () => {
	mcpFixture(async (rpc) => (rpc.method === "tools/call" ? reply(rpc, { content: "bad" }) : undefined));
	await new SearchConversation().ask(
		scripted([
			[search],
			(input) => {
				assert.match(content(input), /^Error:/);
			},
		]),
		"Bad response",
	);
});

test("the tool-round limit stops a turn and leaves complete conversation history", async () => {
	const seen = mcpFixture();
	const conversation = new SearchConversation();
	await assert.rejects(
		conversation.ask(scripted(Array.from({ length: 8 }, () => [search])), "Keep searching"),
		/eight tool rounds/,
	);
	assert.equal(calls(seen).length, 8);
	assert.match(JSON.stringify(conversation.getLastMessage()), /toolResults/);
	await conversation.ask(scripted([() => {}]), "Try again");
});

test("production one-shot uses the OpenAI client, tool dispatcher and final answer", async () => {
	const seen = mcpFixture();
	let requests = 0;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		const body = JSON.parse(raw) as {
			tools?: Array<{ function: { name: string } }>;
			messages: Array<{ role: string; content: string }>;
		};
		if (requests++ === 0) {
			assert.ok(body.tools?.some((tool) => tool.function.name === "WebSearch"));
		} else if (requests === 2) {
			assert.ok(
				body.messages.some(
					(message) => message.role === "tool" && message.content.includes("https://example.com/news"),
				),
			);
		} else {
			assert.equal(body.tools, undefined);
		}
		const delta =
			requests === 1
				? {
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "WebSearch", arguments: JSON.stringify(search.arguments) },
							},
						],
					}
				: { content: "A sourced answer" };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const [d, finish] of [
			[delta, null],
			[{}, requests === 1 ? "tool_calls" : "stop"],
		]) {
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`,
			);
		}
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await createOneShotCommand("openai").parseAsync([
			"node",
			"lemmy-chat",
			"-m",
			"gpt-4o",
			"--apiKey",
			"fixture-key",
			"--baseURL",
			`http://127.0.0.1:${address.port}/v1`,
			"Find news",
		]);
		assert.equal(requests, 2);
		assert.equal(calls(seen).length, 1);
		await createOneShotCommand("openai").parseAsync([
			"node",
			"lemmy-chat",
			"-m",
			"gpt-4o",
			"--apiKey",
			"fixture-key",
			"--baseURL",
			`http://127.0.0.1:${address.port}/v1`,
			"--search",
			"off",
			"Answer without web access",
		]);
		assert.equal(requests, 3);
		assert.equal(calls(seen).length, 1);
	} finally {
		server.close();
		server.closeAllConnections();
	}
});
