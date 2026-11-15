<div align="center">

<img src="docs/screenshots/banner.png" alt="Mr Mail: the email client your AI agent can drive" width="100%">

<br>

<a href="https://github.com/GKihlstadius/mr-mail/releases/latest"><img alt="Download" src="https://img.shields.io/github/v/release/GKihlstadius/mr-mail?style=for-the-badge&label=Download&color=f2c14e&labelColor=0a1122"></a>
<a href="https://github.com/GKihlstadius/mr-mail/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/GKihlstadius/mr-mail?style=for-the-badge&color=f2c14e&labelColor=0a1122"></a>
<a href="https://github.com/GKihlstadius/mr-mail/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/GKihlstadius/mr-mail/total?style=for-the-badge&color=f2c14e&labelColor=0a1122"></a>

<a href="https://github.com/GKihlstadius/mr-mail/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/GKihlstadius/mr-mail/ci.yml?branch=main&style=flat-square&label=CI"></a>
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square"></a>
<img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078d4?style=flat-square">
<a href="docs/mcp.md"><img alt="MCP" src="https://img.shields.io/badge/MCP-28%20tools-8a5cf6?style=flat-square"></a>
<img alt="English and Swedish" src="https://img.shields.io/badge/lang-EN%20%7C%20SV-555?style=flat-square">

### A fast, private email client for Windows that Claude Code, Zed and any MCP agent can drive.

**[Download](https://github.com/GKihlstadius/mr-mail/releases/latest)** &nbsp;·&nbsp; **[Features](#features)** &nbsp;·&nbsp; **[AI agents](#let-your-ai-agent-handle-email)** &nbsp;·&nbsp; **[FAQ](#faq)** &nbsp;·&nbsp; **[Contribute](CONTRIBUTING.md)**

<br>

<img src="docs/screenshots/demo.gif" alt="Mr Mail demo" width="860">

</div>

<br>

## Why Mr Mail

<table>
<tr>
<td width="33%" valign="top">

### Your mail stays yours
No account, no cloud sync, no tracking. Mr Mail talks IMAP and SMTP straight to your provider and keeps everything on your computer. Passwords are encrypted by Windows, remote images are blocked until you allow them.

</td>
<td width="33%" valign="top">

### Built for AI agents
A built in MCP server with 28 tools. Your agent can search, read, summarize, draft, attach files, read Word and Excel attachments, schedule, clean up, answer invitations and read and book your calendar. It never sends unless you ask.

</td>
<td width="33%" valign="top">

### Fast and calm
IMAP IDLE for instant mail, a local SQLite cache and a list that stays smooth with tens of thousands of emails. A clean design in the spirit of Apple Mail, in light and dark.

</td>
</tr>
</table>

## Let your AI agent handle email

<img src="docs/screenshots/agent.png" alt="Claude Code drafts a reply that opens in Mr Mail" width="100%">

Install Mr Mail, open **Settings, Control with AI tools** and click **Connect** next to your agent. Mr Mail adds itself to the agent's config and keeps your other settings and comments intact.

**One click for:** Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Windsurf, Zed, Gemini CLI, LM Studio and Codex CLI. Claude Desktop users can also double click `MrMail-x.y.z.mcpb` from the [latest release](https://github.com/GKihlstadius/mr-mail/releases/latest).

<details>
<summary><b>Manual setup</b> (Claude Code, Zed, any MCP client)</summary>

Claude Code:

```
claude mcp add mr-mail --scope user -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\mr-mail\MrMail.exe" "%LOCALAPPDATA%\Programs\mr-mail\resources\mr-mail-mcp.cjs"
```

Zed (`settings.json`):

```json
"context_servers": {
  "mr-mail": {
    "source": "custom",
    "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\mr-mail\\MrMail.exe",
    "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\mr-mail\\resources\\mr-mail-mcp.cjs"],
    "env": { "ELECTRON_RUN_AS_NODE": "1" }
  }
}
```

Any stdio client: run `MrMail.exe` with `ELECTRON_RUN_AS_NODE=1` and the path to `resources\mr-mail-mcp.cjs` as its only argument.

Clients that only take a URL: turn on **Accept connections over HTTP** in Settings and use `http://127.0.0.1:7337/mcp` with the bearer token shown there (MCP Streamable HTTP, localhost only).

</details>

Then just ask:

> *"Summarize what came in today and draft a reply to Karin saying Tuesday at 2 works."*<br>
> *"Save the attachment from Sam to Downloads, then reply to all with the edited image attached."*<br>
> *"Unsubscribe me from every newsletter I have not opened in three months."*<br>
> *"Find a free hour with Jonas next week and send him an invite."*

**Safe by design.** Agents never send unless you explicitly asked; otherwise they save a draft that opens in the app for you to review. You choose per action whether sending, deleting and unsubscribing is allowed, asks you first (the default) or is never allowed, and an activity log shows every call an agent made. New tools show up in your agent automatically after an app update. Full tool list: [docs/mcp.md](docs/mcp.md).

## Features

| | |
|---|---|
| **Ask Mr Mail** | A chat panel (Ctrl+J) that searches, reads, drafts and books for you with the same tools and permissions as your agents. Works with ChatGPT, a local model or your own server. |
| **Calendar** | Google Calendar, Outlook and iCloud or any CalDAV server. A calm agenda view, create and edit events, find free time, answer invitations with Yes, Maybe or No right in the email. |
| **Contacts** | Everyone you email, with history, upcoming meetings and one click to write or invite. |
| **Command palette** | Ctrl+K to jump anywhere, open recent emails, write to a contact or run any action. Ctrl+/ lists every shortcut. |
| **Smart inbox** | Tabs for Personal, Newsletters and Notifications. People you have written to always land in Personal. |
| **Clean Up** | See who sends you the most, unsubscribe in one click (RFC 8058), archive or delete everything from a sender, set rules for the future. |
| **Undo everything** | Undo send, undo archive and delete (Ctrl+Z), multi select with Ctrl and Shift. |
| **Send later and Remind me** | Schedule emails, snooze messages, get reminded if nobody replies. |
| **Notifications that do things** | Archive, mark as read or reply straight from the Windows notification. |
| **Templates and signatures** | Rich text signatures per account, reusable templates, import signatures from Spark. |
| **AI in the app** *(optional)* | Suggested replies, summaries and to dos with ChatGPT, Claude, a local model or your own OpenAI compatible server. AI in the app only ever writes drafts. |
| **Accounts** | Gmail, Outlook and Microsoft 365, iCloud and any IMAP server. Sign in with Google or Microsoft, or use an app password. |
| **Languages** | English and Swedish, following Windows or your choice. |
| **Auto update** | New releases install with one click from inside the app. |

<p align="center">
  <img src="docs/screenshots/clean-up.png" alt="Clean Up" width="49%">
  <img src="docs/screenshots/dark.png" alt="Dark mode" width="49%">
</p>

## How it compares

| | **Mr Mail** | Thunderbird | New Outlook | Spark |
|---|:---:|:---:|:---:|:---:|
| Free | ✓ | ✓ | ✓ | Freemium |
| Open source | ✓ | ✓ | | |
| Mail goes only between you and your provider | ✓ | ✓ | | |
| Built in MCP server for AI agents | ✓ | | | |
| One click setup for Claude, Cursor, VS Code and more | ✓ | | | |
| Smart inbox that puts people first | ✓ | | ✓ | ✓ |

New Outlook syncs non Microsoft accounts through Microsoft's cloud, and Spark stores account access on its own servers to deliver push and team features.

## Install

1. Download `MrMail-Setup-x.y.z.exe` from the [latest release](https://github.com/GKihlstadius/mr-mail/releases/latest), or use Scoop:
   ```
   scoop bucket add mr-mail https://github.com/GKihlstadius/mr-mail
   scoop install mr-mail/mr-mail
   ```
2. Run it. The installer is not code signed yet, so Windows SmartScreen may say it *protected your PC*: click **More info**, then **Run anyway**.
3. Add your account. Mr Mail finds the server settings for most providers automatically.

Mr Mail updates itself. The only thing it sends anywhere besides your own mail servers is a version check against the GitHub API, plus requests to the AI service you choose, if you turn AI on.

## FAQ

<details>
<summary><b>Does my email pass through any server of yours?</b></summary>

No. There is no Mr Mail server. The app connects directly to your provider over IMAP and SMTP. Your cache lives in a SQLite file under `%APPDATA%`.

</details>

<details>
<summary><b>What does an AI agent see?</b></summary>

Only what it asks for through the MCP tools, while the app is running on your computer. The MCP server talks to the app over localhost with a random token. Nothing is uploaded unless your agent itself sends it to its model.

</details>

<details>
<summary><b>Can an agent send email without asking me?</b></summary>

No. By default Mr Mail asks you in a dialog before anything is sent, deleted or unsubscribed, whichever agent asked. You can change that per action under **Settings, Control with AI tools**, and see every call in the activity log there. Agents are also told to save drafts unless you explicitly ask them to send.

</details>

<details>
<summary><b>Gmail says my password is wrong.</b></summary>

Gmail and Outlook need either an app password or sign in with Google or Microsoft. Sign in needs your own free OAuth client id, see [docs/oauth.md](docs/oauth.md).

</details>

<details>
<summary><b>macOS or Linux?</b></summary>

Not yet. The code is plain Electron and should port well; pull requests are welcome.

</details>

## Build from source

Requires Node 24 or newer, pnpm 10 and Windows.

```
pnpm install
pnpm start        # build and run
pnpm typecheck    # TypeScript and translation check
pnpm test         # unit tests (IMAP tests run when GreenMail is up)
pnpm dist         # installer in release/
```

Integration and end to end tests run against [GreenMail](https://greenmail-mail-test.github.io/greenmail/) in Docker, never against real accounts:

```
docker run -d --name mr-mail-greenmail --cpus 1 -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" greenmail/standalone:2.1.5
pnpm build && pnpm test:e2e
```

**Stack:** Electron, React, TypeScript, imapflow, nodemailer, mailparser, node:sqlite, DOMPurify. No UI framework, about 21 000 lines. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## Roadmap

- [x] MCP server with drafts, attachments, scheduling and clean up
- [x] English and Swedish
- [x] Auto update from GitHub Releases
- [x] Calendar: Google, Outlook, iCloud and CalDAV, invitations in the reader
- [x] One click setup for AI clients, MCP over HTTP, Claude Desktop extension
- [x] Chat in the app, contacts, command palette
- [ ] Code signed installer
- [ ] winget (submitted)
- [ ] More languages (translations are one file per language, see [CONTRIBUTING.md](CONTRIBUTING.md))
- [ ] macOS build

Have an idea? [Open an issue](https://github.com/GKihlstadius/mr-mail/issues/new/choose).

## Support the project

Mr Mail is free and MIT licensed. If it saves you time, you can buy me a coffee:

- **Crypto (BNB Smart Chain, Ethereum or any EVM chain):** `0x9869799157186227bA3Cc980bAE3C64E022453a0`

A star helps more people find it. Bug reports and pull requests help just as much.

<a href="https://star-history.com/#GKihlstadius/mr-mail&Date">
  <img src="https://api.star-history.com/svg?repos=GKihlstadius/mr-mail&type=Date" alt="Star history" width="600">
</a>

## På svenska

Mr Mail är en snabb och privat mejlklient för Windows, på svenska och engelska. Den pratar direkt med din mejlserver, sparar allt på datorn och låter AI-verktyg som Claude Code läsa, sortera och skriva utkast åt dig. Ladda ned den senaste versionen under [Releases](https://github.com/GKihlstadius/mr-mail/releases/latest).

## License

[MIT](LICENSE). The mascot and icon are original artwork for this project.
