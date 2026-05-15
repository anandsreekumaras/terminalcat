import { describe, it, expect } from 'vitest';
import { sanitizeName } from '../src/upload';

describe('sanitizeName', () => {
  it('accepts a plain filename', () => {
    const r = sanitizeName('file.txt');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('file.txt');
  });

  it('accepts dotted, dashed, underscored names', () => {
    expect(sanitizeName('foo-bar_baz.tar.gz').ok).toBe(true);
  });

  it('accepts a 255-char name', () => {
    expect(sanitizeName('a'.repeat(255)).ok).toBe(true);
  });

  it('rejects non-string', () => {
    const cases: unknown[] = [123, null, undefined, {}, []];
    for (const c of cases) {
      const r = sanitizeName(c);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects empty string', () => {
    const r = sanitizeName('');
    expect(r.ok).toBe(false);
  });

  it('rejects a 256-char name', () => {
    const r = sanitizeName('a'.repeat(256));
    expect(r.ok).toBe(false);
  });

  it('rejects NUL byte', () => {
    const r = sanitizeName('foo\0bar');
    expect(r.ok).toBe(false);
  });

  it('rejects traversal "../foo"', () => {
    const r = sanitizeName('../foo');
    expect(r.ok).toBe(false);
  });

  it('rejects forward slash', () => {
    const r = sanitizeName('foo/bar');
    expect(r.ok).toBe(false);
  });

  it('rejects backslash', () => {
    const r = sanitizeName('foo\\bar');
    expect(r.ok).toBe(false);
  });

  it('rejects "."', () => {
    const r = sanitizeName('.');
    expect(r.ok).toBe(false);
  });

  it('rejects ".."', () => {
    const r = sanitizeName('..');
    expect(r.ok).toBe(false);
  });

  it('rejects control byte 0x01', () => {
    const r = sanitizeName('foo\x01bar');
    expect(r.ok).toBe(false);
  });

  it('rejects control byte 0x1F', () => {
    const r = sanitizeName('foo\x1fbar');
    expect(r.ok).toBe(false);
  });

  it('rejects DEL (0x7F)', () => {
    const r = sanitizeName('foo\x7fbar');
    expect(r.ok).toBe(false);
  });

  it('rejects ".hidden" when allowDot=false', () => {
    const r = sanitizeName('.hidden');
    expect(r.ok).toBe(false);
  });

  it('rejects " .hidden" (leading space then dot)', () => {
    const r = sanitizeName(' .hidden');
    expect(r.ok).toBe(false);
  });

  it('accepts ".hidden" when allowDot=true', () => {
    const r = sanitizeName('.hidden', true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('.hidden');
  });
});
