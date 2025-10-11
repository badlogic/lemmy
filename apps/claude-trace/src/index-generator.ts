import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { HTMLGenerator } from "./html-generator";
import { RawPair } from "./types";
import {
	SharedConversationProcessor,
	SimpleConversation,
	ProcessedPair,
	EnhancedMessageParam,
} from "./shared-conversation-processor";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";

export interface ConversationSummary {
	id: string;
	title: string;
	summary: string;
	startTime: string;
	messageCount: number;
	models: string[];
}

export interface LogSummary {
	logFile: string;
	htmlFile: string;
	generated: string;
	conversations: ConversationSummary[];
}

export class IndexGenerator {
	private traceDir: string = ".claude-trace";
	private htmlGenerator: HTMLGenerator;
	private conversationProcessor: SharedConversationProcessor;

	constructor() {
		this.htmlGenerator = new HTMLGenerator();
		this.conversationProcessor = new SharedConversationProcessor();
	}

	async generateIndex(): Promise<void> {
		console.log("Generating conversation index...");
		console.log(`Looking in: ${this.traceDir}/`);

		if (!fs.existsSync(this.traceDir)) {
			console.log(`Directory ${this.traceDir} not found`);
			process.exit(1);
		}

		// Find all log files
		const logFiles = this.findLogFiles();
		console.log(`Found ${logFiles.length} log files`);

		if (logFiles.length === 0) {
			console.log("No log files found");
			process.exit(1);
		}

		// Process each log file
		const allSummaries: LogSummary[] = [];
		for (const logFile of logFiles) {
			console.log(`\nProcessing ${logFile}...`);
			const summary = await this.processLogFile(logFile);
			if (summary) {
				allSummaries.push(summary);
			}
		}

		// Generate index.html
		await this.generateIndexHTML(allSummaries);
		console.log(`\nIndex generated: ${this.traceDir}/index.html`);
	}

	private findLogFiles(): string[] {
		const files = fs.readdirSync(this.traceDir);
		return files
			.filter((file) => file.match(/^log-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.jsonl$/))
			.sort((a, b) => b.localeCompare(a)); // newest first
	}

	private async processLogFile(logFile: string): Promise<LogSummary | null> {
		const logPath = path.join(this.traceDir, logFile);
		const timestamp = logFile.match(/log-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.jsonl$/)?.[1];
		if (!timestamp) return null;

		const summaryFile = `summary-${timestamp}.json`;
		const summaryPath = path.join(this.traceDir, summaryFile);
		const htmlFile = `log-${timestamp}.html`;
		const htmlPath = path.join(this.traceDir, htmlFile);

		// Check if summary needs regeneration
		const logStat = fs.statSync(logPath);
		let needsRegeneration = !fs.existsSync(summaryPath);

		if (!needsRegeneration) {
			const summaryStat = fs.statSync(summaryPath);
			needsRegeneration = summaryStat.mtime < logStat.mtime;
		}

		if (needsRegeneration) {
			console.log(`  Generating summary (${needsRegeneration ? "missing or outdated" : "up to date"})...`);

			// Ensure HTML file exists
			if (!fs.existsSync(htmlPath)) {
				console.log(`  Generating HTML file...`);
				await this.htmlGenerator.generateHTMLFromJSONL(logPath, htmlPath);
			}

			// Process conversations
			const conversations = await this.extractConversations(logPath);
			const summaries: ConversationSummary[] = [];

			// Summarize non-compacted conversations with more than 2 messages
			const nonCompactedConversations = conversations.filter((conv) => !conv.compacted && conv.messages.length > 2);
			console.log(`  Found ${nonCompactedConversations.length} non-compacted conversations (>2 messages)`);

			for (const conversation of nonCompactedConversations) {
				console.log(`    Summarizing conversation ${conversation.id}...`);
				const summary = await this.summarizeConversation(conversation);
				if (summary) {
					summaries.push(summary);
				}
			}

			// Save summary file
			const logSummary: LogSummary = {
				logFile,
				htmlFile,
				generated: new Date().toISOString(),
				conversations: summaries,
			};

			fs.writeFileSync(summaryPath, JSON.stringify(logSummary, null, 2));
			console.log(`  Summary saved: ${summaryFile}`);
			return logSummary;
		} else {
			console.log(`  Using existing summary`);
			return JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
		}
	}

	private async extractConversations(logPath: string): Promise<SimpleConversation[]> {
		// Read and parse JSONL file
		const content = fs.readFileSync(logPath, "utf-8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line.trim());
		const rawPairs: RawPair[] = lines.map((line) => JSON.parse(line));

		// Process pairs using shared implementation
		const processedPairs: ProcessedPair[] = this.conversationProcessor.processRawPairs(rawPairs);

		// Extract conversations
		return this.conversationProcessor.mergeConversations(processedPairs);
	}

	private async summarizeConversation(conversation: SimpleConversation): Promise<ConversationSummary | null> {
		try {
			// Convert conversation to text for summarization
			const conversationText = this.conversationToText(conversation);

			// Prepare prompt for Claude
			const prompt = `Please analyze this conversation and provide:
1. A concise title (max 10 words)
2. A summary in 1-3 paragraphs describing what was accomplished

Conversation:
${conversationText}

Format your response as:
TITLE: [title]
SUMMARY: [summary]`;

			// Call Claude CLI
			const claudeResponse = await this.callClaude(prompt);

			// Parse response
			const titleMatch = claudeResponse.match(/TITLE:\s*(.+)/);
			const summaryMatch = claudeResponse.match(/SUMMARY:\s*([\s\S]+)/);

			if (!titleMatch || !summaryMatch) {
				console.log(`    Failed to parse Claude response for conversation ${conversation.id}`);
				return null;
			}

			return {
				id: conversation.id,
				title: titleMatch[1].trim(),
				summary: summaryMatch[1].trim(),
				startTime: conversation.metadata.startTime,
				messageCount: conversation.messages.length,
				models: Array.from(conversation.models),
			};
		} catch (error) {
			console.log(`    Failed to summarize conversation ${conversation.id}: ${error}`);
			return null;
		}
	}

	private conversationToText(conversation: SimpleConversation): string {
		let text = "";

		// Add system prompt (stripped)
		if (conversation.system) {
			const systemText =
				typeof conversation.system === "string"
					? conversation.system
					: conversation.system.map((block) => (block.type === "text" ? block.text : "[non-text]")).join(" ");
			text += `SYSTEM: ${systemText.substring(0, 500)}...\n\n`;
		}

		// Add messages (without tool results for brevity)
		for (const message of conversation.messages) {
			if (message.hide) continue;

			text += `${message.role.toUpperCase()}: `;

			if (typeof message.content === "string") {
				text += message.content.substring(0, 1000);
			} else if (Array.isArray(message.content)) {
				const textBlocks = message.content
					.filter((block) => block.type === "text")
					.map((block) => (block as any).text)
					.join(" ");
				text += textBlocks.substring(0, 1000);
			}

			text += "\n\n";
		}

		return text;
	}

	private async callClaude(prompt: string): Promise<string> {
		return new Promise((resolve, reject) => {
			console.log("    Calling Claude CLI for summarization...");
			console.log("    This will incur additional token usage");

			const child = spawn("claude", ["-p", prompt], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			child.on("close", (code) => {
				if (code === 0) {
					resolve(stdout.trim());
				} else {
					reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
				}
			});

			child.on("error", (error) => {
				reject(new Error(`Failed to spawn claude CLI: ${error.message}`));
			});
		});
	}

	private async generateIndexHTML(summaries: LogSummary[]): Promise<void> {
		// We'll create a simple index template for now
		// Later we can enhance this with the lazy loading frontend
		const indexPath = path.join(this.traceDir, "index.html");

		let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Trace - Conversation Index</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { border-bottom: 1px solid #ddd; padding-bottom: 20px; margin-bottom: 30px; }
        .log-section { margin-bottom: 40px; }
        .log-header { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        .conversation { border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; margin-bottom: 15px; }
        .conversation h3 { margin-top: 0; color: #2563eb; }
        .conversation-meta { color: #666; font-size: 14px; margin-bottom: 10px; }
        .models { display: flex; gap: 8px; margin-top: 10px; }
        .model-tag { background: #e5f3ff; color: #0066cc; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
        a { color: #2563eb; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Claude Trace - Conversation Index</h1>
        <p>Generated: ${new Date().toISOString().replace("T", " ").slice(0, -5)}</p>
        <p>Total logs: ${summaries.length}</p>
    </div>
`;

		for (const summary of summaries) {
			html += `
    <div class="log-section">
        <div class="log-header">
            <h2><a href="${summary.htmlFile}">${summary.logFile}</a></h2>
            <p>Generated: ${summary.generated.replace("T", " ").slice(0, -5)} | Conversations: ${summary.conversations.length}</p>
        </div>
`;

			for (const conv of summary.conversations) {
				html += `
        <div class="conversation">
            <h3>${conv.title}</h3>
            <div class="conversation-meta">
                ${conv.startTime.replace("T", " ").slice(0, -5)} | ${conv.messageCount} messages
            </div>
            <p>${conv.summary}</p>
            <div class="models">
                ${conv.models.map((model) => `<span class="model-tag">${model}</span>`).join("")}
            </div>
        </div>
`;
			}

			html += `    </div>`;
		}

		html += `
</body>
</html>`;

		fs.writeFileSync(indexPath, html);
	}
}
