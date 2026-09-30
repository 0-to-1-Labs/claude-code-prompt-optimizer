# Contributing to Claude Code Prompt Optimizer

First off, thank you for considering contributing to the Claude Code Prompt Optimizer! 🎉

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- Clear and descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- Your environment (OS, Node.js version, Claude Code version)
- Any relevant error messages or the optimizer log (it holds no prompt text)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When suggesting an enhancement:

- Use a clear and descriptive title
- Provide a detailed description of the proposed functionality
- Explain why this enhancement would be useful
- Include code examples if applicable

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Ensure your code follows the existing style
3. Run the checks below
4. Write a clear commit message
5. Submit your pull request

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/claude-code-prompt-optimizer.git
cd claude-code-prompt-optimizer

# Install dependencies (including dev tools)
npm install

# Type-check and build the bundle
npm run typecheck
npm run build

# Fast path check (free, no model call)
npm test

# Full run against the model (costs money)
npm run smoke
```

`bash -n src/hooks/optimize-prompt.sh` and `shellcheck src/hooks/optimize-prompt.sh`
should also be clean. Bump `version` in both `package.json` and
`.claude-plugin/plugin.json` for a release.

## Code Style

- Use TypeScript for all new code
- Follow existing formatting (2 spaces, single quotes, semicolons)
- Add JSDoc comments for public functions
- Keep functions small and focused

## Testing

- There is no automated test suite yet. `npm test` covers the fast path only.
- Verify a change end to end with one `<optimize>` prompt in Claude Code and read the log.

## Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit first line to 72 characters
- Reference issues and pull requests when relevant

## Questions?

Feel free to open an issue with the `question` label or start a discussion in the GitHub Discussions section.

Thank you for contributing! 🚀
