import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createSanitizer } from '../../shared/sanitize';
import { htmlToText } from '../../shared/richtext';
import { cx } from '../util';
import { t, getLang } from '../../shared/i18n';
import * as I from './Icons';

const sanitize = createSanitizer(window as any);

export interface RichEditorHandle {
  getHtml(): string;
  getText(): string;
  setHtml(html: string): void;
  focus(): void;
  element(): HTMLDivElement | null;
}

interface Props {
  initialHtml: string;
  busy?: boolean;
  placeholder?: string;
  // Behåll fjärrbilder vid inklistring, för signaturer med länkade logotyper.
  allowRemote?: boolean;
  label?: string;
  onChange(): void;
}

// Rensar inklistrad eller inläst HTML: bara säkra taggar, inga fjärrbilder, ingen yttre omslagsdiv.
// Signaturer får behålla länkade bilder (allowRemote), annat klistras in utan fjärrbilder.
export function cleanHtml(html: string, opts: { allowRemote?: boolean } = {}): string {
  const clean = sanitize(html, { allowRemote: !!opts.allowRemote }).html;
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.querySelectorAll('style, title, meta').forEach((n) => n.remove());
  let root: Element = doc.body;
  while (root.children.length === 1 && root.firstElementChild!.tagName === 'DIV' && !root.firstElementChild!.className && root.textContent === root.firstElementChild!.textContent) {
    const only = root.firstElementChild as HTMLElement;
    if (!/font-family/i.test(only.getAttribute('style') ?? '')) break;
    root = only;
  }
  return root.innerHTML;
}

function normalizeUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  return `https://${v}`;
}

type Cmd = 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList';

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ initialHtml, busy, placeholder, allowRemote, label, onChange }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const refresh = useRef<() => void>(() => undefined);

  useImperativeHandle(ref, () => ({
    getHtml: () => el.current?.innerHTML ?? '',
    getText: () => (el.current ? htmlToText(el.current) : ''),
    setHtml: (html: string) => {
      if (el.current) el.current.innerHTML = html;
    },
    focus: () => {
      const node = el.current;
      if (!node) return;
      node.focus();
      const range = document.createRange();
      range.setStart(node, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    },
    element: () => el.current
  }));

  useEffect(() => {
    if (el.current) el.current.innerHTML = initialHtml;
    try {
      document.execCommand('defaultParagraphSeparator', false, 'div');
    } catch {
      /* stöds inte */
    }
  }, []);

  useEffect(() => {
    const update = () => {
      if (!el.current || !el.current.contains(document.getSelection()?.anchorNode ?? null)) return;
      const next: Record<string, boolean> = {};
      for (const c of ['bold', 'italic', 'insertUnorderedList', 'insertOrderedList']) next[c] = document.queryCommandState(c);
      let n: Node | null = document.getSelection()?.anchorNode ?? null;
      while (n && n !== el.current) {
        if (n.nodeName === 'BLOCKQUOTE') next.quote = true;
        n = n.parentNode;
      }
      setActive(next);
    };
    refresh.current = update;
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

  const exec = (cmd: Cmd) => {
    el.current?.focus();
    document.execCommand(cmd);
    refresh.current();
    onChange();
  };

  const toggleQuote = () => {
    el.current?.focus();
    document.execCommand(active.quote ? 'outdent' : 'formatBlock', false, active.quote ? undefined : 'blockquote');
    onChange();
  };

  const openLink = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
    else savedRange.current = null;
    const a = (sel?.anchorNode?.parentElement?.closest('a') as HTMLAnchorElement | null) ?? null;
    setLinkValue(a?.getAttribute('href') ?? '');
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = normalizeUrl(linkValue);
    setLinkOpen(false);
    const node = el.current;
    if (!node) return;
    node.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    if (!url) document.execCommand('unlink');
    else if (sel && !sel.isCollapsed) document.execCommand('createLink', false, url);
    else document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${linkValue.trim().replace(/[<>&]/g, '')}</a>&nbsp;`);
    onChange();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();
    if (html) document.execCommand('insertHTML', false, cleanHtml(html, { allowRemote }));
    else document.execCommand('insertText', false, text);
    onChange();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') {
      e.preventDefault();
      exec('bold');
    } else if (k === 'i') {
      e.preventDefault();
      exec('italic');
    } else if (k === 'k') {
      e.preventDefault();
      openLink();
    }
  };

  const tool = (label: string, on: boolean | undefined, onClick: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      className={cx('fmt-btn', on && 'on')}
      title={label}
      aria-label={label}
      aria-pressed={!!on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <div className="rich">
      <div className="fmt-bar" role="toolbar" aria-label={t('Formatering')}>
        {tool(t('Fet (Ctrl+B)'), active.bold, () => exec('bold'), <I.Bold size={15} />)}
        {tool(t('Kursiv (Ctrl+I)'), active.italic, () => exec('italic'), <I.Italic size={15} />)}
        {tool(t('Länk (Ctrl+K)'), linkOpen, openLink, <I.Link size={15} />)}
        <span className="fmt-sep" />
        {tool(t('Punktlista'), active.insertUnorderedList, () => exec('insertUnorderedList'), <I.ListBullet size={15} />)}
        {tool(t('Numrerad lista'), active.insertOrderedList, () => exec('insertOrderedList'), <I.ListNumber size={15} />)}
        {tool(t('Citat'), active.quote, toggleQuote, <I.Quote size={15} />)}
        {linkOpen && (
          <form
            className="fmt-link"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
          >
            <input
              autoFocus
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setLinkOpen(false);
                  el.current?.focus();
                }
              }}
              placeholder={t('Webbadress eller e-post')}
              aria-label={t('Länkadress')}
              spellCheck={false}
            />
            <button type="submit" className="btn small primary">
              {t('Lägg till')}
            </button>
          </form>
        )}
      </div>
      <div
        ref={el}
        className={cx('editor', busy && 'ai-writing')}
        contentEditable={!busy}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label ?? t('Meddelande')}
        data-placeholder={placeholder}
        spellCheck
        lang={getLang()}
        onInput={onChange}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        onKeyUp={() => refresh.current()}
      />
    </div>
  );
});
