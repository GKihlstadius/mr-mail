import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankFuzzy } from '../src/shared/fuzzy';

describe('luddig sökning', () => {
  it('hittar bokstäver i ordning och missar annars', () => {
    expect(fuzzyScore('nm', 'Nytt mejl')).not.toBeNull();
    expect(fuzzyScore('kal', 'Gå till Kalender')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Nytt mejl')).toBeNull();
    expect(fuzzyScore('', 'vad som helst')).toBe(0);
  });
  it('räknar inte accenter', () => {
    expect(fuzzyScore('stada', 'Gå till Städa')).not.toBeNull();
    expect(fuzzyScore('paminn', 'Påminnelser')).not.toBeNull();
  });
  it('kräver att varje ord träffar', () => {
    expect(fuzzyScore('ny mejl', 'Nytt mejl')).not.toBeNull();
    expect(fuzzyScore('ny kalender', 'Nytt mejl')).toBeNull();
  });
  it('sätter ordstart och början före spridda träffar', () => {
    const items = ['Byt tema', 'Inställningar', 'Gå till Inkorg', 'Synka nu'];
    expect(rankFuzzy(items, 'in', (s) => s)[0]).toBe('Inställningar');
    expect(rankFuzzy(items, 'inko', (s) => s)[0]).toBe('Gå till Inkorg');
    expect(rankFuzzy(items, 'synk', (s) => s)).toEqual(['Synka nu']);
  });
  it('utan sökord behålls ordningen', () => {
    expect(rankFuzzy(['b', 'a', 'c'], ' ', (s) => s, 2)).toEqual(['b', 'a']);
  });
});
