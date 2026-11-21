// tools/hlg_patcher_v121/patch_hlg_v121.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, extname, join as join2, resolve } from "node:path";

// Ricoh-GRMod/core/src/fw/types.ts
var FirmwareError = class extends Error {
  code;
  checks;
  constructor(code, message, checks) {
    super(message ? `${code}: ${message}` : code);
    this.name = "FirmwareError";
    this.code = code;
    if (checks) this.checks = checks;
  }
};

// Ricoh-GRMod/core/src/fw/container.ts
var HDR = 128;
var FOOTER_LEN = 24;
var MODEL_RECORD_LEN = 128;
var MAGIC = 2774162085;
var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
var MAX_LENGTH_HINT = 536870912;
function sum32(b) {
  const len = b.length;
  const n = len - len % 4;
  let s = 0;
  if (LITTLE_ENDIAN && (b.byteOffset & 3) === 0) {
    const w = new Uint32Array(b.buffer, b.byteOffset, n >>> 2);
    for (let i = 0; i < w.length; i++) s = s + w[i] | 0;
  } else {
    for (let i = 0; i < n; i += 4) {
      s = s + (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) | 0;
    }
  }
  if (n !== len) {
    let t = 0;
    for (let i = len - 1; i >= n; i--) t = t << 8 | b[i];
    s = s + t | 0;
  }
  return s >>> 0;
}
function equalRange(a, aOff, b, bOff, len) {
  const la = Math.max(0, Math.min(a.length, aOff + len) - aOff);
  const lb = Math.max(0, Math.min(b.length, bOff + len) - bOff);
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (a[aOff + i] !== b[bOff + i]) return false;
  }
  return true;
}
function truncated(pos) {
  throw new FirmwareError("bad-stream", `read past the end of the input at 0x${pos.toString(16)}`);
}
function parseFrames(src, expectedLength) {
  const n = src.length;
  let cap = expectedLength !== void 0 && expectedLength > 0 && expectedLength <= MAX_LENGTH_HINT ? expectedLength : Math.max(65536, n * 2);
  let out = new Uint8Array(cap);
  let op = 0;
  const grow = (need) => {
    let c = cap;
    while (c < need) c = c * 2;
    const bigger = new Uint8Array(c);
    bigger.set(out.subarray(0, op));
    out = bigger;
    cap = c;
  };
  const frames = [];
  let pos = HDR;
  while (pos + 2 <= n) {
    const fs = pos;
    const os = op;
    const prefix = src[pos] << 8 | src[pos + 1];
    pos += 2;
    if (prefix === 0) break;
    const length = prefix & 32767;
    const end = pos + length;
    let maxback = 0;
    if (prefix & 32768) {
      const e = Math.min(end, n);
      if (e > pos) {
        if (op + (e - pos) > cap) grow(op + (e - pos));
        out.set(src.subarray(pos, e), op);
        op += e - pos;
      }
    } else {
      while (pos < end) {
        let flags;
        if (pos + 1 < n) flags = src[pos] << 8 | src[pos + 1];
        else if (pos < n) flags = src[pos];
        else flags = 0;
        pos += 2;
        for (let bit = 15; bit >= 0; bit--) {
          if (pos >= end) break;
          if (!(flags & 1 << bit)) {
            if (pos >= n) truncated(pos);
            if (op >= cap) grow(op + 1);
            out[op++] = src[pos++];
            continue;
          }
          if (pos + 1 >= n) truncated(pos);
          const first = src[pos];
          const second = src[pos + 1];
          pos += 2;
          const dist = ((first & 248) << 5) + second;
          let cnt = first & 7;
          if (cnt === 7) {
            if (pos >= n) truncated(pos);
            let ext = src[pos++];
            cnt += ext;
            while (ext === 255) {
              if (pos >= n) truncated(pos);
              ext = src[pos++];
              cnt += ext;
            }
          }
          if (!dist) break;
          const back = dist - (op - os);
          if (back > maxback) maxback = back;
          if (dist > op) {
            throw new FirmwareError("bad-stream", `back-reference before the start of the output at 0x${pos.toString(16)}`);
          }
          const run = cnt + 3;
          if (op + run > cap) grow(op + run);
          let from = op - dist;
          for (let k = 0; k < run; k++) out[op++] = out[from++];
        }
      }
    }
    pos = end;
    frames.push({ start: fs, end, stored: (prefix & 32768) !== 0, outStart: os, outLen: op - os, crossref: maxback });
  }
  const decoded = op === out.length ? out : out.slice(0, op);
  return { frames, decoded, streamEnd: pos };
}
function sectionsOf(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out = [];
  let o = 0;
  while (o + 16 <= d.length) {
    let nameLen = 8;
    while (nameLen > 0 && d[o + nameLen - 1] === 0) nameLen--;
    const v1 = dv.getUint16(o + 8, true);
    const v2 = dv.getUint16(o + 10, true);
    const size = dv.getUint32(o + 12, true);
    if (nameLen === 0) break;
    let name = "";
    let printable = true;
    for (let i = 0; i < nameLen; i++) {
      const c = d[o + i];
      if (!(c >= 32 && c < 127)) {
        printable = false;
        break;
      }
      name += String.fromCharCode(c);
    }
    if (!printable) break;
    out.push({ name, offset: o + 16, size, v1, v2 });
    if (name === "RES") break;
    o += 16 + size;
  }
  return out;
}
function projTwice(project) {
  if (project >= 65536) return null;
  return (project | project << 16) >>> 0;
}
var Firmware = class {
  raw;
  header;
  frames;
  decoded;
  streamEnd;
  fProj2;
  fMagic;
  fType;
  /** Stream length from the footer (includes the 00 00 terminator). */
  fClen;
  /** Decoded length from the footer. */
  fDlen;
  fSum;
  project;
  /** The model records between the padded stream and the 0x18-byte footer. */
  models;
  constructor(raw) {
    if (raw.length < HDR + FOOTER_LEN) throw new FirmwareError("too-short", "file is too short to be a firmware container");
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const t = raw.length - FOOTER_LEN;
    this.raw = raw;
    this.header = raw.subarray(0, HDR);
    const dlenHint = dv.getUint32(t + 16, true);
    const parsed = parseFrames(raw, dlenHint);
    this.frames = parsed.frames;
    this.decoded = parsed.decoded;
    this.streamEnd = parsed.streamEnd;
    this.fProj2 = dv.getUint32(t, true);
    this.fMagic = dv.getUint32(t + 4, true);
    this.fType = dv.getUint32(t + 8, true);
    this.fClen = dv.getUint32(t + 12, true);
    this.fDlen = dlenHint;
    this.fSum = dv.getUint32(t + 20, true);
    this.project = dv.getUint32(48, true);
    const pad = (4 - this.streamEnd % 4) % 4;
    const mStart = Math.min(this.streamEnd + pad, raw.length);
    this.models = raw.subarray(mStart, Math.max(mStart, t));
    if (!(this.fMagic === MAGIC && this.fProj2 === projTwice(this.project))) {
      throw new FirmwareError("bad-footer", "footer magic / project number mismatch");
    }
    if (this.fClen !== this.streamEnd - HDR) {
      throw new FirmwareError("bad-stream-length", `footer says 0x${this.fClen.toString(16)}, stream ends at 0x${this.streamEnd.toString(16)}`);
    }
    if (this.fDlen !== this.decoded.length) {
      throw new FirmwareError("bad-decoded-length", `footer says 0x${this.fDlen.toString(16)}, decoded 0x${this.decoded.length.toString(16)}`);
    }
    if (this.models.length % MODEL_RECORD_LEN !== 0) throw new FirmwareError("bad-models", "model record area is not a multiple of 0x80");
    if (!(sum32(raw) === 0 && sum32(this.decoded) === 0)) throw new FirmwareError("bad-checksum", "file or payload word sum is not zero");
  }
  sections() {
    return sectionsOf(this.decoded);
  }
};
function finishContainer(out, fw, streamLen, decodedLength) {
  const proj2 = projTwice(fw.project);
  if (proj2 === null) throw new FirmwareError("bad-footer", "project number does not fit");
  const bodyEnd = HDR + streamLen;
  const pad = (4 - bodyEnd % 4) % 4;
  out.fill(0, bodyEnd, bodyEnd + pad);
  let p = bodyEnd + pad;
  out.set(fw.models, p);
  p += fw.models.length;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(p, proj2, true);
  dv.setUint32(p + 4, MAGIC, true);
  dv.setUint32(p + 8, fw.fType, true);
  dv.setUint32(p + 12, streamLen, true);
  dv.setUint32(p + 16, decodedLength, true);
  p += 20;
  if (p + 4 !== out.length) throw new FirmwareError("internal", "container size computation is off");
  dv.setUint32(p, -sum32(out.subarray(0, p)) >>> 0, true);
}
function containerSize(fw, streamLen) {
  const bodyEnd = HDR + streamLen;
  return bodyEnd + (4 - bodyEnd % 4) % 4 + fw.models.length + FOOTER_LEN;
}
function decodeCompressedFrame(src, f, out, op) {
  if (f.stored) return -1;
  let pos = f.start + 2;
  const end = f.end;
  while (pos < end) {
    const flags = src[pos] << 8 | src[pos + 1];
    pos += 2;
    for (let bit = 15; bit >= 0; bit--) {
      if (pos >= end) break;
      if (!(flags & 1 << bit)) {
        if (op >= out.length) return -1;
        out[op++] = src[pos++];
        continue;
      }
      const first = src[pos];
      const second = src[pos + 1];
      pos += 2;
      const dist = ((first & 248) << 5) + second;
      let cnt = first & 7;
      if (cnt === 7) {
        let ext = src[pos++];
        cnt += ext;
        while (ext === 255) {
          ext = src[pos++];
          cnt += ext;
        }
      }
      if (!dist) break;
      if (dist > op) return -1;
      const run = cnt + 3;
      if (op + run > out.length) return -1;
      let from = op - dist;
      for (let k = 0; k < run; k++) out[op++] = out[from++];
    }
  }
  return op;
}
var FRAME_SIZE = 24576;
function buildGrown(fw, newDecoded, insertions) {
  const ins = [...insertions].sort((a, b) => a.at - b.at);
  let total = 0;
  for (const [k, x] of ins.entries()) {
    if (!(Number.isInteger(x.at) && Number.isInteger(x.length) && x.length > 0 && x.length % FRAME_SIZE === 0 && x.at > 0 && x.at < fw.decoded.length)) {
      throw new FirmwareError("bad-insertion", "an insertion must be a positive multiple of the frame size inside the payload");
    }
    if (k > 0 && ins[k - 1].at === x.at) throw new FirmwareError("bad-insertion", "two insertions at the same place");
    total += x.length;
  }
  if (newDecoded.length !== fw.decoded.length + total) throw new FirmwareError("size-mismatch", "the payload length does not match the insertions");
  if (sum32(newDecoded) !== 0) throw new FirmwareError("payload-sum-nonzero", "the payload word sum must be zero before building");
  const frames = fw.frames;
  const plan = [];
  let shift = 0;
  let next = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let grown = 0;
    while (next < ins.length && ins[next].at < f.outStart + f.outLen) {
      if (ins[next].at < f.outStart) throw new FirmwareError("internal", "insertion order");
      grown += ins[next].length;
      next++;
    }
    const newStart = f.outStart + shift;
    if (grown === 0) {
      plan.push({ orig: i, newStart, len: f.outLen, stored: !equalRange(newDecoded, newStart, fw.decoded, f.outStart, f.outLen) });
    } else {
      if (f.outLen !== FRAME_SIZE) throw new FirmwareError("needs-compressor", "an insertion falls into a frame of unusual size");
      for (let k = 0; k < (f.outLen + grown) / FRAME_SIZE; k++) plan.push({ orig: -1, newStart: newStart + k * FRAME_SIZE, len: FRAME_SIZE, stored: true });
      shift += grown;
    }
  }
  if (next !== ins.length) throw new FirmwareError("internal", "insertion past the last frame");
  const work = new Uint8Array(newDecoded.length);
  let op = 0;
  for (const p of plan) {
    if (op !== p.newStart) throw new FirmwareError("internal", "frame plan has a gap");
    if (!p.stored && !frames[p.orig].stored) {
      const end = decodeCompressedFrame(fw.raw, frames[p.orig], work, op);
      if (end !== op + p.len || !equalRange(work, op, newDecoded, op, p.len)) p.stored = true;
    } else if (!p.stored) {
      work.set(newDecoded.subarray(op, op + p.len), op);
    }
    if (p.stored) {
      if (p.len !== FRAME_SIZE) throw new FirmwareError("needs-compressor", `frame at 0x${p.newStart.toString(16)} needs a real compressor`);
      work.set(newDecoded.subarray(op, op + p.len), op);
    }
    op += p.len;
  }
  if (op !== newDecoded.length) throw new FirmwareError("internal", "frame plan does not cover the payload");
  let streamLen = 2;
  for (const p of plan) streamLen += p.stored ? 2 + p.len : frames[p.orig].end - frames[p.orig].start;
  const out = new Uint8Array(containerSize(fw, streamLen));
  out.set(fw.header, 0);
  let pos = HDR;
  for (const p of plan) {
    if (p.stored) {
      const prefix = 32768 | p.len;
      out[pos] = prefix >>> 8;
      out[pos + 1] = prefix & 255;
      out.set(newDecoded.subarray(p.newStart, p.newStart + p.len), pos + 2);
      pos += 2 + p.len;
    } else {
      const f = frames[p.orig];
      out.set(fw.raw.subarray(f.start, f.end), pos);
      pos += f.end - f.start;
    }
  }
  out[pos] = 0;
  out[pos + 1] = 0;
  pos += 2;
  if (pos !== HDR + streamLen) throw new FirmwareError("internal", "stream size computation is off");
  const re = parseFrames(out.subarray(0, HDR + streamLen), newDecoded.length);
  if (re.frames.length !== plan.length) throw new FirmwareError("frame-count-changed", "re-decoded stream has a different number of frames");
  for (let k = 0; k < plan.length; k++) {
    const g = re.frames[k];
    const stored = plan[k].stored || frames[plan[k].orig].stored;
    if (g.outStart !== plan[k].newStart || g.outLen !== plan[k].len || g.stored !== stored) throw new FirmwareError("internal", "re-decoded frame layout differs");
  }
  if (re.decoded.length !== newDecoded.length || !equalRange(re.decoded, 0, newDecoded, 0, newDecoded.length)) throw new FirmwareError("stored-frame-mismatch", "re-decoded payload differs");
  finishContainer(out, fw, streamLen, newDecoded.length);
  const reencoded = [];
  plan.forEach((p, k) => {
    if (p.stored) reencoded.push(k);
  });
  return { out, reencoded };
}
function verifyContainer(raw, expectDecoded) {
  if (raw.length < HDR + FOOTER_LEN) throw new FirmwareError("too-short", "file is too short to be a firmware container");
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const res = {};
  const proj = dv.getUint32(48, true);
  const proj2 = projTwice(proj);
  res.hdr_proj2 = dv.getUint32(120, true) === proj2;
  res.hdr_magic = dv.getUint32(124, true) === MAGIC;
  const t = raw.length - FOOTER_LEN;
  const p2 = dv.getUint32(t, true);
  const mg = dv.getUint32(t + 4, true);
  const clen = dv.getUint32(t + 12, true);
  const dlen = dv.getUint32(t + 16, true);
  res.ftr_proj2 = p2 === proj2;
  res.ftr_magic = mg === MAGIC;
  res.file_sum_zero = sum32(raw) === 0;
  let dec;
  let frames = [];
  let streamEnd;
  if (clen === dlen) {
    dec = raw.subarray(HDR, Math.min(raw.length, HDR + dlen));
    streamEnd = HDR + dec.length;
  } else {
    const parsed = parseFrames(raw.subarray(0, Math.min(raw.length, HDR + clen)), dlen);
    dec = parsed.decoded;
    frames = parsed.frames;
    streamEnd = parsed.streamEnd;
    res.stream_len_matches = parsed.streamEnd - HDR === clen;
  }
  res.decoded_len_matches = dec.length === dlen;
  res.decoded_sum_zero = sum32(dec) === 0;
  if (expectDecoded !== void 0) {
    res.decoded_equals_expected = dec.length === expectDecoded.length && equalRange(dec, 0, expectDecoded, 0, dec.length);
  }
  return { checks: res, decoded: dec, frames, streamEnd };
}
async function sha256Hex(bytes) {
  const subtle = globalThis.crypto.subtle;
  const digest = await subtle.digest("SHA-256", bytes);
  const h = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < h.length; i++) s += h[i].toString(16).padStart(2, "0");
  return s;
}

// Ricoh-GRMod/core/src/fw/gr4v121/aspect/arm.ts
var REGS = { sb: 9, sl: 10, fp: 11, ip: 12, sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) REGS["r" + i] = i;
var DP = {
  and: { op: 0, kind: "rd-rn-op2" },
  eor: { op: 1, kind: "rd-rn-op2" },
  sub: { op: 2, kind: "rd-rn-op2" },
  rsb: { op: 3, kind: "rd-rn-op2" },
  add: { op: 4, kind: "rd-rn-op2" },
  adc: { op: 5, kind: "rd-rn-op2" },
  sbc: { op: 6, kind: "rd-rn-op2" },
  orr: { op: 12, kind: "rd-rn-op2" },
  bic: { op: 14, kind: "rd-rn-op2" },
  mov: { op: 13, kind: "rd-op2" },
  mvn: { op: 15, kind: "rd-op2" },
  cmp: { op: 10, kind: "rn-op2" },
  cmn: { op: 11, kind: "rn-op2" },
  tst: { op: 8, kind: "rn-op2" },
  teq: { op: 9, kind: "rn-op2" }
};
var BASES = [
  "umull",
  "movw",
  "movt",
  "ldrb",
  "ldrh",
  "strb",
  "strh",
  "uxtb",
  "vldr",
  "push",
  "pop",
  "mrs",
  "msr",
  "mul",
  "ldr",
  "str",
  ...Object.keys(DP)
];
function fail(message) {
  throw new FirmwareError("asm", message);
}
function branchWord(at, target, cond = 14, link = false) {
  const delta = target - at - 8;
  if (delta % 4 !== 0 || !(delta >= -(1 << 25) && delta < 1 << 25)) fail(`branch target out of range: 0x${at.toString(16)} -> 0x${target.toString(16)}`);
  return (cond << 28 | (link ? 184549376 : 167772160) | delta >> 2 & 16777215) >>> 0;
}
function branchTarget(at, word) {
  if ((word & 234881024) !== 167772160) fail(`not a branch at 0x${at.toString(16)}`);
  let d = word & 16777215;
  if (d & 8388608) d -= 16777216;
  return at + 8 + d * 4;
}
function movWord(rd, value, high = false, cond = 14) {
  if (!(value >= 0 && value <= 65535)) fail("MOVW/MOVT immediate out of range");
  return (cond << 28 | (high ? 54525952 : 50331648) | (value & 61440) << 4 | rd << 12 | value & 4095) >>> 0;
}
function movImmediate(word) {
  return word >>> 4 & 61440 | word & 4095;
}

// Ricoh-GRMod/core/src/fw/aspect/arm.ts
var REGS2 = { sb: 9, sl: 10, fp: 11, ip: 12, sp: 13, lr: 14, pc: 15 };
for (let i = 0; i < 16; i++) REGS2["r" + i] = i;
var DP2 = {
  and: { op: 0, kind: "rd-rn-op2" },
  eor: { op: 1, kind: "rd-rn-op2" },
  sub: { op: 2, kind: "rd-rn-op2" },
  rsb: { op: 3, kind: "rd-rn-op2" },
  add: { op: 4, kind: "rd-rn-op2" },
  adc: { op: 5, kind: "rd-rn-op2" },
  sbc: { op: 6, kind: "rd-rn-op2" },
  orr: { op: 12, kind: "rd-rn-op2" },
  bic: { op: 14, kind: "rd-rn-op2" },
  mov: { op: 13, kind: "rd-op2" },
  mvn: { op: 15, kind: "rd-op2" },
  cmp: { op: 10, kind: "rn-op2" },
  cmn: { op: 11, kind: "rn-op2" },
  tst: { op: 8, kind: "rn-op2" },
  teq: { op: 9, kind: "rn-op2" }
};
var BASES2 = [
  "umull",
  "movw",
  "movt",
  "ldrb",
  "ldrh",
  "strb",
  "strh",
  "uxtb",
  "vldr",
  "push",
  "pop",
  "mrs",
  "msr",
  "mul",
  "ldr",
  "str",
  ...Object.keys(DP2)
];

// Ricoh-GRMod/core/src/fw/aspect/fraction.ts
function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
var Frac = class _Frac {
  n;
  /** Always positive. */
  d;
  constructor(n, d = 1n) {
    let nn = BigInt(n);
    let dd = BigInt(d);
    if (dd === 0n) throw new RangeError("zero denominator");
    if (dd < 0n) {
      nn = -nn;
      dd = -dd;
    }
    const g = gcd(nn, dd);
    this.n = g === 0n ? 0n : nn / g;
    this.d = g === 0n ? 1n : dd / g;
  }
  mul(o) {
    const f = o instanceof _Frac ? o : new _Frac(o);
    return new _Frac(this.n * f.n, this.d * f.d);
  }
  div(o) {
    const f = o instanceof _Frac ? o : new _Frac(o);
    return new _Frac(this.n * f.d, this.d * f.n);
  }
  add(o) {
    const f = o instanceof _Frac ? o : new _Frac(o);
    return new _Frac(this.n * f.d + f.n * this.d, this.d * f.d);
  }
  cmp(o) {
    const f = o instanceof _Frac ? o : new _Frac(o);
    const l = this.n * f.d;
    const r = f.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) {
    return this.cmp(o) === 0;
  }
  /** Python `self // 1`. */
  floor() {
    return floorDiv(this.n, this.d);
  }
  /** Python `round(self)`: nearest integer, ties to even. */
  round() {
    const fl = floorDiv(this.n, this.d);
    const twice = 2n * (this.n - fl * this.d);
    if (twice < this.d) return fl;
    if (twice > this.d) return fl + 1n;
    return fl % 2n === 0n ? fl : fl + 1n;
  }
  toNumber() {
    return Number(this.n) / Number(this.d);
  }
  static min(a, b) {
    return a.cmp(b) <= 0 ? a : b;
  }
};

// Ricoh-GRMod/core/src/fw/aspect/geometry.ts
var PLANE_W = 45 << 16;
var PLANE_H = 30 << 16;
var THREE_HALVES = new Frac(3, 2);

// Ricoh-GRMod/core/src/fw/aspect/icon.ts
var RATIO_ICON_W = 60;
var RATIO_ICON_H = 40;
var RATIO_ICON_BYTES = RATIO_ICON_W * RATIO_ICON_H * 4;

// Ricoh-GRMod/core/src/fw/profile.ts
var RTOS_OFFSET = 97552;
var RTOS_VA = 1392508928;
var POST = {
  /** Offset of the array pointer in a style record. */
  recWord: 8,
  entries: 9,
  /** Bytes of one entry: 9 int16 + 2 padding. */
  stride: 20,
  /** Index of saturation 0 (identity). */
  neutral: 4,
  /** Bytes used at the start of a slot's own multi-axis block once that block is free: 9 pointers + 9 entries. */
  bytes: 9 * 4 + 9 * 20,
  /** Words in a style's multi-axis pointer array (all point to its block). */
  maArrWords: 8
};
var ICON_BYTES = 40 * 40 * 4;

// Ricoh-GRMod/core/src/fw/clarity.ts
var CLARITY_VA = 1404356704;
var CLARITY_OFFSET = RTOS_OFFSET + (CLARITY_VA - RTOS_VA);
var CLARITY_ROWS = 9;
var CLARITY_BANDS = 11;
var CLARITY_BYTES = CLARITY_ROWS * CLARITY_BANDS * 2;

// Ricoh-GRMod/core/src/fw/aspect/softfocus.ts
var SOFT_FOCUS_BYTE = 1426607576 + 4 + 2319;
var FIRST_TABLE_RAM = 1426063360 + (1412945840 - 1412937280);

// Ricoh-GRMod/core/src/fw/aspect/directflash.ts
var DIRECT_FLASH_BYTE = 1426607576 + 4 + 2459;
var DIRECT_FLASH_GN_BYTE = 1426607576 + 4 + 2458;
var DIRECT_FLASH_TV_BYTE = 1426607576 + 4 + 265;
var CURRENT = 1426607576;
var LIVE_FLASH_MODE = CURRENT + 3064;
var FLASH_OUTPUT = CURRENT + 276;
var ADJ_RECORD = 1406793492 + 9 * 92;
var LIST_RECORDS = [1406807328 + 11 * 76, 1406807328 + 12 * 76];
var FIRST_TABLE_RAM2 = 1426063360 + (1412945840 - 1412937280);

// Ricoh-GRMod/core/src/fw/aspect/lookstash.ts
var LOOK_STASH = 1434677988;
var ORIENT_WORD = 1434678004;
var ORIENT_VALID = 256;
var FRAME_LOOK = 1434678008;
var STASH_ASM = `ldr r2,[r1,#0x2d0];push {r0,r1};
  ldrb r0,[r1,#0x2ac];cmp r0,#0;bne stashlook;
  add r0,r2,#0x71000;ldrb r1,[r0,#0xe83];cmp r1,#0;ldrbne r2,[r0,#0xe84];ldrbeq r2,[r2,#0xd8];cmp r2,#3;movhi r2,#0;
  orr r2,r2,#0x${ORIENT_VALID.toString(16)};movw r1,#${ORIENT_WORD & 65535};movt r1,#${ORIENT_WORD >>> 16};str r2,[r1];
  stashlook:ldrb r0,[r3,#0x79c];ldrb r1,[r3,#0x7a6];
  cmp r1,#7;movhs r1,#0;
  cmp r1,#4;subhs r1,r1,#3;orrhs r0,r0,#0x20000;bhs stashlevel;
  cmp r1,#3;moveq r1,#2;beq stashlevel;
  cmp r1,#2;moveq r1,#3;
  stashlevel:orr r0,r0,r1,lsl #8;orr r0,r0,#0x10000;movw r1,#${LOOK_STASH & 65535};movt r1,#${LOOK_STASH >>> 16};str r0,[r1];
  ldr r1,[sp,#4];ldrb r1,[r1,#0x2ac];cmp r1,#0;bne stashdone;
  movw r1,#${FRAME_LOOK & 65535};movt r1,#${FRAME_LOOK >>> 16};str r0,[r1];
  stashdone:pop {r0,r1};`;

// Ricoh-GRMod/core/src/fw/aspect/datestamp.ts
var DATESTAMP_BYTE = 1426607576 + 4 + 2379;
var A = 1;
var B = 2;
var C = 4;
var D = 8;
var E = 16;
var F = 32;
var G1 = 64;
var G2 = 128;
var UL = 256;
var UM = 512;
var UR = 1024;
var LL = 2048;
var LM = 4096;
var LR = 8192;
var LETTER_SEGMENTS = {
  A: A | B | C | E | F | G1 | G2,
  B: A | B | C | D | G2 | UM | LM,
  C: A | D | E | F,
  D: A | B | C | D | UM | LM,
  E: A | D | E | F | G1 | G2,
  F: A | E | F | G1 | G2,
  G: A | C | D | E | F | G2,
  H: B | C | E | F | G1 | G2,
  I: A | D | UM | LM,
  J: B | C | D | E,
  K: E | F | G1 | UR | LR,
  L: D | E | F,
  M: B | C | E | F | UL | UR,
  N: B | C | E | F | UL | LR,
  O: A | B | C | D | E | F,
  P: A | B | E | F | G1 | G2,
  Q: A | B | C | D | E | F | LR,
  R: A | B | E | F | G1 | G2 | LR,
  S: A | C | D | F | G1 | G2,
  T: A | UM | LM,
  U: B | C | D | E | F,
  V: E | F | LL | UR,
  W: B | C | E | F | LL | LR,
  X: UL | UR | LL | LR,
  Y: UL | UR | LM,
  Z: A | D | UR | LL,
  "+": G1 | G2 | UM | LM,
  "-": G1 | G2,
  "/": UR | LL,
  "\\": UL | LR,
  "(": UR | LR,
  ")": UL | LL,
  "<": UR | LR,
  ">": UL | LL,
  "&": A | D | E | UL | G1 | LR | UM,
  "?": A | B | G2 | LM,
  "_": D,
  "*": G1 | G2 | UL | UR | LL | LR | UM | LM,
  "=": G1 | G2 | D,
  '"': F | UM,
  "$": A | C | D | F | G1 | G2 | UM | LM,
  "%": F | C | G1 | G2 | UR | LL,
  "#": B | C | D | G1 | G2 | UM | LM,
  "@": A | B | D | E | F | G2 | UM,
  "[": A | D | E | F,
  "]": A | B | C | D,
  "|": UM | LM,
  "^": LL | LR,
  "!": B | C,
  ",": LL,
  ";": A | LL,
  ":": UM | LM,
  "`": UL,
  "~": G1 | G2,
  "{": A | D | E | F | G1,
  "}": A | B | C | D | G2
};

// Ricoh-GRMod/core/src/fw/aspect/datestamp-menu.ts
var SUB_RECORDS = 18;
var SELECT_RECORDS = 124;
var SUB_RECORD_NUMBER = SUB_RECORDS + 1;
var SWITCH_RECORD_NUMBER = SELECT_RECORDS + 1;
var STYLE_RECORD_NUMBER = SELECT_RECORDS + 2;
var ORIENT_RECORD_NUMBER = SELECT_RECORDS + 3;
var FIRST_TABLE_RAM3 = 1426063360 + (1412945840 - 1412937280);
function lo(v) {
  return v & 65535;
}
function hi(v) {
  return v >>> 16;
}
var LOAD_SETTING = `movw r2, #${lo(DATESTAMP_BYTE)}; movt r2, #${hi(DATESTAMP_BYTE)}; ldrb r3, [r2]
  cmp r3, #15; movhi r3, #0; strbhi r3, [r2]`;

// Ricoh-GRMod/core/src/fw/aspect/directflash-menu.ts
var DF_TEXT_ID = 910;
var DF_FASTEST_TEXT_ID = DF_TEXT_ID + 4 + 21 + 15 + 8 + 2 + 5;
var FIRST_TABLE_RAM4 = 1426063360 + (1412945840 - 1412937280);

// Ricoh-GRMod/core/src/fw/aspect/hdrgain.ts
var WRITER_VTABLE = 1408922952;
var SLOT_INFO = WRITER_VTABLE + 9 * 4;
var SLOT_COUNT = WRITER_VTABLE + 10 * 4;
var HDR_SWITCH_BYTE = 1426607576 + 4 + 266;

// Ricoh-GRMod/core/src/fw/aspect/monounlock.ts
var TABLE = 1406923628;
var MONOCHROME_COLUMN = 1;
var LOOK_FLAGS = [];
for (let row = 3; row <= 8; row++) for (let col = 0; col < 7; col++) if (col !== MONOCHROME_COLUMN) LOOK_FLAGS.push(TABLE + row * 7 + col);

// Ricoh-GRMod/core/src/fw/aspect/halation.ts
var HALATION = {
  /** Level (of 255, as Standard renders grey) where light starts; it rises with the square of linear light above it, to 1 at white. */
  start: 220,
  /** Least Standard levels from where light starts to where the look reaches its white. */
  minRange: 35,
  /** Box radius of the narrow and the wide spread, as a fraction of the picture's width (three box passes each way: about a gaussian of this sigma). */
  narrow: 35e-4,
  wide: 0.012,
  /** Share of the narrow spread. */
  mix: 0.6,
  /**
   * The camera's Weak, Medium and Strong: how strongly the spread light lifts the colours. 0.8.2:
   * Weak as test 036's "weak" Weak, Strong as its "normal" Weak (chosen on the camera), Medium
   * between; up to 0.8.1 Weak was 25, Strong 60 (with the harder start).
   */
  gain: [12, 18, 24],
  /** Lift of red, green and blue per unit of light (red first: the red layer is exposed again from behind, a little the green). */
  channels: [1, 0.06, 0.03],
  /** White (0.8.2, chosen on the camera): every channel lifted alike, a soft white bloom like the GR IV HDF's highlight diffusion. */
  white: [0.6, 0.6, 0.6],
  /**
   * White's Weak and Medium from 0.9 (the camera's levels 1 and 2; `struct scatter` in halation.c):
   * like a diffusion filter (Black Pro-Mist 1/8 and 1/4, the GR IV HDF), no start. A share `k` of
   * all the light, in linear light, is spread with three widths (gaussian sigma of `radii` of the
   * picture's width, mixed by `weights`) and laid back: (1 - k) L + k blur(E). E is the light with
   * clipped highlights opened up again, times 1 + `open` x^2 where x is how far the brightest
   * channel's linear light is above `knee` (to 1 at white): a lamp was brighter than white.
   */
  scatter: { k: [0.08, 0.15], radii: [4e-3, 0.02, 0.06], weights: [0.5, 0.35, 0.15], open: 7, knee: 0.55 },
  /** White's Strong from 0.9: the 0.8.2 white glow with a lower start (of 255 as Standard renders grey) and gain (table index = light * gain >> 10). */
  whiteStrong: { start: 150, gain: 25 }
};
var PARAM_BYTES = 16;
var E_MAX = 16384;
var CTX_WORDS = 10;
var MAGIC_AT = CTX_WORDS * 4 + PARAM_BYTES;
var linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
function halationLight(curves, postQ9) {
  return { table: lightTable(HALATION.start, curves, postQ9), strong: lightTable(HALATION.whiteStrong.start, curves, postQ9) };
}
function lightTable(start, curves, postQ9) {
  const level = (v) => {
    if (!curves) return v;
    const x = v / 255 * (16383 / 64);
    const i = Math.min(254, Math.floor(x)), f = x - i;
    let o = curves.map((c) => Math.min(16383, c[i] + (c[i + 1] - c[i]) * f) / 16383);
    if (postQ9) o = [0, 1, 2].map((r) => (postQ9[r * 3] * o[0] + postQ9[r * 3 + 1] * o[1] + postQ9[r * 3 + 2] * o[2]) / 512);
    const [R, G, B2] = o.map((c) => (c < 0 ? 0 : c > 1 ? 1 : c) * 255);
    return Math.max(R, 0.299 * R + 0.587 * G + 0.114 * B2);
  };
  const out = [];
  let top = 0;
  for (let d2 = 0; d2 <= 255; d2++) out.push(top = Math.max(top, level(d2)));
  const white = out[255];
  let dw = 255;
  while (dw > 0 && out[dw - 1] >= white - 0.5) dw--;
  const L0 = linear(Math.min(start, dw - HALATION.minRange) / 255);
  const Lw = linear(dw / 255);
  const table = new Uint16Array(256);
  let d = 0;
  for (let v = 0; v < 256; v++) {
    if (v >= white - 0.5) {
      table[v] = E_MAX;
      continue;
    }
    while (d < 255 && out[d + 1] <= v) d++;
    const a = out[d], b = d < 255 ? out[d + 1] : a;
    const lv = b > a ? d + Math.min(1, Math.max(0, (v - a) / (b - a))) : d;
    const t = (linear(lv / 255) - L0) / (Lw - L0);
    table[v] = t <= 0 ? 0 : Math.min(E_MAX, Math.round(E_MAX * Math.min(1, t) * Math.min(1, t)));
  }
  return table;
}
var PLAIN_LIGHT = halationLight();

// Ricoh-GRMod/core/src/fw/aspect/halation-ui.ts
var HAL_FLAG = 1434677992;
var addr = (r, v) => `movw ${r},#${v & 65535};movt ${r},#${v >>> 16}`;
var flagTest = `${addr("ip", HAL_FLAG)};ldr ip,[ip];cmp ip,#0`;

// Ricoh-GRMod/core/src/color/hue.ts
var RAD = Math.PI / 180;
var HUE_COPIES = 5;
var HUE_BLOCK_BYTES = 12 * HUE_COPIES * 9 * 4;

// Ricoh-GRMod/core/src/fw/aspect/slots.ts
var EXTRA_ICON_BYTES = 40 * 40 * 4;

// Ricoh-GRMod/core/src/jpeg/tables.ts
var ZIGZAG = new Uint8Array([
  0,
  1,
  8,
  16,
  9,
  2,
  3,
  10,
  17,
  24,
  32,
  25,
  18,
  11,
  4,
  5,
  12,
  19,
  26,
  33,
  40,
  48,
  41,
  34,
  27,
  20,
  13,
  6,
  7,
  14,
  21,
  28,
  35,
  42,
  49,
  56,
  57,
  50,
  43,
  36,
  29,
  22,
  15,
  23,
  30,
  37,
  44,
  51,
  58,
  59,
  52,
  45,
  38,
  31,
  39,
  46,
  53,
  60,
  61,
  54,
  47,
  55,
  62,
  63
]);
var NATURAL_TO_ZIGZAG = (() => {
  const t = new Uint8Array(64);
  for (let k = 0; k < 64; k++) t[ZIGZAG[k]] = k;
  return t;
})();
var STD_LUMA_QTABLE = new Uint8Array([
  16,
  11,
  10,
  16,
  24,
  40,
  51,
  61,
  12,
  12,
  14,
  19,
  26,
  58,
  60,
  55,
  14,
  13,
  16,
  24,
  40,
  57,
  69,
  56,
  14,
  17,
  22,
  29,
  51,
  87,
  80,
  62,
  18,
  22,
  37,
  56,
  68,
  109,
  103,
  77,
  24,
  35,
  55,
  64,
  81,
  104,
  113,
  92,
  49,
  64,
  78,
  87,
  103,
  121,
  120,
  101,
  72,
  92,
  95,
  98,
  112,
  100,
  103,
  99
]);
var STD_CHROMA_QTABLE = new Uint8Array([
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99,
  99
]);
var DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
var AC_LUMA_VALUES = [
  1,
  2,
  3,
  0,
  4,
  17,
  5,
  18,
  33,
  49,
  65,
  6,
  19,
  81,
  97,
  7,
  34,
  113,
  20,
  50,
  129,
  145,
  161,
  8,
  35,
  66,
  177,
  193,
  21,
  82,
  209,
  240,
  36,
  51,
  98,
  114,
  130,
  9,
  10,
  22,
  23,
  24,
  25,
  26,
  37,
  38,
  39,
  40,
  41,
  42,
  52,
  53,
  54,
  55,
  56,
  57,
  58,
  67,
  68,
  69,
  70,
  71,
  72,
  73,
  74,
  83,
  84,
  85,
  86,
  87,
  88,
  89,
  90,
  99,
  100,
  101,
  102,
  103,
  104,
  105,
  106,
  115,
  116,
  117,
  118,
  119,
  120,
  121,
  122,
  131,
  132,
  133,
  134,
  135,
  136,
  137,
  138,
  146,
  147,
  148,
  149,
  150,
  151,
  152,
  153,
  154,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  178,
  179,
  180,
  181,
  182,
  183,
  184,
  185,
  186,
  194,
  195,
  196,
  197,
  198,
  199,
  200,
  201,
  202,
  210,
  211,
  212,
  213,
  214,
  215,
  216,
  217,
  218,
  225,
  226,
  227,
  228,
  229,
  230,
  231,
  232,
  233,
  234,
  241,
  242,
  243,
  244,
  245,
  246,
  247,
  248,
  249,
  250
];
var AC_CHROMA_VALUES = [
  0,
  1,
  2,
  3,
  17,
  4,
  5,
  33,
  49,
  6,
  18,
  65,
  81,
  7,
  97,
  113,
  19,
  34,
  50,
  129,
  8,
  20,
  66,
  145,
  161,
  177,
  193,
  9,
  35,
  51,
  82,
  240,
  21,
  98,
  114,
  209,
  10,
  22,
  36,
  52,
  225,
  37,
  241,
  23,
  24,
  25,
  26,
  38,
  39,
  40,
  41,
  42,
  53,
  54,
  55,
  56,
  57,
  58,
  67,
  68,
  69,
  70,
  71,
  72,
  73,
  74,
  83,
  84,
  85,
  86,
  87,
  88,
  89,
  90,
  99,
  100,
  101,
  102,
  103,
  104,
  105,
  106,
  115,
  116,
  117,
  118,
  119,
  120,
  121,
  122,
  130,
  131,
  132,
  133,
  134,
  135,
  136,
  137,
  138,
  146,
  147,
  148,
  149,
  150,
  151,
  152,
  153,
  154,
  162,
  163,
  164,
  165,
  166,
  167,
  168,
  169,
  170,
  178,
  179,
  180,
  181,
  182,
  183,
  184,
  185,
  186,
  194,
  195,
  196,
  197,
  198,
  199,
  200,
  201,
  202,
  210,
  211,
  212,
  213,
  214,
  215,
  216,
  217,
  218,
  226,
  227,
  228,
  229,
  230,
  231,
  232,
  233,
  234,
  242,
  243,
  244,
  245,
  246,
  247,
  248,
  249,
  250
];
var STD_HUFFMAN = [
  { tcTh: 0, bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: DC_VALUES },
  { tcTh: 16, bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125], values: AC_LUMA_VALUES },
  { tcTh: 1, bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: DC_VALUES },
  { tcTh: 17, bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119], values: AC_CHROMA_VALUES }
];

// Ricoh-GRMod/core/src/jpeg/encoder.ts
function buildHeaderTemplate() {
  const b = [];
  b.push(255, 216);
  b.push(255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  const dqtOffsets = [0, 0];
  for (let t = 0; t < 2; t++) {
    b.push(255, 219, 0, 67, t);
    dqtOffsets[t] = b.length;
    for (let i = 0; i < 64; i++) b.push(1);
  }
  const sofOffset = b.length;
  b.push(255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 33, 0, 2, 17, 1, 3, 17, 1);
  for (const spec of STD_HUFFMAN) {
    b.push(255, 196, 0, 2 + 1 + 16 + spec.values.length, spec.tcTh, ...spec.bits, ...spec.values);
  }
  b.push(255, 218, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0);
  return { bytes: new Uint8Array(b), dqtOffsets, sofOffset };
}
var HEADER = buildHeaderTemplate();
var HEADER_BYTES = HEADER.bytes.length;
var OVERHEAD_BYTES = HEADER_BYTES + 2;
function deriveCodes(bits, values) {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let i = 0;
  for (let len = 1; len <= 16; len++) {
    for (let n = 0; n < bits[len - 1]; n++) {
      code[values[i]] = c;
      size[values[i]] = len;
      c++;
      i++;
    }
    c <<= 1;
  }
  return { code, size };
}
var HUFF = (() => {
  const make = (dc, ac) => {
    const d = deriveCodes(STD_HUFFMAN[dc].bits, STD_HUFFMAN[dc].values);
    const a = deriveCodes(STD_HUFFMAN[ac].bits, STD_HUFFMAN[ac].values);
    return { dcCode: d.code, dcSize: d.size, acCode: a.code, acSize: a.size };
  };
  return [make(0, 1), make(2, 3)];
})();
var NBITS = (() => {
  const t = new Uint8Array(2048);
  for (let i = 1; i < 2048; i++) t[i] = 32 - Math.clz32(i);
  return t;
})();
var DCT_MATRIX = (() => {
  const m = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const a = u === 0 ? Math.sqrt(1 / 8) : 0.5;
    for (let x = 0; x < 8; x++) m[u * 8 + x] = a * Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
  return m;
})();
var CACHE_BYTE_LIMIT = 48 << 20;

// Ricoh-GRMod/core/src/fw/aspect/shutdown.ts
var SHUTDOWN_MAX_PICTURES = 8;
var SHUTDOWN_TEXT_ID = 853;
var SHUTDOWN_PICTURE_TEXT = SHUTDOWN_TEXT_ID + 1;
var SHUTDOWN_FACTORY_TEXT = SHUTDOWN_TEXT_ID + 2;
var SHUTDOWN_JPEG_BYTES = 2 * 24576 - 36;
var CTX_BYTES = 6 * 4 + 4 * 2 + SHUTDOWN_MAX_PICTURES * 2 + SHUTDOWN_MAX_PICTURES * 4 * 2;

// Ricoh-GRMod/core/src/fw/aspect/adjslots.ts
var ADJ_EXTRA_BYTE = 1426607576 + 4 + 1161;

// Ricoh-GRMod/core/src/fw/aspect/build.ts
var TEXT_CAPACITY = 896;
var ROW_STRIDE = TEXT_CAPACITY * 4;
var VIEW_BYTES = 400 + 12 * 48;

// Ricoh-GRMod/core/src/fw/aspect/hlg-data.ts
var HLG_MATRIX_B64 = "qhXRCoX/JwPNHQz/9/9rBJ4b";
var HLG_CURVE_B64 = "AACvAswDpwRfBQEGlAYlB70HSgjPCEwJwwk4CqkKFQt9C+ELRQymDAUNYg27DRQObA7CDhYPaA+7DwwQXBCqEPcQRBGQEdoRJBJsErYS/RJEE4oT0BMWFFoUnhThFCQVZxWoFekVKxZsFq0W7BYsF2sXqhfoFyYYZBihGN4YGxlYGZQZzxkLGkYagRq7GvYaMBtqG6Mb3RsWHE8ciBzBHPkcMh1qHaQd3h0YHlIejh7JHgQfQR9+H7sf+R83IHQgsiDvICshZyGjId4hGiJWIpAiyyIEIz8jeCOyI+sjIyRcJJQkzSQEJTwldCWrJeIlGSZQJoYmvSbzJiknXieTJ8gn/ScyKGYomyjQKAQpOClrKZ8p0ykGKjkqbCqeKtEqBCs2K2grmivMK/0rLyxgLJIswyz0LCYtVi2ILbgt6C0ZLkkuei6pLtouCS85L2kvmC/HL/cvJjBWMIUwtDDjMBIxQDFvMZ0xzDH6MSkyVzKFMrMy4TIPMz0zajOYM8Yz8zMhNE40ezSoNNY0AzUwNV01ijW2NeM1EDY8Nmk2ljbCNu42GzdHN3M3nzfMN/s3KzhbOIo4ujjqOBg5SDl3Oac51jkFOjU6ZDqUOsM68johO1A7fzuuO907DDw7PGo8mTzIPPc8JT1UPYM9sj3hPQ8+Pz5tPpw+yj75Pig/Vj8=";
var HLG_ICC_B64 = "AAACFGxjbXMEQAAAbW50clJHQiBYWVogB+kADAABAAsACQAJYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1SSUNPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAABKY3BydAAAAUgAAAA+d3RwdAAAAYgAAAAUclhZWgAAAZwAAAAUZ1hZWgAAAbAAAAAUYlhZWgAAAcQAAAAUclRSQwAAAdgAAAAQZ1RSQwAAAegAAAAQYlRSQwAAAfgAAAAQY2ljcAAAAggAAAAMbWx1YwAAAAAAAAABAAAADGVuVVMAAAAuAAAAHABSAGkAYwBvAGgAIABHAFIAIABJAFYAIABCAFQALgAyADEAMAAwACAASABMAEcAAG1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIgAAABwAQwBDADAAIABQAHUAYgBsAGkAYwAgAEQAbwBtAGEAaQBuAABYWVogAAAAAAAA9tYAAQAAAADTLVhZWiAAAAAAAACsZQAAR2////+BWFlaIAAAAAAAACppAACs4wAAB61YWVogAAAAAAAAIAgAAAuuAADL/2N1cnYAAAAAAAAAAQIzAABjdXJ2AAAAAAAAAAECMwAAY3VydgAAAAAAAAABAjMAAGNpY3AAAAAACRIAAQ==";
var HLG_HOOK_B64 = "BBAb5QIMEeMIEJQFDBCUFQAAUeMiAAAKCBCR5QAAUeMfAAAKnBfR5RYAUeMcAAAaGCCU5UgwlOUDMILgTBCU5QIQQeJMEITlIcSg4QLAw+UDEMPlUBCU5QEwguD/EKDjABDD5eIQoOMBEMPlAhCg4wIQw+VAEKDjAxDD5SwQj+IEAIPiiSCg4wTAkeQEwIDkASBS4vv//xpQEJTlCR2B4lAQhOUBAKDjFNBL4jConeg=";

// Ricoh-GRMod/core/src/fw/aspect/hlg.ts
function b64decode(s) {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const buf = [];
  let bits = 0;
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=") break;
    const idx = chars.indexOf(c);
    if (idx === -1) continue;
    v = v << 6 | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      buf.push(v >> bits & 255);
    }
  }
  return new Uint8Array(buf);
}
function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
function join(arrays) {
  const out = new Uint8Array(arrays.reduce((acc, a) => acc + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
var HLG_MATRIX = b64decode(HLG_MATRIX_B64);
var HLG_CURVE = b64decode(HLG_CURVE_B64);
var HLG_ICC = b64decode(HLG_ICC_B64);
var HLG_HOOK = b64decode(HLG_HOOK_B64);
var HLG_APP2_DATA = join([ascii("ICC_PROFILE\0"), HLG_ICC, new Uint8Array(2)]);
var HLG_HOOK_BLOCK = join([HLG_HOOK, HLG_APP2_DATA]);
function createHdrScale(native, toningScale) {
  if (native.length !== 400 * 60 * 4 || toningScale.length !== 400 * 60 * 4) {
    throw new FirmwareError("unexpected-layout", "native scale size mismatch");
  }
  const custom = new Uint8Array(native);
  for (const cx of [20, 200, 380]) {
    for (let y = 4; y < 34; y++) {
      for (let x = cx - 18; x <= cx + 18; x++) {
        if (x >= 0 && x < 400) {
          const i = (y * 400 + x) * 4;
          custom[i] = 0;
          custom[i + 1] = 0;
          custom[i + 2] = 0;
          custom[i + 3] = 191;
        }
      }
    }
  }
  for (let y = 4; y < 34; y++) {
    for (let x = 0; x < 40; x++) {
      const i = (y * 400 + x) * 4;
      custom[i] = toningScale[i];
      custom[i + 1] = toningScale[i + 1];
      custom[i + 2] = toningScale[i + 2];
      custom[i + 3] = toningScale[i + 3];
    }
  }
  const drawBar = (cx, barIndex, lit) => {
    const val = lit ? 255 : 85;
    let x0 = 0;
    let x1 = 0;
    let y0 = 0;
    const y1 = 17;
    if (barIndex === 1) {
      x0 = cx - 8;
      x1 = cx - 5;
      y0 = 14;
    } else if (barIndex === 2) {
      x0 = cx - 2;
      x1 = cx + 1;
      y0 = 10;
    } else if (barIndex === 3) {
      x0 = cx + 4;
      x1 = cx + 7;
      y0 = 6;
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * 400 + x) * 4;
        custom[i] = val;
        custom[i + 1] = val;
        custom[i + 2] = val;
        custom[i + 3] = 255;
      }
    }
  };
  drawBar(200, 1, true);
  drawBar(200, 2, false);
  drawBar(200, 3, false);
  drawBar(380, 1, true);
  drawBar(380, 2, true);
  drawBar(380, 3, false);
  return custom;
}

// tools/hlg_patcher_v121/patch_hlg_v121.ts
var BASE2 = 1392508928;
var EXPECTED_RTOS_OFFSET = 97576;
var OFFICIAL_RTOS_LENGTH2 = 21024256;
var OFFICIAL_ICONBIN_LENGTH = 15790304;
var RAM_DEST = 1426063360;
var RAM_SRC = 1413171456;
var RAM_LEN = 361728;
var APPEND_LIMIT = 1426063360;
var TARGET_TONE_ID = 22;
var TONE_STANDARD = 11;
var VARIANTS = 3;
var NATIVE_TONES = 38;
var TARGET_TEXT_ID = 323;
var LANGUAGES2 = 21;
var NATIVE_TEXT_ROOTS2 = 1426071832;
var NATIVE_ICON_CATALOG = 1426145920;
var NATIVE_ICON_COUNT = 709;
var EXTENDED_ICON_SLOTS = 1280;
var NATIVE_SCALE_ICON = 609;
var NATIVE_TONING_SCALE_ICON = 210;
var STD_REC_VA = 1426177368;
var STD_MA_DESC_VA = 1409819280;
var GAMMA_DESC_WORD0 = 1410033040;
var STYLE_TABLES = [
  ["T_REC", 1426409472, 1402271096, 1402271100, 1402271108],
  ["T_MA", 1426408788, 1402271140, 1402271144, 1402271152],
  ["T_GAM", 1426407768, 1402271228, 1402271232, 1402271240]
];
var ICON_CAT_LO = 1396710688;
var ICON_CAT_HI = 1396710692;
var ICON_BOUND_HELPERS = [
  [1394867700, 3813937073],
  // cmp r4, #708
  [1394869868, 3814133681]
  // cmp r7, #708
];
var TEXT_CAT_SITES = [
  [1398370548, 1398370552],
  [1398367964, 1398367972]
];
var HOOK_SITE = 1401109032;
var HDR_SCALE_SHOOTING = 1394386920;
var HDR_SCALE_RAW = 1394250900;
var HDR_INTENSE_TABLES = [1407086044, 1407085500, 1407086036, 1407085712];
var HDR_INTENSE_COUNT_CMP = 1396507292;
var HDR_INTENSE_COUNT_MOV = 1396507296;
var HDR_INTENSE_ASCII_CMP = 1396356472;
var HDRGAIN_WRITER_SLOT_COUNT = 1409152416 + 10 * 4;
var HDRGAIN_NATIVE_GET_BLOCK_COUNT = 1401108292;
var HLG_MARKER = new Uint8Array([
  71,
  82,
  52,
  72,
  76,
  71,
  49,
  50,
  49,
  0,
  0,
  0
  // "GR4HLG121\0\0\0"
]);
function u16le2(values) {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return out;
}
function u32le2(values) {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
}
function concatBytes(parts) {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
function readU32(buf, off) {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`Out-of-bounds u32 read at offset 0x${off.toString(16)}`);
  }
  return (buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 | buf[off + 3] << 24) >>> 0;
}
function writeU32(buf, off, val) {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`Out-of-bounds u32 write at offset 0x${off.toString(16)}`);
  }
  const v = val >>> 0;
  buf[off] = v & 255;
  buf[off + 1] = v >>> 8 & 255;
  buf[off + 2] = v >>> 16 & 255;
  buf[off + 3] = v >>> 24;
}
function decodeMovwMovt(loWord, hiWord, expectedReg, label) {
  const loMask = (268369920 | 61440) >>> 0;
  const expectLo = (3808428032 | expectedReg << 12) >>> 0;
  const expectHi = (3812622336 | expectedReg << 12) >>> 0;
  if ((loWord & 4293980160) >>> 0 !== expectLo || (hiWord & 4293980160) >>> 0 !== expectHi) {
    throw new Error(`${label}: expected movw/movt r${expectedReg}, got 0x${loWord.toString(16)} / 0x${hiWord.toString(16)}`);
  }
  return (movImmediate(hiWord) << 16 | movImmediate(loWord)) >>> 0;
}
function decodeHookFirstWords() {
  const dv = new DataView(HLG_HOOK.buffer, HLG_HOOK.byteOffset, 8);
  return [dv.getUint32(0, true), dv.getUint32(4, true)];
}
function romVa121(va) {
  if (va >= RAM_DEST && va < RAM_DEST + RAM_LEN) {
    return RAM_SRC + (va - RAM_DEST);
  }
  return va;
}
function rtosReadU32(rtos, va) {
  const mapped = romVa121(va);
  if (mapped < BASE2 || mapped + 4 > BASE2 + rtos.length) {
    throw new Error(`VA 0x${va.toString(16)} (mapped 0x${mapped.toString(16)}) is outside RTOS bounds`);
  }
  return readU32(rtos, mapped - BASE2);
}
function rtosReadBytes(rtos, va, len) {
  const mapped = romVa121(va);
  if (mapped < BASE2 || mapped + len > BASE2 + rtos.length) {
    throw new Error(`VA range 0x${va.toString(16)}..+0x${len.toString(16)} is outside RTOS bounds`);
  }
  return rtos.slice(mapped - BASE2, mapped - BASE2 + len);
}
function rtosWriteU32(rtos, va, val) {
  const mapped = romVa121(va);
  if (mapped < BASE2 || mapped + 4 > BASE2 + rtos.length) {
    throw new Error(`VA 0x${va.toString(16)} (mapped 0x${mapped.toString(16)}) is outside RTOS bounds`);
  }
  writeU32(rtos, mapped - BASE2, val);
}
function rtosExpectU32(rtos, va, expected, what) {
  const got = rtosReadU32(rtos, va);
  if (got !== expected >>> 0) {
    throw new Error(
      `Unexpected instruction/data at ${what} (0x${va.toString(16)}): expected 0x${(expected >>> 0).toString(16).padStart(8, "0")}, got 0x${got.toString(16).padStart(8, "0")}`
    );
  }
}
function isHlgHookInstalled(rtos) {
  const w = rtosReadU32(rtos, HOOK_SITE);
  if (w >>> 24 !== 234) return false;
  const target = branchTarget(HOOK_SITE, w);
  if (target < BASE2 || target + 8 > BASE2 + rtos.length) return false;
  const [h0, h1] = decodeHookFirstWords();
  return rtosReadU32(rtos, target) === h0 && rtosReadU32(rtos, target + 4) === h1;
}
function inspectFirmware(raw) {
  const v = verifyContainer(raw);
  const validContainer = Object.values(v.checks).every((ok) => ok === true);
  if (!validContainer) {
    throw new Error(`Input firmware failed container verification: ${JSON.stringify(v.checks)}`);
  }
  const secs = sectionsOf(v.decoded);
  const rtosSec = secs.find((s) => s.name === "RTOS");
  const iconSec = secs.find((s) => s.name === "ICONBIN");
  const resSec = secs.find((s) => s.name === "RES");
  if (!rtosSec || !iconSec || !resSec) {
    throw new Error("Missing expected sections (RTOS, ICONBIN, RES) in decoded payload");
  }
  const rtos = v.decoded.subarray(rtosSec.offset, rtosSec.offset + rtosSec.size);
  const ramCopyOk = rtosSec.offset === EXPECTED_RTOS_OFFSET && rtosSec.size >= OFFICIAL_RTOS_LENGTH2 && rtosReadU32(rtos, BASE2 + 1104) === RAM_SRC && rtosReadU32(rtos, BASE2 + 1108) === RAM_DEST && rtosReadU32(rtos, BASE2 + 1112) === RAM_LEN;
  if (!ramCopyOk) {
    return {
      validContainer,
      isGr4V121: false,
      rtosSize: rtosSec.size,
      iconbinSize: iconSec.size,
      resCount: resSec.size,
      isGrmodGrown: rtosSec.size > OFFICIAL_RTOS_LENGTH2,
      hasRelocatedStyleTables: false,
      hasHdrGainMap: false,
      hlgInstalled: false,
      hlgMarkerPresent: false,
      chosenScaleIconId: null
    };
  }
  const activeTrec = decodeMovwMovt(rtosReadU32(rtos, STYLE_TABLES[0][3]), rtosReadU32(rtos, STYLE_TABLES[0][4]), 3, "T_REC");
  const hlgInstalled = isHlgHookInstalled(rtos);
  const markerTail = rtos.subarray(rtos.length - 16, rtos.length - 4);
  const hlgMarkerPresent = HLG_MARKER.every((b, idx) => markerTail[idx] === b);
  const shootWord = rtosReadU32(rtos, HDR_SCALE_SHOOTING);
  const chosenScaleIconId = (shootWord & 4293980160) >>> 0 === 3808440320 ? movImmediate(shootWord) : null;
  return {
    validContainer,
    isGr4V121: true,
    rtosSize: rtosSec.size,
    iconbinSize: iconSec.size,
    resCount: resSec.size,
    isGrmodGrown: rtosSec.size > OFFICIAL_RTOS_LENGTH2 || iconSec.size > OFFICIAL_ICONBIN_LENGTH,
    hasRelocatedStyleTables: activeTrec !== STYLE_TABLES[0][1],
    hasHdrGainMap: rtosReadU32(rtos, HDRGAIN_WRITER_SLOT_COUNT) !== HDRGAIN_NATIVE_GET_BLOCK_COUNT,
    hlgInstalled,
    hlgMarkerPresent,
    chosenScaleIconId
  };
}
async function patchHlgV121(raw) {
  const v = verifyContainer(raw);
  const failedChecks = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failedChecks.length > 0) {
    throw new Error(`Input firmware failed container verification (${failedChecks.join(", ")})`);
  }
  const fw = new Firmware(raw);
  const secs = sectionsOf(fw.decoded);
  const rtosSec = secs.find((s) => s.name === "RTOS");
  const iconSec = secs.find((s) => s.name === "ICONBIN");
  const resSec = secs.find((s) => s.name === "RES");
  if (!rtosSec || !iconSec || !resSec) {
    throw new Error("Missing expected sections (RTOS, ICONBIN, RES)");
  }
  const rtosOrig = fw.decoded.subarray(rtosSec.offset, rtosSec.offset + rtosSec.size);
  if (rtosSec.offset !== EXPECTED_RTOS_OFFSET || rtosSec.size < OFFICIAL_RTOS_LENGTH2 || rtosReadU32(rtosOrig, BASE2 + 1104) !== RAM_SRC || rtosReadU32(rtosOrig, BASE2 + 1108) !== RAM_DEST || rtosReadU32(rtosOrig, BASE2 + 1112) !== RAM_LEN) {
    throw new Error("Input file is NOT Ricoh GR IV firmware v1.21 (fwdc248b.bin)");
  }
  if ((rtosSec.size - OFFICIAL_RTOS_LENGTH2) % FRAME_SIZE !== 0) {
    throw new Error(`RTOS growth (0x${(rtosSec.size - OFFICIAL_RTOS_LENGTH2).toString(16)}) is not a multiple of frame size 0x6000`);
  }
  if (iconSec.size < OFFICIAL_ICONBIN_LENGTH || (iconSec.size - OFFICIAL_ICONBIN_LENGTH) % FRAME_SIZE !== 0 || iconSec.size % 4 !== 0) {
    throw new Error(`ICONBIN size (0x${iconSec.size.toString(16)}) is incompatible`);
  }
  const baseType = rtosSec.size > OFFICIAL_RTOS_LENGTH2 || iconSec.size > OFFICIAL_ICONBIN_LENGTH ? "grmod-grown" : "official";
  const hasHdrGainMap = rtosReadU32(rtosOrig, HDRGAIN_WRITER_SLOT_COUNT) !== HDRGAIN_NATIVE_GET_BLOCK_COUNT;
  const activeTrecBefore = decodeMovwMovt(rtosReadU32(rtosOrig, STYLE_TABLES[0][3]), rtosReadU32(rtosOrig, STYLE_TABLES[0][4]), 3, "T_REC");
  const hasRelocatedStyleTables = activeTrecBefore !== STYLE_TABLES[0][1];
  if (isHlgHookInstalled(rtosOrig)) {
    return {
      alreadyPatched: true,
      baseType,
      hasHdrGainMap,
      hasRelocatedStyleTables,
      oldRtosSize: rtosSec.size,
      oldIconbinSize: iconSec.size
    };
  }
  rtosExpectU32(rtosOrig, HOOK_SITE, 3796619284, "SetupAppNInfo epilogue (HOOK_SITE)");
  rtosExpectU32(rtosOrig, HDR_SCALE_SHOOTING, 3808440929, "HDR_SCALE_SHOOTING");
  rtosExpectU32(rtosOrig, HDR_SCALE_RAW, 3808440929, "HDR_SCALE_RAW");
  for (let i = 0; i < HDR_INTENSE_TABLES.length; i++) {
    rtosExpectU32(rtosOrig, HDR_INTENSE_TABLES[i], 197121, `HDR_INTENSE_TABLE_${i}`);
  }
  rtosExpectU32(rtosOrig, HDR_INTENSE_COUNT_CMP, 3813670915, "HDR_INTENSE_COUNT_CMP");
  rtosExpectU32(rtosOrig, HDR_INTENSE_COUNT_MOV, 2476736515, "HDR_INTENSE_COUNT_MOV");
  rtosExpectU32(rtosOrig, HDR_INTENSE_ASCII_CMP, 167772173, "HDR_INTENSE_ASCII_CMP");
  rtosExpectU32(rtosOrig, STYLE_TABLES[0][1] + TONE_STANDARD * 4, STD_REC_VA, "T_REC[11] Standard");
  rtosExpectU32(rtosOrig, STYLE_TABLES[1][1] + TONE_STANDARD * 4, STD_MA_DESC_VA, "T_MA[11] Standard");
  const oldRtosSize = rtosSec.size;
  const rtosGrowth = FRAME_SIZE;
  const newRtosSize = oldRtosSize + rtosGrowth;
  if (BASE2 + newRtosSize >= APPEND_LIMIT) {
    throw new Error(`Grown RTOS end (0x${(BASE2 + newRtosSize).toString(16)}) would reach RAM at 0x${APPEND_LIMIT.toString(16)}`);
  }
  const rtosBuf = new Uint8Array(newRtosSize);
  rtosBuf.set(rtosOrig, 0);
  let cursor = oldRtosSize;
  const reserveTail = 16;
  const appendRtos = (bytes, align = 4) => {
    const pad = (align - cursor % align) % align;
    cursor += pad;
    if (cursor + bytes.length > newRtosSize - reserveTail) {
      throw new Error(`Appended HLG payload exceeds 1-frame RTOS growth budget at 0x${cursor.toString(16)}`);
    }
    const va = BASE2 + cursor;
    rtosBuf.set(bytes, cursor);
    cursor += bytes.length;
    return va;
  };
  const activeIconCatalog = decodeMovwMovt(
    rtosReadU32(rtosOrig, ICON_CAT_LO),
    rtosReadU32(rtosOrig, ICON_CAT_HI),
    0,
    "ICON_CAT"
  );
  const activeTextCatalog = decodeMovwMovt(
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[0][0]),
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[0][1]),
    3,
    "TEXT_CAT_0"
  );
  const activeTextCatalog2 = decodeMovwMovt(
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[1][0]),
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[1][1]),
    3,
    "TEXT_CAT_1"
  );
  if (activeTextCatalog !== activeTextCatalog2) {
    throw new Error(
      `Text catalog mismatch between loader sites: 0x${activeTextCatalog.toString(16)} vs 0x${activeTextCatalog2.toString(16)}`
    );
  }
  let iconCatalogVa;
  let chosenIconId = -1;
  if (activeIconCatalog === NATIVE_ICON_CATALOG) {
    for (const [site, expectedCmp] of ICON_BOUND_HELPERS) {
      rtosExpectU32(rtosBuf, site, expectedCmp, `icon bound site 0x${site.toString(16)}`);
    }
    iconCatalogVa = appendRtos(new Uint8Array(EXTENDED_ICON_SLOTS * 4), 16);
    const nativeEntries = rtosReadBytes(rtosBuf, NATIVE_ICON_CATALOG, NATIVE_ICON_COUNT * 4);
    rtosBuf.set(nativeEntries, iconCatalogVa - BASE2);
    chosenIconId = 800;
    rtosWriteU32(rtosBuf, ICON_CAT_LO, movWord(0, iconCatalogVa & 65535));
    rtosWriteU32(rtosBuf, ICON_CAT_HI, movWord(0, iconCatalogVa >>> 16, true));
    for (const [site, cmpWord] of ICON_BOUND_HELPERS) {
      const cmpReg = (3780116483 | (cmpWord >>> 16 & 15) << 16) >>> 0;
      const helperVa = appendRtos(new Uint8Array(20), 16);
      const words = [
        3844943876,
        movWord(3, chosenIconId),
        cmpReg,
        3835506692,
        branchWord(helperVa + 16, site + 4)
      ];
      rtosBuf.set(u32le2(words), helperVa - BASE2);
      rtosWriteU32(rtosBuf, site, branchWord(site, helperVa));
    }
  } else {
    if (activeIconCatalog < BASE2 + OFFICIAL_RTOS_LENGTH2 || activeIconCatalog + NATIVE_ICON_COUNT * 4 > BASE2 + oldRtosSize) {
      throw new Error(`Relocated icon catalog VA 0x${activeIconCatalog.toString(16)} is invalid`);
    }
    iconCatalogVa = activeIconCatalog;
    const maxSlots = activeTextCatalog > activeIconCatalog && activeTextCatalog - activeIconCatalog <= 16384 ? Math.min(EXTENDED_ICON_SLOTS, activeTextCatalog - activeIconCatalog >>> 2) : EXTENDED_ICON_SLOTS;
    for (let id = 800; id < Math.min(990, maxSlots); id++) {
      if (rtosReadU32(rtosBuf, iconCatalogVa + id * 4) === 0) {
        chosenIconId = id;
        break;
      }
    }
    if (chosenIconId === -1) {
      for (let id = 792; id < maxSlots; id++) {
        if (rtosReadU32(rtosBuf, iconCatalogVa + id * 4) === 0) {
          chosenIconId = id;
          break;
        }
      }
    }
    if (chosenIconId === -1) {
      throw new Error(`No free icon slot left in extended icon catalog (0..${maxSlots - 1})`);
    }
    for (const [site] of ICON_BOUND_HELPERS) {
      const bWord = rtosReadU32(rtosBuf, site);
      if (bWord >>> 24 !== 234) {
        throw new Error(`Expected branch instruction at icon bound site 0x${site.toString(16)}, got 0x${bWord.toString(16)}`);
      }
      const helperVa = branchTarget(site, bWord);
      rtosExpectU32(rtosBuf, helperVa, 3844943876, `icon bound helper push {r3} at 0x${helperVa.toString(16)}`);
      const boundMov = rtosReadU32(rtosBuf, helperVa + 4);
      if ((boundMov & 4293980160) >>> 0 !== 3808440320) {
        throw new Error(`Expected movw r3, #upper at icon bound helper+4 (0x${(helperVa + 4).toString(16)}), got 0x${boundMov.toString(16)}`);
      }
      const newUpper = Math.max(chosenIconId, movImmediate(boundMov));
      rtosWriteU32(rtosBuf, helperVa + 4, movWord(3, newUpper));
    }
  }
  const iconOrig = fw.decoded.subarray(iconSec.offset, iconSec.offset + iconSec.size);
  const oldIconSize = iconSec.size;
  const scaleBytesLen = 400 * 60 * 4;
  const iconGrowth = 4 * FRAME_SIZE;
  const newIconSize = oldIconSize + iconGrowth;
  const nativeScaleDesc = rtosReadU32(rtosBuf, iconCatalogVa + NATIVE_SCALE_ICON * 4);
  const nativeScaleAt = rtosReadU32(rtosBuf, nativeScaleDesc + 8) * 4;
  if (nativeScaleAt + scaleBytesLen > oldIconSize) {
    throw new Error(`Native scale icon offset 0x${nativeScaleAt.toString(16)} out of range`);
  }
  const nativeScalePixels = iconOrig.slice(nativeScaleAt, nativeScaleAt + scaleBytesLen);
  const nativeToningDesc = rtosReadU32(rtosBuf, iconCatalogVa + NATIVE_TONING_SCALE_ICON * 4);
  const nativeToningAt = rtosReadU32(rtosBuf, nativeToningDesc + 8) * 4;
  if (nativeToningAt + scaleBytesLen > oldIconSize) {
    throw new Error(`Native toning scale icon offset 0x${nativeToningAt.toString(16)} out of range`);
  }
  const nativeToningPixels = iconOrig.slice(nativeToningAt, nativeToningAt + scaleBytesLen);
  const scalePixels = createHdrScale(nativeScalePixels, nativeToningPixels);
  if (scalePixels.length !== scaleBytesLen) {
    throw new Error(`Unexpected scale pixel size ${scalePixels.length}`);
  }
  const scaleDescVa = appendRtos(concatBytes([u16le2([1, 400, 60, 0]), u32le2([oldIconSize / 4])]), 16);
  rtosWriteU32(rtosBuf, iconCatalogVa + chosenIconId * 4, scaleDescVa);
  const curveVa = appendRtos(HLG_CURVE, 256);
  const gamDescVa = appendRtos(u32le2([GAMMA_DESC_WORD0, 1, curveVa, curveVa, curveVa]), 4);
  const matrixVa = appendRtos(HLG_MATRIX, 4);
  const stdRec = rtosReadBytes(rtosBuf, STD_REC_VA, 84);
  const recBytes = new Uint8Array(stdRec);
  writeU32(recBytes, 4, matrixVa);
  const recVa = appendRtos(recBytes, 4);
  const hdrUtf16 = new Uint8Array([72, 0, 68, 0, 82, 0, 0, 0]);
  const textVa = appendRtos(hdrUtf16, 4);
  const textDescVa = appendRtos(concatBytes([Uint8Array.from([4, 1, 0, 0]), u32le2([textVa])]), 4);
  const hookVa = appendRtos(HLG_HOOK_BLOCK, 16);
  rtosBuf.set(HLG_MARKER, newRtosSize - 16);
  rtosWriteU32(rtosBuf, HOOK_SITE, branchWord(HOOK_SITE, hookVa));
  rtosWriteU32(rtosBuf, HDR_SCALE_SHOOTING, movWord(3, chosenIconId));
  rtosWriteU32(rtosBuf, HDR_SCALE_RAW, movWord(3, chosenIconId));
  for (const tbl of HDR_INTENSE_TABLES) {
    rtosWriteU32(rtosBuf, tbl, 131328);
  }
  rtosWriteU32(rtosBuf, HDR_INTENSE_ASCII_CMP, 2583691277);
  const tableUpdates = [
    [STYLE_TABLES[0], recVa],
    [STYLE_TABLES[1], STD_MA_DESC_VA],
    [STYLE_TABLES[2], gamDescVa]
  ];
  for (const [[tName, nativeBase, strideSite, loSite, hiSite], targetVal] of tableUpdates) {
    for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
      rtosWriteU32(rtosBuf, nativeBase + 4 * (vIdx * NATIVE_TONES + TARGET_TONE_ID), targetVal);
    }
    const strideWord = rtosReadU32(rtosBuf, strideSite);
    if ((strideWord & 4294967040) >>> 0 !== 3818921984) {
      throw new Error(`${tName}: expected mov r2, #stride at 0x${strideSite.toString(16)}, got 0x${strideWord.toString(16)}`);
    }
    const stride = strideWord & 255;
    if (stride < NATIVE_TONES) {
      throw new Error(`${tName}: unexpected table stride ${stride}`);
    }
    const activeBase = decodeMovwMovt(rtosReadU32(rtosBuf, loSite), rtosReadU32(rtosBuf, hiSite), 3, tName);
    if (activeBase !== nativeBase) {
      for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
        rtosWriteU32(rtosBuf, activeBase + 4 * (vIdx * stride + TARGET_TONE_ID), targetVal);
      }
    }
  }
  for (let l = 0; l < LANGUAGES2; l++) {
    const nativeRow = rtosReadU32(rtosBuf, NATIVE_TEXT_ROOTS2 + l * 4);
    rtosWriteU32(rtosBuf, nativeRow + TARGET_TEXT_ID * 4, textDescVa);
    if (activeTextCatalog !== NATIVE_TEXT_ROOTS2) {
      const extRow = rtosReadU32(rtosBuf, activeTextCatalog + l * 4);
      if (extRow !== 0) {
        rtosWriteU32(rtosBuf, extRow + TARGET_TEXT_ID * 4, textDescVa);
      }
    }
  }
  const oldRtosEnd = rtosSec.offset + oldRtosSize;
  const oldIconEnd = iconSec.offset + oldIconSize;
  const newDecoded = new Uint8Array(fw.decoded.length + rtosGrowth + iconGrowth);
  newDecoded.set(fw.decoded.subarray(0, rtosSec.offset), 0);
  newDecoded.set(rtosBuf, rtosSec.offset);
  newDecoded.set(fw.decoded.subarray(oldRtosEnd, iconSec.offset), rtosSec.offset + newRtosSize);
  const newIconOffset = iconSec.offset + rtosGrowth;
  newDecoded.set(iconOrig, newIconOffset);
  newDecoded.set(scalePixels, newIconOffset + oldIconSize);
  newDecoded.set(fw.decoded.subarray(oldIconEnd), newIconOffset + newIconSize);
  writeU32(newDecoded, rtosSec.offset - 4, newRtosSize);
  writeU32(newDecoded, newIconOffset - 4, newIconSize);
  const compOffset = rtosSec.offset + newRtosSize - 4;
  writeU32(newDecoded, compOffset, 0);
  const comp = -sum32(newDecoded) >>> 0;
  writeU32(newDecoded, compOffset, comp);
  if (sum32(newDecoded) !== 0) {
    throw new Error("Internal error: patched payload word sum is not zero");
  }
  for (let i = 1; i <= 4; i++) {
    if (newDecoded[newDecoded.length - i] !== fw.decoded[fw.decoded.length - i]) {
      throw new Error("Internal error: last payload word changed");
    }
  }
  const origSecs = sectionsOf(fw.decoded);
  const newSecs = sectionsOf(newDecoded);
  if (origSecs.length !== newSecs.length) {
    throw new Error("Internal error: section count changed");
  }
  for (let i = 0; i < origSecs.length; i++) {
    if (origSecs[i].name !== newSecs[i].name) throw new Error(`Internal error: section ${origSecs[i].name} mismatch`);
    if (origSecs[i].name === "RTOS" || origSecs[i].name === "ICONBIN") continue;
    if (sum32(newDecoded.subarray(newSecs[i].offset, newSecs[i].name === "RES" ? newDecoded.length : newSecs[i].offset + newSecs[i].size)) !== sum32(fw.decoded.subarray(origSecs[i].offset, origSecs[i].name === "RES" ? fw.decoded.length : origSecs[i].offset + origSecs[i].size))) {
      throw new Error(`Internal error: section ${origSecs[i].name} modified unexpectedly`);
    }
  }
  const insertions = [
    { at: oldRtosEnd, length: rtosGrowth },
    { at: oldIconEnd, length: iconGrowth }
  ];
  const built = buildGrown(fw, newDecoded, insertions);
  const verifyOut = verifyContainer(built.out, newDecoded);
  const outFailed = Object.entries(verifyOut.checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (outFailed.length > 0) {
    throw new Error(`Output container verification failed: ${outFailed.join(", ")}`);
  }
  return {
    alreadyPatched: false,
    output: built.out,
    outputSha256: await sha256Hex(built.out),
    chosenIconId,
    baseType,
    hasHdrGainMap,
    hasRelocatedStyleTables,
    checks: verifyOut.checks,
    oldRtosSize,
    newRtosSize,
    oldIconbinSize: oldIconSize,
    newIconbinSize: newIconSize,
    reencodedFrames: built.reencoded.length
  };
}
function printUsage() {
  console.log([
    "Ricoh GR IV v1.21 BT.2100 HLG Photo Post-Patcher (Standalone)",
    "",
    "Usage:",
    "  node gr4_v121_hlg_patcher.mjs <input.bin> [output.bin]",
    "  node gr4_v121_hlg_patcher.mjs <input.bin> -o <output.bin>",
    "  node gr4_v121_hlg_patcher.mjs --inspect <fw.bin>",
    "",
    "Supports BOTH official GR IV v1.21 fwdc248b.bin AND GRMod-built v1.21 firmware",
    "(0.8.15 / 0.8.16 / future releases, with any combination of GRMod features)."
  ].join("\n"));
}
async function runCli() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printUsage();
    return 0;
  }
  if (args[0] === "--inspect") {
    const file = args[1];
    if (!file) {
      console.error("ERROR: --inspect requires a firmware file path.");
      return 1;
    }
    const raw2 = new Uint8Array(readFileSync(resolve(file)));
    const info = inspectFirmware(raw2);
    console.log(`File                    : ${resolve(file)}`);
    console.log(`Container valid         : ${info.validContainer}`);
    console.log(`GR IV v1.21 detected    : ${info.isGr4V121}`);
    console.log(`Base layout             : ${info.isGrmodGrown ? "GRMod / Grown" : "Official / In-Place"}`);
    console.log(`RTOS / ICONBIN sizes    : 0x${info.rtosSize.toString(16)} / 0x${info.iconbinSize.toString(16)} (RES files: ${info.resCount})`);
    console.log(`Relocated style tables  : ${info.hasRelocatedStyleTables}`);
    console.log(`GRMod HDR Gain Map      : ${info.hasHdrGainMap}`);
    console.log(`HLG Photo installed     : ${info.hlgInstalled ? "YES" : "NO"} (marker=${info.hlgMarkerPresent}, scaleIconId=${info.chosenScaleIconId ?? "n/a"})`);
    return info.isGr4V121 ? 0 : 1;
  }
  let inputPath;
  let outputPath;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--output") {
      outputPath = args[++i];
      if (!outputPath) {
        console.error("ERROR: -o/--output requires a file path.");
        return 1;
      }
    } else if (!inputPath) {
      inputPath = a;
    } else if (!outputPath) {
      outputPath = a;
    } else {
      console.error(`ERROR: Unexpected argument: ${a}`);
      return 1;
    }
  }
  if (!inputPath) {
    printUsage();
    return 1;
  }
  const resolvedIn = resolve(inputPath);
  if (!existsSync(resolvedIn)) {
    console.error(`ERROR: Input file does not exist: ${resolvedIn}`);
    return 1;
  }
  let resolvedOut;
  if (outputPath) {
    resolvedOut = resolve(outputPath);
  } else {
    const ext = extname(resolvedIn);
    const stem = basename(resolvedIn, ext);
    resolvedOut = join2(dirname(resolvedIn), `${stem}_hlg${ext || ".bin"}`);
  }
  const raw = new Uint8Array(readFileSync(resolvedIn));
  const res = await patchHlgV121(raw);
  if (res.alreadyPatched) {
    console.log(`[SKIP] HLG Photo is ALREADY installed in ${resolvedIn} (base=${res.baseType}). No changes written.`);
    return 0;
  }
  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, res.output);
  console.log("=== GR IV v1.21 BT.2100 HLG Photo Patch Complete ===");
  console.log(`Input           : ${resolvedIn} (${res.baseType}${res.hasRelocatedStyleTables ? ", relocated style tables" : ""})`);
  console.log(`Output          : ${resolvedOut} (${res.output.length.toLocaleString()} bytes)`);
  console.log(`Output SHA-256  : ${res.outputSha256}`);
  console.log(`RTOS size       : 0x${res.oldRtosSize.toString(16)} -> 0x${res.newRtosSize.toString(16)}`);
  console.log(`ICONBIN size    : 0x${res.oldIconbinSize.toString(16)} -> 0x${res.newIconbinSize.toString(16)}`);
  console.log(`Scale icon ID   : ${res.chosenIconId} ([OFF, 1-bar, 2-bars])`);
  console.log(`Frames re-emit  : ${res.reencodedFrames}`);
  console.log(`Self-checks     : ALL PASSED (${Object.keys(res.checks).length}/${Object.keys(res.checks).length})`);
  console.log('Slot 22 behavior: Named "HDR", Rec.2020 + ARIB STD-B67 + CICP ICC, Level 0 = OFF bypass.');
  if (res.hasHdrGainMap) {
    console.log("[NOTE] GRMod HDR Gain Map is also present in this firmware. When shooting HLG in Slot 22, switch OFF [Shooting > HDR] in camera menu.");
  }
  return 0;
}
runCli().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
export {
  inspectFirmware,
  patchHlgV121
};
