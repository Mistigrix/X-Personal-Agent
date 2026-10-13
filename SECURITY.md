# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use your Git host's private vulnerability reporting (on GitHub: Security → Report a vulnerability) and include:

- what an attacker could do, and under which conditions;
- steps to reproduce, or a proof of concept;
- the version or commit affected.

Never include real credentials, tokens or private post content in a report.

## Scope

Of particular interest:
- any way to publish an AI-generated post **without an explicit approval of its exact text**;
- any way for a Telegram user who is not allowlisted to act on the bot;
- any credential appearing in logs, error messages, the database or the repository;
- any way to publish the same post twice automatically.

How the agent handles secrets and data is described in [docs/security.md](docs/security.md).
