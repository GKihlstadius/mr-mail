import { describe, expect, it } from 'vitest';
import { dataDirName } from '../src/shared/brand';

describe('datamappen', () => {
  const has = (...dirs: string[]) => (d: string) => dirs.includes(d);
  it('väljer den gamla mappen när bara den har en databas', () => {
    expect(dataDirName(has('Brevlåda'))).toBe('Brevlåda');
  });
  it('väljer den nya när den har en databas', () => {
    expect(dataDirName(has('Brevlåda', 'Mr Mail'))).toBe('Mr Mail');
    expect(dataDirName(has('Mr Mail'))).toBe('Mr Mail');
  });
  it('ny installation utan databas får den nya mappen', () => {
    expect(dataDirName(has())).toBe('Mr Mail');
  });
});
