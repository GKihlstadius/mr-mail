import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiEngine, OutboxInfo, ReminderKind, FolderRole, FullMessage, MailboxSelection, MessageSummary, SearchQuery } from '../shared/types';
import { isEmptyQuery, parseSearch } from '../shared/search';
import { api, type AppState, type SparkExport } from './api';
import { Sidebar } from './components/Sidebar';
import { MessageList } from './components/MessageList';
import { Reader } from './components/Reader';
import { AccountDialog } from './components/AccountDialog';
import { SignaturesDialog, SparkImportDialog } from './components/Signatures';
import { SettingsDialog } from './components/SettingsDialog';
import { CleanView } from './components/CleanView';
import { OutboxDialog, UndoSend } from './components/Outbox';
import { AiTools, QuickReplies } from './components/AiAssist';
import { whenText } from './components/PopMenu';
import { BulkPanel, type BulkAction } from './components/BulkPanel';
import { isGmailAllMail } from './folderTree';
import * as I from './components/Icons';
import { badgeDataUrl, printDocument } from './print';
import { t, tn } from '../shared/i18n';

const ROLE_TITLES_SV: Record<FolderRole, string> = {
  inbox: 'Inkorg',
  sent: 'Skickat',
  drafts: 'Utkast',
  trash: 'Papperskorg',
  archive: 'Arkiv',
  junk: 'Skräppost',
  other: 'Mapp'
};

// Översättning sker vid visning, aldrig på modulnivå.
const roleTitle = (role: FolderRole) => t(ROLE_TITLES_SV[role]);

const PAGE = 500;

type InboxTab = 'personal' | 'newsletter' | 'notification' | 'all';
const inboxTabs = (): { id: InboxTab; label: string }[] => [
  { id: 'all', label: t('Alla') },
  { id: 'personal', label: t('Personligt') },
  { id: 'newsletter', label: t('Nyhetsbrev') },
  { id: 'notification', label: t('Aviseringar') }
];
const tabOf = (m: MessageSummary): InboxTab =>
  !m.category || m.category === 'personal' ? 'personal' : m.category === 'newsletter' ? 'newsletter' : 'notification';
const tabEmpty = (): Record<InboxTab, string> => ({
  personal: t('Inga personliga mejl.'),
  newsletter: t('Inga nyhetsbrev.'),
  notification: t('Inga aviseringar, kvitton eller sociala mejl.'),
  all: t('Inga meddelanden.')
});

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [selection, setSelection] = useState<MailboxSelection>({ kind: 'unified', role: 'inbox' });
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<FullMessage | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [accountDialog, setAccountDialog] = useState<{ accountId?: string; login?: boolean } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signaturesOpen, setSignaturesOpen] = useState(false);
  const [sparkImport, setSparkImport] = useState<SparkExport | null>(null);
  const sparkChecked = useRef(false);
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toastTimer = useRef<number | null>(null);
  const openSeq = useRef(0);
  const [filters, setFilters] = useState<Partial<SearchQuery>>({});
  const [limit, setLimit] = useState(PAGE);
  const [serverHits, setServerHits] = useState<MessageSummary[]>([]);
  const [serverBusy, setServerBusy] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const exhausted = useRef(new Set<string>());
  // Mejl som just flyttats bort hålls borta ur listan tills servern har svarat, annars blinkar de tillbaka.
  const hidden = useRef(new Set<string>());
  const moreInCache = useRef(false);
  const [thread, setThread] = useState<MessageSummary[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [changeTick, setChangeTick] = useState(0);
  const [outbox, setOutbox] = useState<OutboxInfo[]>([]);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [update, setUpdate] = useState<{ version: string } | null>(null);

  const search = useMemo(() => parseSearch(query, filters), [query, JSON.stringify(filters)]);
  const searching = !isEmptyQuery(search);
  const effectiveSel: MailboxSelection = searching ? { kind: 'search', search } : selection;
  const selKey = JSON.stringify(effectiveSel);

  useEffect(() => {
    setLimit(PAGE);
    setChecked(new Set());
  }, [selKey]);

  const showToast = useCallback((text: string, action?: { label: string; run: () => void }) => {
    setToast({ text, action });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 8000 : 5000);
  }, []);

  const refreshState = useCallback(async () => {
    setState(await api.state());
  }, []);

  // Första start: finns en signaturexport från Spark erbjuds importen en gång.
  useEffect(() => {
    if (!state || sparkChecked.current) return;
    sparkChecked.current = true;
    if (state.settings.sparkOffered || !state.accounts.length) return;
    void api
      .sparkFind()
      .then((data) => data?.signatures.length && setSparkImport(data))
      .catch(() => undefined);
  }, [state]);

  const refreshList = useCallback(async () => {
    try {
      const res = await api.list(effectiveSel, limit);
      moreInCache.current = res.more;
      setMessages(hidden.current.size ? res.items.filter((m) => !hidden.current.has(m.id)) : res.items);
    } catch (e: any) {
      showToast(e.message);
    }
  }, [selKey, limit]);

  // Sökning på servern utöver cachen, en kort stund efter sista tangenttrycket.
  useEffect(() => {
    setServerHits([]);
    if (!searching) {
      setServerBusy(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setServerBusy(true);
      api
        .searchServer(search)
        .then((hits) => {
          if (live) setServerHits(hits.filter((m) => !hidden.current.has(m.id)));
        })
        .catch((e) => live && showToast(e.message))
        .finally(() => live && setServerBusy(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [selKey]);

  // Träffar från cachen och servern, ett mejl en gång (samma Message-ID i flera mappar räknas en gång).
  const listed = useMemo(() => {
    if (!searching || !serverHits.length) return messages;
    const out = [...messages];
    const ids = new Set(out.map((m) => m.id));
    const mids = new Set(out.map((m) => `${m.accountId}|${m.messageId}`).filter((k) => !k.endsWith('|')));
    for (const h of serverHits) {
      if (ids.has(h.id) || (h.messageId && mids.has(`${h.accountId}|${h.messageId}`))) continue;
      ids.add(h.id);
      if (h.messageId) mids.add(`${h.accountId}|${h.messageId}`);
      out.push(h);
    }
    return out.sort((a, b) => b.date - a.date);
  }, [messages, serverHits, searching]);

  // Smart inkorg: personliga mejl för sig, nyhetsbrev och aviseringar i egna flikar.
  const inboxView =
    !searching &&
    ((selection.kind === 'unified' && selection.role === 'inbox') ||
      (selection.kind === 'folder' && state?.folders.find((f) => f.accountId === selection.accountId && f.path === selection.path)?.role === 'inbox'));
  const smart = !!state?.settings.smartInbox && inboxView;
  const [tab, setTabState] = useState<InboxTab>(() => {
    try {
      const v = localStorage.getItem('inkorg-flik');
      return v === 'personal' || v === 'newsletter' || v === 'notification' ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const setTab = useCallback((tb: InboxTab) => {
    setTabState(tb);
    setSelectedId(null);
    try {
      localStorage.setItem('inkorg-flik', tb);
    } catch {
      /* valet sparas bara när det går */
    }
  }, []);
  const tabs = useMemo(() => {
    if (!smart) return null;
    const count = (tb: InboxTab) => listed.filter((m) => !m.seen && (tb === 'all' || tabOf(m) === tb)).length;
    return inboxTabs().map((tb) => ({ ...tb, unread: count(tb.id) }));
  }, [smart, listed]);
  const shown = useMemo(() => (smart && tab !== 'all' ? listed.filter((m) => tabOf(m) === tab) : listed), [smart, tab, listed]);

  // Förhämtar brödtexten för de översta mejlen och mejlen runt det valda, så att de öppnas direkt.
  useEffect(() => {
    if (cleaning || !shown.length) return;
    const timer = setTimeout(() => {
      const idx = selectedId ? shown.findIndex((m) => m.id === selectedId) : -1;
      const near = idx >= 0 ? shown.slice(Math.max(0, idx - 2), idx + 4) : [];
      const top = shown.slice(0, 15);
      void api.prefetch([...near, ...top].filter((m) => !m.hasAttachments && m.id !== selectedId).map((m) => m.id)).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [shown, selectedId, cleaning]);

  // Oändlig lista: visa fler ur cachen, och när cachen tar slut hämtas äldre mejl från servern.
  const onEndReached = useCallback(async () => {
    if (searching || olderBusy) return;
    if (moreInCache.current) {
      setLimit((l) => l + PAGE);
      return;
    }
    if (exhausted.current.has(selKey) || (selection.kind !== 'folder' && selection.kind !== 'unified')) return;
    setOlderBusy(true);
    try {
      const added = await api.loadOlder(selection);
      if (!added) exhausted.current.add(selKey);
      else setLimit((l) => l + PAGE);
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setOlderBusy(false);
    }
  }, [searching, olderBusy, selKey, selection]);

  useEffect(() => {
    void refreshState();
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    const offChanged = api.on('changed', () => {
      setChangeTick((n) => n + 1);
      void refreshState();
      void refreshList();
    });
    void api.outbox().then(setOutbox).catch(() => undefined);
    const offOutbox = api.on('outbox', (list: OutboxInfo[]) => setOutbox(list));
    const offUpdate = api.on('update', (u: { version: string } | null) => setUpdate(u));
    void api.updateCheck().then(setUpdate).catch(() => undefined);
    const offOpen = api.on('open-message', (id: string) => {
      setCleaning(false);
      setQuery('');
      setSelection({ kind: 'unified', role: 'inbox' });
      setSelectedId(id);
    });
    return () => {
      offChanged();
      offOpen();
      offOutbox();
      offUpdate();
    };
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setCurrent(null);
      return;
    }
    const seq = ++openSeq.current;
    setLoadingBody(true);
    setBodyError(null);
    api
      .open(selectedId)
      .then((m) => {
        if (seq === openSeq.current) setCurrent(m);
      })
      .catch((e) => {
        if (seq === openSeq.current) {
          setCurrent(null);
          setBodyError(e.message);
        }
      })
      .finally(() => {
        if (seq === openSeq.current) setLoadingBody(false);
      });
  }, [selectedId]);

  // Hela konversationen för läsvyn, från cachen. Uppdateras när listan ändras (nya svar, flaggor).
  useEffect(() => {
    if (!selectedId) {
      setThread([]);
      return;
    }
    let live = true;
    api
      .thread(selectedId)
      .then((th) => live && setThread(th))
      .catch(() => live && setThread([]));
    return () => {
      live = false;
    };
  }, [selectedId, messages]);

  // Håll läsvyns flaggor i takt med listan.
  useEffect(() => {
    if (!current) return;
    const m = shown.find((x) => x.id === current.id);
    if (m && (m.flagged !== current.flagged || m.seen !== current.seen || m.answered !== current.answered)) {
      setCurrent({ ...current, flagged: m.flagged, seen: m.seen, answered: m.answered });
    }
  }, [shown]);

  const selectedSummary = shown.find((m) => m.id === selectedId) ?? null;

  const title = useMemo(() => {
    if (effectiveSel.kind === 'search') return t('Sökresultat');
    if (effectiveSel.kind === 'unified') return t('Alla inkorgar');
    if (effectiveSel.kind === 'label') return effectiveSel.label;
    if (effectiveSel.kind === 'reminders') return t('Påminnelser');
    if (effectiveSel.role === 'other') {
      const sel = effectiveSel;
      return state?.folders.find((f) => f.accountId === sel.accountId && f.path === sel.path)?.name ?? roleTitle('other');
    }
    if (isGmailAllMail(effectiveSel.role, effectiveSel.path)) return t('Alla mejl');
    return roleTitle(effectiveSel.role);
  }, [JSON.stringify(effectiveSel), state]);

  const subtitle = useMemo(() => {
    if (effectiveSel.kind === 'search') return serverBusy ? t('{n} träffar · söker på servern…', { n: shown.length }) : t('{n} träffar i alla konton', { n: shown.length });
    if (effectiveSel.kind === 'reminders') return shown.length ? t('{n} väntar', { n: shown.length }) : t('Inga påminnelser');
    const unread = shown.filter((m) => !m.seen).length;
    if (effectiveSel.kind === 'folder' || effectiveSel.kind === 'label') {
      const acc = state?.accounts.find((a) => a.id === effectiveSel.accountId);
      return `${acc?.name ?? ''}${unread ? ` · ${t('{n} olästa', { n: unread })}` : ''}`;
    }
    return unread ? t('{n} olästa', { n: unread }) : t('{n} meddelanden', { n: shown.length });
  }, [shown, JSON.stringify(effectiveSel), state, serverBusy]);

  const dropFromList = useCallback((ids: string[]) => {
    const set = new Set(ids);
    for (const id of ids) hidden.current.add(id);
    setMessages((list) => list.filter((m) => !set.has(m.id)));
    setServerHits((list) => list.filter((m) => !set.has(m.id)));
  }, []);

  const unhide = useCallback((ids: string[], failed: boolean) => {
    if (failed) for (const id of ids) hidden.current.delete(id);
    else setTimeout(() => ids.forEach((id) => hidden.current.delete(id)), 5000);
  }, []);

  // Väljer mejlet efter de som tas bort, eller före om de låg sist.
  const selectNext = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      const idxs = shown.map((m, i) => (set.has(m.id) ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length) return;
      const after = shown.slice(Math.max(...idxs) + 1).find((m) => !set.has(m.id));
      const before = shown.slice(0, Math.min(...idxs)).reverse().find((m) => !set.has(m.id));
      const next = after ?? before ?? null;
      setSelectedId(next ? next.id : null);
    },
    [shown]
  );

  // Flytten som pågår just nu. Ctrl+Z direkt efter en flytt väntar in den, så att rätt flytt ångras.
  const pendingMove = useRef<Promise<string | undefined> | null>(null);

  const undoMove = useCallback(
    (undoId?: string) => {
      setToast(null);
      void (async () => undoId ?? (pendingMove.current ? await pendingMove.current : undefined))()
        .then((id) => api.undoMove(id))
        .then((n) => showToast(n === 1 ? t('Mejlet är tillbaka.') : t('{n} mejl är tillbaka.', { n })))
        .catch((e) => showToast(e.message));
    },
    [showToast]
  );

  // Flyttar ett eller flera mejl. Listan uppdateras direkt och flytten kan ångras från notisen.
  const moveIds = useCallback(
    async (ids: string[], target: { role?: FolderRole; path?: string }) => {
      if (!ids.length) return;
      if (ids.includes(selectedId ?? '')) selectNext(ids);
      dropFromList(ids);
      setChecked(new Set());
      try {
        const call = api.moveMany(ids, target);
        const pending = call.then((x) => x.undoId).catch(() => undefined);
        pendingMove.current = pending;
        void pending.finally(() => {
          if (pendingMove.current === pending) pendingMove.current = null;
        });
        const r = await call;
        unhide(ids, false);
        const n = r.moved;
        if (!n) return;
        const one = n === 1;
        const folderName = target.path ? (state?.folders.find((f) => f.path === target.path)?.name ?? target.path) : '';
        const text =
          target.role === 'archive'
            ? one
              ? t('Mejlet arkiverat.')
              : t('{n} mejl arkiverade.', { n })
            : target.role === 'trash'
              ? r.undoId
                ? one
                  ? t('Mejlet i papperskorgen.')
                  : t('{n} mejl i papperskorgen.', { n })
                : one
                  ? t('Mejlet raderat för gott.')
                  : t('{n} mejl raderade för gott.', { n })
              : one
                ? t('Mejlet flyttat till {folder}.', { folder: folderName })
                : t('{n} mejl flyttade till {folder}.', { n, folder: folderName });
        const partial = r.error ? ' ' + t('{n} gick inte: {error}', { n: ids.length - n, error: r.error }) : '';
        if (r.error) void refreshList();
        showToast(text + partial, r.undoId ? { label: t('Ångra'), run: () => undoMove(r.undoId) } : undefined);
      } catch (e: any) {
        unhide(ids, true);
        showToast(e.message);
        void refreshList();
      }
    },
    [selectedId, selectNext, dropFromList, unhide, showToast, undoMove, refreshList, state]
  );

  const act = useCallback(
    async (action: string, msg: MessageSummary) => {
      try {
        if (action === 'archive' || action === 'trash') {
          await moveIds([msg.id], { role: action as FolderRole });
        } else if (action === 'flag') await api.flag(msg.id, 'flagged', !msg.flagged);
        else if (action === 'unread') {
          await api.flag(msg.id, 'seen', !msg.seen);
        } else if (action === 'reply' || action === 'replyAll' || action === 'forward') {
          await api.compose({ mode: action, accountId: msg.accountId, sourceId: msg.id });
        } else if (action === 'editDraft') {
          await api.compose({ mode: 'draft', accountId: msg.accountId, sourceId: msg.id });
        } else if (action === 'suggest') {
          await api.compose({ mode: 'reply', accountId: msg.accountId, sourceId: msg.id, suggest: true });
        }
      } catch (e: any) {
        showToast(e.message);
        void refreshList();
      }
    },
    [moveIds, showToast, refreshList]
  );

  // Åtgärder på flera markerade mejl.
  const bulk = useCallback(
    async (action: BulkAction) => {
      const ids = shown.filter((m) => checked.has(m.id)).map((m) => m.id);
      if (!ids.length) return;
      if (action === 'archive' || action === 'trash') return moveIds(ids, { role: action });
      try {
        const flag = action === 'read' || action === 'unread' ? 'seen' : 'flagged';
        const value = action === 'read' || action === 'flag';
        await Promise.all(ids.map((id) => api.flag(id, flag, value)));
      } catch (e: any) {
        showToast(e.message);
      }
    },
    [shown, checked, moveIds, showToast]
  );

  // Klick i listan: Ctrl växlar markering, Shift markerar ett intervall, vanligt klick väljer ett mejl.
  const onRowClick = useCallback(
    (id: string, mod: { ctrl: boolean; shift: boolean }) => {
      if (mod.shift && selectedId) {
        const a = shown.findIndex((m) => m.id === selectedId);
        const b = shown.findIndex((m) => m.id === id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setChecked(new Set(shown.slice(lo, hi + 1).map((m) => m.id)));
          return;
        }
      }
      if (mod.ctrl) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (!next.size && selectedId) next.add(selectedId);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      setChecked(new Set());
      setSelectedId(id);
    },
    [shown, selectedId]
  );

  const newMessage = useCallback(
    (to?: string) => {
      if (!state?.accounts.length) {
        setAccountDialog({});
        return;
      }
      const accountId =
        effectiveSel.kind === 'folder' || effectiveSel.kind === 'label'
          ? effectiveSel.accountId
          : (selectedSummary?.accountId ?? state.accounts.find((a) => state.statuses.find((s) => s.id === a.id)?.state === 'online')?.id ?? state.accounts[0].id);
      void api.compose({ mode: 'new', accountId, to });
    },
    [state, effectiveSel, selectedSummary]
  );

  // Flyttar ett mejl till en godtycklig mapp (Flytta till och dra och släpp). Är mejlet markerat flyttas alla markerade.
  const moveTo = useCallback(
    (id: string, path: string) => {
      const ids = checked.size > 1 && checked.has(id) ? shown.filter((m) => checked.has(m.id)).map((m) => m.id) : [id];
      return moveIds(ids, { path });
    },
    [checked, shown, moveIds]
  );

  // Påminn mig döljer mejlet tills tiden är inne, Följ upp om inget svar låter det ligga kvar.
  const remindMsg = useCallback(
    async (id: string, kind: ReminderKind, due: number) => {
      try {
        if (kind === 'snooze' && selection.kind !== 'reminders') {
          selectNext([id]);
          dropFromList([id]);
        }
        try {
          await api.remind(id, kind, due);
        } catch (e) {
          unhide([id], true);
          throw e;
        }
        // Påminnelsen är sparad, mejlet ska synas direkt under Påminnelser.
        unhide([id], true);
        showToast(kind === 'snooze' ? t('Mejlet visas igen {when}.', { when: whenText(due) }) : t('Du får en påminnelse {when} om ingen har svarat.', { when: whenText(due) }));
      } catch (e: any) {
        showToast(e.message);
        void refreshList();
      }
    },
    [selection, selectNext, dropFromList, unhide, showToast, refreshList]
  );

  const printMsg = useCallback(
    async (pdf: boolean) => {
      if (!current) return;
      try {
        const ok = await api.print(printDocument(current), pdf, current.subject || t('mejl'));
        if (ok && pdf) showToast(t('PDF:en är sparad.'));
      } catch (e: any) {
        showToast(e.message);
      }
    },
    [current, showToast]
  );

  // Märket i aktivitetsfältet följer antalet olästa i inkorgarna.
  const totalUnread = state?.statuses.reduce((n, s) => n + s.unread, 0) ?? 0;
  useEffect(() => {
    void api.setBadge(badgeDataUrl(totalUnread), totalUnread).catch(() => undefined);
  }, [totalUnread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cleaning && !(e.ctrlKey && e.key.toLowerCase() === 'n')) return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newMessage();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        void printMsg(false);
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('search')?.focus();
        return;
      }
      if (typing || accountDialog || settingsOpen) return;
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoMove();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setChecked(new Set(shown.map((m) => m.id)));
        return;
      }
      if (checked.size > 1) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          void bulk('trash');
          return;
        }
        if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          void bulk('archive');
          return;
        }
        if (e.key === 'Escape') {
          setChecked(new Set());
          return;
        }
      }
      const idx = shown.findIndex((m) => m.id === selectedId);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = shown[e.key === 'ArrowDown' ? idx + 1 : Math.max(0, idx - 1)];
        if (next && e.shiftKey && selectedId) {
          setChecked((prev) => new Set([...prev, selectedId, next.id]));
          setSelectedId(next.id);
        } else if (next) {
          setChecked(new Set());
          setSelectedId(next.id);
        }
      } else if (selectedSummary && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        void act('trash', selectedSummary);
      } else if (selectedSummary && e.ctrlKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void act(e.shiftKey ? 'replyAll' : 'reply', selectedSummary);
      } else if (selectedSummary && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        void act('forward', selectedSummary);
      } else if (selectedSummary && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        void act('unread', selectedSummary);
      } else if (selectedSummary && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void act('flag', selectedSummary);
      } else if (selectedSummary && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void act('archive', selectedSummary);
      } else if (selectedSummary && e.key === 'Enter') {
        e.preventDefault();
        if (state?.folders.find((f) => f.accountId === selectedSummary.accountId && f.path === selectedSummary.folder)?.role === 'drafts') void act('editDraft', selectedSummary);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const target = e.key === 'Home' ? shown[0] : shown[shown.length - 1];
        if (target) setSelectedId(target.id);
      } else if (e.key === 'Escape' && searching) {
        setQuery('');
        setFilters({});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, selectedId, selectedSummary, act, newMessage, accountDialog, settingsOpen, state, searching, printMsg, cleaning, checked, bulk, undoMove]);

  // Motorvalet gäller hela appen och sparas direkt.
  const setEngine = useCallback(
    async (aiEngine: AiEngine) => {
      try {
        await api.saveSettings({ aiEngine });
        await refreshState();
      } catch (e: any) {
        showToast(e.message);
      }
    },
    [refreshState, showToast]
  );

  if (!state) return <div className="app loading" />;
  const readerMsg = current && current.id === selectedId ? current : null;
  const readerIsDraft = !!readerMsg && state.folders.find((f) => f.accountId === readerMsg.accountId && f.path === readerMsg.folder)?.role === 'drafts';

  return (
    <div className={cleaning ? 'app cleaning' : 'app'}>
      <Sidebar
        state={state}
        selection={query || cleaning ? null : selection}
        cleaning={cleaning}
        laterCount={outbox.filter((o) => o.kind === 'later').length}
        onOutbox={() => setOutboxOpen(true)}
        onClean={() => {
          setCleaning(true);
          setSelectedId(null);
        }}
        onSelect={(sel) => {
          setCleaning(false);
          setQuery('');
          setSelection(sel);
          setSelectedId(null);
          if (sel.kind === 'folder') void api.syncFolder(sel.accountId, sel.path).catch(() => undefined);
        }}
        onAddAccount={() => setAccountDialog({})}
        onEditAccount={(id, login) => setAccountDialog({ accountId: id, login })}
        onSettings={() => setSettingsOpen(true)}
        onDropMessage={(messageId, accountId, path) => {
          const msg = shown.find((m) => m.id === messageId);
          if (msg && msg.accountId !== accountId) showToast(t('Mejl kan bara flyttas till mappar i samma konto.'));
          else void moveTo(messageId, path);
        }}
      />
      {cleaning ? (
        <CleanView
          accounts={state.accounts}
          version={changeTick}
          autoScan={!state.settings.cleanScanned}
          onToast={showToast}
          onShowMail={(address) => {
            setCleaning(false);
            setQuery(`från:${address}`);
          }}
        />
      ) : (
      <>
      <MessageList
        title={title}
        subtitle={subtitle}
        messages={shown}
        threads={!searching && state.settings.threads}
        filters={filters}
        onFilters={setFilters}
        searching={searching}
        serverBusy={serverBusy}
        olderBusy={olderBusy}
        onEndReached={onEndReached}
        accounts={state.accounts}
        folders={state.folders}
        showAccount={effectiveSel.kind === 'unified' || effectiveSel.kind === 'search'}
        selectedId={selectedId}
        checked={checked}
        tabs={tabs}
        tab={tab}
        onTab={(id) => setTab(id as InboxTab)}
        query={query}
        onQuery={setQuery}
        onSelect={onRowClick}
        onOpen={(m) => {
          if (state.folders.find((f) => f.accountId === m.accountId && f.path === m.folder)?.role === 'drafts') void act('editDraft', m);
        }}
        onCompose={() => newMessage()}
        onRefresh={() => api.reconnect()}
        onMove={(id, path) => void moveTo(id, path)}
        empty={
          state.accounts.length === 0
            ? t('Lägg till ett konto för att komma igång.')
            : state.statuses.every((s) => s.state === 'needs-password')
              ? t('Logga in på dina konton i sidopanelen.')
              : query
                ? t('Inga träffar.')
                : smart
                  ? tabEmpty()[tab]
                  : t('Inga meddelanden.')
        }
      />
      {checked.size > 1 ? (
        <BulkPanel count={checked.size} onAction={(a) => void bulk(a)} onClear={() => setChecked(new Set())} />
      ) : (
      <Reader
        message={current}
        summary={selectedSummary}
        thread={thread.length > 1 && state.settings.threads ? thread : []}
        loading={loadingBody}
        error={bodyError}
        account={state.accounts.find((a) => a.id === (current?.accountId ?? selectedSummary?.accountId))}
        folders={state.folders}
        engine={state.settings.aiEngine}
        onAction={act}
        onMove={(id, path) => void moveTo(id, path)}
        onMailto={newMessage}
        onError={showToast}
        reminders={state.reminders}
        onRemind={(id, kind, due) => void remindMsg(id, kind, due)}
        onClearRemind={(id) => void api.remindClear(id).catch((e) => showToast(e.message))}
        onPrint={(pdf) => void printMsg(pdf)}
        after={
          readerMsg && (
            <QuickReplies
              message={readerMsg}
              engine={state.settings.aiEngine}
              ownEmail={state.accounts.find((a) => a.id === readerMsg.accountId)?.email}
              isDraft={readerIsDraft}
              onQuickReply={(text) => void api.compose({ mode: 'reply', accountId: readerMsg.accountId, sourceId: readerMsg.id, prefill: text }).catch((e) => showToast(e.message))}
            />
          )
        }
      >
        {readerMsg && !readerIsDraft && <AiTools message={readerMsg} threadSize={thread.length || 1} engine={state.settings.aiEngine} onEngine={setEngine} />}
      </Reader>
      )}
      </>
      )}
      {accountDialog && (
        <AccountDialog
          accounts={state.accounts}
          accountId={accountDialog.accountId}
          login={accountDialog.login}
          status={state.statuses.find((s) => s.id === accountDialog.accountId)}
          signatures={state.settings.signatures}
          onEditSignatures={() => setSignaturesOpen(true)}
          onClose={() => setAccountDialog(null)}
          onSaved={() => {
            setAccountDialog(null);
            void refreshState();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={state.settings}
          onEditSignatures={() => setSignaturesOpen(true)}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void refreshState();
          }}
        />
      )}
      {signaturesOpen && (
        <SignaturesDialog
          accounts={state.accounts}
          signatures={state.settings.signatures}
          onImport={(data) => {
            setSignaturesOpen(false);
            setSparkImport(data);
          }}
          onClose={() => {
            setSignaturesOpen(false);
            void refreshState();
          }}
        />
      )}
      {sparkImport && (
        <SparkImportDialog
          data={sparkImport}
          accounts={state.accounts}
          signatures={state.settings.signatures}
          onClose={() => {
            setSparkImport(null);
            void refreshState();
          }}
          onDone={(n) => {
            setSparkImport(null);
            void refreshState();
            showToast(tn(n, 'En signatur importerad.', '{n} signaturer importerade.'));
          }}
        />
      )}
      {outboxOpen && <OutboxDialog items={outbox.filter((o) => o.kind === 'later')} accounts={state.accounts} onError={showToast} onClose={() => setOutboxOpen(false)} />}
      <UndoSend items={outbox.filter((o) => o.kind === 'undo')} onError={showToast} />
      {update && (
        <div className="update-banner" role="status">
          <span>{t('Version {version} finns.', { version: update.version })}</span>
          <button
            className="btn small primary"
            id="update-install"
            onClick={() => void api.updateInstall().catch((e) => showToast(e.message))}
          >
            {t('Installera och starta om')}
          </button>
          <button className="icon-btn" aria-label={t('Senare')} title={t('Senare')} onClick={() => setUpdate(null)}>
            <I.Close size={14} />
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
