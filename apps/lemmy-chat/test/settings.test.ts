import assert from "node:assert/strict";
import { test, mock } from "node:test";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

test("saved search off and a one-run override preserve the actual provider settings", async () => {
	// Node runs each test file in its own process. Import the app only after
	// isolating homedir, so no real defaults file or ambient credentials are used.
	const directory = await mkdtemp(join(os.tmpdir(), "lemmy-chat-settings-"));
	mock.method(os, "homedir", () => directory);
	syncBuiltinESMExports();
	const { createDefaultsCommand, createOneShotCommand } = await import("../src/commands.js");
	const { DEFAULTS_FILE, saveProviderConfig, loadDefaultsConfig } = await import("../src/defaults.js");
	assert.ok(DEFAULTS_FILE.startsWith(directory));
	const originalFetch = globalThis.fetch;
	let searches = 0;
	let modelRequests = 0;
	globalThis.fetch = async (url, init = {}) => {
		assert.equal(String(url), "https://search.parallel.ai/mcp");
		assert.equal(new Headers(init.headers).get("User-Agent"), "lemmy-chat/0.1.0");
		assert.equal(new Headers(init.headers).has("Authorization"), false);
		const rpc = JSON.parse(String(init.body)) as { id?: number; method: string };
		if (rpc.id === undefined) return new Response(null, { status: 202 });
		let result: unknown;
		if (rpc.method === "initialize") {
			result = {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			};
		} else if (rpc.method === "tools/list") {
			result = { tools: [{ name: "web_search", inputSchema: { type: "object" } }] };
		} else {
			assert.equal(rpc.method, "tools/call");
			searches++;
			result = { content: [{ type: "text", text: "Source https://example.com/news" }] };
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), {
			headers: { "Content-Type": "application/json" },
		});
	};
	const server = createServer(async (req, res) => {
		assert.equal(req.headers.authorization, "Bearer fixture-key");
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		const body = JSON.parse(raw) as {
			model: string;
			tools?: Array<{ function: { name: string } }>;
			messages: Array<{ role: string; content: string }>;
		};
		assert.equal(body.model, "gpt-4o");
		modelRequests++;
		if (modelRequests === 1) assert.equal(body.tools, undefined);
		else assert.ok(body.tools?.some((tool) => tool.function.name === "WebSearch"));
		if (modelRequests === 3) assert.match(body.messages.at(-1)?.content ?? "", /https:\/\/example.com\/news/);
		const delta =
			modelRequests === 2
				? {
						tool_calls: [
							{
								index: 0,
								id: "saved-call",
								type: "function",
								function: {
									name: "WebSearch",
									arguments: JSON.stringify({
										objective: "Find news",
										search_queries: ["current news example"],
									}),
								},
							},
						],
					}
				: { content: "A sourced answer" };
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const [d, finish] of [
			[delta, null],
			[{}, modelRequests === 2 ? "tool_calls" : "stop"],
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
		saveProviderConfig("openai", {
			model: "gpt-4o",
			apiKey: "fixture-key",
			baseURL: `http://127.0.0.1:${address.port}/v1`,
		});
		const before = loadDefaultsConfig();
		await createDefaultsCommand().parseAsync(["node", "lemmy-chat", "--search", "off"]);
		const saved = await readFile(DEFAULTS_FILE, "utf8");
		assert.equal(loadDefaultsConfig().search, "off");
		assert.deepEqual(loadDefaultsConfig().providers, before.providers);
		assert.equal(loadDefaultsConfig().defaultProvider, "openai");
		await createOneShotCommand("openai").parseAsync(["node", "lemmy-chat", "Use saved settings"]);
		assert.equal(searches, 0);
		assert.equal(modelRequests, 1);
		await createOneShotCommand("openai").parseAsync(["node", "lemmy-chat", "--search", "parallel", "Find news"]);
		assert.equal(searches, 1);
		assert.equal(modelRequests, 3);
		assert.equal(await readFile(DEFAULTS_FILE, "utf8"), saved);
	} finally {
		server.close();
		server.closeAllConnections();
		globalThis.fetch = originalFetch;
		mock.restoreAll();
		syncBuiltinESMExports();
		await rm(directory, { recursive: true, force: true });
	}
});
