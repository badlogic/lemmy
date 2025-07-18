import type {
    ContentBlock,
    ContentBlockParam,
    Message,
    MessageCreateParams,
    MessageParam,
    RawMessageStreamEvent,
    TextBlock,
    TextBlockParam,
    ToolResultBlockParam,
    ThinkingBlock,
    ToolUseBlock as ToolUseBlockType,
} from "@anthropic-ai/sdk/resources/messages";
import type { RawPair, BedrockInvocationMetrics } from "./types";

// Core interfaces for processed data
export interface ProcessedPair {
    id: string;
    timestamp: string;
    request: MessageCreateParams;
    response: Message;
    model: string;
    isStreaming: boolean;
    rawStreamData?: string; // Raw SSE/body_raw data for debugging
    streamFormat?: "standard" | "bedrock" | null; // Detected stream format
}

// Extended message type with tool result pairing
export interface EnhancedMessageParam extends MessageParam {
    toolResults?: Record<string, ToolResultBlockParam>;
    hide?: boolean;
}

export interface SimpleConversation {
    id: string;
    models: Set<string>;
    system?: string | TextBlockParam[];
    messages: EnhancedMessageParam[];
    response: Message;
    allPairs: ProcessedPair[];
    finalPair: ProcessedPair;
    compacted?: boolean;
    metadata: {
        startTime: string;
        endTime: string;
        totalPairs: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}

/**
 * Shared conversation processing functionality for both frontend and backend
 */
export class SharedConversationProcessor {
    /**
     * Process raw JSONL pairs into ProcessedPairs
     */
    processRawPairs(rawPairs: RawPair[]): ProcessedPair[] {
        if (!rawPairs || rawPairs.length === 0) {
            return [];
        }

        const processedPairs: ProcessedPair[] = [];

        for (let i = 0; i < rawPairs.length; i++) {
            const pair = rawPairs[i];
            if (!pair?.request || !pair?.response) {
                continue;
            }

            try {
                // Detect streaming
                const isStreaming = !!pair.response.body_raw;
                let response: Message;
                let streamFormat: "standard" | "bedrock" | null = null;

                if (pair.response.body_raw) {
                    // Parse streaming response and detect format
                    streamFormat = this.isBedrockResponse(pair.response.body_raw) ? "bedrock" : "standard";
                    response = this.parseStreamingResponse(pair.response.body_raw);
                } else if (pair.response.body) {
                    response = pair.response.body as Message;
                } else {
                    continue;
                }

                // Extract model from request headers or URL
                const model = this.extractModel(pair);

                processedPairs.push({
                    id: `${pair.request.timestamp || Date.now()}_${Math.random()}`,
                    timestamp: new Date((pair.request.timestamp || Date.now()) * 1000).toISOString(),
                    request: pair.request.body as MessageCreateParams,
                    response,
                    model,
                    isStreaming,
                    rawStreamData: pair.response.body_raw,
                    streamFormat,
                });
            } catch (error) {
                console.warn(`Failed to process raw pair at index ${i}:`, error);
                // Continue processing other pairs
            }
        }

        return processedPairs;
    }

    /**
     * Detect if the response is from Bedrock by checking for binary event stream format
     */
    private isBedrockResponse(bodyRaw: string): boolean {
        // Check for AWS EventStream format with binary headers and base64 encoded events
        return bodyRaw.startsWith("\u0000\u0000");
    }

    /**
     * Parse Bedrock binary event stream and extract the standard message events
     */
    private parseBedrockStreamingResponse(bodyRaw: string): Message {
        if (!bodyRaw || bodyRaw.length === 0) {
            throw new Error("Empty bodyRaw provided to parseBedrockStreamingResponse");
        }

        const events: RawMessageStreamEvent[] = [];
        let bedrockMetrics: BedrockInvocationMetrics | null = null;

        try {
            // Extract JSON payloads from AWS EventStream format
            // The format contains binary headers followed by JSON payloads
            const jsonChunks = this.extractJsonChunksFromEventStream(bodyRaw);

            for (const jsonChunk of jsonChunks) {
                try {
                    const eventPayload = JSON.parse(jsonChunk);

                    // Check if this is an event with base64-encoded bytes
                    if (eventPayload.bytes) {
                        const base64Data = eventPayload.bytes;
                        const decodedJson = this.decodeBase64ToUtf8(base64Data);
                        const event = JSON.parse(decodedJson) as RawMessageStreamEvent;
                        events.push(event);
                    }
                } catch (chunkError) {
                    console.warn("Failed to parse JSON chunk:", jsonChunk, chunkError);
                    // Continue with other chunks
                }
            }

            // Extract Bedrock metrics from the last event if present
            bedrockMetrics = this.extractBedrockMetrics(bodyRaw);
        } catch (error) {
            console.error("Failed to parse Bedrock streaming response:", error);
            throw new Error(`Bedrock streaming response parsing failed: ${error}`);
        }

        return this.buildMessageFromEvents(events, bedrockMetrics);
    }

    /**
     * Decode base64 string to UTF-8, compatible with both browser and Node.js environments
     */
    private decodeBase64ToUtf8(base64Data: string): string {
        // Check if we're in a browser environment
        if (typeof window !== "undefined" && typeof atob !== "undefined") {
            // Browser environment - use atob()
            return atob(base64Data);
        } else if (typeof Buffer !== "undefined") {
            // Node.js environment - use Buffer
            return Buffer.from(base64Data, "base64").toString("utf-8");
        } else {
            // Fallback implementation for environments without either
            throw new Error("Base64 decoding not supported in this environment");
        }
    }

    /**
     * Extract JSON chunks from AWS EventStream binary format
     */
    private extractJsonChunksFromEventStream(bodyRaw: string): string[] {
        if (!bodyRaw || bodyRaw.length === 0) {
            return [];
        }

        const jsonChunks: string[] = [];
        const pattern = 'event{"bytes":';

        let searchIndex = 0;

        while (searchIndex < bodyRaw.length) {
            // Find the next occurrence of the pattern
            const patternIndex = bodyRaw.indexOf(pattern, searchIndex);
            if (patternIndex === -1) {
                break; // No more patterns found
            }

            // Start extracting JSON from the '{' after 'event'
            const jsonStartIndex = patternIndex + 5; // Skip 'event' prefix
            let braceCount = 0;
            let jsonEndIndex = -1;

            // Find the matching closing brace
            for (let i = jsonStartIndex; i < bodyRaw.length; i++) {
                const char = bodyRaw[i];

                if (char === "{") {
                    braceCount++;
                } else if (char === "}") {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEndIndex = i;
                        break;
                    }
                }
            }

            // Extract the JSON chunk if we found a complete object
            if (jsonEndIndex !== -1) {
                const jsonChunk = bodyRaw.substring(jsonStartIndex, jsonEndIndex + 1);
                jsonChunks.push(jsonChunk);
                searchIndex = jsonEndIndex + 1;
            } else {
                // No matching brace found, move past this pattern
                searchIndex = patternIndex + pattern.length;
            }
        }

        return jsonChunks;
    }

    /**
     * Extract Bedrock invocation metrics from the response
     */
    private extractBedrockMetrics(bodyRaw: string): BedrockInvocationMetrics | null {
        try {
            // Look for the amazon-bedrock-invocationMetrics in the last decoded event
            const metricsMatch = bodyRaw.match(/"amazon-bedrock-invocationMetrics":\s*(\{[^}]+\})/);
            if (metricsMatch && metricsMatch[1]) {
                return JSON.parse(metricsMatch[1]) as BedrockInvocationMetrics;
            }
        } catch (e) {
            // Skip invalid metrics
        }
        return null;
    }

    /**
     * Parse streaming response from raw SSE data
     */
    private parseStreamingResponse(bodyRaw: string): Message {
        if (this.isBedrockResponse(bodyRaw)) {
            return this.parseBedrockStreamingResponse(bodyRaw);
        } else {
            return this.parseStandardStreamingResponse(bodyRaw);
        }
    }

    /**
     * Parse standard Anthropic API streaming response
     */
    private parseStandardStreamingResponse(bodyRaw: string): Message {
        if (!bodyRaw || bodyRaw.length === 0) {
            throw new Error("Empty bodyRaw provided to parseStandardStreamingResponse");
        }

        const lines = bodyRaw.split("\n");
        const events: RawMessageStreamEvent[] = [];

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.substring(6).trim();
            if (data === "[DONE]") break;

            try {
                const event = JSON.parse(data) as RawMessageStreamEvent;
                events.push(event);
            } catch (e) {
                console.warn("Failed to parse SSE event:", data, e);
                // Skip invalid JSON
            }
        }

        return this.buildMessageFromEvents(events);
    }

    /**
     * Build a Message object from a list of streaming events
     */
    private buildMessageFromEvents(
        events: RawMessageStreamEvent[],
        bedrockMetrics?: BedrockInvocationMetrics | null,
    ): Message {
        // Initialize with defaults
        let message: Partial<Message> = {
            id: "",
            type: "message",
            role: "assistant",
            content: [],
            model: "",
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: null,
            },
        };

        // Track content blocks being built
        const contentBlocks: ContentBlock[] = [];
        let currentBlockIndex = -1;

        for (const event of events) {
            switch (event.type) {
                case "message_start":
                    // Initialize message with base structure
                    message = { ...message, ...event.message };
                    break;

                case "content_block_start":
                    // Start a new content block
                    currentBlockIndex = event.index;
                    contentBlocks[currentBlockIndex] = { ...event.content_block };
                    break;

                case "content_block_delta":
                    // Update the current content block
                    if (currentBlockIndex >= 0 && contentBlocks[currentBlockIndex]) {
                        const block = contentBlocks[currentBlockIndex];
                        const delta = event.delta;

                        switch (delta.type) {
                            case "text_delta":
                                if (block.type === "text") {
                                    (block as TextBlock).text = ((block as TextBlock).text || "") + delta.text;
                                }
                                break;

                            case "input_json_delta":
                                if (block.type === "tool_use") {
                                    // Accumulate JSON string for tool_use blocks
                                    const toolBlock = block as ToolUseBlockType;
                                    if (typeof toolBlock.input === "string") {
                                        toolBlock.input = toolBlock.input + delta.partial_json;
                                    } else {
                                        // Initialize as string if not already
                                        (toolBlock.input as any) = delta.partial_json;
                                    }
                                }
                                break;

                            case "thinking_delta":
                                if (block.type === "thinking") {
                                    (block as ThinkingBlock).thinking =
                                        ((block as ThinkingBlock).thinking || "") + delta.thinking;
                                }
                                break;

                            case "signature_delta":
                                if (block.type === "thinking") {
                                    (block as ThinkingBlock).signature =
                                        ((block as ThinkingBlock).signature || "") + delta.signature;
                                }
                                break;

                            case "citations_delta":
                                // Handle citations delta if needed
                                break;
                        }
                    }
                    break;

                case "content_block_stop":
                    // Finalize content block
                    if (currentBlockIndex >= 0 && contentBlocks[currentBlockIndex]) {
                        const block = contentBlocks[currentBlockIndex];
                        // Parse JSON input if it's a tool_use block
                        if (block.type === "tool_use") {
                            const toolBlock = block as ToolUseBlockType;
                            if (typeof toolBlock.input === "string") {
                                try {
                                    toolBlock.input = JSON.parse(toolBlock.input);
                                } catch (e) {
                                    // Keep as string if JSON parsing fails
                                    console.warn("Failed to parse tool input JSON:", toolBlock.input);
                                }
                            }
                        }
                    }
                    break;

                case "message_delta":
                    // Update message-level fields
                    if (event.delta.stop_reason) {
                        message.stop_reason = event.delta.stop_reason;
                    }
                    if (event.delta.stop_sequence) {
                        message.stop_sequence = event.delta.stop_sequence;
                    }
                    if (event.usage) {
                        // Preserve existing input_tokens if not provided in this delta
                        // Input tokens are typically only sent once and shouldn't change
                        const currentInputTokens = message.usage?.input_tokens ?? 0;

                        message.usage = {
                            input_tokens: event.usage.input_tokens ?? currentInputTokens,
                            output_tokens: event.usage.output_tokens ?? message.usage?.output_tokens ?? 0,
                            cache_creation_input_tokens:
                                event.usage.cache_creation_input_tokens ?? message.usage?.cache_creation_input_tokens ?? null,
                            cache_read_input_tokens:
                                event.usage.cache_read_input_tokens ?? message.usage?.cache_read_input_tokens ?? null,
                            server_tool_use: event.usage.server_tool_use ?? message.usage?.server_tool_use ?? null,
                            service_tier: null, // MessageDeltaUsage doesn't have service_tier
                        };
                    }
                    break;

                case "message_stop":
                    // Finalize message
                    break;
            }
        }

        // Set the final content blocks
        message.content = contentBlocks.filter((block) => block != null);

        // If we have bedrock metrics, merge them into usage
        if (bedrockMetrics && message.usage) {
            message.usage.input_tokens = bedrockMetrics.inputTokenCount;
            message.usage.output_tokens = bedrockMetrics.outputTokenCount;
        }

        return message as Message;
    }

    /**
     * Extract model name from the raw pair
     */
    private extractModel(pair: RawPair): string {
        // Try to extract from Bedrock URL
        if (pair.request?.url && pair.request.url.includes("bedrock-runtime")) {
            const urlMatch = pair.request.url.match(/\/model\/([^\/]+)/);
            if (urlMatch && urlMatch[1]) {
                return this.normalizeModelName(urlMatch[1]);
            }
        }

        // Try to get model from request body
        if (pair.request?.body && typeof pair.request.body === "object" && "model" in pair.request.body) {
            return this.normalizeModelName((pair.request.body as any).model);
        }

        // Try to get from response
        if (pair.response?.body && typeof pair.response.body === "object" && "model" in pair.response.body) {
            return this.normalizeModelName((pair.response.body as any).model);
        }

        // Default
        return "unknown";
    }

    /**
     * Normalize model names from different formats to a consistent display format
     */
    private normalizeModelName(modelName: string): string {
        if (!modelName) return "unknown";

        // Handle Bedrock model names
        if (modelName.startsWith("us.anthropic.")) {
            // Convert "us.anthropic.claude-3-5-sonnet-20241022-v1:0" to "claude-3-5-sonnet-20241022"
            const match = modelName.match(/us\.anthropic\.([^:]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }

        // Return as-is for other formats
        return modelName;
    }

    /**
     * Group processed pairs into conversations
     */
    mergeConversations(
        pairs: ProcessedPair[],
        options: { includeShortConversations?: boolean } = {},
    ): SimpleConversation[] {
        if (!pairs || pairs.length === 0) return [];

        // Group pairs by system instructions + model
        const pairsBySystem = new Map<string, ProcessedPair[]>();

        for (const pair of pairs) {
            const system = pair.request.system;
            const model = pair.model;
            const systemKey = JSON.stringify({ system, model });

            if (!pairsBySystem.has(systemKey)) {
                pairsBySystem.set(systemKey, []);
            }
            pairsBySystem.get(systemKey)!.push(pair);
        }

        const allConversations: SimpleConversation[] = [];

        for (const [, systemPairs] of pairsBySystem) {
            const sortedPairs = [...systemPairs].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );

            // Group pairs by conversation thread
            const conversationThreads = new Map<string, ProcessedPair[]>();

            for (const pair of sortedPairs) {
                const messages = pair.request.messages || [];
                if (messages.length === 0) continue;

                const firstUserMessage = messages[0];
                const normalizedFirstMessage = this.normalizeMessageForGrouping(firstUserMessage);
                const conversationKey = JSON.stringify({ firstMessage: normalizedFirstMessage });
                const keyHash = this.hashString(conversationKey);

                if (!conversationThreads.has(keyHash)) {
                    conversationThreads.set(keyHash, []);
                }
                conversationThreads.get(keyHash)!.push(pair);
            }

            // For each conversation thread, keep the final pair
            for (const [conversationKey, threadPairs] of conversationThreads) {
                const sortedThreadPairs = [...threadPairs].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                );

                const finalPair = sortedThreadPairs.reduce((longest, current) => {
                    const currentMessages = current.request.messages || [];
                    const longestMessages = longest.request.messages || [];
                    return currentMessages.length > longestMessages.length ? current : longest;
                });

                const modelsUsed = new Set(sortedThreadPairs.map((pair) => pair.model));
                const enhancedMessages = this.processToolResults(finalPair.request.messages || []);

                const conversation: SimpleConversation = {
                    id: this.hashString(conversationKey),
                    models: modelsUsed,
                    system: finalPair.request.system,
                    messages: enhancedMessages,
                    response: finalPair.response,
                    allPairs: sortedThreadPairs,
                    finalPair: finalPair,
                    metadata: {
                        startTime: sortedThreadPairs[0].timestamp,
                        endTime: finalPair.timestamp,
                        totalPairs: sortedThreadPairs.length,
                        inputTokens: finalPair.response.usage?.input_tokens || 0,
                        outputTokens: finalPair.response.usage?.output_tokens || 0,
                        totalTokens:
                            (finalPair.response.usage?.input_tokens || 0) + (finalPair.response.usage?.output_tokens || 0),
                    },
                };

                allConversations.push(conversation);
            }
        }

        // Apply compact conversation detection
        const mergedConversations = this.detectAndMergeCompactConversations(allConversations);

        // Filter out short conversations unless explicitly included
        const filteredConversations = options.includeShortConversations
            ? mergedConversations
            : mergedConversations.filter((conv) => conv.messages.length > 2);

        // Sort by start time
        return filteredConversations.sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );
    }

    /**
     * Process messages to pair tool_use with tool_result
     */
    private processToolResults(messages: MessageParam[]): EnhancedMessageParam[] {
        const enhancedMessages: EnhancedMessageParam[] = [];
        const pendingToolUses: Record<string, { messageIndex: number; toolIndex: number }> = {};

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const enhancedMessage: EnhancedMessageParam = { ...message, toolResults: {}, hide: false };

            if (Array.isArray(message.content)) {
                let hasOnlyToolResults = true;
                let hasTextContent = false;

                for (let j = 0; j < message.content.length; j++) {
                    const block = message.content[j];

                    if (block.type === "tool_use" && "id" in block) {
                        const toolUse = block as ToolUseBlockType;
                        pendingToolUses[toolUse.id] = { messageIndex: i, toolIndex: j };
                        hasOnlyToolResults = false;
                    } else if (block.type === "tool_result" && "tool_use_id" in block) {
                        const toolResult = block as ToolResultBlockParam;
                        const toolUseId = toolResult.tool_use_id;

                        if (pendingToolUses[toolUseId]) {
                            const { messageIndex } = pendingToolUses[toolUseId];
                            if (!enhancedMessages[messageIndex]) {
                                enhancedMessages[messageIndex] = { ...messages[messageIndex], toolResults: {}, hide: false };
                            }
                            enhancedMessages[messageIndex].toolResults![toolUseId] = toolResult;
                            delete pendingToolUses[toolUseId];
                        }
                    } else if (block.type === "text") {
                        hasTextContent = true;
                        hasOnlyToolResults = false;
                    } else {
                        hasOnlyToolResults = false;
                    }
                }

                if (hasOnlyToolResults && !hasTextContent) {
                    enhancedMessage.hide = true;
                }
            }

            enhancedMessages[i] = enhancedMessage;
        }

        return enhancedMessages;
    }

    /**
     * Detect and merge compact conversations
     */
    private detectAndMergeCompactConversations(conversations: SimpleConversation[]): SimpleConversation[] {
        if (conversations.length <= 1) return conversations;

        const sortedConversations = [...conversations].sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );

        const usedConversations = new Set<number>();
        const mergedConversations: SimpleConversation[] = [];

        for (let i = 0; i < sortedConversations.length; i++) {
            const currentConv = sortedConversations[i];

            if (usedConversations.has(i)) continue;

            // Check if this is a compact conversation (1 pair with many messages)
            if (currentConv.allPairs.length === 1 && currentConv.messages.length > 2) {
                let originalConv: SimpleConversation | null = null;
                let originalIndex = -1;

                for (let j = 0; j < sortedConversations.length; j++) {
                    if (j === i || usedConversations.has(j)) continue;

                    const otherConv = sortedConversations[j];

                    // Check if other conversation has exactly 2 fewer messages
                    if (otherConv.messages.length === currentConv.messages.length - 2) {
                        // Check if messages match (simplified check)
                        let messagesMatch = true;
                        for (let k = 1; k < otherConv.messages.length; k++) {
                            if (!this.messagesRoughlyEqual(otherConv.messages[k], currentConv.messages[k])) {
                                messagesMatch = false;
                                break;
                            }
                        }

                        if (messagesMatch) {
                            originalConv = otherConv;
                            originalIndex = j;
                            break;
                        }
                    }
                }

                if (originalConv) {
                    const mergedConv = this.mergeCompactConversation(originalConv, currentConv);
                    mergedConversations.push(mergedConv);
                    usedConversations.add(i);
                    usedConversations.add(originalIndex);
                } else {
                    currentConv.compacted = true;
                    mergedConversations.push(currentConv);
                    usedConversations.add(i);
                }
            } else {
                mergedConversations.push(currentConv);
                usedConversations.add(i);
            }
        }

        // Add remaining conversations
        for (let i = 0; i < sortedConversations.length; i++) {
            if (!usedConversations.has(i)) {
                mergedConversations.push(sortedConversations[i]);
            }
        }

        return mergedConversations.sort(
            (a, b) => new Date(a.metadata.startTime).getTime() - new Date(b.metadata.startTime).getTime(),
        );
    }

    /**
     * Merge a compact conversation with its original counterpart
     */
    private mergeCompactConversation(
        originalConv: SimpleConversation,
        compactConv: SimpleConversation,
    ): SimpleConversation {
        const originalMessages = originalConv.messages || [];
        const compactMessages = compactConv.messages || [];

        const mergedMessages = [...compactMessages];
        if (originalMessages.length > 0 && mergedMessages.length > 0) {
            mergedMessages[0] = originalMessages[0];
        }

        const allPairs = [...originalConv.allPairs, ...compactConv.allPairs].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const allModels = new Set([...originalConv.models, ...compactConv.models]);
        const startTime = allPairs[0].timestamp;
        const endTime = allPairs[allPairs.length - 1].timestamp;

        return {
            id: compactConv.id,
            models: allModels,
            system: originalConv.system,
            messages: mergedMessages,
            response: compactConv.response,
            allPairs: allPairs,
            finalPair: compactConv.finalPair,
            compacted: true,
            metadata: {
                startTime: startTime,
                endTime: endTime,
                totalPairs: allPairs.length,
                inputTokens: (originalConv.metadata.inputTokens || 0) + (compactConv.metadata.inputTokens || 0),
                outputTokens: (originalConv.metadata.outputTokens || 0) + (compactConv.metadata.outputTokens || 0),
                totalTokens: (originalConv.metadata.totalTokens || 0) + (compactConv.metadata.totalTokens || 0),
            },
        };
    }

    /**
     * Compare two messages to see if they're roughly equal
     */
    private messagesRoughlyEqual(msg1: MessageParam, msg2: MessageParam): boolean {
        if (msg1.role !== msg2.role) return false;

        const content1 = msg1.content;
        const content2 = msg2.content;

        if (typeof content1 !== typeof content2) return false;
        if (Array.isArray(content1) !== Array.isArray(content2)) return false;

        return true;
    }

    /**
     * Normalize message for grouping (removes dynamic content)
     */
    private normalizeMessageForGrouping(message: MessageParam): MessageParam {
        if (!message || !message.content) return message;

        let normalizedContent: string | ContentBlockParam[];

        if (Array.isArray(message.content)) {
            normalizedContent = message.content.map((block) => {
                if (block.type === "text" && "text" in block) {
                    let text = block.text;
                    text = text.replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "Generated [TIMESTAMP]");
                    text = text.replace(/The user opened the file [^\s]+ in the IDE\./g, "The user opened file in IDE.");
                    text = text.replace(/<system-reminder>.*?<\/system-reminder>/gs, "[SYSTEM-REMINDER]");
                    return { type: "text", text: text };
                }
                return block;
            });
        } else {
            normalizedContent = message.content;
        }

        return {
            role: message.role,
            content: normalizedContent,
        };
    }

    /**
     * Generate hash string for conversation grouping
     */
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString();
    }
}
