// Wire-format helpers for the v2 protocol. Spec: PROTOCOL.md.
//
// Binary frame layout: [tag:1][sidLen:1][sessionId:N][payload:M]
//   - tag      : channel selector
//   - sidLen   : length of sessionId in bytes (validator below caps at 64)
//   - sessionId: UTF-8, [a-zA-Z0-9_-]{1,64}
//   - payload  : rest of frame

export const TAG = {
  STDIN: 0x01,
  STDOUT: 0x02,
  FILE_UP_CHUNK: 0x03,
  FILE_DOWN_CHUNK: 0x04,
} as const;

export interface DataFrame {
  tag: number;
  sessionId: string;
  payload: Buffer;
}

export function encodeDataFrame(tag: number, sessionId: string, payload: Buffer): Buffer {
  const sidBytes = Buffer.from(sessionId, 'utf8');
  if (sidBytes.length === 0 || sidBytes.length > 255) {
    throw new RangeError(`sessionId byte length out of range: ${sidBytes.length}`);
  }
  const out = Buffer.allocUnsafe(2 + sidBytes.length + payload.length);
  out[0] = tag & 0xff;
  out[1] = sidBytes.length;
  sidBytes.copy(out, 2);
  payload.copy(out, 2 + sidBytes.length);
  return out;
}

export function decodeDataFrame(buf: Buffer): DataFrame | null {
  if (buf.length < 2) return null;
  const tag = buf[0]!;
  const sidLen = buf[1]!;
  if (sidLen === 0) return null;
  if (buf.length < 2 + sidLen) return null;
  const sessionId = buf.subarray(2, 2 + sidLen).toString('utf8');
  const payload = buf.subarray(2 + sidLen);
  return { tag, sessionId, payload };
}

// === file chunk payload =====================================================
// Inside a FILE_UP_CHUNK / FILE_DOWN_CHUNK data frame, the payload is itself
// structured: [idLen:1][transferId][seq:4 BE][bytes].
// transferId is the server-issued upload/download id.

export interface FilePayload {
  id: string;
  seq: number;
  data: Buffer;
}

export function decodeFilePayload(payload: Buffer): FilePayload | null {
  if (payload.length < 5) return null;
  const idLen = payload[0]!;
  if (idLen === 0) return null;
  if (payload.length < 1 + idLen + 4) return null;
  const id = payload.subarray(1, 1 + idLen).toString('utf8');
  const seq = payload.readUInt32BE(1 + idLen);
  const data = payload.subarray(1 + idLen + 4);
  return { id, seq, data };
}

export function encodeFilePayload(id: string, seq: number, data: Buffer): Buffer {
  const idBytes = Buffer.from(id, 'utf8');
  if (idBytes.length === 0 || idBytes.length > 255) {
    throw new RangeError(`transferId byte length out of range: ${idBytes.length}`);
  }
  const out = Buffer.allocUnsafe(1 + idBytes.length + 4 + data.length);
  out[0] = idBytes.length;
  idBytes.copy(out, 1);
  out.writeUInt32BE(seq >>> 0, 1 + idBytes.length);
  data.copy(out, 1 + idBytes.length + 4);
  return out;
}

// Session ID validation. Two reasons for the strict regex:
//   1. tmux session names tolerate most printables but interact weirdly
//      with `:` and whitespace, and our server passes the value to argv
//      (no shell, but still feeds tmux's parser).
//   2. Our binary frame's sidLen is one byte, so 64 is comfortably under
//      the wire budget and well-suited for human-typeable IDs.
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}
