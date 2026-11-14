import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { htmlToText, outgoingHtml, quoteBlockHtml, signatureBlock, textToEditorHtml } from '../src/shared/richtext';

const dom = (html: string) => new JSDOM(`<body>${html}</body>`).window.document.body;

describe('rik text', () => {
  it('ger ett läsbart textalternativ', () => {
    const body = dom(
      '<div>Hej <b>Anna</b>!</div><div><br></div><div>Se <a href="https://nordljus.se">sidan</a>.</div><ul><li>ett</li><li>två</li></ul><ol><li>a</li><li>b</li></ol><blockquote><div>citat</div></blockquote><div>Slut</div>'
    );
    expect(htmlToText(body)).toBe('Hej Anna!\n\nSe sidan (https://nordljus.se).\n- ett\n- två\n1. a\n2. b\n> citat\nSlut');
  });

  it('gör om text till redigerarens rader och länkar', () => {
    expect(textToEditorHtml('Hej\n\nhttps://x.se <b>')).toBe('<div>Hej</div><div><br></div><div><a href="https://x.se">https://x.se</a> &lt;b&gt;</div>');
  });

  it('signatur som text eller HTML', () => {
    expect(signatureBlock('')).toBe('');
    expect(signatureBlock('Alex\nNordljus')).toBe('<div class="brevlada-signature"><div>Alex</div><div>Nordljus</div></div>');
    expect(signatureBlock('<b>Alex</b>')).toBe('<div class="brevlada-signature"><b>Alex</b></div>');
  });

  it('citerar originalet som blockquote', () => {
    const q = quoteBlockHtml('Den 1 nov skrev Anna:', 'Hej <du>');
    expect(q).toContain('<blockquote type="cite"');
    expect(q).toContain('Hej &lt;du&gt;');
    expect(htmlToText(dom(outgoingHtml('<div>Svar</div>', q)))).toBe('Svar\n\nDen 1 nov skrev Anna:\n> Hej <du>');
  });
});
