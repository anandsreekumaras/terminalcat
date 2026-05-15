import { describe, it, expect } from 'vitest';
import { errMsg } from '../src/errors';

describe('errMsg', () => {
  it('returns .message for Error instance', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('returns .message for subclasses of Error', () => {
    expect(errMsg(new TypeError('bad type'))).toBe('bad type');
  });

  it('returns string as-is', () => {
    expect(errMsg('plain string')).toBe('plain string');
  });

  it('returns empty string as-is', () => {
    expect(errMsg('')).toBe('');
  });

  it('stringifies number', () => {
    expect(errMsg(42)).toBe('42');
  });

  it('returns "null" for null', () => {
    expect(errMsg(null)).toBe('null');
  });

  it('returns "undefined" for undefined', () => {
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('falls back to String() for object without message', () => {
    expect(errMsg({})).toBe('[object Object]');
  });

  it('uses object toString override when present', () => {
    const o = { toString() { return 'custom-rep'; } };
    expect(errMsg(o)).toBe('custom-rep');
  });
});
