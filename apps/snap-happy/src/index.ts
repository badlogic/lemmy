#!/usr/bin/env node

/**
 * Snap Happy MCP Server
 *
 * A Model Context Protocol server that provides screenshot functionality.
 * Supports cross-platform screenshot capture and retrieval with base64 encoding.
 *
 * Available tools:
 * - GetLastScreenshot: Returns the most recent screenshot
 * - TakeScreenshot: Takes a new screenshot and returns it
 *
 * Environment configuration:
 * - SNAP_HAPPY_SCREENSHOT_PATH: Directory for storing screenshots
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import {
	getScreenshotConfig,
	validateScreenshotPath,
	takeScreenshot,
	getLastScreenshot,
	imageToBase64,
	listWindows,
} from "./screenshot.js";

const server = new Server(
	{
		name: "snap-happy",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools,
	};
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name } = request.params;

	try {
		const config = getScreenshotConfig();
		validateScreenshotPath(config.screenshotPath);

		switch (name) {
			case "GetLastScreenshot": {
				const lastScreenshotPath = getLastScreenshot(config.screenshotPath);

				if (!lastScreenshotPath) {
					return {
						content: [
							{
								type: "text",
								text: "No screenshots found in the configured directory.",
							},
						],
					};
				}

				const base64Data = imageToBase64(lastScreenshotPath);

				return {
					content: [
						{
							type: "text",
							text: `Last screenshot: ${lastScreenshotPath}`,
						},
						{
							type: "image",
							data: base64Data,
							mimeType: "image/png",
						},
					],
				};
			}

			case "TakeScreenshot": {
				const args = request.params.arguments || {};
				const windowId = args.windowId as number | undefined;
				const options = {
					maxWidth: args.maxWidth as number | undefined,
					maxHeight: args.maxHeight as number | undefined,
					quality: args.quality as number | undefined,
					format: args.format as 'png' | 'jpeg' | undefined,
					returnPath: args.returnPath as boolean | undefined,
				};

				const screenshotPath = takeScreenshot(config.screenshotPath, windowId, options);
				
				// If returnPath is true, just return the file path
				if (options.returnPath) {
					return {
						content: [
							{
								type: "text",
								text: `Screenshot saved to: ${screenshotPath}${windowId ? ` (window ID: ${windowId})` : ""}\nOptimization: ${options.maxWidth || 1920}x${options.maxHeight || 1080}, ${options.format || 'png'}${options.format === 'jpeg' ? `, quality: ${options.quality || 80}` : ""}`,
							},
						],
					};
				}

				// Return base64 data as before
				const base64Data = imageToBase64(screenshotPath);
				const mimeType = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';

				return {
					content: [
						{
							type: "text",
							text: `Screenshot taken: ${screenshotPath}${windowId ? ` (window ID: ${windowId})` : ""}\nOptimization: ${options.maxWidth || 1920}x${options.maxHeight || 1080}, ${options.format || 'png'}${options.format === 'jpeg' ? `, quality: ${options.quality || 80}` : ""}`,
						},
						{
							type: "image",
							data: base64Data,
							mimeType: mimeType,
						},
					],
				};
			}

			case "ListWindows": {
				const windows = listWindows();

				const windowList = windows
					.map(
						(win) =>
							`ID: ${win.id} | App: ${win.app} | Title: ${win.title} | Position: ${win.position.x},${win.position.y} | Size: ${win.size.width}x${win.size.height}`,
					)
					.join("\n");

				return {
					content: [
						{
							type: "text",
							text: `Found ${windows.length} windows:\n\n${windowList}\n\nNote: Window IDs can now be used with TakeScreenshot windowId parameter to capture specific windows.`,
						},
					],
				};
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		return {
			content: [
				{
					type: "text",
					text: `Error: ${errorMessage}`,
				},
			],
			isError: true,
		};
	}
});

// Error handling
server.onerror = (error) => {
	console.error("[MCP Error]", error);
};

process.on("SIGINT", async () => {
	await server.close();
	process.exit(0);
});

/**
 * Main function to start the MCP server
 * Sets up stdio transport and connects the server
 */
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Snap Happy MCP server running on stdio");
}

main().catch((error) => {
	console.error("Failed to start server:", error);
	process.exit(1);
});
