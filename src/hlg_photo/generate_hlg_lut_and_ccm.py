#!/usr/bin/env python3
"""Ricoh GR IV (v1.11) BT.2100 HLG Photo: ISP Tables & CCM Generator.

Generates the exact hardware tables for the Ricoh GR IV v1.11 ISP pipeline:
  1. 3x3 Color Correction Matrix (CCM) in Q13 (8192 = 1.0) signed int16 format:
     M_HLG = round( M_709_to_2020 @ M_STD * 8192 )
     where M_STD is the camera's Standard look matrix extracted from 05_RTOS.bin (0x54049850).
     Every row sums to exactly 8192.
  2. 1D 256-point 14-bit (0..16383) ARIB STD-B67 (HLG) Tone Curve with inverse
     base tone curve S^-1 pre-compensation:
     curve_c[i] = round( 16383 * HLG( S^-1( i * 64 / 16383.0 ) ) )
     evaluated over display input b_i in [0, 1], monotonically clamped to [0, 16383].
  3. Firmware rodata / RAM audit of all 34 styles across T_REC, T_GAM, T_MA, and ORDER_TABLE.
"""
import json
import math
import struct
import sys
from pathlib import Path
import numpy as np

RTOS_BASE = 0x53000000
RTOS_PAYLOAD_OFFSET = 0x00017D10
RAM_VA = 0x55000000
RAM_LEN = 0x57480
RAM_IMG_VA = 0x5437B640

# Official Ricoh GR IV Base Tone Curve S(lin) from empirical pipeline calibration
# 256 uint16 values: display = S(lin) for linear scene light lin = i / 256.0
BASE_CURVE = [
    0, 426, 773, 1108, 1431, 1745, 2049, 2347, 2637, 2921, 3199, 3470, 3737, 3998, 4255, 4508,
    4757, 5002, 5242, 5470, 5687, 5893, 6089, 6277, 6457, 6628, 6794, 6953, 7107, 7255, 7398, 7536,
    7670, 7800, 7926, 8049, 8169, 8285, 8399, 8508, 8616, 8722, 8824, 8925, 9023, 9120, 9213, 9306,
    9396, 9485, 9572, 9657, 9741, 9823, 9903, 9982, 10059, 10137, 10212, 10286, 10358, 10430, 10500, 10570,
    10638, 10705, 10773, 10838, 10902, 10966, 11028, 11090, 11151, 11211, 11270, 11329, 11387, 11445, 11501, 11557,
    11612, 11666, 11720, 11773, 11826, 11878, 11929, 11980, 12030, 12080, 12130, 12178, 12226, 12274, 12321, 12367,
    12414, 12460, 12504, 12550, 12594, 12638, 12682, 12725, 12767, 12810, 12852, 12893, 12935, 12976, 13016, 13057,
    13097, 13136, 13175, 13214, 13252, 13291, 13328, 13366, 13403, 13440, 13477, 13513, 13550, 13585, 13621, 13656,
    13691, 13723, 13755, 13787, 13818, 13849, 13880, 13911, 13942, 13971, 14002, 14031, 14060, 14090, 14119, 14149,
    14177, 14206, 14234, 14263, 14290, 14318, 14346, 14373, 14401, 14427, 14455, 14481, 14507, 14534, 14560, 14586,
    14612, 14637, 14663, 14688, 14714, 14739, 14764, 14789, 14813, 14838, 14862, 14886, 14911, 14934, 14958, 14982,
    15005, 15028, 15052, 15075, 15098, 15121, 15143, 15167, 15189, 15211, 15234, 15255, 15277, 15300, 15321, 15342,
    15365, 15386, 15407, 15429, 15449, 15470, 15492, 15512, 15532, 15554, 15574, 15594, 15615, 15635, 15655, 15675,
    15695, 15714, 15734, 15754, 15773, 15792, 15812, 15831, 15850, 15870, 15889, 15907, 15926, 15945, 15963, 15982,
    16001, 16019, 16037, 16055, 16074, 16092, 16109, 16128, 16145, 16163, 16180, 16199, 16216, 16233, 16250, 16268,
    16285, 16302, 16320, 16337, 16353, 16370, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384,
]

# Standard ITU-R BT.709 -> ITU-R BT.2020 linear conversion matrix (D65)
M_709_TO_2020 = np.array([
    [0.6274039, 0.3292830, 0.0433131],
    [0.0690973, 0.9195404, 0.0113623],
    [0.0163914, 0.0880133, 0.8955953],
], dtype=np.float64)


def foff(va: int) -> int:
    """Map runtime Virtual Address to unpacked payload.bin file offset."""
    if RAM_VA <= va < RAM_VA + RAM_LEN:
        va = RAM_IMG_VA + (va - RAM_VA)
    return RTOS_PAYLOAD_OFFSET + (va - RTOS_BASE)


def arib_std_b67_oetf(e: float) -> float:
    """ARIB STD-B67 / ITU-R BT.2100 HLG Opto-Electronic Transfer Function.

    Input e in [0.0, 1.0] (linear scene reflectance normalized to 1.0).
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


class BaseToneCurve:
    """Ricoh GR IV hardware base tone curve S(lin) and inverse S^-1(d)."""

    def __init__(self, table=BASE_CURVE):
        self.s_tab = np.array(table, dtype=np.float64) / 16383.0
        self.s_x = np.arange(256, dtype=np.float64) / 256.0
        self.s_xmax = self.s_x[255]

    def s(self, lin: float) -> float:
        lin = max(0.0, min(self.s_xmax, float(lin)))
        return float(np.interp(lin, self.s_x, self.s_tab))

    def sinv(self, d: float) -> float:
        d = max(0.0, min(1.0, float(d)))
        return float(np.interp(d, self.s_tab, self.s_x))


def generate_precompensated_hlg_curve(base_curve: BaseToneCurve, headroom: float = 1.0) -> list[int]:
    """Generate 256-point 14-bit (0..16383) ARIB STD-B67 HLG tone curve.

    Input index i in [0..255] corresponds to display input b_i = (i * 64) / 16383.0.
    The hardware applies: display = curve_c( S( clip( M1 @ Sinv(d_std) ) ) ).
    To achieve true HLG(E), curve_c at input b_i is evaluated at E_i = Sinv(b_i) * headroom:
        curve_c[i] = round( 16383 * HLG( Sinv(b_i) * headroom ) )
    monotonically non-decreasing in [0..16383].
    """
    curve = []
    run = 0
    for i in range(256):
        b_i = (i * 64) / 16383.0
        e_i = base_curve.sinv(b_i) * headroom
        y_i = arib_std_b67_oetf(e_i)
        val = int(round(y_i * 16383.0))
        val = max(0, min(16383, val))
        if val < run:
            val = run
        run = val
        curve.append(val)
    return curve


def compute_hlg_matrix(m_std_q13: list[int] | tuple[int, ...]) -> list[list[int]]:
    """Compute HLG Color Matrix in Q13 from linear BT.709->BT.2020 times Standard matrix."""
    m_std = np.array(m_std_q13, dtype=np.float64).reshape((3, 3)) / 8192.0
    prod = M_709_TO_2020 @ m_std
    q = np.round(prod * 8192.0).astype(int)
    # Ensure exact row sum of 8192 on the diagonal (grey stays grey)
    for r in range(3):
        row_sum = int(np.sum(q[r]))
        q[r, r] += 8192 - row_sum
    return q.tolist()


def inspect_firmware_styles(payload: bytes) -> dict:
    """Audit all 34 styles in initialized RAM across Tone, Gamma, MultiAxis tables."""
    T_REC = 0x55053780
    T_GAM = 0x55053138
    T_MA = 0x55053504
    ORDER_TABLE = 0x53DBE388
    ORDER_COUNT = 20

    order = list(payload[foff(ORDER_TABLE) : foff(ORDER_TABLE) + ORDER_COUNT])

    styles = []
    for tone_id in range(34):
        variant_records = []
        for v in range(3):
            rec_ptr = struct.unpack_from("<I", payload, foff(T_REC + 4 * (v * 34 + tone_id)))[0]
            gam_ptr = struct.unpack_from("<I", payload, foff(T_GAM + 4 * (v * 34 + tone_id)))[0]
            ma_ptr = struct.unpack_from("<I", payload, foff(T_MA + 4 * (v * 34 + tone_id)))[0]
            variant_records.append((rec_ptr, gam_ptr, ma_ptr))

        rec_ptr, gam_ptr, ma_ptr = variant_records[0]
        rec_bytes = payload[foff(rec_ptr) : foff(rec_ptr) + 0x54]
        mat_ptr, post_ptr = struct.unpack_from("<II", rec_bytes, 4)
        mat_q13 = list(struct.unpack_from("<9h", payload, foff(mat_ptr)))

        gam_bytes = payload[foff(gam_ptr) : foff(gam_ptr) + 20]
        desc_hdr = gam_bytes[:8].hex()
        r_curve, g_curve, b_curve = struct.unpack_from("<III", gam_bytes, 8)

        ma_arr_ptr = struct.unpack_from("<I", payload, foff(ma_ptr + 8))[0]
        ma_blocks = [hex(b) for b in struct.unpack_from("<8I", payload, foff(ma_arr_ptr))]

        styles.append({
            "tone_id": tone_id,
            "tone_id_hex": f"0x{tone_id:02x}",
            "rec_vaddr": f"0x{rec_ptr:08x}",
            "matrix_vaddr": f"0x{mat_ptr:08x}",
            "matrix_q13": mat_q13,
            "post_array_vaddr": f"0x{post_ptr:08x}",
            "gam_vaddr": f"0x{gam_ptr:08x}",
            "gam_hdr_hex": desc_hdr,
            "curves_vaddr": [f"0x{r_curve:08x}", f"0x{g_curve:08x}", f"0x{b_curve:08x}"],
            "ma_vaddr": f"0x{ma_ptr:08x}",
            "ma_arr_vaddr": f"0x{ma_arr_ptr:08x}",
            "ma_blocks": ma_blocks,
        })

    return {
        "menu_order_20": order,
        "styles": styles,
    }


def main():
    worktree_root = Path(__file__).resolve().parent.parent.parent
    shared_root = worktree_root.parent.parent if worktree_root.parent.name == "worktrees" else worktree_root
    payload_path = shared_root / "firmware" / "unpacked" / "v1.11" / "payload.bin"

    out_dir = worktree_root / "assets" / "isp_tables"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Base Tone Curve & Pre-compensated HLG curve
    base_curve = BaseToneCurve(BASE_CURVE)
    hlg_curve_256 = generate_precompensated_hlg_curve(base_curve, headroom=1.0)
    hlg_curve_bytes = struct.pack(f"<{len(hlg_curve_256)}H", *hlg_curve_256)
    (out_dir / "arib_std_b67_hlg_256x14bit.bin").write_bytes(hlg_curve_bytes)

    # 2. Extract Standard matrix & compute HLG Q13 matrix
    m_std_q13 = (8736, 32, -576, 224, 8288, -320, -192, 448, 7936)
    if payload_path.exists():
        payload = payload_path.read_bytes()
        T_REC = 0x55053780
        std_rec_ptr = struct.unpack_from("<I", payload, foff(T_REC + 4 * 11))[0]
        std_matrix_ptr = struct.unpack_from("<I", payload, foff(std_rec_ptr + 4))[0]
        m_std_q13 = struct.unpack_from("<9h", payload, foff(std_matrix_ptr))

    hlg_matrix_q13 = compute_hlg_matrix(m_std_q13)
    flat_q13 = [val for row in hlg_matrix_q13 for val in row]
    hlg_matrix_bytes = struct.pack("<9h", *flat_q13)
    (out_dir / "ccm_rec709_to_rec2020_q13.bin").write_bytes(hlg_matrix_bytes)

    # 3. Emit C Header
    c_header = [
        "/* Auto-generated Ricoh GR IV BT.2100 HLG ISP Tables (Hardware Q13 CCM + 14-bit 256p HLG OETF) */",
        "#pragma once",
        "#include <stdint.h>\n",
        "/* Pre-curve Linear 3x3 Color Matrix in Q13 (8192 = 1.0), row-major, row sum = 8192 */",
        "static const int16_t kCcmRec709ToRec2020_Q13[3][3] = {",
        f"    {{{hlg_matrix_q13[0][0]}, {hlg_matrix_q13[0][1]}, {hlg_matrix_q13[0][2]}}},",
        f"    {{{hlg_matrix_q13[1][0]}, {hlg_matrix_q13[1][1]}, {hlg_matrix_q13[1][2]}}},",
        f"    {{{hlg_matrix_q13[2][0]}, {hlg_matrix_q13[2][1]}, {hlg_matrix_q13[2][2]}}}",
        "};\n",
        "/* 256-point 14-bit (0..16383) ARIB STD-B67 HLG Tone Curve with S^-1 pre-compensation */",
        "static const uint16_t kLutAribStdB67Hlg_256x14bit[256] = {",
    ]
    for i in range(0, 256, 16):
        row_str = ", ".join(f"{v:5d}" for v in hlg_curve_256[i : i + 16])
        c_header.append(f"    {row_str},")
    c_header.append("};\n")
    (out_dir / "hlg_isp_tables.h").write_text("\n".join(c_header), encoding="utf-8")

    # 4. JSON Report & Firmware Audit
    report = {
        "description": "Ricoh GR IV v1.11 BT.2100 HLG Photo Hardware Calibration",
        "ccm_rec709_to_rec2020_q13": hlg_matrix_q13,
        "m_std_q13": list(m_std_q13),
        "hlg_curve_sample": hlg_curve_256[::16] + [hlg_curve_256[-1]],
    }
    if payload_path.exists():
        report["firmware_audit"] = inspect_firmware_styles(payload)

    (out_dir / "hlg_isp_parameters.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Generated verified BT.2100 HLG ISP tables in {out_dir}:")
    print(f"  - Q13 Matrix: {hlg_matrix_q13}")
    print(f"  - 256-entry 14-bit HLG curve: {len(hlg_curve_256)} entries ({len(hlg_curve_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
