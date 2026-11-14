import { describe, expect, it } from 'vitest';
import { categorize, findUnsubscribeLink, parseListHeaders, parseUnsubscribe } from '../src/shared/cleanup';

describe('Städa', () => {
  it('läser listrubriker, även radbrutna', () => {
    const raw =
      'References: <a@b>\r\nList-Unsubscribe: <mailto:unsub@news.se?subject=stop>,\r\n <https://news.se/u/123>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nList-Id: Nyheter <nyheter.news.se>\r\n\r\n';
    expect(parseListHeaders(raw)).toEqual({ unsubscribe: '<mailto:unsub@news.se?subject=stop>, <https://news.se/u/123>', oneClick: true, bulk: true });
    expect(parseListHeaders('References: <a@b>\r\n\r\n')).toEqual({ unsubscribe: '', oneClick: false, bulk: false });
    expect(parseListHeaders('Precedence: bulk\r\n').bulk).toBe(true);
  });

  it('tolkar avregistreringsadresser', () => {
    expect(parseUnsubscribe('<mailto:unsub@news.se?subject=stop%20please>, <https://news.se/u/123>, <http://old.se/u>')).toEqual({
      https: 'https://news.se/u/123',
      http: 'http://old.se/u',
      mailto: { to: 'unsub@news.se', subject: 'stop please', body: 'unsubscribe' }
    });
    expect(parseUnsubscribe('trasig rubrik')).toEqual({});
  });

  it('hittar avregistreringslänken i mejlet när rubriken saknas', () => {
    const html =
      '<p><a href="https://uber.com/erbjudande">Spara 40%</a></p><p style="font-size:10px">Vill du inte ha fler mejl? <a href="https://uber.com/x?a=1&amp;b=2"><span>Avregistrera dig</span></a> eller <a href="https://uber.com/prefs">Hantera e-post</a></p>';
    expect(findUnsubscribeLink(html)).toBe('https://uber.com/x?a=1&b=2');
    expect(findUnsubscribeLink('<a href="https://news.se/u/unsubscribe?id=9">här</a>')).toBe('https://news.se/u/unsubscribe?id=9');
    expect(findUnsubscribeLink('<a href="mailto:x@y.se">Unsubscribe</a><a href="https://y.se">Läs mer</a>')).toBeNull();
  });

  it('känner igen nyhetsbrev på avsändaren när rubrikerna saknas', () => {
    const c = (address: string) => categorize({ address, subject: 'Hej', bulk: false, unsubscribe: false });
    expect(c('team@mail.notion.so')).toBe('newsletter');
    expect(c('info@tillskottsbolaget.se')).toBe('newsletter');
    expect(c('news@longevity-bros.ltd')).toBe('newsletter');
    expect(c('admin@swebaltin.se')).toBe('personal');
  });

  it('sorterar avsändare i kategorier', () => {
    const c = (address: string, subject = '', bulk = false) => categorize({ address, subject, bulk, unsubscribe: false });
    expect(c('notification@facebookmail.com', 'Ny vän', true)).toBe('social');
    expect(c('info@linkedin.com')).toBe('social');
    expect(c('kvitto@ica.se')).toBe('receipt');
    expect(c('hej@butik.se', 'Orderbekräftelse 1234', true)).toBe('receipt');
    expect(c('noreply@github.com', 'CI gick igenom', true)).toBe('notification');
    expect(c('nyheter@butik.se', 'Veckans erbjudanden', true)).toBe('newsletter');
    expect(c('karin@exempel.se', 'Demo nästa vecka?')).toBe('personal');
  });
});
