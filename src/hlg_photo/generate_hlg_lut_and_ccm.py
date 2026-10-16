#!/usr/bin/env python3
"""Ricoh GR IV (v1.11) HLG Photo Phase 1: Rec.2020 3x3 CCM & ARIB STD-B67 1D LUT Generator.

Generates the mathematical and binary tables required to transform a reserved Image Control
(Look) slot in 05_RTOS.bin into a True BT.2100 HLG Photo profile:
  1. 3x3 Color Correction Matrix (CCM): Linear Rec.709/sRGB -> Linear Rec.2020 (BT.2020)
     in floating-point, S3.8 (1.0 = 256), and S3.10 (1.0 = 1024) fixed-point representations.
  2. 1D Tone Curve LUT: ARIB STD-B67 (HLG) OETF (and inverse gamma pre-compensation)
     for 256-point, 1024-point, and 4096-point Milbeaut ISP gamma tables.
  3. RTOS Image Control (Look) table inspection at vaddr 0x53dbf360 (payload 0x00dd7070)
     and visibility gate inspection at vaddr 0x533cc6e0 (payload 0x003e43f0).
"""
import json
import math
import struct
import sys
from pathlib import Path

RTOS_BASE = 0x53000000
RTOS_PAYLOAD_OFFSET = 0x00017D10

# ITU-R BT.709 (D65) -> ITU-R BT.2020 (D65) exact linear RGB conversion matrix
MAT_709_TO_2020 = [
    [0.6274039, 0.3292830, 0.0433131],
    [0.0690973, 0.9195404, 0.0113623],
    [0.0163914, 0.0880133, 0.8955953],
]


def arib_std_b67_oetf(e: float) -> float:
    """ARIB STD-B67 / ITU-R BT.2100 HLG Opto-Electronic Transfer Function (OETF).
    Input e in [0.0, 1.0] (normalized linear scene light).
    Output E' in [0.0, 1.0] (non-linear HLG signal).
    """
    a = 0.17883277
    b = 1.0 - 4.0 * a  # 0.28466892
    c = 0.5 - a * math.log(4.0 * a)  # 0.55991073
    if e <= 0.0:
        return 0.0
    if e <= (1.0 / 12.0):
        return math.sqrt(3.0 * e)
    return a * math.log(12.0 * e - b) + c


def quantize_ccm(matrix, scale: int):
    """Quantize a 3x3 float matrix to signed integers where each row sums to exactly `scale`."""
    out = []
    for row in matrix:
        q = [int(round(v * scale)) for v in row]
        diff = scale - sum(q)
        max_idx = max(range(3), key=lambda idx: abs(row[idx]))
        q[max_idx] += diff
        out.append(q)
    return out


def generate_hlg_lut(num_points: int, out_max: int):
    """Generate 1D ARIB STD-B67 HLG OETF table of length `num_points` with values in [0, out_max]."""
    lut = []
    for i in range(num_points):
        e = i / float(num_points - 1)
        y = arib_std_b67_oetf(e)
        lut.append(min(out_max, max(0, int(round(y * out_max)))))
    return lut


def inspect_rtos_look_table(rtos_path: Path):
    """Read the 17-entry Image Control (Look) pointer table at 0x53dbf360 in 05_RTOS.bin."""
    rtos = rtos_path.read_bytes()
    table_vaddr = 0x53DBF360
    table_off = table_vaddr - RTOS_BASE
    entries = []
    for idx in range(17):
        ptr = struct.unpack_from("<I", rtos, table_off + idx * 4)[0]
        str_off = ptr - RTOS_BASE
        if 0 <= str_off <= len(rtos) - 16:
            raw_bytes = rtos[str_off : str_off + 16]
            u16_units = struct.unpack("<8H", raw_bytes)
            ascii_preview = "".join(chr(c) if 32 <= c < 127 else "." for c in u16_units).rstrip(".")
            raw_hex = raw_bytes.hex()
        else:
            ascii_preview = "<non-pointer/terminator>"
            raw_hex = ""
        entries.append({
            "index": idx,
            "slot_hex": f"{idx:#04x}",
            "ptr_vaddr": f"{ptr:#010x}",
            "ptr_payload_offset": f"{ptr - RTOS_BASE + RTOS_PAYLOAD_OFFSET:#010x}" if 0 <= str_off < len(rtos) else None,
            "utf16_preview": ascii_preview,
            "raw_hex": raw_hex,
        })

    # Also inspect the visibility gate instruction at vaddr 0x533cc6e4 (beq #0x533cc710)
    gate_vaddr = 0x533CC6E0
    gate_off = gate_vaddr - RTOS_BASE
    gate_words = [f"{w:#010x}" for w in struct.unpack_from("<4I", rtos, gate_off)]

    return {
        "look_table_vaddr": hex(table_vaddr),
        "look_table_payload_offset": hex(table_off + RTOS_PAYLOAD_OFFSET),
        "visibility_gate_vaddr": hex(gate_vaddr),
        "visibility_gate_payload_offset": hex(gate_off + RTOS_PAYLOAD_OFFSET),
        "visibility_gate_words": gate_words,
        "entries": entries,
    }


def main():
    worktree_root = Path(__file__).resolve().parent.parent.parent
    # Share unpacked firmware from main repository root if running inside a git worktree
    shared_root = worktree_root.parent.parent if worktree_root.parent.name == "worktrees" else worktree_root
    rtos_path = shared_root / "firmware" / "unpacked" / "v1.11" / "sections" / "05_RTOS.bin"

    out_dir = worktree_root / "assets" / "isp_tables"
    out_dir.mkdir(parents=True, exist_ok=True)

    ccm_s3_8 = quantize_ccm(MAT_709_TO_2020, 256)
    ccm_s3_10 = quantize_ccm(MAT_709_TO_2020, 1024)
    lut_256_8bit = generate_hlg_lut(256, 255)
    lut_1024_10bit = generate_hlg_lut(1024, 1023)
    lut_4096_12bit = generate_hlg_lut(4096, 4095)

    # Save binary 1D LUTs (uint16 little-endian)
    (out_dir / "arib_std_b67_hlg_1024x10bit.bin").write_bytes(
        struct.pack(f"<{len(lut_1024_10bit)}H", *lut_1024_10bit)
    )
    (out_dir / "arib_std_b67_hlg_4096x12bit.bin").write_bytes(
        struct.pack(f"<{len(lut_4096_12bit)}H", *lut_4096_12bit)
    )
    # Save binary 3x3 CCMs (int16 little-endian)
    flat_s3_8 = [v for row in ccm_s3_8 for v in row]
    flat_s3_10 = [v for row in ccm_s3_10 for v in row]
    (out_dir / "ccm_rec709_to_rec2020_s3_8.bin").write_bytes(struct.pack("<9h", *flat_s3_8))
    (out_dir / "ccm_rec709_to_rec2020_s3_10.bin").write_bytes(struct.pack("<9h", *flat_s3_10))

    # Also emit a portable C header for RTOS/Linux hook compilation
    c_header = [
        "/* Auto-generated Ricoh GR IV BT.2100 HLG ISP Tables (Rec.2020 CCM + ARIB STD-B67 OETF) */",
        "#pragma once",
        "#include <stdint.h>\n",
        "static const int16_t kCcmRec709ToRec2020_S3_8[3][3] = {",
        f"    {{{ccm_s3_8[0][0]}, {ccm_s3_8[0][1]}, {ccm_s3_8[0][2]}}},",
        f"    {{{ccm_s3_8[1][0]}, {ccm_s3_8[1][1]}, {ccm_s3_8[1][2]}}},",
        f"    {{{ccm_s3_8[2][0]}, {ccm_s3_8[2][1]}, {ccm_s3_8[2][2]}}}",
        "};\n",
        "static const int16_t kCcmRec709ToRec2020_S3_10[3][3] = {",
        f"    {{{ccm_s3_10[0][0]}, {ccm_s3_10[0][1]}, {ccm_s3_10[0][2]}}},",
        f"    {{{ccm_s3_10[1][0]}, {ccm_s3_10[1][1]}, {ccm_s3_10[1][2]}}},",
        f"    {{{ccm_s3_10[2][0]}, {ccm_s3_10[2][1]}, {ccm_s3_10[2][2]}}}",
        "};\n",
        "static const uint16_t kLutAribStdB67Hlg_1024x10bit[1024] = {",
    ]
    for i in range(0, 1024, 16):
        row_str = ", ".join(f"{v:4d}" for v in lut_1024_10bit[i : i + 16])
        c_header.append(f"    {row_str},")
    c_header.append("};\n")
    (out_dir / "hlg_isp_tables.h").write_text("\n".join(c_header), encoding="utf-8")

    report = {
        "ccm_float_rec709_to_rec2020": MAT_709_TO_2020,
        "ccm_fixed_s3_8_scale256": ccm_s3_8,
        "ccm_fixed_s3_10_scale1024": ccm_s3_10,
        "lut_256_8bit_sample": lut_256_8bit[::16] + [lut_256_8bit[-1]],
        "lut_1024_10bit_sample": lut_1024_10bit[::64] + [lut_1024_10bit[-1]],
    }

    if rtos_path.exists():
        report["rtos_look_audit"] = inspect_rtos_look_table(rtos_path)

    out_json = out_dir / "hlg_isp_parameters.json"
    out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Generated HLG ISP LUTs and Rec.2020 CCMs in {out_dir}")
    print(f"  - S3.8 CCM (1.0=256):  {ccm_s3_8}")
    print(f"  - S3.10 CCM (1.0=1024): {ccm_s3_10}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
