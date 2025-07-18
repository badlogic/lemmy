import fs from "fs";
import path from "path";
import { RawPair, ClaudeData, HTMLGenerationData } from "./types";

export class HTMLGenerator {
	private frontendDir: string;
	private templatePath: string;
	private bundlePath: string;

	constructor() {
		this.frontendDir = path.join(__dirname, "..", "frontend");
		this.templatePath = path.join(this.frontendDir, "template.html");
		this.bundlePath = path.join(this.frontendDir, "dist", "index.global.js");
	}

	private ensureFrontendBuilt(): void {
		if (!fs.existsSync(this.bundlePath)) {
			throw new Error(
				`Frontend bundle not found at ${this.bundlePath}. ` + `Run 'npm run build' in frontend directory first.`,
			);
		}
	}

	private loadTemplateFiles(): { htmlTemplate: string; jsBundle: string } {
		this.ensureFrontendBuilt();

		const htmlTemplate = fs.readFileSync(this.templatePath, "utf-8");
		const jsBundle = fs.readFileSync(this.bundlePath, "utf-8");

		return { htmlTemplate, jsBundle };
	}

	private filterClaudeAPIPairs(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => {
			const url = pair.request.url;
			// Include both Anthropic API and Bedrock API calls
			return url.includes("/v1/messages") || url.includes("bedrock-runtime.amazonaws.com");
		});
	}

	private filterShortConversations(pairs: RawPair[]): RawPair[] {
		return pairs.filter((pair) => {
			const messages = pair.request?.body?.messages;
			if (!Array.isArray(messages)) return true;
			return messages.length > 2;
		});
	}

	private prepareDataForInjection(data: HTMLGenerationData): string {
		const claudeData: ClaudeData = {
			rawPairs: data.rawPairs,
			timestamp: data.timestamp,
			metadata: {
				includeAllRequests: data.includeAllRequests || false,
			},
		};

		// Convert to JSON with minimal whitespace
		const dataJson = JSON.stringify(claudeData, null, 0);

		// Base64 encode to avoid all escaping issues
		return Buffer.from(dataJson, "utf-8").toString("base64");
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	public async generateHTML(
		pairs: RawPair[],
		outputFile: string,
		options: {
			title?: string;
			timestamp?: string;
			includeAllRequests?: boolean;
		} = {},
	): Promise<void> {
		try {
			let filteredPairs = pairs;

			// Remove filtering entirely - show all data
			// Previously filtered to only include v1/messages pairs with messages.length >= 2
			// but this was too aggressive and excluded valid data

			// Load template and bundle files
			const { htmlTemplate, jsBundle } = this.loadTemplateFiles();

			// Prepare data for injection
			const htmlData: HTMLGenerationData = {
				rawPairs: filteredPairs,
				timestamp: options.timestamp || new Date().toISOString().replace("T", " ").slice(0, -5),
				includeAllRequests: options.includeAllRequests || false,
			};

			const dataJsonEscaped = this.prepareDataForInjection(htmlData);

			// BIZARRE BUT NECESSARY: Use split() instead of replace() for bundle injection
			//
			// Why this weird approach? Using replace instead of split() for some reason duplicates
			// the htmlTemplate itself inside the new string! Maybe a bug in Node's String.replace?
			const templateParts = htmlTemplate.split("__CLAUDE_LOGGER_BUNDLE_REPLACEMENT_UNIQUE_9487__");
			if (templateParts.length !== 2) {
				throw new Error("Template bundle replacement marker not found or found multiple times");
			}

			// Reconstruct the template with the bundle injected between the split parts
			let htmlContent = templateParts[0] + jsBundle + templateParts[1];
			htmlContent = htmlContent
				.replace("__CLAUDE_LOGGER_DATA_REPLACEMENT_UNIQUE_9487__", dataJsonEscaped)
				.replace(
					"__CLAUDE_LOGGER_TITLE_REPLACEMENT_UNIQUE_9487__",
					this.escapeHtml(options.title || `${filteredPairs.length} API Calls`),
				);

			// Ensure output directory exists
			const outputDir = path.dirname(outputFile);
			if (!fs.existsSync(outputDir)) {
				fs.mkdirSync(outputDir, { recursive: true });
			}

			// Write HTML file
			fs.writeFileSync(outputFile, htmlContent, "utf-8");
		} catch (error) {
			console.error(`Error generating HTML: ${error}`);
			throw error;
		}
	}

	public async generateHTMLFromJSONL(
		jsonlFile: string,
		outputFile?: string,
		includeAllRequests: boolean = true,
	): Promise<string> {
		if (!fs.existsSync(jsonlFile)) {
			throw new Error(`File '${jsonlFile}' not found.`);
		}

		// Load all pairs from the JSONL file
		const pairs: RawPair[] = [];
		const fileContent = fs.readFileSync(jsonlFile, "utf-8");
		const lines = fileContent.split("\n");

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			const line = lines[lineNum].trim();
			if (line) {
				try {
					const pair = JSON.parse(line) as RawPair;
					pairs.push(pair);
				} catch (error) {
					console.warn(`Warning: Skipping invalid JSON on line ${lineNum + 1}: ${line.slice(0, 100)}...`);
					continue;
				}
			}
		}

		if (pairs.length === 0) {
			throw new Error(`No valid data found in '${jsonlFile}'.`);
		}

		// Determine output file
		if (!outputFile) {
			outputFile = jsonlFile.replace(/\.jsonl$/, ".html");
		}

		await this.generateHTML(pairs, outputFile, { includeAllRequests });
		return outputFile;
	}

	public getTemplatePaths(): { templatePath: string; bundlePath: string } {
		return {
			templatePath: this.templatePath,
			bundlePath: this.bundlePath,
		};
	}
}
