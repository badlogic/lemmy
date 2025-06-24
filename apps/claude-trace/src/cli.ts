#!/usr/bin/env node

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { HTMLGenerator } from "./html-generator";
import { t } from "./i18n";

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
${colors.blue}${t("cli.title")}${colors.reset}
${t("cli.description")}

${colors.yellow}${t("cli.usage")}${colors.reset}
  claude-trace [OPTIONS] [--run-with CLAUDE_ARG...]

${colors.yellow}${t("cli.options")}${colors.reset}
  --extract-token    ${t("cli.help.extractToken")}
  --generate-html    ${t("cli.help.generateHtml")}
  --index           ${t("cli.help.index")}
  --run-with         ${t("cli.help.runWith")}
  --include-all-requests ${t("cli.help.includeAllRequests")}
  --no-open          ${t("cli.help.noOpen")}
  --help, -h         ${t("cli.help.helpFlag")}

${colors.yellow}${t("cli.modes")}${colors.reset}
  ${colors.green}${t("cli.modeLabels.interactiveLogging")}${colors.reset}
    claude-trace                               Start Claude with traffic logging
    claude-trace --run-with chat                    Run Claude with specific command
    claude-trace --run-with chat --model sonnet-3.5 Run Claude with multiple arguments

  ${colors.green}${t("cli.modeLabels.tokenExtraction")}${colors.reset}
    claude-trace --extract-token               Extract OAuth token for SDK usage

  ${colors.green}${t("cli.modeLabels.htmlGeneration")}${colors.reset}
    claude-trace --generate-html file.jsonl          Generate HTML from JSONL file
    claude-trace --generate-html file.jsonl out.html Generate HTML with custom output name
    claude-trace --generate-html file.jsonl          Generate HTML and open in browser (default)
    claude-trace --generate-html file.jsonl --no-open Generate HTML without opening browser

  ${colors.green}${t("cli.modeLabels.indexing")}${colors.reset}
    claude-trace --index                             Generate conversation summaries and index

${colors.yellow}${t("cli.examples")}${colors.reset}
  # Start Claude with logging
  claude-trace

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

${colors.yellow}${t("cli.output")}${colors.reset}
  Logs are saved to: ${colors.green}.claude-trace/log-YYYY-MM-DD-HH-MM-SS.{jsonl,html}${colors.reset}

${colors.yellow}${t("cli.migration")}${colors.reset}
  This tool replaces Python-based claude-logger and claude-token.py scripts
  with a pure Node.js implementation. All output formats are compatible.

For more information, visit: https://github.com/mariozechner/claude-trace
`);
}

function getClaudeAbsolutePath(): string {
	try {
		return require("child_process")
			.execSync("which claude", {
				encoding: "utf-8",
			})
			.trim();
	} catch (error) {
		const os = require("os");
		const localClaudePath = path.join(os.homedir(), ".claude", "local", "node_modules", ".bin", "claude");

		if (fs.existsSync(localClaudePath)) {
			return localClaudePath;
		}

		log(t("cli.errors.claudeNotFound"), "red");
		log(`${t("cli.errors.claudeLocalNotFound")} ${localClaudePath}`, "red");
		log(t("cli.errors.installClaude"), "red");
		process.exit(1);
	}
}

function getLoaderPath(): string {
	const loaderPath = path.join(__dirname, "interceptor-loader.js");

	if (!fs.existsSync(loaderPath)) {
		log(`${t("cli.errors.interceptorNotFound")} ${loaderPath}`, "red");
		process.exit(1);
	}

	return loaderPath;
}

// Scenario 1: No args -> launch node with interceptor and absolute path to claude
async function runClaudeWithInterception(
	claudeArgs: string[] = [],
	includeAllRequests: boolean = false,
	openInBrowser: boolean = false,
): Promise<void> {
	log(t("cli.messages.startingClaude"), "blue");
	if (claudeArgs.length > 0) {
		log(`🔧 Claude arguments: ${claudeArgs.join(" ")}`, "blue");
	}
	console.log("");

	const claudePath = getClaudeAbsolutePath();
	const loaderPath = getLoaderPath();

	log(t("cli.messages.trafficLogger"), "green");
	log(t("cli.messages.logsLocation"), "blue");
	console.log("");

	// Launch node with interceptor and absolute path to claude, plus any additional arguments
	const spawnArgs = ["--require", loaderPath, claudePath, ...claudeArgs];
	const child: ChildProcess = spawn("node", spawnArgs, {
		env: {
			...process.env,
			NODE_OPTIONS: "--no-deprecation",
			CLAUDE_TRACE_INCLUDE_ALL_REQUESTS: includeAllRequests ? "true" : "false",
			CLAUDE_TRACE_OPEN_BROWSER: openInBrowser ? "true" : "false",
		},
		stdio: "inherit",
		cwd: process.cwd(),
	});

	// Handle child process events
	child.on("error", (error: Error) => {
		log(`${t("cli.errors.errorStartingClaude")} ${error.message}`, "red");
		process.exit(1);
	});

	child.on("exit", (code: number | null, signal: string | null) => {
		if (signal) {
			log(`\n${t("cli.messages.claudeTerminated")} ${signal}`, "yellow");
		} else if (code !== 0 && code !== null) {
			log(`\n${t("cli.messages.claudeExited")} ${code}`, "yellow");
		} else {
			log(`\n${t("cli.messages.claudeSessionCompleted")}`, "green");
		}
	});

	// Handle our own signals
	const handleSignal = (signal: string) => {
		log(`\n${t("cli.messages.receivedSignal")} ${signal}, ${t("cli.messages.shutdownMessage")}`, "yellow");
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
		log(`${t("cli.errors.unexpectedError")} ${err.message}`, "red");
		process.exit(1);
	}
}

// Scenario 2: --extract-token -> launch node with token interceptor and absolute path to claude
async function extractToken(): Promise<void> {
	const claudePath = getClaudeAbsolutePath();

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
		log(`❌ Token extractor not found at: ${tokenExtractorPath}`, "red");
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
		console.error(t("cli.errors.tokenTimeout"));
		process.exit(1);
	}, 30000);

	// Handle child process events
	child.on("error", (error: Error) => {
		clearTimeout(timeout);
		cleanup();
		console.error(`${t("cli.errors.errorStartingClaude")} ${error.message}`);
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
		console.error(t("cli.errors.tokenNotFound"));
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
			log(`${t("cli.messages.openingBrowser")} ${finalOutputFile} in browser`, "green");
		}

		process.exit(0);
	} catch (error) {
		const err = error as Error;
		log(`${t("cli.errors.unexpectedError")} ${err.message}`, "red");
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
		log(`${t("cli.errors.unexpectedError")} ${err.message}`, "red");
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

	// Scenario 2: --extract-token
	if (claudeTraceArgs.includes("--extract-token")) {
		await extractToken();
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
			log(t("cli.errors.missingInputFile"), "red");
			log(t("cli.errors.usageGenerateHtml"), "yellow");
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
	await runClaudeWithInterception(claudeArgs, includeAllRequests, openInBrowser);
}

main().catch((error) => {
	const err = error as Error;
	log(`${t("cli.errors.unexpectedError")} ${err.message}`, "red");
	process.exit(1);
});
