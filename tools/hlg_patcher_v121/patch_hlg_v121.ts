// SPDX-License-Identifier: GPL-2.0-only
/**
 * Standalone, GRMod-version-independent BT.2100 HLG Photo Post-Patcher for Ricoh GR IV v1.21.
 *
 * Works on BOTH:
 *  - Official Ricoh GR IV v1.21 firmware (`fwdc248b.bin`)
 *  - Any GR IV v1.21 firmware already exported by GRMod (0.8.15, 0.8.16, or future builds)
 *
 * Transforms Slot 22 (0x16, "HDR Tone") into direct in-camera BT.2100 HLG HDR photography
 * (Rec.2020 CCM + ARIB STD-B67 LUT + neutral MA table + APP2 CICP [9, 18, 0, 1] ICC hook
 * + Level 0 "OFF" bypass slider with native OFF / 1-bar / 2-bars track icon).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, extname, join, resolve } from 'node:path';
import {
  FRAME_SIZE, Firmware, buildGrown, sectionsOf, sha256Hex, sum32, verifyContainer,
} from '../../Ricoh-GRMod/core/src/fw/container';
import {
  branchTarget, branchWord, movImmediate, movWord,
} from '../../Ricoh-GRMod/core/src/fw/gr4v121/aspect/arm';
import {
  HLG_CURVE, HLG_HOOK, HLG_HOOK_BLOCK, HLG_MATRIX, createHdrScale,
} from '../../Ricoh-GRMod/core/src/fw/aspect/hlg';

// -----------------------------------------------------------------------------
// Verified Ricoh GR IV v1.21 constants (SHA-256 bf4d6c35f6da1c16ed5f2943af570eab8fef326f7501a2b3ce5413fa55ec5c99)
// -----------------------------------------------------------------------------
const BASE = 0x53000000;
const EXPECTED_RTOS_OFFSET = 0x17d28;
const OFFICIAL_RTOS_LENGTH = 0x140ce00;
const OFFICIAL_ICONBIN_LENGTH = 0xf0f0e0;

const RAM_DEST = 0x55000000;
const RAM_SRC = 0x543b4900;
const RAM_LEN = 0x58500;
const APPEND_LIMIT = 0x55000000;

const TARGET_TONE_ID = 22; // 0x16: HDR Tone
const TONE_STANDARD = 11;  // 0x0b: Standard
const VARIANTS = 3;
const NATIVE_TONES = 38;

const TARGET_TEXT_ID = 323;
const LANGUAGES = 21;
const NATIVE_TEXT_ROOTS = 0x55002118;

const NATIVE_ICON_CATALOG = 0x55014280;
const NATIVE_ICON_COUNT = 709;
const EXTENDED_ICON_SLOTS = 1280;
const NATIVE_SCALE_ICON = 0x261;        // 609 (400x60)
const NATIVE_TONING_SCALE_ICON = 0xd2;  // 210 (400x60)

const STD_REC_VA = 0x5501bd58;      // T_REC[11]
const STD_MA_DESC_VA = 0x54082290;  // T_MA[11]
const GAMMA_DESC_WORD0 = 0x540b6590;

const STYLE_TABLES: readonly [string, number, number, number, number][] = [
  ['T_REC', 0x55054800, 0x5394f578, 0x5394f57c, 0x5394f584],
  ['T_MA',  0x55054554, 0x5394f5a4, 0x5394f5a8, 0x5394f5b0],
  ['T_GAM', 0x55054158, 0x5394f5fc, 0x5394f600, 0x5394f608],
];

// Scaffold sites in v1.21
const ICON_CAT_LO = 0x53401d20;
const ICON_CAT_HI = 0x53401d24;
const ICON_BOUND_HELPERS: readonly [number, number][] = [
  [0x5323fdf4, 0xe3540fb1], // cmp r4, #708
  [0x5324066c, 0xe3570fb1], // cmp r7, #708
];
const TEXT_CAT_SITES: readonly [number, number][] = [
  [0x535970f4, 0x535970f8],
  [0x535966dc, 0x535966e4],
];

// HLG patch sites (10 sites, zero overlap with GRMod features)
const HOOK_SITE = 0x53833a28;
const HDR_SCALE_SHOOTING = 0x531ca7e8;
const HDR_SCALE_RAW = 0x531a9494;
const HDR_INTENSE_TABLES = [0x53de6ddc, 0x53de6bbc, 0x53de6dd4, 0x53de6c90] as const;
const HDR_INTENSE_COUNT_CMP = 0x533d029c;
const HDR_INTENSE_COUNT_MOV = 0x533d02a0;
const HDR_INTENSE_ASCII_CMP = 0x533ab578;

// Optional detection of upstream GRMod HDR Gain Map (informational warning only)
const HDRGAIN_WRITER_SLOT_COUNT = 0x53fdf5a0 + 10 * 4;
const HDRGAIN_NATIVE_GET_BLOCK_COUNT = 0x53833744;

const HLG_MARKER = new Uint8Array([
  0x47, 0x52, 0x34, 0x48, 0x4c, 0x47, 0x31, 0x32, 0x31, 0x00, 0x00, 0x00, // "GR4HLG121\0\0\0"
]);

function u16le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return out;
}

function u32le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function readU32(buf: Uint8Array, off: number): number {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`Out-of-bounds u32 read at offset 0x${off.toString(16)}`);
  }
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function writeU32(buf: Uint8Array, off: number, val: number): void {
  if (off < 0 || off + 4 > buf.length) {
    throw new Error(`Out-of-bounds u32 write at offset 0x${off.toString(16)}`);
  }
  const v = val >>> 0;
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = v >>> 24;
}

function decodeMovwMovt(loWord: number, hiWord: number, expectedReg: number, label: string): number {
  const loMask = (0x0fff0000 | 0x0000f000) >>> 0;
  const expectLo = (0xe3000000 | (expectedReg << 12)) >>> 0;
  const expectHi = (0xe3400000 | (expectedReg << 12)) >>> 0;
  if ((loWord & 0xfff0f000) >>> 0 !== expectLo || (hiWord & 0xfff0f000) >>> 0 !== expectHi) {
    throw new Error(`${label}: expected movw/movt r${expectedReg}, got 0x${loWord.toString(16)} / 0x${hiWord.toString(16)}`);
  }
  return ((movImmediate(hiWord) << 16) | movImmediate(loWord)) >>> 0;
}

function decodeHookFirstWords(): [number, number] {
  const dv = new DataView(HLG_HOOK.buffer, HLG_HOOK.byteOffset, 8);
  return [dv.getUint32(0, true), dv.getUint32(4, true)];
}

export interface InspectInfo {
  validContainer: boolean;
  isGr4V121: boolean;
  rtosSize: number;
  iconbinSize: number;
  resCount: number;
  isGrmodGrown: boolean;
  hasRelocatedStyleTables: boolean;
  hasHdrGainMap: boolean;
  hlgInstalled: boolean;
  hlgMarkerPresent: boolean;
  chosenScaleIconId: number | null;
}

function romVa121(va: number): number {
  if (va >= RAM_DEST && va < RAM_DEST + RAM_LEN) {
    return RAM_SRC + (va - RAM_DEST);
  }
  return va;
}

function rtosReadU32(rtos: Uint8Array, va: number): number {
  const mapped = romVa121(va);
  if (mapped < BASE || mapped + 4 > BASE + rtos.length) {
    throw new Error(`VA 0x${va.toString(16)} (mapped 0x${mapped.toString(16)}) is outside RTOS bounds`);
  }
  return readU32(rtos, mapped - BASE);
}

function rtosReadBytes(rtos: Uint8Array, va: number, len: number): Uint8Array {
  const mapped = romVa121(va);
  if (mapped < BASE || mapped + len > BASE + rtos.length) {
    throw new Error(`VA range 0x${va.toString(16)}..+0x${len.toString(16)} is outside RTOS bounds`);
  }
  return rtos.slice(mapped - BASE, mapped - BASE + len);
}

function rtosWriteU32(rtos: Uint8Array, va: number, val: number): void {
  const mapped = romVa121(va);
  if (mapped < BASE || mapped + 4 > BASE + rtos.length) {
    throw new Error(`VA 0x${va.toString(16)} (mapped 0x${mapped.toString(16)}) is outside RTOS bounds`);
  }
  writeU32(rtos, mapped - BASE, val);
}

function rtosExpectU32(rtos: Uint8Array, va: number, expected: number, what: string): void {
  const got = rtosReadU32(rtos, va);
  if (got !== expected >>> 0) {
    throw new Error(
      `Unexpected instruction/data at ${what} (0x${va.toString(16)}): expected 0x${(expected >>> 0).toString(16).padStart(8, '0')}, got 0x${got.toString(16).padStart(8, '0')}`,
    );
  }
}

function isHlgHookInstalled(rtos: Uint8Array): boolean {
  const w = rtosReadU32(rtos, HOOK_SITE);
  if ((w >>> 24) !== 0xea) return false;
  const target = branchTarget(HOOK_SITE, w);
  if (target < BASE || target + 8 > BASE + rtos.length) return false;
  const [h0, h1] = decodeHookFirstWords();
  return rtosReadU32(rtos, target) === h0 && rtosReadU32(rtos, target + 4) === h1;
}

export function inspectFirmware(raw: Uint8Array): InspectInfo {
  const v = verifyContainer(raw);
  const validContainer = Object.values(v.checks).every((ok) => ok === true);
  if (!validContainer) {
    throw new Error(`Input firmware failed container verification: ${JSON.stringify(v.checks)}`);
  }
  const secs = sectionsOf(v.decoded);
  const rtosSec = secs.find((s) => s.name === 'RTOS');
  const iconSec = secs.find((s) => s.name === 'ICONBIN');
  const resSec = secs.find((s) => s.name === 'RES');
  if (!rtosSec || !iconSec || !resSec) {
    throw new Error('Missing expected sections (RTOS, ICONBIN, RES) in decoded payload');
  }
  const rtos = v.decoded.subarray(rtosSec.offset, rtosSec.offset + rtosSec.size);

  const ramCopyOk =
    rtosSec.offset === EXPECTED_RTOS_OFFSET &&
    rtosSec.size >= OFFICIAL_RTOS_LENGTH &&
    rtosReadU32(rtos, BASE + 0x450) === RAM_SRC &&
    rtosReadU32(rtos, BASE + 0x454) === RAM_DEST &&
    rtosReadU32(rtos, BASE + 0x458) === RAM_LEN;

  if (!ramCopyOk) {
    return {
      validContainer,
      isGr4V121: false,
      rtosSize: rtosSec.size,
      iconbinSize: iconSec.size,
      resCount: resSec.size,
      isGrmodGrown: rtosSec.size > OFFICIAL_RTOS_LENGTH,
      hasRelocatedStyleTables: false,
      hasHdrGainMap: false,
      hlgInstalled: false,
      hlgMarkerPresent: false,
      chosenScaleIconId: null,
    };
  }

  const activeTrec = decodeMovwMovt(rtosReadU32(rtos, STYLE_TABLES[0][3]), rtosReadU32(rtos, STYLE_TABLES[0][4]), 3, 'T_REC');
  const hlgInstalled = isHlgHookInstalled(rtos);
  const markerTail = rtos.subarray(rtos.length - 16, rtos.length - 4);
  const hlgMarkerPresent = HLG_MARKER.every((b, idx) => markerTail[idx] === b);
  const shootWord = rtosReadU32(rtos, HDR_SCALE_SHOOTING);
  const chosenScaleIconId = (shootWord & 0xfff0f000) >>> 0 === 0xe3003000 ? movImmediate(shootWord) : null;

  return {
    validContainer,
    isGr4V121: true,
    rtosSize: rtosSec.size,
    iconbinSize: iconSec.size,
    resCount: resSec.size,
    isGrmodGrown: rtosSec.size > OFFICIAL_RTOS_LENGTH || iconSec.size > OFFICIAL_ICONBIN_LENGTH,
    hasRelocatedStyleTables: activeTrec !== STYLE_TABLES[0][1],
    hasHdrGainMap: rtosReadU32(rtos, HDRGAIN_WRITER_SLOT_COUNT) !== HDRGAIN_NATIVE_GET_BLOCK_COUNT,
    hlgInstalled,
    hlgMarkerPresent,
    chosenScaleIconId,
  };
}

export interface PatchResult {
  alreadyPatched: boolean;
  output?: Uint8Array;
  outputSha256?: string;
  chosenIconId?: number;
  baseType: 'official' | 'grmod-grown';
  hasHdrGainMap: boolean;
  hasRelocatedStyleTables: boolean;
  checks?: Record<string, boolean>;
  oldRtosSize: number;
  newRtosSize?: number;
  oldIconbinSize: number;
  newIconbinSize?: number;
  reencodedFrames?: number;
}

export async function patchHlgV121(raw: Uint8Array): Promise<PatchResult> {
  const v = verifyContainer(raw);
  const failedChecks = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (failedChecks.length > 0) {
    throw new Error(`Input firmware failed container verification (${failedChecks.join(', ')})`);
  }

  const fw = new Firmware(raw);
  const secs = sectionsOf(fw.decoded);
  const rtosSec = secs.find((s) => s.name === 'RTOS');
  const iconSec = secs.find((s) => s.name === 'ICONBIN');
  const resSec = secs.find((s) => s.name === 'RES');
  if (!rtosSec || !iconSec || !resSec) {
    throw new Error('Missing expected sections (RTOS, ICONBIN, RES)');
  }

  const rtosOrig = fw.decoded.subarray(rtosSec.offset, rtosSec.offset + rtosSec.size);
  if (
    rtosSec.offset !== EXPECTED_RTOS_OFFSET ||
    rtosSec.size < OFFICIAL_RTOS_LENGTH ||
    rtosReadU32(rtosOrig, BASE + 0x450) !== RAM_SRC ||
    rtosReadU32(rtosOrig, BASE + 0x454) !== RAM_DEST ||
    rtosReadU32(rtosOrig, BASE + 0x458) !== RAM_LEN
  ) {
    throw new Error('Input file is NOT Ricoh GR IV firmware v1.21 (fwdc248b.bin)');
  }

  if ((rtosSec.size - OFFICIAL_RTOS_LENGTH) % FRAME_SIZE !== 0) {
    throw new Error(`RTOS growth (0x${(rtosSec.size - OFFICIAL_RTOS_LENGTH).toString(16)}) is not a multiple of frame size 0x6000`);
  }
  if (iconSec.size < OFFICIAL_ICONBIN_LENGTH || (iconSec.size - OFFICIAL_ICONBIN_LENGTH) % FRAME_SIZE !== 0 || iconSec.size % 4 !== 0) {
    throw new Error(`ICONBIN size (0x${iconSec.size.toString(16)}) is incompatible`);
  }

  const baseType: 'official' | 'grmod-grown' =
    rtosSec.size > OFFICIAL_RTOS_LENGTH || iconSec.size > OFFICIAL_ICONBIN_LENGTH ? 'grmod-grown' : 'official';
  const hasHdrGainMap = rtosReadU32(rtosOrig, HDRGAIN_WRITER_SLOT_COUNT) !== HDRGAIN_NATIVE_GET_BLOCK_COUNT;
  const activeTrecBefore = decodeMovwMovt(rtosReadU32(rtosOrig, STYLE_TABLES[0][3]), rtosReadU32(rtosOrig, STYLE_TABLES[0][4]), 3, 'T_REC');
  const hasRelocatedStyleTables = activeTrecBefore !== STYLE_TABLES[0][1];

  // 2. Idempotency check
  if (isHlgHookInstalled(rtosOrig)) {
    return {
      alreadyPatched: true,
      baseType,
      hasHdrGainMap,
      hasRelocatedStyleTables,
      oldRtosSize: rtosSec.size,
      oldIconbinSize: iconSec.size,
    };
  }

  // 3. Verify all 10 HLG target sites & Standard table entries
  rtosExpectU32(rtosOrig, HOOK_SITE, 0xe24bd014, 'SetupAppNInfo epilogue (HOOK_SITE)');
  rtosExpectU32(rtosOrig, HDR_SCALE_SHOOTING, 0xe3003261, 'HDR_SCALE_SHOOTING');
  rtosExpectU32(rtosOrig, HDR_SCALE_RAW, 0xe3003261, 'HDR_SCALE_RAW');
  for (let i = 0; i < HDR_INTENSE_TABLES.length; i++) {
    rtosExpectU32(rtosOrig, HDR_INTENSE_TABLES[i], 0x00030201, `HDR_INTENSE_TABLE_${i}`);
  }
  rtosExpectU32(rtosOrig, HDR_INTENSE_COUNT_CMP, 0xe3500003, 'HDR_INTENSE_COUNT_CMP');
  rtosExpectU32(rtosOrig, HDR_INTENSE_COUNT_MOV, 0x93a00003, 'HDR_INTENSE_COUNT_MOV');
  rtosExpectU32(rtosOrig, HDR_INTENSE_ASCII_CMP, 0x0a00000d, 'HDR_INTENSE_ASCII_CMP');
  rtosExpectU32(rtosOrig, STYLE_TABLES[0][1] + TONE_STANDARD * 4, STD_REC_VA, 'T_REC[11] Standard');
  rtosExpectU32(rtosOrig, STYLE_TABLES[1][1] + TONE_STANDARD * 4, STD_MA_DESC_VA, 'T_MA[11] Standard');

  // 4. Prepare grown RTOS (+1 frame = 0x6000) & ICONBIN (+4 frames = 0x18000)
  const oldRtosSize = rtosSec.size;
  const rtosGrowth = FRAME_SIZE; // 0x6000
  const newRtosSize = oldRtosSize + rtosGrowth;
  if (BASE + newRtosSize >= APPEND_LIMIT) {
    throw new Error(`Grown RTOS end (0x${(BASE + newRtosSize).toString(16)}) would reach RAM at 0x${APPEND_LIMIT.toString(16)}`);
  }

  const rtosBuf = new Uint8Array(newRtosSize);
  rtosBuf.set(rtosOrig, 0);
  let cursor = oldRtosSize;
  const reserveTail = 16; // last 12B marker + 4B checksum word

  const appendRtos = (bytes: Uint8Array, align = 4): number => {
    const pad = (align - (cursor % align)) % align;
    cursor += pad;
    if (cursor + bytes.length > newRtosSize - reserveTail) {
      throw new Error(`Appended HLG payload exceeds 1-frame RTOS growth budget at 0x${cursor.toString(16)}`);
    }
    const va = BASE + cursor;
    rtosBuf.set(bytes, cursor);
    cursor += bytes.length;
    return va;
  };

  // 5. Detect & update Icon Catalog + Lookup Bound Helpers (works for both stock and GRMod-grown)
  const activeIconCatalog = decodeMovwMovt(
    rtosReadU32(rtosOrig, ICON_CAT_LO),
    rtosReadU32(rtosOrig, ICON_CAT_HI),
    0,
    'ICON_CAT',
  );
  const activeTextCatalog = decodeMovwMovt(
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[0][0]),
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[0][1]),
    3,
    'TEXT_CAT_0',
  );
  const activeTextCatalog2 = decodeMovwMovt(
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[1][0]),
    rtosReadU32(rtosOrig, TEXT_CAT_SITES[1][1]),
    3,
    'TEXT_CAT_1',
  );
  if (activeTextCatalog !== activeTextCatalog2) {
    throw new Error(
      `Text catalog mismatch between loader sites: 0x${activeTextCatalog.toString(16)} vs 0x${activeTextCatalog2.toString(16)}`,
    );
  }

  let iconCatalogVa: number;
  let chosenIconId = -1;

  if (activeIconCatalog === NATIVE_ICON_CATALOG) {
    // Stock / non-grown firmware: install relocated icon catalog + lookup bound helpers
    for (const [site, expectedCmp] of ICON_BOUND_HELPERS) {
      rtosExpectU32(rtosBuf, site, expectedCmp, `icon bound site 0x${site.toString(16)}`);
    }
    iconCatalogVa = appendRtos(new Uint8Array(EXTENDED_ICON_SLOTS * 4), 16);
    const nativeEntries = rtosReadBytes(rtosBuf, NATIVE_ICON_CATALOG, NATIVE_ICON_COUNT * 4);
    rtosBuf.set(nativeEntries, iconCatalogVa - BASE);
    chosenIconId = 800;

    rtosWriteU32(rtosBuf, ICON_CAT_LO, movWord(0, iconCatalogVa & 0xffff));
    rtosWriteU32(rtosBuf, ICON_CAT_HI, movWord(0, iconCatalogVa >>> 16, true));

    for (const [site, cmpWord] of ICON_BOUND_HELPERS) {
      const cmpReg = (0xe1500003 | (((cmpWord >>> 16) & 15) << 16)) >>> 0;
      const helperVa = appendRtos(new Uint8Array(20), 16);
      const words = [
        0xe52d3004,
        movWord(3, chosenIconId),
        cmpReg,
        0xe49d3004,
        branchWord(helperVa + 16, site + 4),
      ];
      rtosBuf.set(u32le(words), helperVa - BASE);
      rtosWriteU32(rtosBuf, site, branchWord(site, helperVa));
    }
  } else {
    // GRMod-grown firmware: reuse GRMod's relocated icon catalog and bound helpers
    if (activeIconCatalog < BASE + OFFICIAL_RTOS_LENGTH || activeIconCatalog + NATIVE_ICON_COUNT * 4 > BASE + oldRtosSize) {
      throw new Error(`Relocated icon catalog VA 0x${activeIconCatalog.toString(16)} is invalid`);
    }
    iconCatalogVa = activeIconCatalog;
    const maxSlots =
      activeTextCatalog > activeIconCatalog && activeTextCatalog - activeIconCatalog <= 0x4000
        ? Math.min(EXTENDED_ICON_SLOTS, (activeTextCatalog - activeIconCatalog) >>> 2)
        : EXTENDED_ICON_SLOTS;

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
      if ((bWord >>> 24) !== 0xea) {
        throw new Error(`Expected branch instruction at icon bound site 0x${site.toString(16)}, got 0x${bWord.toString(16)}`);
      }
      const helperVa = branchTarget(site, bWord);
      rtosExpectU32(rtosBuf, helperVa, 0xe52d3004, `icon bound helper push {r3} at 0x${helperVa.toString(16)}`);
      const boundMov = rtosReadU32(rtosBuf, helperVa + 4);
      if ((boundMov & 0xfff0f000) >>> 0 !== 0xe3003000) {
        throw new Error(`Expected movw r3, #upper at icon bound helper+4 (0x${(helperVa + 4).toString(16)}), got 0x${boundMov.toString(16)}`);
      }
      const newUpper = Math.max(chosenIconId, movImmediate(boundMov));
      rtosWriteU32(rtosBuf, helperVa + 4, movWord(3, newUpper));
    }
  }

  // 6. Synthesize custom 400x60 [OFF, 1-bar, 2-bars] scale icon and append to ICONBIN
  const iconOrig = fw.decoded.subarray(iconSec.offset, iconSec.offset + iconSec.size);
  const oldIconSize = iconSec.size;
  const scaleBytesLen = 400 * 60 * 4; // 96,000 bytes
  const iconGrowth = 4 * FRAME_SIZE;  // 0x18000 = 98,304 bytes
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

  const scaleDescVa = appendRtos(concatBytes([u16le([1, 400, 60, 0]), u32le([oldIconSize / 4])]), 16);
  rtosWriteU32(rtosBuf, iconCatalogVa + chosenIconId * 4, scaleDescVa);

  // 7. Append HLG curve, gamma descriptor, matrix, ToneRecord, "HDR" label & descriptor, APP2 hook
  const curveVa = appendRtos(HLG_CURVE, 256);
  const gamDescVa = appendRtos(u32le([GAMMA_DESC_WORD0, 1, curveVa, curveVa, curveVa]), 4);
  const matrixVa = appendRtos(HLG_MATRIX, 4);

  const stdRec = rtosReadBytes(rtosBuf, STD_REC_VA, 84);
  const recBytes = new Uint8Array(stdRec);
  writeU32(recBytes, 4, matrixVa);
  const recVa = appendRtos(recBytes, 4);

  const hdrUtf16 = new Uint8Array([0x48, 0x00, 0x44, 0x00, 0x52, 0x00, 0x00, 0x00]); // "HDR\0"
  const textVa = appendRtos(hdrUtf16, 4);
  const textDescVa = appendRtos(concatBytes([Uint8Array.from([4, 1, 0, 0]), u32le([textVa])]), 4);

  const hookVa = appendRtos(HLG_HOOK_BLOCK, 16);

  // Stamp marker right before trailing checksum compensation word
  rtosBuf.set(HLG_MARKER, newRtosSize - 16);

  // 8. Patch hooks, sliders, tables, all 3 variants of style tables (native + relocated), and 21 languages
  rtosWriteU32(rtosBuf, HOOK_SITE, branchWord(HOOK_SITE, hookVa));
  rtosWriteU32(rtosBuf, HDR_SCALE_SHOOTING, movWord(3, chosenIconId));
  rtosWriteU32(rtosBuf, HDR_SCALE_RAW, movWord(3, chosenIconId));
  for (const tbl of HDR_INTENSE_TABLES) {
    rtosWriteU32(rtosBuf, tbl, 0x00020100); // [0, 1, 2, 0]
  }
  rtosWriteU32(rtosBuf, HDR_INTENSE_ASCII_CMP, 0x9a00000d); // bls (allow 0..3)

  const tableUpdates: readonly [typeof STYLE_TABLES[number], number][] = [
    [STYLE_TABLES[0], recVa],
    [STYLE_TABLES[1], STD_MA_DESC_VA],
    [STYLE_TABLES[2], gamDescVa],
  ];
  for (const [[tName, nativeBase, strideSite, loSite, hiSite], targetVal] of tableUpdates) {
    for (let vIdx = 0; vIdx < VARIANTS; vIdx++) {
      rtosWriteU32(rtosBuf, nativeBase + 4 * (vIdx * NATIVE_TONES + TARGET_TONE_ID), targetVal);
    }
    const strideWord = rtosReadU32(rtosBuf, strideSite);
    if ((strideWord & 0xffffff00) >>> 0 !== 0xe3a02000) {
      throw new Error(`${tName}: expected mov r2, #stride at 0x${strideSite.toString(16)}, got 0x${strideWord.toString(16)}`);
    }
    const stride = strideWord & 0xff;
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

  for (let l = 0; l < LANGUAGES; l++) {
    const nativeRow = rtosReadU32(rtosBuf, NATIVE_TEXT_ROOTS + l * 4);
    rtosWriteU32(rtosBuf, nativeRow + TARGET_TEXT_ID * 4, textDescVa);
    if (activeTextCatalog !== NATIVE_TEXT_ROOTS) {
      const extRow = rtosReadU32(rtosBuf, activeTextCatalog + l * 4);
      if (extRow !== 0) {
        rtosWriteU32(rtosBuf, extRow + TARGET_TEXT_ID * 4, textDescVa);
      }
    }
  }

  // 9. Rebuild grown decoded payload, adjust section sizes + checksum compensation word, rebuild container
  const oldRtosEnd = rtosSec.offset + oldRtosSize;
  const oldIconEnd = iconSec.offset + oldIconSize;
  const newDecoded = new Uint8Array(fw.decoded.length + rtosGrowth + iconGrowth);

  newDecoded.set(fw.decoded.subarray(0, rtosSec.offset), 0);
  newDecoded.set(rtosBuf, rtosSec.offset);
  newDecoded.set(fw.decoded.subarray(oldRtosEnd, iconSec.offset), rtosSec.offset + newRtosSize);

  const newIconOffset = iconSec.offset + rtosGrowth;
  newDecoded.set(iconOrig, newIconOffset);
  newDecoded.set(scalePixels, newIconOffset + oldIconSize);
  // Remaining padding in newIconOffset + oldIconSize + scalePixels.length .. newIconSize is zeroed

  newDecoded.set(fw.decoded.subarray(oldIconEnd), newIconOffset + newIconSize);

  // Update RTOS and ICONBIN u32 section size headers
  writeU32(newDecoded, rtosSec.offset - 4, newRtosSize);
  writeU32(newDecoded, newIconOffset - 4, newIconSize);

  // Zero checksum word at end of new RTOS, compute payload compensation word so sum32 === 0
  const compOffset = rtosSec.offset + newRtosSize - 4;
  writeU32(newDecoded, compOffset, 0);
  const comp = (-sum32(newDecoded)) >>> 0;
  writeU32(newDecoded, compOffset, comp);

  if (sum32(newDecoded) !== 0) {
    throw new Error('Internal error: patched payload word sum is not zero');
  }
  for (let i = 1; i <= 4; i++) {
    if (newDecoded[newDecoded.length - i] !== fw.decoded[fw.decoded.length - i]) {
      throw new Error('Internal error: last payload word changed');
    }
  }

  // Validate section sums outside RTOS / ICONBIN stayed completely untouched (including RES / LINUX / INITFS)
  const origSecs = sectionsOf(fw.decoded);
  const newSecs = sectionsOf(newDecoded);
  if (origSecs.length !== newSecs.length) {
    throw new Error('Internal error: section count changed');
  }
  for (let i = 0; i < origSecs.length; i++) {
    if (origSecs[i].name !== newSecs[i].name) throw new Error(`Internal error: section ${origSecs[i].name} mismatch`);
    if (origSecs[i].name === 'RTOS' || origSecs[i].name === 'ICONBIN') continue;
    if (sum32(newDecoded.subarray(newSecs[i].offset, newSecs[i].name === 'RES' ? newDecoded.length : newSecs[i].offset + newSecs[i].size)) !==
        sum32(fw.decoded.subarray(origSecs[i].offset, origSecs[i].name === 'RES' ? fw.decoded.length : origSecs[i].offset + origSecs[i].size))) {
      throw new Error(`Internal error: section ${origSecs[i].name} modified unexpectedly`);
    }
  }

  const insertions = [
    { at: oldRtosEnd, length: rtosGrowth },
    { at: oldIconEnd, length: iconGrowth },
  ];
  const built = buildGrown(fw, newDecoded, insertions);
  const verifyOut = verifyContainer(built.out, newDecoded);
  const outFailed = Object.entries(verifyOut.checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (outFailed.length > 0) {
    throw new Error(`Output container verification failed: ${outFailed.join(', ')}`);
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
    reencodedFrames: built.reencoded.length,
  };
}

// -----------------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------------
function printUsage(): void {
  console.log([
    'Ricoh GR IV v1.21 BT.2100 HLG Photo Post-Patcher (Standalone)',
    '',
    'Usage:',
    '  node gr4_v121_hlg_patcher.mjs <input.bin> [output.bin]',
    '  node gr4_v121_hlg_patcher.mjs <input.bin> -o <output.bin>',
    '  node gr4_v121_hlg_patcher.mjs --inspect <fw.bin>',
    '',
    'Supports BOTH official GR IV v1.21 fwdc248b.bin AND GRMod-built v1.21 firmware',
    '(0.8.15 / 0.8.16 / future releases, with any combination of GRMod features).',
  ].join('\n'));
}

async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    return 0;
  }

  if (args[0] === '--inspect') {
    const file = args[1];
    if (!file) {
      console.error('ERROR: --inspect requires a firmware file path.');
      return 1;
    }
    const raw = new Uint8Array(readFileSync(resolve(file)));
    const info = inspectFirmware(raw);
    console.log(`File                    : ${resolve(file)}`);
    console.log(`Container valid         : ${info.validContainer}`);
    console.log(`GR IV v1.21 detected    : ${info.isGr4V121}`);
    console.log(`Base layout             : ${info.isGrmodGrown ? 'GRMod / Grown' : 'Official / In-Place'}`);
    console.log(`RTOS / ICONBIN sizes    : 0x${info.rtosSize.toString(16)} / 0x${info.iconbinSize.toString(16)} (RES files: ${info.resCount})`);
    console.log(`Relocated style tables  : ${info.hasRelocatedStyleTables}`);
    console.log(`GRMod HDR Gain Map      : ${info.hasHdrGainMap}`);
    console.log(`HLG Photo installed     : ${info.hlgInstalled ? 'YES' : 'NO'} (marker=${info.hlgMarkerPresent}, scaleIconId=${info.chosenScaleIconId ?? 'n/a'})`);
    return info.isGr4V121 ? 0 : 1;
  }

  let inputPath: string | undefined;
  let outputPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--output') {
      outputPath = args[++i];
      if (!outputPath) {
        console.error('ERROR: -o/--output requires a file path.');
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

  let resolvedOut: string;
  if (outputPath) {
    resolvedOut = resolve(outputPath);
  } else {
    const ext = extname(resolvedIn);
    const stem = basename(resolvedIn, ext);
    resolvedOut = join(dirname(resolvedIn), `${stem}_hlg${ext || '.bin'}`);
  }

  const raw = new Uint8Array(readFileSync(resolvedIn));
  const res = await patchHlgV121(raw);

  if (res.alreadyPatched) {
    console.log(`[SKIP] HLG Photo is ALREADY installed in ${resolvedIn} (base=${res.baseType}). No changes written.`);
    return 0;
  }

  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, res.output!);

  console.log('=== GR IV v1.21 BT.2100 HLG Photo Patch Complete ===');
  console.log(`Input           : ${resolvedIn} (${res.baseType}${res.hasRelocatedStyleTables ? ', relocated style tables' : ''})`);
  console.log(`Output          : ${resolvedOut} (${res.output!.length.toLocaleString()} bytes)`);
  console.log(`Output SHA-256  : ${res.outputSha256}`);
  console.log(`RTOS size       : 0x${res.oldRtosSize.toString(16)} -> 0x${res.newRtosSize!.toString(16)}`);
  console.log(`ICONBIN size    : 0x${res.oldIconbinSize.toString(16)} -> 0x${res.newIconbinSize!.toString(16)}`);
  console.log(`Scale icon ID   : ${res.chosenIconId} ([OFF, 1-bar, 2-bars])`);
  console.log(`Frames re-emit  : ${res.reencodedFrames}`);
  console.log(`Self-checks     : ALL PASSED (${Object.keys(res.checks!).length}/${Object.keys(res.checks!).length})`);
  console.log('Slot 22 behavior: Named "HDR", Rec.2020 + ARIB STD-B67 + CICP ICC, Level 0 = OFF bypass.');
  if (res.hasHdrGainMap) {
    console.log('[NOTE] GRMod HDR Gain Map is also present in this firmware. When shooting HLG in Slot 22, switch OFF [Shooting > HDR] in camera menu.');
  }
  return 0;
}

runCli().then(
  (code) => { if (code !== 0) process.exit(code); },
  (err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
