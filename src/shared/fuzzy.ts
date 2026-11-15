// Luddig sökning för kommandopaletten: bokstäverna i ordning, med bonus för ordstarter och
// sammanhängande träffar. Varje ord i frågan måste träffa. Accenter räknas inte (a hittar å).

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function wordScore(word: string, text: string): number | null {
  if (!word) return 0;
  const direct = text.indexOf(word);
  if (direct >= 0) {
    const start = direct === 0 || /[\s\-_.@/(]/.test(text[direct - 1]);
    return 100 + word.length * 4 + (start ? 40 : 0) + (direct === 0 ? 30 : 0) - Math.min(direct, 30);
  }
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of word) {
    const i = text.indexOf(ch, at + 1);
    if (i < 0) return null;
    const start = i === 0 || /[\s\-_.@/(]/.test(text[i - 1]);
    run = i === at + 1 ? run + 1 : 0;
    score += 2 + run * 3 + (start ? 8 : 0) - Math.min(i - at - 1, 6);
    at = i;
  }
  return score;
}

export function fuzzyScore(query: string, text: string): number | null {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = fold(text);
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, hay);
    if (s === null) return null;
    total += s;
  }
  return total;
}

// Bästa träffarna först. Lika poäng behåller ordningen i listan.
export function rankFuzzy<T>(items: T[], query: string, text: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
