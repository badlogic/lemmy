// CommonJS loader for interceptor
try {
	// Try to load the compiled JS version first
	const path = require("path");
	const fs = require("fs");

	const jsPath = path.join(__dirname, "interceptor.js");
	const tsPath = path.join(__dirname, "interceptor.ts");

	// Build config from environment variables
	const config = {};
	if (process.env.CLAUDE_TRACE_OUTPUT_DIR) {
		config.logDirectory = process.env.CLAUDE_TRACE_OUTPUT_DIR;
	}

	if (fs.existsSync(jsPath)) {
		// Use compiled JavaScript
		const { initializeInterceptor } = require("./interceptor.js");
		initializeInterceptor(config);
	} else if (fs.existsSync(tsPath)) {
		// Use TypeScript via tsx
		require("tsx/cjs/api").register();
		const { initializeInterceptor } = require("./interceptor.ts");
		initializeInterceptor(config);
	} else {
		console.error("Could not find interceptor file");
		process.exit(1);
	}
} catch (error) {
	console.error("Error loading interceptor:", error.message);
	process.exit(1);
}
