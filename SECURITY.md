# Security policy

Mr Mail handles email and credentials, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through [GitHub security advisories](https://github.com/GKihlstadius/mr-mail/security/advisories/new). You will get an answer within a few days.

Helpful details: affected version, steps to reproduce and the impact you see.

## Supported versions

Only the latest release gets fixes. Mr Mail updates itself, so most users are on it within days.

## How Mr Mail protects you

- Passwords and OAuth tokens are encrypted with Windows (Electron safeStorage) and never written to logs.
- HTML email is sanitized with DOMPurify and rendered in a locked frame without scripts. Remote images are blocked until you allow them.
- The MCP bridge listens only on 127.0.0.1 and requires a random token created at each start.
- There is no Mr Mail server. Mail goes directly between the app and your provider.
