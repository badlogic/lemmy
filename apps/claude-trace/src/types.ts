// Types matching the frontend expectations for compatibility

export interface RawPair {
	request: {
		timestamp: number;
		method: string;
		url: string;
		headers: Record<string, string>;
		body: any;
	};
	response: {
		timestamp: number;
		status_code: number;
		headers: Record<string, string>;
		body?: any;
		body_raw?: string;
		events?: SSEEvent[];
	} | null; // null for orphaned requests
	logged_at: string;
	note?: string; // For orphaned requests
}

export interface SSEEvent {
	event: string;
	data: any;
	timestamp: string;
}

export interface ClaudeData {
	rawPairs: RawPair[];
	timestamp?: string;
	metadata?: Record<string, any>;
}

// Internal types for HTML generation
export interface HTMLGenerationData {
	rawPairs: RawPair[];
	timestamp: string;
	title?: string;
	includeAllRequests?: boolean;
}

export interface TemplateReplacements {
	__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__: string;
	__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__: string;
	__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__: string;
}

// Frontend-specific types
export interface ProcessedConversation {
	id: string;
	model: string;
	messages: any[]; // Original message format from API
	system?: any; // System prompt
	latestResponse?: string; // Latest assistant response
	pairs: RawPair[]; // All pairs in this conversation
	metadata: {
		startTime: string;
		endTime: string;
		totalPairs: number;
		totalTokens?: number;
		tokenUsage?: {
			input: number;
			output: number;
		};
	};
	rawPairs: RawPair[]; // Keep for compatibility
}

export interface ProcessedMessage {
	role: "user" | "assistant" | "system";
	content: string;
	thinking?: string;
	toolCalls?: ToolCall[];
	metadata?: {
		timestamp: string;
		model?: string;
	};
}

export interface ToolCall {
	id: string;
	type: string;
	name: string;
	input: any;
	result?: any;
	error?: string;
}

// Bedrock-specific types
export interface BedrockBinaryEvent {
	bytes: string; // base64 encoded JSON
	p?: string; // additional payload
}

export interface BedrockInvocationMetrics {
	inputTokenCount: number;
	outputTokenCount: number;
	invocationLatency: number;
	firstByteLatency: number;
	cacheReadInputTokenCount?: number;
	cacheWriteInputTokenCount?: number;
}

declare global {
	interface Window {
		claudeData: ClaudeData;
	}
}
