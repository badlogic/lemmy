# lemmy-chat

Interactive chat application demonstrating lemmy and lemmy-tui integration with auto-generated CLI options.

## Features

- **Interactive Terminal UI**: Built with lemmy-tui differential rendering for smooth performance
- **Multi-provider Support**: Anthropic Claude, OpenAI, and Google Gemini through unified lemmy interface
- **Auto-generated CLI**: Command-line options automatically generated from TypeScript configuration interfaces
- **Persistent Defaults**: Save your preferred settings and use them automatically
- **Image Support**: Analyze images with multimodal models
- **Streaming & Thinking**: Real-time streaming with visual thinking output for supported models
- **Context Management**: Persistent conversation context across the session

## Quick Start

```bash
# Build and install
npm run build
npm run install-global

# Set API keys
export ANTHROPIC_API_KEY="sk-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="..."

# Set your defaults
lemmy-chat defaults anthropic -m claude-3-5-sonnet-20241022

# Start chatting
lemmy-chat chat
```

## Web search

Chat and one-shot messages can search the web and read public pages with
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp).
Search uses Fast mode and needs no Parallel account or API key. Your existing
model provider and credentials are used as before. The model decides when to
call `WebSearch` or `WebFetch`; these calls send their arguments to Parallel.
The anonymous service is intended for exploration and light use and has usage limits.

Search is enabled by default for models that support tools. Disable it for one
run, or save your preference in `~/.lemmy-chat/defaults.json`:

```bash
lemmy-chat chat --search off
lemmy-chat openai -m gpt-4o --search off "Explain this code"
lemmy-chat defaults --search off
lemmy-chat chat --search parallel  # Override the saved preference for this run
lemmy-chat defaults --search parallel
```

A run's `--search` takes precedence over the saved setting. Clearing defaults
restores `parallel`. Models marked as lacking tool support and requests with
`toolChoice: none` do not receive the search tools. Search failures are returned
to the model as tool errors, without switching providers. Each search/fetch call
has a 15-second deadline, and a turn stops after eight tool rounds. `/clear`
starts a fresh conversation, including its anonymous search identifier.

## Commands

### Interactive Chat Mode

Start an interactive chat session with persistent context:

```bash
# Using saved defaults
lemmy-chat chat

# With specific provider and model
lemmy-chat chat -p anthropic -m claude-3-5-sonnet-20241022
lemmy-chat chat -p openai -m gpt-4o
lemmy-chat chat -p google -m gemini-1.5-pro
```

**Features:**

- Persistent conversation context
- Real-time streaming output
- Visual thinking display (gray text) for supported models
- Token usage and cost tracking
- Professional terminal interface with proper input handling

### Defaults System

Save and manage your preferred settings:

```bash
# Set defaults (saves to ~/.lemmy-chat/defaults.json)
lemmy-chat defaults anthropic -m claude-3-5-sonnet-20241022 --thinkingEnabled
lemmy-chat defaults openai -m gpt-4o --reasoningEffort medium

# Show current defaults
lemmy-chat defaults --show

# Clear saved defaults
lemmy-chat defaults --clear

# Use defaults automatically
lemmy-chat chat                         # Interactive mode with defaults
lemmy-chat "Hello world"                # One-shot with defaults
```

### Model Discovery

Explore available models with filtering:

```bash
# List all models
lemmy-chat models

# Filter by provider
lemmy-chat models --provider anthropic
lemmy-chat models --provider openai

# Filter by capabilities
lemmy-chat models --tools               # Function calling support
lemmy-chat models --images              # Image input support
lemmy-chat models --cheap               # Cost-effective options

# JSON output for scripting
lemmy-chat models --json
```

### One-Shot Messages

Send single messages without persistent context:

```bash
# With specific provider/model
lemmy-chat anthropic -m claude-3-5-sonnet-20241022 "Explain quantum computing"
lemmy-chat openai -m gpt-4o "Write a poem about TypeScript"

# Using saved defaults
lemmy-chat "What's the capital of France?"
```

### Image Analysis

Analyze images with multimodal models:

```bash
# Single image
lemmy-chat -i screenshot.png "What's in this image?"
lemmy-chat anthropic -m claude-3-5-sonnet-20241022 -i diagram.jpg "Explain this flowchart"

# Multiple images
lemmy-chat --images before.jpg after.jpg "What changed between these images?"
```

**Supported formats**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.tif`

## Advanced Features

### Thinking/Reasoning Output

Models that support internal reasoning display their thought process:

```bash
# Anthropic thinking mode
lemmy-chat anthropic -m claude-3-5-sonnet-20241022 --thinkingEnabled "Solve this complex problem"

# OpenAI reasoning models (automatic)
lemmy-chat openai -m o1-mini --reasoningEffort high "Analyze this data"
```

Thinking appears in gray text, separated from the final response.

### Provider-Specific Options

Each provider exposes its unique capabilities:

```bash
# Anthropic options
lemmy-chat anthropic --help    # Shows thinkingEnabled, betaFeatures, etc.

# OpenAI options
lemmy-chat openai --help       # Shows reasoningEffort, organization, etc.

# Google options
lemmy-chat google --help       # Shows projectId, includeThoughts, etc.
```

## Architecture

This application demonstrates several key concepts:

### Auto-Generated CLI

- TypeScript interfaces automatically become command-line options
- Type validation, help text, and enum choices generated from code
- Perfect sync between TypeScript types and CLI arguments

### TUI Integration

- Uses lemmy-tui's differential rendering for smooth performance
- Container-based component architecture
- Proper focus management and keyboard handling

### Provider Abstraction

- Single unified interface across all LLM providers
- Context serialization and conversation management
- Streaming support with provider-specific optimizations

## Development

```bash
# Development mode
npm run dev

# Build
npm run build

# Type checking
npm run typecheck

# Deterministic search and application tests (no model or search credentials)
npm run test:run

# Test with simulation
npx tsx --no-deprecation src/index.ts chat --simulate-input "Hello world" "ENTER"
```

**Testing Commands:**
Test model switching: `npx tsx --no-deprecation src/index.ts chat --simulate-input "/" "model" "SPACE" "gpt-4o" "ENTER"`

Special input keywords: "TAB", "ENTER", "SPACE", "ESC"

## Examples

### Quick Setup Workflow

```bash
# 1. Set your preferred provider and model
lemmy-chat defaults anthropic -m claude-3-5-sonnet-20241022

# 2. Start using without repetitive options
lemmy-chat "Hello!"
lemmy-chat chat
lemmy-chat -i image.png "Describe this"
```

### Model Discovery Workflow

```bash
# Find cost-effective models with image support
lemmy-chat models --images --cheap

# Get detailed Anthropic model information
lemmy-chat models --provider anthropic

# Export model data for scripts
lemmy-chat models --json > models.json
```

### Advanced Chat Session

```bash
# Start with thinking enabled and custom limits
lemmy-chat chat -p anthropic -m claude-3-5-sonnet-20241022 --thinkingEnabled --maxOutputTokens 2000

# The session will show:
# - Gray thinking text when the model reasons internally
# - Token usage per message
# - Running conversation cost
# - Smooth terminal interface with proper line handling
```

This application serves as both a practical chat tool and a demonstration of building sophisticated CLI applications with TypeScript, unified LLM interfaces, and modern terminal UIs.
