import { t } from '../shared/i18n';
import type { FullMessage } from '../shared/types';
import { buildFrameDocument, createSanitizer, escapeHtml, textToHtml } from '../shared/sanitize';
import { formatAddress } from '../shared/compose';
import { fullDate } from './util';

const sanitize = createSanitizer(window as any);

// Dokument för utskrift och PDF: rubriker överst, sedan det sanerade mejlet. Fjärrbilder visas inte.
export function printDocument(m: FullMessage): string {
  const rows: [string, string][] = [
    [t('Från'), formatAddress(m.from)],
    [t('Till'), m.to.map(formatAddress).join(', ')],
    ...(m.cc.length ? ([[t('Kopia'), m.cc.map(formatAddress).join(', ')]] as [string, string][]) : []),
    [t('Datum'), fullDate(m.date)],
    [t('Ämne'), m.subject || t('(inget ämne)')]
  ];
  const attachments = m.body.attachments.filter((a) => !a.inline).map((a) => a.filename);
  if (attachments.length) rows.push([t('Bilagor'), attachments.join(', ')]);
  const header =
    `<div style="font:13px/1.5 'Segoe UI',system-ui,sans-serif;color:#1d1d1f;border-bottom:1px solid #d2d2d7;padding:0 0 12px;margin:0 0 16px">` +
    `<div style="font-size:18px;font-weight:600;margin-bottom:8px">${escapeHtml(m.subject || t('(inget ämne)'))}</div>` +
    rows.map(([k, v]) => `<div><span style="color:#6e6e73;display:inline-block;min-width:64px">${k}</span> ${escapeHtml(v)}</div>`).join('') +
    `</div>`;
  const body = m.body.html ? sanitize(m.body.html, { allowRemote: false, inlineImages: m.body.inlineImages }).html : textToHtml(m.body.text);
  const doc = buildFrameDocument(body, { allowRemote: false, dark: false });
  const withHeader = /<body[^>]*>/i.test(doc) ? doc.replace(/<body[^>]*>/i, (b) => b + header) : header + doc;
  return withHeader.replace('<head>', '<head><meta charset="utf-8"><title>' + escapeHtml(m.subject || t('Mejl')) + '</title><style>@page{margin:16mm}body{padding:0 !important}</style>');
}

// Märket i aktivitetsfältet: en röd cirkel med antalet olästa.
export function badgeDataUrl(count: number): string | null {
  if (count <= 0) return null;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#e5483f';
  g.beginPath();
  g.arc(16, 16, 16, 0, Math.PI * 2);
  g.fill();
  const text = count > 99 ? '99+' : String(count);
  g.fillStyle = '#fff';
  g.font = `bold ${text.length > 2 ? 13 : text.length > 1 ? 17 : 20}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 16, 17);
  return c.toDataURL('image/png');
}
