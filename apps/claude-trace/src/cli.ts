#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { HTMLGenerator } from "./html-generator";

// Colors for output
export const colors = {
	red: "\x1b[0;31m",
	green: "\x1b[0;32m",
	yellow: "\x1b[1;33m",
	blue: "\x1b[0;34m",
	reset: "\x1b[0m",
} as const;

type ColorName = keyof typeof colors;

function log(message: string, color: ColorName = "reset"): void {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

function showHelp(): void {
	console.log(`
${colors.blue}Claude Trace${colors.reset}
Record all your interactions with Claude Code as you develop your projects

${colors.yellow}USAGE:${colors.reset}
  claude-trace [OPTIONS] [--run-with CLAUDE_ARG...]

${colors.yellow}OPTIONS:${colors.reset}
  --extract-token    Extract OAuth token and exit (reproduces claude-token.py)
  --generate-html    Generate HTML report from JSONL file
  --index           Generate conversation summaries and index for .claude-trace/ directory
  --run-with         Pass all following arguments to Claude process
  --include-all-requests Include all requests made through fetch, otherwise only requests to v1/messages with more than 2 messages in the context
  --no-open          Don't open generated HTML file in browser
  --no-html          Skip HTML generation (JSONL only)
  --log              Specify custom log file base name (without extension)
  --claude-path      Specify custom path to Claude binary
  --help, -h         Show this help message

${colors.yellow}MODES:${colors.reset}
  ${colors.green}Interactive logging:${colors.reset}
    claude-trace                               Start Claude with traffic logging
    claude-trace --log my-session              Start Claude with custom log file name
    claude-trace --run-with chat                    Run Claude with specific command
    claude-trace --run-with chat --model sonnet-3.5 Run Claude with multiple arguments

  ${colors.green}Token extraction:${colors.reset}
    claude-trace --extract-token               Extract OAuth token for SDK usage

  ${colors.green}HTML generation:${colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name
    claude-trace --generate-html file.jsonl          Generate HTML and open in browser (default)
    claude-trace --generate-html file.jsonl --no-open Generate HTML without opening browser

  ${colors.green}Indexing:${colors.reset}
    claude-trace --index                             Generate conversation summaries and index

${colors.yellow}EXAMPLES:${colors.reset}
  # Start Claude with logging
  claude-trace

  # Start Claude with custom log file name
  claude-trace --log my-session

  # Run Claude chat with logging
  claude-trace --run-with chat

  # Run Claude with specific model
  claude-trace --run-with chat --model sonnet-3.5

  # Pass multiple arguments to Claude
  claude-trace --run-with --model gpt-4o --temperature 0.7

  # Extract token for Anthropic SDK
  export ANTHROPIC_API_KEY=$(claude-trace --extract-token)

  # Generate HTML report
  claude-trace --generate-html logs/traffic.jsonl report.html

  # Generate HTML report and open in browser (default)
  claude-trace --generate-html logs/traffic.jsonl

  # Generate HTML report without opening browser
  claude-trace --generate-html logs/traffic.jsonl --no-open

  # Generate conversation index
  claude-trace --index

  # Use custom Claude binary path
  claude-trace --claude-path /usr/local/bin/claude

${colors.yellow}OUTPUT:${colors.reset}
  Logs are saved to: ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}
  With --log NAME:   ${colors.green}.claude-trace/NAME.{jsonl,html}${colors.reset}

${colors.yellow}MIGRATION:${colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/mariozechner/claude-trace
`);
}

function resolveToJsFile(filePath: string): string {
	try {
		// First, resolve any symlinks
		const realPath = fs.realpathSync(filePath);

		// Check if it's already a JS file
		if (realPath.endsWith(".js")) {
			return realPath;
		}

		// If it's a Node.js shebang script, check if it's actually a JS file
		if (fs.existsSync(realPath)) {
			const content = fs.readFileSync(realPath, "utf-8");
			// Check for Node.js shebang
			if (
				content.startsWith("#!/usr/bin/env node") ||
				content.match(/^#!.*\/node$/m) ||
				content.includes("require(") ||
				content.includes("import ")
			) {
				// This is likely a JS file without .js extension
				return realPath;
			}
		}

		// If not a JS file, try common JS file locations
		const possibleJsPaths = [
			realPath + ".js",
			realPath.replace(/\/bin\//, "/lib/") + ".js",
			realPath.replace(/\/\.bin\//, "/lib/bin/") + ".js",
		];

		for (const jsPath of possibleJsPaths) {
			if (fs.existsSync(jsPath)) {
				return jsPath;
			}
		}

		// Fall back to original path
		return realPath;
	} catch (error) {
		// If resolution fails, return original path
		return filePath;
	}
}

function getClaudeAbsolutePath(customPath?: string): string {
	// If custom path is provided, use it directly
	if (customPath) {
		if (!fs.existsSync(customPath)) {
			log(`Claude binary not found at specified path: ${customPath}`, "red");
			process.exit(1);
		}
		return resolveToJsFile(customPath);
	}

	try {
		let claudePath = require("child_process")
			.execSync("which claude", {
				encoding: "utf-8",
			})
			.trim();

		// Handle shell aliases (e.g., "claude: aliased to /path/to/claude")
		const aliasMatch = claudePath.match(/:\s*aliased to\s+(.+)$/);
		if (aliasMatch && aliasMatch[1]) {
			claudePath = aliasMatch[1];
		}

		// Check if the path is a bash wrapper
		if (fs.existsSync(claudePath)) {
			const content = fs.readFileSync(claudePath, "utf-8");
			if (content.startsWith("#!/bin/bash")) {
				// Parse bash wrapper to find actual executable
				const execMatch = content.match(/exec\s+"([^"]+)"/);
				if (execMatch && execMatch[1]) {
					const actualPath = execMatch[1];
					// Resolve any symlinks to get the final JS file
					return resolveToJsFile(actualPath);
				}
			}
		}

		return resolveToJsFile(claudePath);
	} catch (error) {
		// First try the local bash wrapper
		const os = require("os");
		const localClaudeWrapper = path.join(os.homedir(), ".claude", "local", "claude");

		if (fs.existsSync(localClaudeWrapper)) {
			const content = fs.readFileSync(localClaudeWrapper, "utf-8");
			if (content.startsWith("#!/bin/bash")) {
				const execMatch = content.match(/exec\s+"([^"]+)"/);
				if (execMatch && execMatch[1]) {
					return resolveToJsFile(execMatch[1]);
				}
			}
		}

		// Then try the node_modules/.bin path
		const localClaudePath = path.join(os.homedir(), ".claude", "local", "node_modules", ".bin", "claude");
		if (fs.existsSync(localClaudePath)) {
			return resolveToJsFile(localClaudePath);
		}

		log(`Claude CLI not found in PATH`, "red");
		log(`Also checked for local installation at: ${localClaudeWrapper}`, "red");
		log(`Please install Claude Code CLI first`, "red");
		process.exit(1);
	}
}

function getLoaderPath(): string {
	const loaderPath = path.join(__dirname, "interceptor-loader.js");

	if (!fs.existsSync(loaderPath)) {
		log(`Interceptor loader not found at: ${loaderPath}`, "red");
		process.exit(1);
	}

	return loaderPath;
}

// Scenario 1: No args -> launch node with interceptor and absolute path to claude
async function runClaudeWithInterception(
	claudeArgs: string[] = [],
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
	customClaudePath?: string,
	logBaseName?: string,
	generateHTML: boolean = true,
): Promise<void> {
	log("Claude Trace", "blue");
	log("Starting Claude with traffic logging", "yellow");
	if (claudeArgs.length > 0) {
		log(`Claude arguments: ${claudeArgs.join(" ")}`, "blue");
	}
	console.log("");

	const claudePath = getClaudeAbsolutePath(customClaudePath);
	const loaderPath = getLoaderPath();

	log(`Using Claude binary: ${claudePath}`, "blue");
	log("Starting traffic logger...", "green");
	console.log("");

	// Launch node with interceptor and absolute path to claude, plus any additional arguments
	const spawnArgs = ["--require", loaderPath, claudePath, ...claudeArgs];
	const child: ChildProcess = spawn("node", spawnArgs, {
		env: {
			...process.env,
			NODE_OPTIONS: "--no-deprecation",
			CLAUDE_TRACE_INCLUDE_ALL_REQUESTS: includeAllRequests ? "true" : "false",
			CLAUDE_TRACE_OPEN_BROWSER: openInBrowser ? "true" : "false",
			CLAUDE_TRACE_GENERATE_HTML: generateHTML ? "true" : "false",
			...(logBaseName ? { CLAUDE_TRACE_LOG_NAME: logBaseName } : {}),
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	// Handle child process events
	child.on("error", (error: Error) => {
		log(`Error starting Claude: ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		if (signal) {
			log(`\nClaude terminated by signal: ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\nClaude exited with code: ${code}`, "yellow");
		} else {
			log("\nClaude session completed", "green");
		}
	});

	// Handle our own signals
	const handleSignal = (signal: string) => {
		log(`\nReceived ${signal}, shutting down...`, "yellow");
		if (child.pid) {
			child.kill(signal as NodeJS.Signals);
		}
	};

	process.on("SIGINT", () => handleSignal("SIGINT"));
	process.on("SIGTERM", () => handleSignal("SIGTERM"));

	// Wait for child process to complete
	try {
		await new Promise<void>((resolve, reject) => {
			child.on("exit", () => resolve());
			child.on("error", reject);
		});
	} catch (error) {
		const err = error as Error;
		log(`Unexpected error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Scenario 2: --extract-token -> launch node with token interceptor and absolute path to claude
async function extractToken(customClaudePath?: string): Promise<void> {
	const claudePath = getClaudeAbsolutePath(customClaudePath);

	// Log to stderr so it doesn't interfere with token output
	console.error(`Using Claude binary: ${claudePath}`);

	// Create .claude-trace directory if it doesn't exist
	const claudeTraceDir = path.join(process.cwd(), ".claude-trace");
	if (!fs.existsSync(claudeTraceDir)) {
		fs.mkdirSync(claudeTraceDir, { recursive: true });
	}

	// Token file location
	const tokenFile = path.join(claudeTraceDir, "token.txt");

	// Use the token extractor directly without copying
	const tokenExtractorPath = path.join(__dirname, "token-extractor.js");
	if (!fs.existsSync(tokenExtractorPath)) {
		log(`Token extractor not found at: ${tokenExtractorPath}`, "red");
		process.exit(1);
	}

	const cleanup = () => {
		try {
			if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
		} catch (e) {
			// Ignore cleanup errors
		}
	};

	// Launch node with token interceptor and absolute path to claude
	const { ANTHROPIC_API_KEY, ...envWithoutApiKey } = process.env;
	const child: ChildProcess = spawn("node", ["--require", tokenExtractorPath, claudePath, "-p", "hello"], {
		env: {
			...envWithoutApiKey,
			NODE_TLS_REJECT_UNAUTHORIZED: "0",
			CLAUDE_TRACE_TOKEN_FILE: tokenFile,
		},
		stdio: "inherit", // Suppress all output from Claude
		cwd: process.cwd(),
	});

	// Set a timeout to avoid hanging
	const timeout = setTimeout(() => {
		child.kill();
		cleanup();
		console.error("Timeout: No token found within 30 seconds");
		process.exit(1);
	}, 30000);

	// Handle child process events
	child.on("error", (error: Error) => {
		clearTimeout(timeout);
		cleanup();
		console.error(`Error starting Claude: ${error.message}`);
		process.exit(1);
	});

	child.on("exit", () => {
		clearTimeout(timeout);

		try {
			if (fs.existsSync(tokenFile)) {
				const token = fs.readFileSync(tokenFile, "utf-8").trim();
				cleanup();
				if (token) {
					// Only output the token, nothing else
					console.log(token);
					process.exit(0);
				}
			}
		} catch (e) {
			// File doesn't exist or read error
		}

		cleanup();
		console.error("No authorization token found");
		process.exit(1);
	});

	// Check for token file periodically
	const checkToken = setInterval(() => {
		try {
			if (fs.existsSync(tokenFile)) {
				const token = fs.readFileSync(tokenFile, "utf-8").trim();
				if (token) {
					clearTimeout(timeout);
					clearInterval(checkToken);
					child.kill();
					cleanup();

					// Only output the token, nothing else
					console.log(token);
					process.exit(0);
				}
			}
		} catch (e) {
			// Ignore read errors, keep trying
		}
	}, 500);
}

// Scenario 3: --generate-html input.jsonl output.html
async function generateHTMLFromCLI(
	inputFile: string,
	outputFile?: string,
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
): Promise<void> {
	try {
		const htmlGenerator = new HTMLGenerator();
		const finalOutputFile = await htmlGenerator.generateHTMLFromJSONL(inputFile, outputFile, includeAllRequests);

		if (openInBrowser) {
			spawn("open", [finalOutputFile], { detached: true, stdio: "ignore" }).unref();
			log(`Opening ${finalOutputFile} in browser`, "green");
		}

		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`Error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Scenario 4: --index
async function generateIndex(): Promise<void> {
	try {
		const { IndexGenerator } = await import("./index-generator");
		const indexGenerator = new IndexGenerator();
		await indexGenerator.generateIndex();
		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`Error: ${err.message}`, "red");
		process.exit(1);
	}
}

// Main entry point
async function main(): Promise<void> {
	const args = process.argv.slice(2);

	// Split arguments at --run-with flag
	const argIndex = args.indexOf("--run-with");
	let claudeTraceArgs: string[];
	let claudeArgs: string[];

	if (argIndex !== -1) {
		claudeTraceArgs = args.slice(0, argIndex);
		claudeArgs = args.slice(argIndex + 1);
	} else {
		claudeTraceArgs = args;
		claudeArgs = [];
	}

	// Check for help flags
	if (claudeTraceArgs.includes("--help") || claudeTraceArgs.includes("-h")) {
		showHelp();
		process.exit(0);
	}

	// Check for include all requests flag
	const includeAllRequests = claudeTraceArgs.includes("--include-all-requests");

	// Check for no-open flag (inverted logic - open by default)
	const openInBrowser = !claudeTraceArgs.includes("--no-open");

	// Check for no-html flag (inverted logic - generate HTML by default)
	const generateHTML = !claudeTraceArgs.includes("--no-html");

	// Check for custom Claude path
	let customClaudePath: string | undefined;
	const claudePathIndex = claudeTraceArgs.indexOf("--claude-path");
	if (claudePathIndex !== -1 && claudeTraceArgs[claudePathIndex + 1]) {
		customClaudePath = claudeTraceArgs[claudePathIndex + 1];
	}

	// Check for custom log base name
	let logBaseName: string | undefined;
	const logIndex = claudeTraceArgs.indexOf("--log");
	if (logIndex !== -1 && claudeTraceArgs[logIndex + 1]) {
		logBaseName = claudeTraceArgs[logIndex + 1];
	}

	// Scenario 2: --extract-token
	if (claudeTraceArgs.includes("--extract-token")) {
		await extractToken(customClaudePath);
		return;
	}

	// Scenario 3: --generate-html input.jsonl [output.html]
	if (claudeTraceArgs.includes("--generate-html")) {
		const flagIndex = claudeTraceArgs.indexOf("--generate-html");
		const inputFile = claudeTraceArgs[flagIndex + 1];

		// Find the next argument that's not a flag as the output file
		let outputFile: string | undefined;
		for (let i = flagIndex + 2; i < claudeTraceArgs.length; i++) {
			const arg = claudeTraceArgs[i];
			if (!arg.startsWith("--")) {
				outputFile = arg;
				break;
			}
		}

		if (!inputFile) {
			log(`Missing input file for --generate-html`, "red");
			log(`Usage: claude-trace --generate-html input.jsonl [output.html]`, "yellow");
			process.exit(1);
		}

		await generateHTMLFromCLI(inputFile, outputFile, includeAllRequests, openInBrowser);
		return;
	}

	// Scenario 4: --index
	if (claudeTraceArgs.includes("--index")) {
		await generateIndex();
		return;
	}

	// Scenario 1: No args (or claude with args) -> launch claude with interception
	await runClaudeWithInterception(claudeArgs, includeAllRequests, openInBrowser, customClaudePath, logBaseName, generateHTML);
}

main().catch((error) => {
	const err = error as Error;
	log(`Unexpected error: ${err.message}`, "red");
	process.exit(1);
});
