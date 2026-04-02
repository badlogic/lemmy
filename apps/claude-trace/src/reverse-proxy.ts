import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { RawPair, SSEEvent } from "./types";
import { HTMLGenerator } from "./html-generator";
import { SharedConversationProcessor } from "./shared-conversation-processor";

export interface ReverseProxyConfig {
	port?: number;
	logDirectory?: string;
	logBaseName?: string;
	includeAllRequests?: boolean;
	openBrowser?: boolean;
	logSensitiveHeaders?: boolean;
}

export class ReverseProxyServer {
	private server: http.Server | null = null;
	private config: Required<ReverseProxyConfig>;
	private pairs: RawPair[] = [];
	private logFile: string;
	private htmlFile: string;
	private htmlGenerator: HTMLGenerator;
	private targetHost = "api.anthropic.com";
	private targetPort = 443;

	constructor(config: ReverseProxyConfig = {}) {
		this.config = {
			port: config.port || 0, // 0 = auto-assign
			logDirectory: config.logDirectory || ".claude-trace",
			logBaseName: config.logBaseName || "",
			includeAllRequests: config.includeAllRequests || false,
			openBrowser: config.openBrowser || false,
			logSensitiveHeaders: config.logSensitiveHeaders || false,
		};

		// Create log directory if needed
		if (!fs.existsSync(this.config.logDirectory)) {
			fs.mkdirSync(this.config.logDirectory, { recursive: true });
		}

		// Generate filenames
		const fileBaseName =
			this.config.logBaseName ||
			`log-${new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -5)}`;

		this.logFile = path.join(this.config.logDirectory, `${fileBaseName}.jsonl`);
		this.htmlFile = path.join(this.config.logDirectory, `${fileBaseName}.html`);

		// Clear log file
		fs.writeFileSync(this.logFile, "");

		this.htmlGenerator = new HTMLGenerator();
	}

	private processHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
		const result: Record<string, string> = {};
		const sensitiveKeys = ["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"];

		for (const [key, value] of Object.entries(headers)) {
			if (value === undefined) continue;
			const strValue = Array.isArray(value) ? value.join(", ") : value;

			if (this.config.logSensitiveHeaders) {
				result[key] = strValue;
			} else {
				const lowerKey = key.toLowerCase();
				if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
					if (strValue.length > 14) {
						result[key] = `${strValue.substring(0, 10)}...${strValue.slice(-4)}`;
					} else if (strValue.length > 4) {
						result[key] = `${strValue.substring(0, 2)}...${strValue.slice(-2)}`;
					} else {
						result[key] = "[REDACTED]";
					}
				} else {
					result[key] = strValue;
				}
			}
		}

		return result;
	}

	private parseSSEEvents(body: string): SSEEvent[] {
		const events: SSEEvent[] = [];
		const lines = body.split("\n");
		let currentEvent = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				currentEvent = line.substring(7).trim();
			} else if (line.startsWith("data: ")) {
				const data = line.substring(6).trim();
				if (data === "[DONE]") break;
				try {
					const parsed = JSON.parse(data);
					events.push({
						event: currentEvent || parsed?.type || "unknown",
						data: parsed,
						timestamp: new Date().toISOString(),
					});
				} catch {
					// Skip unparseable events
				}
			}
		}
		return events;
	}

	private async writePairToLog(pair: RawPair): Promise<void> {
		try {
			const jsonLine = JSON.stringify(pair) + "\n";
			fs.appendFileSync(this.logFile, jsonLine);
		} catch (err) {
			console.error(`Failed to write log: ${err}`);
		}
	}

	private async generateHTML(): Promise<void> {
		try {
			await this.htmlGenerator.generateHTML(this.pairs, this.htmlFile, {
				title: `${this.pairs.length} API Calls`,
				timestamp: new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: this.config.includeAllRequests,
			});
		} catch (err) {
			console.error(`Failed to generate HTML: ${err}`);
		}
	}

	public async start(): Promise<{ port: number; url: string }> {
		// Use plain HTTP to avoid TLS certificate issues with Bun binaries
		// The proxy receives HTTP from Claude, forwards as HTTPS to Anthropic
		return new Promise((resolve, reject) => {
			const httpServer = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});
			this.server = httpServer;

			httpServer.on("error", (err) => {
				reject(err);
			});

			httpServer.listen(this.config.port, "127.0.0.1", () => {
				const address = httpServer.address();
				if (address && typeof address === "object") {
					const port = address.port;
					const url = `http://127.0.0.1:${port}`;

					console.log(`Logs will be written to:`);
					console.log(`  JSONL: ${path.resolve(this.logFile)}`);
					console.log(`  HTML:  ${path.resolve(this.htmlFile)}`);

					resolve({ port, url });
				} else {
					reject(new Error("Failed to get server address"));
				}
			});
		});
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const requestTimestamp = Date.now();
		let requestBody = "";

		req.on("data", (chunk) => {
			requestBody += chunk;
		});

		req.on("end", () => {
			// Forward the request to the real Anthropic API
			const options: https.RequestOptions = {
				hostname: this.targetHost,
				port: this.targetPort,
				path: req.url,
				method: req.method,
				headers: {
					...req.headers,
					host: this.targetHost,
				},
			};

			const proxyReq = https.request(options, (proxyRes) => {
				const responseTimestamp = Date.now();
				const responseChunks: Buffer[] = [];

				proxyRes.on("data", (chunk) => {
					responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
					res.write(chunk);
				});

				proxyRes.on("end", async () => {
					res.end();

					// Check if this is a request we should log
					const url = `https://${this.targetHost}${req.url}`;
					const shouldLog =
						this.config.includeAllRequests || (req.url && req.url.includes("/v1/messages"));

					if (shouldLog) {
						// Parse request body
						let parsedRequestBody: any = null;
						try {
							parsedRequestBody = requestBody ? JSON.parse(requestBody) : null;
						} catch {
							parsedRequestBody = requestBody || null;
						}

						// Decompress response if gzipped
						const rawBuffer = Buffer.concat(responseChunks);
						let responseBody: string;
						const contentEncoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();
						try {
							if (contentEncoding === "gzip") {
								responseBody = zlib.gunzipSync(rawBuffer).toString("utf-8");
							} else if (contentEncoding === "br") {
								responseBody = zlib.brotliDecompressSync(rawBuffer).toString("utf-8");
							} else if (contentEncoding === "deflate") {
								responseBody = zlib.inflateSync(rawBuffer).toString("utf-8");
							} else {
								responseBody = rawBuffer.toString("utf-8");
							}
						} catch {
							responseBody = rawBuffer.toString("utf-8");
						}

						// Parse response body
						let parsedResponseBody: { body?: any; body_raw?: string; events?: SSEEvent[] } = {};
						const contentType = proxyRes.headers["content-type"] || "";
						try {
							if (contentType.includes("application/json")) {
								parsedResponseBody = { body: JSON.parse(responseBody) };
							} else if (contentType.includes("text/event-stream")) {
								const events = this.parseSSEEvents(responseBody);
								const processor = new SharedConversationProcessor();
								try {
									const message = processor.parseStreamingResponse(responseBody);
									parsedResponseBody = { body: message, events };
								} catch {
									parsedResponseBody = { body_raw: responseBody, events };
								}
							} else {
								parsedResponseBody = { body_raw: responseBody };
							}
						} catch {
							parsedResponseBody = { body_raw: responseBody };
						}

						const pair: RawPair = {
							request: {
								timestamp: requestTimestamp / 1000,
								method: req.method || "GET",
								url: url,
								headers: this.processHeaders(req.headers as Record<string, string>),
								body: parsedRequestBody,
							},
							response: {
								timestamp: responseTimestamp / 1000,
								status_code: proxyRes.statusCode || 0,
								headers: this.processHeaders(
									proxyRes.headers as Record<string, string>,
								),
								...parsedResponseBody,
							},
							logged_at: new Date().toISOString(),
						};

						this.pairs.push(pair);
						await this.writePairToLog(pair);
						await this.generateHTML();
					}
				});

				// Forward response headers
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
			});

			proxyReq.on("error", (err) => {
				console.error(`Proxy request error: ${err.message}`);
				res.writeHead(502);
				res.end(`Proxy error: ${err.message}`);
			});

			// Forward request body
			if (requestBody) {
				proxyReq.write(requestBody);
			}
			proxyReq.end();
		});
	}

	public stop(): void {
		if (this.server) {
			console.log(`Logged ${this.pairs.length} request/response pairs`);

			// Open browser if requested
			if (this.config.openBrowser && fs.existsSync(this.htmlFile)) {
				try {
					const { spawn } = require("child_process");
					const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
					spawn(cmd, [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
					console.log(`Opening ${this.htmlFile} in browser`);
				} catch (err) {
					console.error(`Failed to open browser: ${err}`);
				}
			}

			this.server.close();
			this.server = null;
		}
	}
}