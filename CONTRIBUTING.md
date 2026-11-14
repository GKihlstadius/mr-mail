# Contributing to Mr Mail

Thanks for wanting to help. Bug reports, translations and pull requests are all welcome.

## Getting started

Requires Windows, Node 24 or newer and pnpm 10.

```
pnpm install
pnpm start          # build and run the app
pnpm typecheck      # TypeScript plus the translation check
pnpm test           # unit tests
```

The layout is described in [AGENTS.md](AGENTS.md): `src/main` is the Electron main process (IMAP, SMTP, cache, MCP tools), `src/renderer` the React UI, `src/shared` code used by both.

## Testing

Unit tests run with `pnpm test`. Integration and end to end tests use [GreenMail](https://greenmail-mail-test.github.io/greenmail/) in Docker and never touch real accounts:

```
docker run -d --name mr-mail-greenmail --cpus 1 -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" greenmail/standalone:2.1.5
pnpm build && pnpm test:e2e
docker stop mr-mail-greenmail
```

Please run `pnpm typecheck` and `pnpm test` before opening a pull request. If you change the UI, run the e2e suite too.

## Guidelines

- **Small pull requests.** One fix or feature per PR, with a short description of why.
- **Every visible string goes through `t()`** from `src/shared/i18n.ts`. Swedish is the key; add the English text in `src/shared/i18n/en/*.ts`. `pnpm typecheck` fails on missing translations.
- **Style:** no em dashes or en dashes in any text, no emojis in code or commit messages.
- **Design:** clean and calm, in the spirit of Apple Mail. No heavy UI frameworks.
- **Security:** secrets only through Electron safeStorage, never in logs. HTML email is always sanitized.
- **AI safety:** nothing is ever sent automatically. MCP tools send only when the user explicitly asked.

## Adding a language

1. Copy `src/shared/i18n/en/` to a new folder, for example `de/`, and translate the values.
2. Register it in `src/shared/i18n.ts` and add it to the language picker in Settings.
3. Run `pnpm typecheck` to find anything missing.

## Reporting bugs

Use the [bug report template](https://github.com/GKihlstadius/mr-mail/issues/new/choose). Include your Windows version, your mail provider and what you expected to happen. Never paste passwords, tokens or private email content.
