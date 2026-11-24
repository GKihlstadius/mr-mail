# Changelog

## 0.7.2

- **Trusted senders:** images from the internet load right away for senders you trust. Everyone else stays blocked until you allow it.
- The account name under each message is now plain text, without a colored dot.
- The installer no longer puts a shortcut on the desktop. Mr Mail is in the Start menu.

## 0.7.1

- Fixed: when upgrading from Brevlåda, an empty "Mr Mail" data folder could make the app start without your accounts. The app now picks the folder that actually has a database.

## 0.7.0

- **Calendar:** Google Calendar, Outlook (Microsoft Graph) and iCloud, Fastmail or any CalDAV server. Agenda view, create and edit events, invite people, find free time. Outlook asks for calendar access only when you connect the calendar.
- **Invitations in the reader:** answer Yes, Maybe or No right in the email; the reply goes to the organizer and your calendar is updated.
- **Ask Mr Mail:** a chat panel (Ctrl+J) that uses the same tools and permissions as MCP agents. Works with ChatGPT (API key), a local model or your own OpenAI compatible server.
- **Contacts** with history and upcoming meetings, and a **command palette** (Ctrl+K). Ctrl+/ lists all shortcuts.
- **One click setup** for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed, Gemini CLI, LM Studio and Codex CLI.
- **MCP over HTTP** for URL only clients, and a **Claude Desktop extension** (.mcpb) in every release.
- **Permissions and activity log:** choose allow, ask or never for sending, deleting and unsubscribing. Default is ask.
- 28 MCP tools, including calendar tools and answering invitations.
- Scoop bucket. Installs from Scoop leave updates to Scoop.
- Fixed: a fast AI reply could be overwritten in the compose window.

## 0.6.1

- New icon: a retro mascot with a letter.
- The taskbar shows the Mr Mail icon instead of the Electron icon.
- CI and release workflows: tagged versions are built and published automatically.

## 0.6.0

First public release.

- English and Swedish, following Windows or your choice.
- MCP server with 22 tools for Claude Code, Zed and other agents: search, read, draft, edit drafts, attachments, scheduling, reminders, folders and clean up.
- Agents can read Word, Excel and PowerPoint attachments and save attachments to disk.
- Smart inbox, Clean Up with one click unsubscribe, undo send, send later, reminders, templates and signatures.
- Updates from GitHub Releases.
