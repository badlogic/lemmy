# Internationalization (i18n) System

This directory contains the internationalization system for claude-trace.

## Supported Languages

- **English (en)** - Default/Base language
- **Spanish (es)** - Español
- **Japanese (ja)** - 日本語

## Usage

### Setting Language

#### Environment Variable (Recommended)
```bash
export CLAUDE_TRACE_LANG=es  # Spanish
export CLAUDE_TRACE_LANG=ja  # Japanese
export CLAUDE_TRACE_LANG=en  # English (default)
```

#### Automatic Detection
If no explicit language is set, the system will try to detect from system locale:
- `LANG`, `LANGUAGE`, or `LC_ALL` environment variables
- Falls back to English if detection fails

### Adding New Languages

1. Create a new translation file: `translations/{language-code}.json`
2. Copy the structure from `translations/en.json`
3. Translate all values (keep keys the same)
4. Run validation: `npm run validate:translations`

### Translation Keys

All translation keys follow a nested structure:

```typescript
{
  "cli": {
    "title": "Claude Trace",
    "errors": {
      "claudeNotFound": "❌ Claude CLI not found in PATH"
    },
    "help": {
      "extractToken": "Extract OAuth token and exit"
    }
  }
}
```

Access in code:
```typescript
import { t } from "./i18n";

console.log(t("cli.title"));                    // "Claude Trace"
console.log(t("cli.errors.claudeNotFound"));    // "❌ Claude CLI not found in PATH"
```

## Development

### Validation
```bash
npm run validate:translations
```

This checks that all languages have the same translation keys as English.

### Testing
```bash
npm run test:i18n
```

### Adding New Translations

1. Update the English base file (`translations/en.json`)
2. Update all other language files
3. Run validation to ensure completeness
4. Update TypeScript interfaces in `index.ts` if needed

## File Structure

```
src/i18n/
├── index.ts                    # Main i18n system
├── translations/
│   ├── en.json                # English (base)
│   ├── es.json                # Spanish
│   └── ja.json                # Japanese
├── validate-translations.mjs  # Validation script
└── README.md                  # This file
```

## Type Safety

The system includes TypeScript interfaces to ensure type safety for translation keys. If you add new keys, update the `TranslationKeys` interface in `index.ts`.