import type { SVGProps, ReactNode } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Inbox = (p: P) => (
  <Svg {...p}>
    <path d="M3 13.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4.5" />
    <path d="M3 13.5 5.6 5.6A2 2 0 0 1 7.5 4.2h9a2 2 0 0 1 1.9 1.4L21 13.5h-5a1 1 0 0 0-1 1 3 3 0 0 1-6 0 1 1 0 0 0-1-1H3Z" />
  </Svg>
);
export const Send = (p: P) => (
  <Svg {...p}>
    <path d="M21 3 10.5 13.5" />
    <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
  </Svg>
);
export const Draft = (p: P) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);
export const Trash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
  </Svg>
);
export const Archive = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
    <path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4" />
  </Svg>
);
export const Junk = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 5 5.8v5.4c0 4 2.9 7.5 7 8.8 4.1-1.3 7-4.8 7-8.8V5.8L12 3Z" />
    <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
  </Svg>
);
export const Folder = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V7.5Z" />
  </Svg>
);
export const Tag = (p: P) => (
  <Svg {...p}>
    <path d="M12.5 3H5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 .6 1.4l6.5 6.5a2 2 0 0 0 2.8 0l6.5-6.5a2 2 0 0 0 0-2.8L13.9 3.6A2 2 0 0 0 12.5 3Z" />
    <circle cx="8" cy="8" r="1.3" />
  </Svg>
);
export const MoveTo = (p: P) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V7.5Z" />
    <path d="M12 10.5v4M10 12.7l2 2 2-2" />
  </Svg>
);
export const Reply = (p: P) => (
  <Svg {...p}>
    <path d="M9 15 4 10l5-5" />
    <path d="M4 10h10a6 6 0 0 1 6 6v3" />
  </Svg>
);
export const ReplyAll = (p: P) => (
  <Svg {...p}>
    <path d="M8 15 3 10l5-5" />
    <path d="M12 15 7 10l5-5" />
    <path d="M7 10h8a6 6 0 0 1 6 6v3" />
  </Svg>
);
export const Forward = (p: P) => (
  <Svg {...p}>
    <path d="m15 15 5-5-5-5" />
    <path d="M20 10H10a6 6 0 0 0-6 6v3" />
  </Svg>
);
export const Flag = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return (
    <Svg {...rest}>
      <path d="M5 21V4" />
      <path d="M5 4h11.5l-2 4 2 4H5" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  );
};
export const Envelope = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m4 7 8 6 8-6" />
  </Svg>
);
export const EnvelopeOpen = (p: P) => (
  <Svg {...p}>
    <path d="M3 10v8.5A1.5 1.5 0 0 0 4.5 20h15a1.5 1.5 0 0 0 1.5-1.5V10" />
    <path d="M3 10 12 3.5 21 10l-9 6-9-6Z" />
  </Svg>
);
export const Compose = (p: P) => (
  <Svg {...p}>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    <path d="M18.4 3.6a2 2 0 0 1 2.8 2.8L12 15.6l-3.6.8.8-3.6 9.2-9.2Z" />
  </Svg>
);
export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const Sparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9L12 3.5Z" />
  </Svg>
);
export const Broom = (p: P) => (
  <Svg {...p}>
    <path d="M19.5 3.5 12.6 10.4" />
    <path d="M10.9 9.6c1.5-.8 3.3.2 3.5 1.9l.1.6-5.6 7.4c-1.6-.1-3.3-.7-4.7-2.1-.6-.6-1-1.2-1.3-1.8l1.5-.4 1.6-2.1-1.7.3c.2-1.1.9-2.2 2.1-3.1Z" />
    <path d="m8.7 19.5 1.6-3.2M6.2 17.6l2-2.3" />
  </Svg>
);
export const Paperclip = (p: P) => (
  <Svg {...p}>
    <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7" />
  </Svg>
);
export const Gear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
);
export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const Chevron = (p: P) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
export const Close = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg strokeWidth={2.2} {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);
export const Image = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);
export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.8-3.5M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.8 3.5M20 20v-4h-4" />
  </Svg>
);
export const Stack = (p: P) => (
  <Svg {...p}>
    <path d="M4 9.5 12 5l8 4.5-8 4.5-8-4.5Z" />
    <path d="m4 14 8 4.5 8-4.5" />
  </Svg>
);
export const Bold = (p: P) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </Svg>
);
export const Italic = (p: P) => (
  <Svg {...p}>
    <path d="M10 5h8M6 19h8M14.5 5 9.5 19" />
  </Svg>
);
export const Link = (p: P) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const ListBullet = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <circle cx="5" cy="6" r="1" fill="currentColor" />
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="5" cy="18" r="1" fill="currentColor" />
  </Svg>
);
export const ListNumber = (p: P) => (
  <Svg {...p}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 5l1.5-1v5M3.8 13.2c.3-.7 2.7-.9 2.4.6-.2.8-2.4 2-2.4 2.2h2.6" strokeWidth={1.3} />
  </Svg>
);
export const Quote = (p: P) => (
  <Svg {...p}>
    <path d="M5 5v14" strokeWidth={2.4} />
    <path d="M10 8h9M10 12h9M10 16h6" />
  </Svg>
);
export const Clock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const Printer = (p: P) => (
  <Svg {...p}>
    <path d="M7 9V4h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
    <path d="M7 14h10v6H7z" />
  </Svg>
);
export const Filter = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Svg>
);
export const Calendar = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);
export const Pin = (p: P) => (
  <Svg {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.3" />
  </Svg>
);
export const Video = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="6.5" width="12.5" height="11" rx="2.2" />
    <path d="m15.5 10.5 5-3v9l-5-3" />
  </Svg>
);
export const People = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.2A5.4 5.4 0 0 1 20.5 19" />
  </Svg>
);
