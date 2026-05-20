# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
```

Run from source:

```bash
/path/to/prime-agent/prime-agent.sh
```

The script can be run from any directory. Prime Agent keeps the caller's current working directory.

## Local Configuration

User configuration lives under `~/.prime/agent/`. Project-local settings, prompts, themes, extensions, and skills live under `.prime/agent/` in the project root. Override the user config directory with `PRIME_AGENT_CODING_AGENT_DIR`.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.prime/agent/prime-agent-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
