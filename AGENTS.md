# Mr Mail

Lightweight email client for Windows. Electron, React 19, TypeScript, ESM. IMAP with imapflow,
parsing with mailparser, SMTP with nodemailer, cache in `node:sqlite`, secrets with Electron
`safeStorage`.

## Layout

    src/main      main process: imap.ts, smtp.ts, db.ts, ai.ts, parse.ts, agent.ts (MCP tools), main.ts
    src/mcp       stdio MCP server that forwards calls to the running app
    src/preload   preload.ts, the only bridge to the renderer
    src/renderer  React UI (App.tsx, Compose.tsx, components/)
    src/shared    types, accounts, sanitizing, prompts, i18n
    tests         vitest, integration tests against GreenMail in Docker
    scripts       build, e2e (Playwright against Electron), screenshots, translation check

## Commands

    pnpm typecheck        TypeScript plus translation check, must be clean
    pnpm test             vitest (GreenMail tests run when it is up)
    pnpm build && pnpm test:e2e    whole app through Playwright (does not build by itself)
    pnpm dist             NSIS installer in release/

## Rules

- Languages: Swedish is the source language in code. Wrap every user visible string in `t()`
  from `src/shared/i18n.ts` and add the English text to `src/shared/i18n/en/*.ts`. Never call
  `t()` at module level. `pnpm typecheck` fails on missing translations.
- No em dashes or en dashes in any text, Swedish or English. No emojis in code or commits.
- Design: like Apple Mail. Clean, airy, Segoe UI Variable, soft corners, light and dark mode.
  No heavy UI frameworks.
- Security: passwords and OAuth tokens only through safeStorage, never in logs. HTML email is
  sanitized with DOMPurify in a locked frame, remote images blocked until the user allows them.
- Nothing is sent automatically. AI in the app only writes drafts. MCP tools only send when the
  user explicitly asked; otherwise a draft is saved and opened in the app.
- Test against GreenMail, never against real accounts.
- GreenMail can spin and eat every core: start it with `--cpus 1` and stop it when done.
