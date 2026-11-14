# Sign in with Google and Microsoft (OAuth)

Mr Mail can sign in to Gmail and Outlook without app passwords. You sign in in the browser at
Google or Microsoft, and Mr Mail only stores a refresh token, encrypted by Windows (safeStorage).
You can revoke it from your account at any time.

Because Mr Mail is open source and runs on your computer, it uses **your own client id**. You
create it once (free), then paste it under **Settings, Sign in with Google and Microsoft**. Until
then, app passwords work as usual.

The quickest way for Google: **Add Account, Sign in with Google, Show guide**. It has the steps
below with fields for the client id and secret, and starts the sign in as soon as you save.

## Google (Gmail)

1. Open <https://console.cloud.google.com/> and create a new project, for example `Mr Mail`.
2. **APIs and services, Library**: enable **Gmail API**.
3. **Google Auth Platform** (formerly *OAuth consent screen*):
   - App name `Mr Mail`, your email as support and contact address.
   - Audience: **External**.
   - **Test users**: add the Gmail addresses you want to use. The app can stay in testing mode,
     then Google does not need to review it.
   - **Data access, Add scopes**: add `https://mail.google.com/`.
4. **Clients, Create client**: application type **Desktop app**. Save.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**
   (starts with `GOCSPX-`). For desktop apps the secret is not really secret, but Google requires
   it. Mr Mail stores it encrypted.
6. In Mr Mail: the gear at the bottom left, paste both, **Save**.
7. Click the Gmail account in the sidebar, choose **Sign in with Google** and approve in the
   browser. Google warns that the app is not verified; that is expected in testing mode.

In testing mode Google's refresh token expires after 7 days, and Mr Mail then shows "Sign in
again". To avoid that, publish the app under **Audience, Publish app**.

Redirect: Mr Mail uses `http://127.0.0.1:<random port>/`. It does not need to be registered,
Google accepts loopback addresses for desktop apps.

## Microsoft (Outlook, Hotmail, Microsoft 365)

1. Open <https://entra.microsoft.com/>, **App registrations, New registration**.
2. Name `Mr Mail`. Account types: **Accounts in any organizational directory and personal
   Microsoft accounts**.
3. Redirect URI: platform **Public client/native (mobile and desktop)**, address
   `http://localhost`. Register.
4. Under **Authentication**: make sure `http://localhost` is listed under *Mobile and desktop
   applications* and turn on **Allow public client flows**. Save.
5. **API permissions, Add a permission, APIs my organization uses**: search
   `Office 365 Exchange Online`, choose *Delegated permissions* and add `IMAP.AccessAsUser.All`
   and `SMTP.Send`. (If they are not there, use Microsoft Graph, where they have the same names.)
   `offline_access`, `openid` and `email` are added automatically at sign in.
6. Copy the **Application (client) ID** from the overview. No client secret is needed.
7. In Mr Mail: Settings, paste it as *Microsoft client id*, **Save**.
8. Add the account as **Outlook** and choose **Sign in with Microsoft**.

For Microsoft 365 in an organization, an administrator may need to approve the app, and SMTP AUTH
must be enabled for the mailbox.

## Troubleshooting

| Message in Mr Mail | Cause |
|---|---|
| Client id missing | The fields under Settings are empty. |
| Client id or client secret is wrong | Wrong value pasted, or the client type is not Desktop app. |
| The sign in has expired or been revoked | The token was revoked or expired (Google testing mode, 7 days). Sign in again. |
| You signed in as X, but the account is Y | The wrong account was chosen in the browser. |

## How it works

OAuth 2.0 with PKCE (S256) and loopback redirect per RFC 8252, in `src/main/oauth.ts`. IMAP and
SMTP use XOAUTH2. Tokens are encrypted with safeStorage and never written to logs.
