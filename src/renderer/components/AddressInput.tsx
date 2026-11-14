import { useEffect, useRef, useState } from 'react';
import type { Contact } from '../../shared/types';
import { formatAddress } from '../../shared/compose';
import { api } from '../api';
import { cx } from '../util';

interface Props {
  id: string;
  value: string;
  onChange(value: string): void;
  autoFocus?: boolean;
}

// Adressfält med förslag från kontakter i cachen. Förslagen gäller ordet efter sista kommatecknet.
export function AddressInput({ id, value, onChange, autoFocus }: Props) {
  const [items, setItems] = useState<Contact[]>([]);
  const [index, setIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const seq = useRef(0);

  const token = (value.match(/[^,;]*$/)?.[0] ?? '').trim();

  useEffect(() => {
    if (!focused || token.length < 1 || token.includes('<')) {
      setItems([]);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api
        .contacts(token)
        .then((list) => {
          if (n !== seq.current) return;
          const already = new Set(value.toLowerCase().match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []);
          setItems(list.filter((c) => !already.has(c.address)));
          setIndex(0);
        })
        .catch(() => setItems([]));
    }, 90);
    return () => clearTimeout(t);
  }, [token, focused]);

  const pick = (c: Contact) => {
    const head = value.slice(0, value.length - (value.match(/[^,;]*$/)?.[0].length ?? 0));
    const prefix = head ? `${head.trimEnd()} ` : '';
    onChange(`${prefix}${formatAddress({ name: c.name, address: c.address })}, `);
    setItems([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setItems([]);
    }
  };

  return (
    <div className="addr">
      <input
        id={id}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={`${id}-list`}
      />
      {items.length > 0 && (
        <div className="addr-list" id={`${id}-list`} role="listbox">
          {items.map((c, i) => (
            <button
              key={c.address}
              type="button"
              role="option"
              aria-selected={i === index}
              className={cx('addr-item', i === index && 'on')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(c)}
            >
              <span className="addr-name">{c.name || c.address}</span>
              {c.name && <span className="addr-mail">{c.address}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
