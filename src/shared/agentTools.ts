// Verktygen som AI-agenter (Claude Code, Zed, opencode) får via MCP. Samma lista används av
// stdio-servern och av appen, som utför anropen. Namn och fält är engelska; de gamla svenska
// namnen tas emot av agent.ts men visas inte i listan.

import { APP_NAME } from './brand';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });
const num = (description: string) => ({ type: 'number', description });
const ids = { type: 'array', items: { type: 'string' }, description: 'Email ids, from list_emails or search_emails.' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const MAILBOX = 'inbox, sent, drafts, archive, trash, junk, or the name of a custom folder. Default: inbox.';

const writeFields = {
  account: str('Sending account: email address or account name. For replies, the account that received the email is used.'),
  to: str('Recipients, comma separated. Can be omitted for replies.'),
  cc: str('Cc recipients, comma separated.'),
  bcc: str('Bcc recipients, comma separated.'),
  subject: str('Subject. Can be omitted for replies and forwards.'),
  text: str('Message body in plain text. Do not include the signature, it is added automatically. The quote of the original email is also added automatically.'),
  reply_to: str('Id of the email being replied to.'),
  reply_all: bool('Reply to everyone instead of only the sender.'),
  forward: str('Id of the email to forward, with its attachments.'),
  attachments: { type: 'array', items: { type: 'string' }, description: 'Files to attach: full paths on this computer.' }
};

const sendAt = str('Send at a given time instead of now: "YYYY-MM-DD HH:MM" in local time. The email waits in the outbox in the app, where it can be undone.');

const attachmentSpec = str('Attachment number (1, 2 and so on, as shown by read_email) or file name.');

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'accounts',
    description: `Lists the email accounts in ${APP_NAME} with status and unread count, plus the user's writing tone for replies.`,
    inputSchema: obj({})
  },
  {
    name: 'list_emails',
    description: 'Lists the latest emails in a folder, newest first. Without an account, the inboxes of all accounts are shown together.',
    inputSchema: obj({
      account: str('Email address or account name. Omit for all accounts.'),
      folder: str(MAILBOX),
      unread_only: bool('Only show unread emails.'),
      limit: num('Maximum number of emails, default 25, at most 200.')
    })
  },
  {
    name: 'search_emails',
    description:
      'Searches all emails, including old ones not yet downloaded (the search runs against the server). The query can contain from:, to:, subject:, before:YYYY-MM-DD, after:YYYY-MM-DD, has:attachment, is:unread and free text.',
    inputSchema: obj({ query: str('The search query.'), limit: num('Maximum number of emails, default 25, at most 200.') }, ['query'])
  },
  {
    name: 'read_email',
    description: 'Reads an email: headers, the full text and the names of the attachments. It is not marked as read unless you ask for it.',
    inputSchema: obj({ id: str('Email id.'), mark_read: bool('Mark the email as read.') }, ['id'])
  },
  {
    name: 'read_attachment',
    description:
      'Reads the content of an attachment. Text, HTML, Word (docx), Excel (xlsx) and PowerPoint (pptx) are returned as text. Other files, such as PDFs and images, are saved to a temporary folder and you get the path so you can read the file yourself.',
    inputSchema: obj({ id: str('Email id.'), attachment: attachmentSpec }, ['id'])
  },
  {
    name: 'save_attachment',
    description: 'Saves attachments from an email as files on this computer. The default is the Downloaded files folder. Returns the paths.',
    inputSchema: obj(
      {
        id: str('Email id.'),
        attachment: str('Attachment number or file name. Omit to save all.'),
        folder: str('Folder to save in, full path. Default: the Downloaded files folder.')
      },
      ['id']
    )
  },
  {
    name: 'read_thread',
    description: 'Reads the whole conversation the email belongs to, oldest first.',
    inputSchema: obj({ id: str('Id of any email in the thread.') }, ['id'])
  },
  {
    name: 'draft_email',
    description: `Writes a draft and saves it in Drafts. It is opened in ${APP_NAME} so the user can read, change and send it. Use this when the user asks for a draft or wants to read first. Returns the draft id, which can be sent with send_draft.`,
    inputSchema: obj({ ...writeFields, open: bool(`Open the draft in a window in ${APP_NAME}. Default: yes.`) }, ['text'])
  },
  {
    name: 'send_email',
    description:
      'Sends an email right away. Use only when the user has explicitly asked for the email to be sent, for example "send a reply to Anna". If the user asks for a draft or wants to read first, use draft_email.',
    inputSchema: obj({ ...writeFields, send_at: sendAt }, ['text'])
  },
  {
    name: 'edit_draft',
    description: `Edits an existing draft in Drafts: recipients, subject, text or attachments. Existing attachments are kept. The text replaces what was written by hand, the signature and quote are kept. The draft is opened in ${APP_NAME} afterwards.`,
    inputSchema: obj(
      {
        id: str('Draft id.'),
        to: str('New recipients, replacing the old ones.'),
        cc: str('New cc, replacing the old one.'),
        bcc: str('Bcc recipients.'),
        subject: str('New subject.'),
        text: str('New message body in plain text, without the signature.'),
        attachments: { type: 'array', items: { type: 'string' }, description: 'Files to add: full paths on this computer.' },
        remove_attachments: { type: 'array', items: { type: 'string' }, description: 'Attachments to remove from the draft: numbers (as shown by read_email) or file names.' },
        open: bool(`Open the draft in ${APP_NAME}. Default: yes.`)
      },
      ['id']
    )
  },
  {
    name: 'send_draft',
    description: 'Sends an existing draft from Drafts, including any changes the user has made. Only when the user has asked for it to be sent.',
    inputSchema: obj({ id: str('Draft id.'), send_at: sendAt }, ['id'])
  },
  {
    name: 'archive',
    description: 'Moves emails to the archive.',
    inputSchema: obj({ ids }, ['ids'])
  },
  {
    name: 'trash',
    description: 'Moves emails to the trash. Emails already in the trash are deleted permanently. Only when the user has asked for it.',
    inputSchema: obj({ ids }, ['ids'])
  },
  {
    name: 'mark',
    description: 'Marks emails as read or unread, and flags or unflags them.',
    inputSchema: obj({ ids, read: bool('true for read, false for unread.'), flagged: bool('true for flagged, false for not flagged.') }, ['ids'])
  },
  {
    name: 'move',
    description: 'Moves emails to a folder in the same account.',
    inputSchema: obj({ ids, folder: str(MAILBOX) }, ['ids', 'folder'])
  },
  {
    name: 'senders',
    description:
      'The senders who send the most, for cleaning up the inbox: number of emails, share unread, category (newsletters, notifications, receipts, social, personal) and whether they can be unsubscribed from.',
    inputSchema: obj({
      category: str('newsletters, notifications, receipts, social or personal. Omit for all.'),
      account: str('Only one account: email address or account name. Omit for all.'),
      limit: num('Maximum number of senders, default 30, at most 300.')
    })
  },
  {
    name: 'unsubscribe',
    description: "Unsubscribes the user from a sender's mailings using List-Unsubscribe. Only when the user has asked for it.",
    inputSchema: obj({ address: str("The sender's email address.") }, ['address'])
  },
  {
    name: 'clean_up',
    description:
      'Archives or trashes all emails from a sender, in all accounts, including old ones not yet downloaded. With always: true it also applies to new emails from now on. Only trash when the user has asked for it.',
    inputSchema: obj(
      {
        address: str("The sender's email address."),
        action: { type: 'string', enum: ['archive', 'trash'], description: 'archive or trash.' },
        account: str('Only in one account: email address or account name. Omit for all.'),
        always: bool('Do the same automatically with new emails from the sender.'),
        older_than_days: num('Only emails older than this many days.')
      },
      ['address', 'action']
    )
  },
  {
    name: 'create_folder',
    description: 'Creates a new folder in an account, for example to sort emails with move.',
    inputSchema: obj(
      { account: str('Email address or account name.'), name: str('Folder name.'), parent_folder: str('Create it inside an existing folder (name). Omit for the top level.') },
      ['account', 'name']
    )
  },
  {
    name: 'find_contact',
    description: 'Finds email addresses among the people the user has exchanged email with, by name or part of an address.',
    inputSchema: obj({ query: str('Name or part of the address, for example Erik.') }, ['query'])
  },
  {
    name: 'remind',
    description: 'Hides an email from the inbox and shows it again as unread at a given time (snooze). Without a time the reminder is removed.',
    inputSchema: obj({ id: str('Email id.'), time: str('When, as "YYYY-MM-DD HH:MM" in local time. Omit to remove the reminder.') }, ['id'])
  },
  {
    name: 'show_in_app',
    description: `Opens ${APP_NAME} and shows the email, or opens a draft for editing.`,
    inputSchema: obj({ id: str('Email or draft id.') }, ['id'])
  }
];

export const AGENT_INSTRUCTIONS = [
  `${APP_NAME} is the user's email client. With these tools you read, sort and answer the user's email.`,
  `Do what the user asks: if the user says "send", send with send_email or send_draft. If the user asks for a draft, or wants to read first, use draft_email so it opens in ${APP_NAME}.`,
  'Never send anything the user has not explicitly asked to be sent. Never delete anything without being asked.',
  'Read attachments with read_attachment and save them with save_attachment. Attach files from the computer with the attachments field in draft_email and send_email.',
  'Write in the user\'s tone (see accounts) and in the language of the conversation or of the email being answered. Use no em dashes or en dashes and no emojis. The signature and the quote are added automatically.'
].join('\n');

// Gamla svenska verktygsnamn som fortfarande tas emot vid anrop, men inte visas i listan.
export const TOOL_ALIASES: Record<string, string> = {
  konton: 'accounts',
  lista_mejl: 'list_emails',
  sok_mejl: 'search_emails',
  las_mejl: 'read_email',
  las_bilaga: 'read_attachment',
  spara_bilaga: 'save_attachment',
  las_trad: 'read_thread',
  skriv_utkast: 'draft_email',
  andra_utkast: 'edit_draft',
  skicka_mejl: 'send_email',
  skicka_utkast: 'send_draft',
  arkivera: 'archive',
  radera: 'trash',
  markera: 'mark',
  flytta: 'move',
  skapa_mapp: 'create_folder',
  avsandare: 'senders',
  avregistrera: 'unsubscribe',
  stada: 'clean_up',
  sok_kontakt: 'find_contact',
  paminn: 'remind',
  visa_i_brevlada: 'show_in_app'
};

export type AgentArgs = Record<string, unknown>;
