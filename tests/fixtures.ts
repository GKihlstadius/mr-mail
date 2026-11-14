export const htmlMail = [
  'From: Nyhetsbrev <news@shop.se>',
  'To: alex@nordljus.se',
  'Subject: Erbjudande',
  'Date: Wed, 11 Nov 2026 08:00:00 +0000',
  'Message-ID: <n1@shop.se>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: multipart/related; boundary="b2"',
  '',
  '--b2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1>Rea</h1><p>Allt ska bort</p><img src="https://track.shop.se/p.gif"><img src="cid:logo@shop"></body></html>',
  '--b2',
  'Content-Type: image/png',
  'Content-ID: <logo@shop>',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  '--b2--',
  '--b1',
  'Content-Type: application/pdf; name="faktura.pdf"',
  'Content-Disposition: attachment; filename="faktura.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0YK',
  '--b1--',
  ''
].join('\r\n');

// Påhittade konton som läggs in vid första start i testerna.
export const SEED = JSON.stringify([
  ['alex.berg@gmail.com', 'gmail', 'Gmail', 'Alex Berg'],
  ['alex@nordljus.se', 'simply', 'Nordljus', 'Alex Berg'],
  ['hej@nordljus.se', 'simply', 'Nordljus hej', 'Nordljus']
]);

