# Control Mr Mail with AI tools (MCP)

Claude Code, Zed, opencode and other tools that speak MCP can read, sort and answer email
in Mr Mail. The tools only send when you explicitly ask for it ("send a reply to Karin").
If you ask for a draft, or want to read first, it is saved in Drafts and opened in a compose
window in the app.

## Connect

Settings, **Control with AI tools**, has ready-made lines to copy.

Claude Code:

    claude mcp add mr-mail --scope user -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\mr-mail\MrMail.exe" "%LOCALAPPDATA%\Programs\mr-mail\resources\mr-mail-mcp.cjs"

Zed, in `settings.json`:

    "context_servers": {
      "mr-mail": {
        "source": "custom",
        "command": "C:\Users\<you>\AppData\Local\Programs\mr-mail\MrMail.exe",
        "args": ["C:\Users\<you>\AppData\Local\Programs\mr-mail\resources\mr-mail-mcp.cjs"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" }
      }
    }

If Mr Mail is not running, it is started hidden in the system tray on the first call.

## Tools

| Tool | What it does |
|---|---|
| `accounts` | The accounts, status, unread count and your writing tone |
| `list_emails` | Latest emails in a folder, an account or all inboxes |
| `search_emails` | Searches all emails, including old ones, with the same syntax as the search box |
| `read_email`, `read_thread` | The whole email or the whole conversation |
| `read_attachment`, `save_attachment` | Reads an attachment as text, or saves it to disk |
| `draft_email` | Saves a draft and opens it in the app |
| `edit_draft` | Changes recipients, subject, text or attachments of an existing draft |
| `send_email`, `send_draft` | Sends, only when you have asked for it. `send_at` schedules it |
| `archive`, `trash`, `mark`, `move` | Sorts |
| `create_folder` | Creates a folder in an account |
| `senders` | Who sends the most, per category, as in the Clean up view |
| `unsubscribe` | Unsubscribes from a mailing |
| `clean_up` | Archives or trashes everything from a sender, and optionally all new emails too |
| `find_contact` | Finds addresses among the people you have emailed |
| `remind` | Hides an email and brings it back as unread at a given time |
| `show_in_app` | Shows the email, or opens a draft, in the app |

Folders can be given as `inbox`, `sent`, `drafts`, `archive`, `trash`, `junk` or the name of
a custom folder. Dates and times are written `YYYY-MM-DD HH:MM` in local time.

Tool results use English field names, for example `id`, `date`, `from`, `subject`,
`account`, `folder`, `unread`, `flagged`, `answered`, `attachments`, `thread_length` and
`snippet`.

## Older Swedish names

Earlier versions used Swedish tool and argument names (`lista_mejl`, `skriv_utkast`,
`konto`, `mapp`, `till`, `amne` and so on). They still work when called, so existing agent
setups keep running, but the tool list only shows the English names. Swedish folder names
(`inkorg`, `skickat`, `utkast`, `arkiv`, `papperskorg`) and category names (`nyhetsbrev`,
`aviseringar`, `kvitton`, `sociala`, `personligt`) are accepted as well. Replies are in
English.

## How it works

`mr-mail-mcp.cjs` speaks MCP over stdio and forwards the calls to the app through a local
bridge on 127.0.0.1. The port and a random key are in `mcp.json` in the app's data folder
and change on every start. The bridge does not accept calls from browsers. Turn it off in
Settings.

The tool list is fetched from the running app, so new tools show up after an update without
restarting your AI tool.
