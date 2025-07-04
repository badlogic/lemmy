import type { SerializedContext, ChatClient } from "@mariozechner/lemmy";
import type { MessageCreateParamsBase, ThinkingConfigEnabled } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { AnthropicConfig, OpenAIConfig, GoogleConfig } from "@mariozechner/lemmy";
import type { ModelData } from "@mariozechner/lemmy";

// Basic types for claude-bridge

export interface RawPair {
	request: {
		timestamp: number;
		method: string;
		url: string;
		headers: Record<string, string>;
		body: unknown;
	};
	response: {
		timestamp: number;
		status_code: number;
		headers: Record<string, string>;
		body?: unknown;
		body_raw?: string;
	} | null;
	logged_at: string;
	note?: string;
}

export type Provider = "anthropic" | "openai" | "google" | "proxy";

// JSON Schema types
export interface JSONSchema {
	type?: string;
	properties?: Record<string, JSONSchema>;
	items?: JSONSchema;
	required?: string[];
	enum?: any[];
	oneOf?: JSONSchema[];
	anyOf?: JSONSchema[];
	allOf?: JSONSchema[];
	$ref?: string;
	definitions?: Record<string, JSONSchema>;
	// Additional properties
	description?: string;
	[key: string]: any;
}

export interface BridgeConfig {
	provider: Provider;
	model: string;
	apiKey?: string | undefined;
	baseURL?: string | undefined;
	maxRetries?: number | undefined;
	logDirectory?: string | undefined;
	logLevel?: "debug" | "info" | "warn" | "error" | undefined;
	debug?: boolean | undefined;
	trace?: boolean | undefined;
}

export interface CapabilityValidationResult {
	valid: boolean;
	warnings: string[];
	adjustments: {
		maxOutputTokens?: number;
		thinkingEnabled?: boolean;
		toolsDisabled?: boolean;
		imagesIgnored?: boolean;
	};
}

export interface ProviderClientInfo {
	client: ChatClient;
	provider: Provider;
	model: string;
	modelData: ModelData | null; // null for unknown models
}

export type ProviderConfig = AnthropicConfig | OpenAIConfig | GoogleConfig | OpenAIConfig; // Proxy uses OpenAI config

export interface TransformationEntry {
	timestamp: number;
	request_id: string;
	raw_request: MessageCreateParamsBase;
	lemmy_context: SerializedContext;
	bridge_config: {
		provider: Provider;
		model: string;
	};
	raw_response?: {
		status_code: number;
		headers: Record<string, string>;
		body?: unknown;
		body_raw?: string;
	};
	decoded_sse?: unknown[] | undefined;
	logged_at: string;
}
