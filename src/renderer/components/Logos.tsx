// Märken för kontoval. Google-G:t följer Googles riktlinjer för knappen Logga in med Google,
// övriga är enkla symboler i leverantörens färg.

export function GoogleLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function Tile({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <span className="logo-tile" style={{ background: bg }} aria-hidden="true">
      {children}
    </span>
  );
}

export function SimplyLogo() {
  return (
    <Tile bg="linear-gradient(135deg,#25b88a,#13916a)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M16.5 7.2c-1-1.1-2.6-1.7-4.3-1.7-2.4 0-4.2 1.3-4.2 3.2 0 4.3 8.8 2.4 8.8 6.8 0 2-1.9 3.3-4.5 3.3-1.9 0-3.6-.7-4.6-1.9" />
      </svg>
    </Tile>
  );
}

export function ICloudLogo() {
  return (
    <Tile bg="linear-gradient(180deg,#5fb0ff,#2f7ff0)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
        <path d="M7.2 18.5h10.3a3.8 3.8 0 0 0 .5-7.57A5.3 5.3 0 0 0 7.8 9.6a4.45 4.45 0 0 0-.6 8.9Z" />
      </svg>
    </Tile>
  );
}

export function OutlookLogo() {
  return (
    <Tile bg="linear-gradient(135deg,#1d8fe1,#0f5fb8)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4">
        <ellipse cx="12" cy="12" rx="5.6" ry="6.6" />
      </svg>
    </Tile>
  );
}

export function OtherLogo() {
  return (
    <Tile bg="linear-gradient(180deg,#9a9aa2,#74747c)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
        <path d="m4.5 7 7.5 6 7.5-6" />
      </svg>
    </Tile>
  );
}
