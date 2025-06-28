# Lemmy Monorepo

A TypeScript ecosystem for building AI applications with unified LLM interfaces, terminal UIs, and practical tools.

## 🚀 Quick Start

```bash
# Clone and install
git clone https://github.com/mariozechner/lemmy
cd lemmy && npm install

# Start development mode
npm run dev

# Run tests
npm run test
```

## Core Packages

### [@mariozechner/lemmy](./packages/lemmy/)

TypeScript library for building AI applications with multiple LLM providers. Unified interface, manual tool handling, and conversation management across Anthropic Claude, OpenAI, and Google Gemini.

**Key Features:**

- Multi-provider support (Anthropic, OpenAI, Google)
- Manual tool execution with interception capabilities
- Context serialization and conversation management
- Streaming with thinking/reasoning support
- Type-safe tool definitions with Zod schemas

### [@mariozechner/lemmy-tui](./packages/lemmy-tui/)

Terminal UI framework with differential rendering for building interactive CLI applications.

**Key Features:**

- Differential rendering for performance
- Text editing, autocomplete, and selection components
- Markdown rendering and syntax highlighting
- Composable component architecture

## Applications

### [claude-bridge](./apps/claude-bridge/)

Use OpenAI, Google, and other LLM providers with Claude Code by intercepting and transforming API requests.

### [lemmy-chat](./apps/lemmy-chat/)

Interactive chat application demonstrating lemmy and lemmy-tui integration. Work in progress.

### [red-teaming](./apps/red-teaming/)

Red teaming example. See [BlueSky Thread](https://bsky.app/profile/badlogic.bsky.social/post/3lpz4hkziwc2c)

### [snap-happy](./apps/snap-happy/)

Screenshot capture MCP server.

### [claude-trace](./apps/claude-trace/)

Trace and analyze Claude Code conversations with rich visualization. See [Twitter Thread](https://nitter.net/badlogicgames/status/1929312803799576757#m), [Simon Willison Blog Post](https://simonwillison.net/2025/Jun/2/claude-trace/)

## 📖 Documentation

- **[Core Library Documentation](./packages/lemmy/README.md)** - Detailed API reference and examples
- **[TUI Framework Guide](./packages/lemmy-tui/README.md)** - Building terminal interfaces
- **[Architecture Overview](./CLAUDE.md)** - Internal structure and development notes

## 🛠️ Development

### Prerequisites

- Node.js 18+
- npm 7+
- TypeScript 5+

### Commands

```bash
npm run build     # Build all packages and apps
npm run clean     # Clean all dist folders
npm run typecheck # Type check all projects
npm run test      # Run all tests
npm run dev       # Start compilation in watch mode
```

### Testing Individual Packages

```bash
# Test core library
cd packages/lemmy && npm run test:run

# Test TUI components
cd packages/lemmy-tui
npx tsx --no-deprecation src/index.ts chat --simulate-input "Hello world" "ENTER"
```

### Monorepo Structure

- Dependencies build in correct order (packages before apps)
- Unified scripts run across all workspaces
- TypeScript project references for incremental compilation
- Shared configuration for consistent development

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
