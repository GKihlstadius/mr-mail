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
| `respond_to_invite` | Answers a calendar invitation in an email: accept, tentative or decline |
| `list_events` | Calendar events in a period, from all connected calendars |
| `find_free_time` | Free slots for a meeting of a given length, within working hours |
| `create_event` | Creates an event; with attendees it sends invitations |
| `update_event`, `delete_event` | Changes or deletes an event from `list_events` |

Folders can be given as `inbox`, `sent`, `drafts`, `archive`, `trash`, `junk` or the name of
a custom folder. Dates and times are written `YYYY-MM-DD HH:MM` in local time.

Tool results use English field names, for example `id`, `date`, `from`, `subject`,
`account`, `folder`, `unread`, `flagged`, `answered`, `attachments`, `thread_length` and
`snippet`.

## Calendar

The calendar tools use the calendars connected in Mr Mail: Google and Outlook through their
sign in, iCloud, Fastmail and other CalDAV servers with the account password. See
[oauth.md](oauth.md#calendar). Events are cached for the past week and the next 60 days, so
`list_events` and `find_free_time` answer fast; other periods are fetched from the server.

- Times are `YYYY-MM-DD HH:MM` in local time, or `YYYY-MM-DD` for all day events. For all day
  events `end` is the last day.
- `find_free_time` looks within working hours, 09:00 to 17:00 on weekdays by default
  (`work_start`, `work_end`, `include_weekends`). All day events, free time and declined
  meetings do not count as busy.
- `read_email` shows a short summary of a calendar invitation, and `respond_to_invite` sends
  the answer to the organizer from the invited account and updates the calendar.

Permissions follow the settings under **Control with AI tools**: `respond_to_invite`, and
`create_event` or `update_event` that send invitations or changes to attendees, count as
sending. `delete_event` counts as deleting, and also as sending when attendees are told the
meeting is cancelled. Creating an event without attendees only needs the user's request.

## Older Swedish names

Earlier versions used Swedish tool and argument names (`lista_mejl`, `skriv_utkast`,
`konto`, `mapp`, `till`, `amne` and so on). The calendar tools also have Swedish names:
`svara_pa_inbjudan`, `lista_handelser`, `hitta_ledig_tid`, `skapa_handelse`, `andra_handelse`
and `ta_bort_handelse`. They still work when called, so existing agent
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
