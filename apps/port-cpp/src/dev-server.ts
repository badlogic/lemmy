#!/usr/bin/env npx tsx

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface FileData {
	content: string;
	diff: string;
	originalContent?: string; // Full content from prevBranch
	modifiedContent?: string; // Full content from currBranch (or current)
	error?: string;
}

interface WatchedFile {
	absolutePath: string;
	prevBranch?: string;
	currBranch?: string;
	watchers: Set<any>; // Set of WebSocket connections watching this file
}

class DevServer {
	private app = express();
	private server = createServer(this.app);
	private wss = new WebSocketServer({ server: this.server });
	private fileWatchers = new Map<string, chokidar.FSWatcher>(); // filepath -> file watcher
	private watchedFiles = new Map<string, WatchedFile>(); // filepath -> file info + watching sockets
	private clientFiles = new Map<any, Set<string>>(); // websocket -> set of filepaths being watched

	constructor() {
		this.setupRoutes();
		this.setupWebSocket();
	}

	private setupRoutes() {
		// Parse JSON bodies for API routes
		this.app.use(express.json());

		// API route to open files in Cursor
		this.app.post("/api/open-in-cursor", (req, res) => {
			try {
				const { filepath } = req.body;

				if (!filepath) {
					return res.status(400).json({ error: "filepath is required" });
				}

				// Execute cursor command to open the file
				console.log(`🎯 Opening in Cursor: ${filepath}`);
				execSync(`cursor "${filepath}"`, { stdio: "inherit" });

				res.json({ success: true, message: `Opened ${filepath} in Cursor` });
			} catch (error) {
				console.error(`❌ Failed to open file in Cursor:`, error);
				res.status(500).json({
					error: "Failed to open file in Cursor",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});

		// Main route - serve the HTML
		this.app.get("/", (req, res) => {
			res.sendFile(path.join(__dirname, "frontend", "index.html"));
		});

		// Serve static files from frontend directory
		this.app.use(express.static(path.join(__dirname, "frontend")));
	}

	private setupWebSocket() {
		this.wss.on("connection", (ws) => {
			console.log("Client connected");

			// Initialize client tracking
			this.clientFiles.set(ws, new Set());

			ws.on("message", (data) => {
				try {
					const message = JSON.parse(data.toString());
					console.log("Received message:", message);

					if (message.type === "watch") {
						// Watch a new file: { type: "watch", absolutePath: "/path/to/file", prevBranch?: "...", currBranch?: "..." }
						const { absolutePath, prevBranch, currBranch } = message;
						console.log(`Watching file: ${absolutePath}`);
						this.watchFile(ws, absolutePath, prevBranch, currBranch);
					} else if (message.type === "unwatch") {
						// Stop watching a file: { type: "unwatch", absolutePath: "/path/to/file" }
						const { absolutePath } = message;
						console.log(`Unwatching file: ${absolutePath}`);
						this.unwatchFile(ws, absolutePath);
					} else if (message.type === "refresh") {
						// Refresh all watched files for this client: { type: "refresh" }
						console.log("Refreshing all files for client");
						this.refreshAllFilesForClient(ws);
					} else {
						console.log("Unknown message type:", message.type);
					}
				} catch (error) {
					console.error("Error parsing WebSocket message:", error);
				}
			});

			ws.on("close", () => {
				console.log("Client disconnected");
				this.cleanupClient(ws);
			});

			// Send current state for all watched files to the new client
			this.broadcastAllFilesToClient(ws);
		});
	}

	private watchFile(ws: any, absolutePath: string, prevBranch?: string, currBranch?: string) {
		// Add this client to the file's watchers
		let fileInfo = this.watchedFiles.get(absolutePath);
		if (!fileInfo) {
			fileInfo = {
				absolutePath,
				prevBranch,
				currBranch,
				watchers: new Set(),
			};
			this.watchedFiles.set(absolutePath, fileInfo);
		}
		fileInfo.watchers.add(ws);

		// Track this file for this client
		const clientWatchedFiles = this.clientFiles.get(ws);
		if (clientWatchedFiles) {
			clientWatchedFiles.add(absolutePath);
		}

		// Set up file system watcher if not already watching
		if (!this.fileWatchers.has(absolutePath)) {
			const watcher = chokidar.watch(absolutePath, { ignoreInitial: false });
			watcher.on("change", () => this.broadcastFileUpdate(absolutePath));
			watcher.on("add", () => this.broadcastFileUpdate(absolutePath));
			this.fileWatchers.set(absolutePath, watcher);
			console.log(`Started file system watcher for: ${absolutePath}`);
		}

		// Broadcast initial content to this client
		this.broadcastFileUpdateToClient(ws, absolutePath);
	}

	private unwatchFile(ws: any, absolutePath: string) {
		const fileInfo = this.watchedFiles.get(absolutePath);
		if (!fileInfo) return;

		// Remove this client from the file's watchers
		fileInfo.watchers.delete(ws);

		// Remove from client tracking
		const clientWatchedFiles = this.clientFiles.get(ws);
		if (clientWatchedFiles) {
			clientWatchedFiles.delete(absolutePath);
		}

		// If no more clients are watching this file, clean it up
		if (fileInfo.watchers.size === 0) {
			this.watchedFiles.delete(absolutePath);

			// Close the file watcher
			const watcher = this.fileWatchers.get(absolutePath);
			if (watcher) {
				watcher.close();
				this.fileWatchers.delete(absolutePath);
				console.log(`Stopped file system watcher for: ${absolutePath}`);
			}

			// Broadcast removal to all clients
			this.broadcastFileRemoval(absolutePath);
		}
	}

	private cleanupClient(ws: any) {
		const clientWatchedFiles = this.clientFiles.get(ws);
		if (clientWatchedFiles) {
			// Unwatch all files for this client
			for (const absolutePath of clientWatchedFiles) {
				this.unwatchFile(ws, absolutePath);
			}
			this.clientFiles.delete(ws);
		}
		console.log(`Cleaned up client, removed from ${clientWatchedFiles?.size || 0} files`);
	}

	private broadcastFileUpdate(absolutePath: string) {
		const watchedFile = this.watchedFiles.get(absolutePath);
		if (!watchedFile) {
			console.log(`No watched file found for: ${absolutePath}`);
			return;
		}

		console.log(`Getting file data for: ${absolutePath}`);
		const fileData = this.getFileData(absolutePath, watchedFile.prevBranch, watchedFile.currBranch);

		const message = {
			type: "fileUpdate",
			absolutePath,
			filename: path.basename(absolutePath),
			...fileData,
		};

		console.log(`Broadcasting file update to ${watchedFile.watchers.size} clients:`, {
			absolutePath,
			contentLength: fileData.content.length,
		});

		// Send to all clients watching this file
		watchedFile.watchers.forEach((client) => {
			if (client.readyState === 1) {
				client.send(JSON.stringify(message));
			}
		});
	}

	private broadcastFileUpdateToClient(ws: any, absolutePath: string) {
		const watchedFile = this.watchedFiles.get(absolutePath);
		if (!watchedFile) return;

		const fileData = this.getFileData(absolutePath, watchedFile.prevBranch, watchedFile.currBranch);

		const message = {
			type: "fileUpdate",
			absolutePath,
			filename: path.basename(absolutePath),
			...fileData,
		};

		if (ws.readyState === 1) {
			ws.send(JSON.stringify(message));
			console.log(`Sent initial file data to client: ${absolutePath}`);
		}
	}

	private broadcastFileRemoval(absolutePath: string) {
		const message = {
			type: "fileRemoved",
			absolutePath,
		};

		this.wss.clients.forEach((client) => {
			if (client.readyState === 1) {
				client.send(JSON.stringify(message));
			}
		});
	}

	private broadcastAllFilesToClient(ws: any) {
		// Send current state of all watched files to newly connected client
		for (const absolutePath of this.watchedFiles.keys()) {
			this.broadcastFileUpdateToClient(ws, absolutePath);
		}
	}

	private refreshAllFilesForClient(ws: any) {
		// Refresh all files that this specific client is watching
		const clientFiles = this.clientFiles.get(ws);
		if (clientFiles) {
			for (const absolutePath of clientFiles) {
				// Re-send the file data with fresh git diff calculation
				this.broadcastFileUpdateToClient(ws, absolutePath);
			}
		}
	}

	private getFileData(absolutePath: string, prevBranch?: string, currBranch?: string): FileData {
		try {
			const content = fs.readFileSync(absolutePath, "utf8");
			let diff = "";
			let originalContent: string | undefined;
			let modifiedContent: string | undefined;

			// Generate git diff if branches are provided
			if (prevBranch && currBranch) {
				diff = this.getGitDiff(absolutePath, prevBranch, currBranch);
				// Get full content from both branches
				originalContent = this.getFileContentFromBranch(absolutePath, prevBranch);
				modifiedContent = this.getFileContentFromBranch(absolutePath, currBranch);
			} else if (prevBranch) {
				// Compare current state vs prevBranch
				diff = this.getGitDiff(absolutePath, prevBranch, "HEAD");
				originalContent = this.getFileContentFromBranch(absolutePath, prevBranch);
				modifiedContent = content; // Current working directory content
			} else {
				// Compare current state vs last commit
				diff = this.getGitDiff(absolutePath, "HEAD", null);
				originalContent = this.getFileContentFromBranch(absolutePath, "HEAD");
				modifiedContent = content; // Current working directory content
			}

			return { content, diff, originalContent, modifiedContent };
		} catch (error) {
			return {
				content: "",
				diff: "",
				error: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private getGitDiff(filePath: string, fromRef: string, toRef: string | null): string {
		try {
			// Find git repository root by walking up the directory tree
			let gitRoot = path.dirname(filePath);
			while (gitRoot !== path.dirname(gitRoot)) {
				if (fs.existsSync(path.join(gitRoot, ".git"))) {
					break;
				}
				gitRoot = path.dirname(gitRoot);
			}

			// Convert absolute path to relative path from git root
			const relativePath = path.relative(gitRoot, filePath);
			let command: string;

			if (toRef === null) {
				// Compare working directory vs fromRef
				command = `git diff ${fromRef} -- "${relativePath}"`;
			} else {
				// Compare fromRef vs toRef
				command = `git diff ${fromRef}..${toRef} -- "${relativePath}"`;
			}

			console.log(`Running git command: ${command} in ${gitRoot}`);
			return execSync(command, { cwd: gitRoot, encoding: "utf8" });
		} catch (error) {
			return `Error generating git diff: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private getFileContentFromBranch(filePath: string, branch: string): string {
		try {
			// Find git repository root by walking up the directory tree
			let gitRoot = path.dirname(filePath);
			while (gitRoot !== path.dirname(gitRoot)) {
				if (fs.existsSync(path.join(gitRoot, ".git"))) {
					break;
				}
				gitRoot = path.dirname(gitRoot);
			}

			// Convert absolute path to relative path from git root
			const relativePath = path.relative(gitRoot, filePath);
			const command = `git show ${branch}:${relativePath}`;

			console.log(`Getting file content: ${command} in ${gitRoot}`);
			return execSync(command, { cwd: gitRoot, encoding: "utf8" });
		} catch (error) {
			console.log(
				`Error getting file content from branch ${branch}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	start(port: number) {
		this.server.listen(port, () => {
			console.log("📁 File viewer server starting...");
			console.log(`🚀 Development server running at: http://localhost:${port}`);
			console.log(
				`📖 Usage: http://localhost:${port}/?java=/path/to/File.java&targets=/path/to/File.h,/path/to/File.cpp&prevBranch=4.2&currentBranch=4.3-beta`,
			);
			console.log(`📖 Example usage with fileViewer API:`);
			console.log(`fileViewer.open("/absolute/path/to/file.java", 0, "4.2", "4.3-beta")`);
			console.log(`fileViewer.open("/absolute/path/to/file.h", 1)`);
		});
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const server = new DevServer();
	const port = Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
	server.start(port);
}

export default DevServer;
