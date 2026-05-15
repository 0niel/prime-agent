# Quickstart

This page gets you from install to a useful first Prime Agent session.

## Install

Install Prime Agent with curl:

```bash
curl -fsSL https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.sh | sh
```

Or with npm:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Then start Prime Agent in the project directory you want it to work on:

```bash
cd /path/to/project
prime-agent
```

## Authenticate

Prime Agent can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Prime Agent and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching Prime Agent:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

You can also run `/login` and select an API-key provider to store the key in `~/.prime/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Prime Agent starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Prime Agent gives the model one tool:

- `ipython` - run Python in a persistent kernel

Additional built-in tools (`bash`, `edit`) are available through tool options. Prime Agent runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give Prime Agent project instructions

Prime Agent loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Prime Agent loads:

- `~/.prime/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Prime Agent, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
prime-agent @README.md "Summarize this"
prime-agent @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
prime-agent -c                  # Continue most recent session
prime-agent -r                  # Browse previous sessions
prime-agent --session <path|id> # Open a specific session
```

Inside Prime Agent, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
prime-agent -p "Summarize this codebase"
cat README.md | prime-agent -p "Summarize this text"
prime-agent -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Pi](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Pi Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
