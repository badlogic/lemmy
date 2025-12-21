import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool definition for retrieving the most recent screenshot
 */
export const getLastScreenshotTool: Tool = {
	name: "GetLastScreenshot",
	description: "Returns the most recent screenshot as base64 encoded PNG data",
	inputSchema: {
		type: "object",
		properties: {},
		required: [],
	},
	annotations: {
		title: "Get Last Screenshot",
		readOnlyHint: true,
		openWorldHint: false,
	},
};

/**
 * MCP tool definition for taking a new screenshot
 */
export const takeScreenshotTool: Tool = {
	name: "TakeScreenshot",
	description:
		"Takes a new screenshot with optimization options. Can resize, compress, change format, or return file path only. Optionally capture a specific window by ID (macOS and Windows). If asked to capture a specific app, ALWAYS use ListWindows tool first, to get the windowId. Without windowId parameter, takes a full screen screenshot.",
	inputSchema: {
		type: "object",
		properties: {
			windowId: {
				type: "number",
				description:
					"Optional window ID to capture specific window (macOS and Windows). If asked to capture a specific app, ALWAYS use ListWindows tool first, to get the windowId.",
			},
			maxWidth: {
				type: "number",
				description: "Maximum width for the screenshot (default: 1920). Images larger than this will be resized proportionally.",
				default: 1920,
			},
			maxHeight: {
				type: "number", 
				description: "Maximum height for the screenshot (default: 1080). Images larger than this will be resized proportionally.",
				default: 1080,
			},
			quality: {
				type: "number",
				description: "JPEG quality (1-100, default: 80). Only applies when format is 'jpeg'.",
				minimum: 1,
				maximum: 100,
				default: 80,
			},
			format: {
				type: "string",
				enum: ["png", "jpeg"],
				description: "Image format (default: 'png'). JPEG provides smaller file sizes but with compression artifacts.",
				default: "png",
			},
			returnPath: {
				type: "boolean",
				description: "If true, returns only the file path instead of base64 image data. Useful for large screenshots to avoid response size limits.",
				default: false,
			},
		},
		required: [],
	},
	annotations: {
		title: "Take Screenshot",
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
};

/**
 * MCP tool definition for listing windows (macOS and Windows)
 */
export const listWindowsTool: Tool = {
	name: "ListWindows",
	description:
		"Lists all visible windows with their IDs, titles, application names, positions, and sizes (macOS and Windows). Window IDs can be used with TakeScreenshot to capture specific windows on both macOS and Windows. Use this tool FIRST when asked to capture a specific application or window.",
	inputSchema: {
		type: "object",
		properties: {},
		required: [],
	},
	annotations: {
		title: "List Windows",
		readOnlyHint: true,
		openWorldHint: false,
	},
};

/**
 * Array of all available MCP tools for the snap-happy server
 */
export const tools: Tool[] = [getLastScreenshotTool, takeScreenshotTool, listWindowsTool];
