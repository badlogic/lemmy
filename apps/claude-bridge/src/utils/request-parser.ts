import type { MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/messages/messages.js";

export interface ParsedRequestData {
	url: string;
	method: string;
	timestamp: number;
	headers: Record<string, string>;
	body: MessageCreateParamsBase;
}

/**
 * Redact sensitive information from HTTP headers
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const result = { ...headers };
	const sensitiveKeys = [
		"authorization",
		"x-api-key",
		"x-auth-token",
		"cookie",
		"set-cookie",
		"x-session-token",
		"x-access-token",
		"bearer",
		"proxy-authorization",
	];

	for (const [key, value] of Object.entries(result)) {
		if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
			result[key] =
				value.length > 14
					? `${value.substring(0, 10)}...${value.slice(-4)}`
					: value.length > 4
						? `${value.substring(0, 2)}...${value.slice(-2)}`
						: "[REDACTED]";
		}
	}
	return result;
}

/**
 * Parse Anthropic API request data from fetch parameters
 */
export async function parseAnthropicMessageCreateRequest(
	url: string,
	init: RequestInit,
	logger?: { error: (msg: string) => void },
): Promise<ParsedRequestData> {
	let body: MessageCreateParamsBase | null = null;

	if (init.body) {
		try {
			if (typeof init.body !== "string") throw new Error("Anthropic request body must be a string");
			body = JSON.parse(init.body) as MessageCreateParamsBase;
		} catch (error) {
			logger?.error(
				`Failed to parse Anthropic request body: ${error instanceof Error ? error.message : String(error)}`,
			);
			body = null;
		}
	}

	if (!body) throw Error("Anthropic request body must not be null");

	return {
		url,
		timestamp: Date.now() / 1000,
		method: init.method || "POST",
		headers: redactHeaders(Object.fromEntries(new Headers(init.headers || {}).entries())),
		body,
	};
}

/**
 * Parse HTTP response with proper content type handling
 */
export async function parseResponse(response: Response): Promise<{
	timestamp: number;
	status_code: number;
	headers: Record<string, string>;
	body?: unknown;
	body_raw?: string;
}> {
	const contentType = response.headers.get("content-type") || "";
	let body, body_raw;

	try {
		if (contentType.includes("application/json")) {
			body = await response.json();
		} else {
			body_raw = await response.text();
		}
	} catch {
		// Ignore parse errors
	}

	const result: any = {
		timestamp: Date.now() / 1000,
		status_code: response.status,
		headers: redactHeaders(Object.fromEntries(response.headers.entries())),
	};

	if (body !== undefined) result.body = body;
	if (body_raw !== undefined) result.body_raw = body_raw;

	return result;
}

/**
 * Check if URL is an Anthropic API endpoint
 */
export function isAnthropicAPI(url: string): boolean {
	return (
		url.includes(process.env["ANTHROPIC_BASE_URL"]?.replace(/https:\/\//g, "") || "api.anthropic.com") &&
		url.includes("/v1/messages")
	);
}

/**
 * Generate unique request ID
 */
export function generateRequestId(): string {
	return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
