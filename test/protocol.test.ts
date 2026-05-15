import { describe, it, expect } from 'vitest';
import {
  TAG,
  encodeDataFrame,
  decodeDataFrame,
  encodeFilePayload,
  decodeFilePayload,
  isValidSessionId,
} from '../src/protocol';

describe('encodeDataFrame / decodeDataFrame', () => {
  it('round-trips empty payload', () => {
    const enc = encodeDataFrame(TAG.STDIN, 'abc', Buffer.alloc(0));
    const dec = decodeDataFrame(enc);
    expect(dec).not.toBeNull();
    expect(dec!.tag).toBe(TAG.STDIN);
    expect(dec!.sessionId).toBe('abc');
    expect(dec!.payload.length).toBe(0);
  });

  it('round-trips 1-byte payload', () => {
    const payload = Buffer.from([0x42]);
    const enc = encodeDataFrame(TAG.STDOUT, 'sess_1', payload);
    const dec = decodeDataFrame(enc);
    expect(dec).not.toBeNull();
    expect(dec!.tag).toBe(TAG.STDOUT);
    expect(dec!.sessionId).toBe('sess_1');
    expect(Buffer.compare(dec!.payload, payload)).toBe(0);
  });

  it('round-trips 1 KiB payload', () => {
    const payload = Buffer.alloc(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const enc = encodeDataFrame(TAG.FILE_UP_CHUNK, 'longish-session_id-1', payload);
    const dec = decodeDataFrame(enc);
    expect(dec).not.toBeNull();
    expect(dec!.tag).toBe(TAG.FILE_UP_CHUNK);
    expect(dec!.sessionId).toBe('longish-session_id-1');
    expect(Buffer.compare(dec!.payload, payload)).toBe(0);
  });

  it('round-trips across all defined tags', () => {
    for (const tag of Object.values(TAG)) {
      const enc = encodeDataFrame(tag, 'x', Buffer.from('hello'));
      const dec = decodeDataFrame(enc);
      expect(dec).not.toBeNull();
      expect(dec!.tag).toBe(tag);
    }
  });

  it('decodeDataFrame returns null on empty buffer', () => {
    expect(decodeDataFrame(Buffer.alloc(0))).toBeNull();
  });

  it('decodeDataFrame returns null on 1-byte buffer (header truncated)', () => {
    expect(decodeDataFrame(Buffer.from([0x01]))).toBeNull();
  });

  it('decodeDataFrame returns null when sidLen=0', () => {
    expect(decodeDataFrame(Buffer.from([0x01, 0x00]))).toBeNull();
  });

  it('decodeDataFrame returns null on truncated session id', () => {
    // tag=0x01, sidLen=10, but only 5 bytes follow.
    const buf = Buffer.concat([Buffer.from([0x01, 0x0a]), Buffer.from('hello')]);
    expect(decodeDataFrame(buf)).toBeNull();
  });
});

describe('encodeFilePayload / decodeFilePayload', () => {
  it('round-trips empty data', () => {
    const enc = encodeFilePayload('u_abc', 0, Buffer.alloc(0));
    const dec = decodeFilePayload(enc);
    expect(dec).not.toBeNull();
    expect(dec!.id).toBe('u_abc');
    expect(dec!.seq).toBe(0);
    expect(dec!.data.length).toBe(0);
  });

  it('round-trips a sample chunk', () => {
    const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const enc = encodeFilePayload('u_deadbeef', 7, data);
    const dec = decodeFilePayload(enc);
    expect(dec).not.toBeNull();
    expect(dec!.id).toBe('u_deadbeef');
    expect(dec!.seq).toBe(7);
    expect(Buffer.compare(dec!.data, data)).toBe(0);
  });

  it('round-trips a large seq (writeUInt32BE high bit)', () => {
    const enc = encodeFilePayload('u_x', 0xdeadbeef, Buffer.from('z'));
    const dec = decodeFilePayload(enc);
    expect(dec).not.toBeNull();
    expect(dec!.seq).toBe(0xdeadbeef);
  });

  it('decodeFilePayload returns null on too-short payload', () => {
    expect(decodeFilePayload(Buffer.alloc(0))).toBeNull();
    expect(decodeFilePayload(Buffer.alloc(4))).toBeNull();
  });

  it('decodeFilePayload returns null when idLen=0', () => {
    // idLen=0, then 4 bytes of "seq", then no data. Min length 5 is met.
    expect(decodeFilePayload(Buffer.from([0, 0, 0, 0, 0]))).toBeNull();
  });

  it('decodeFilePayload returns null on truncated id+seq', () => {
    // idLen says 8, but only 2 bytes of id follow and no seq bytes.
    const buf = Buffer.concat([Buffer.from([8]), Buffer.from('ab'), Buffer.from([0, 0])]);
    expect(decodeFilePayload(buf)).toBeNull();
  });
});

describe('isValidSessionId', () => {
  it('accepts short alphanumeric', () => {
    expect(isValidSessionId('abc')).toBe(true);
  });

  it('accepts underscores, hyphens, mixed case, digits', () => {
    expect(isValidSessionId('abc_123-XY')).toBe(true);
  });

  it('accepts boundary length 64', () => {
    expect(isValidSessionId('a'.repeat(64))).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false);
  });

  it('rejects length 65', () => {
    expect(isValidSessionId('a'.repeat(65))).toBe(false);
  });

  it('rejects slash', () => {
    expect(isValidSessionId('abc/def')).toBe(false);
  });

  it('rejects dot', () => {
    expect(isValidSessionId('abc.def')).toBe(false);
  });

  it('rejects space', () => {
    expect(isValidSessionId('abc def')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidSessionId(123)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId({})).toBe(false);
  });
});
