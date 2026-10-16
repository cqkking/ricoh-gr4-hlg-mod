#!/usr/bin/env python3
"""Ricoh GR IV (v1.11 fwdc248b.bin) BT.2100 HLG HDR Photo Firmware Patcher.

Applies the verified empirical ISP calibration and in-camera APP2 ICC injection hook
to the Ricoh GR IV Standard Edition (China Mainland sales version) v1.11 firmware:
  1. Cinema Green (toneId = 19 = 0x13) is 100% restored to factory original.
  2. Slot Transformation (Target: HDR Tone / HDR色调, toneId = 0x16 = 22):
     - Q13 Color Matrix in dedicated ToneRecord at HLG_REC_VA: Linear Rec.709 -> Rec.2020 @ M_STD
     - Gamma Descriptor at HLG_GAM_DESC_VA: desc[4]=1, desc[5]=0, 14-bit ARIB STD-B67 HLG curve
     - Neutral Multi-Axis Table: T_MA[22] repointed to Standard neutral table (0x54049de8)
     - UI Name (Text ID 306 across all 21 languages): renamed from "HDR色调"/"HDR Tone" to "HDR"
     - UI Icon: retains official HDR Tone icon (0 changes to ICONBIN)
  3. Safe Landing Region (0x540db200 in RTOS rodata zero padding):
     - Houses ARM hook code, APP2 ICC payload, 14-bit HLG LUT, gamma descriptor,
       Q13 CCM, dedicated ToneRecord struct, and "HDR" UTF-16LE text descriptor.
  4. In-Camera Automatic APP2 CICP ICC Profile Injection:
     - Hooks ExifJpegWriter::SetupAppNInfo at 0x5380bf50 (branching to 0x540db200)
     - Checks [r1, #0x79c] == 22 (HDR mode)
     - Fixes APP7 length in m_workArea to terminate cleanly at [r4, #0x50]
     - Appends 32-byte aligned APP2 ICC_PROFILE segment (FF E2, len=576, BT.2100 HLG CICP [9, 18, 0, 1])
     - Advances [r4, #0x50] by 576 bytes so every .JPG shot in HLG mode is an HDR HLG photo straight out of camera!
  5. Word-Sum Checksum Compensation:
     - Absorbs word delta at COMP_VA = 0x54049394 (payload 0x10610a4) so payload word-sum == 0.
  6. Packaging:
     - Encodes patched payload into production-ready, flashable fwdc248b.bin container.
"""
import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# Add worktree root to path for tools imports
WORKTREE_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(WORKTREE_ROOT))
from tools.fw_container import (
    decode_container,
    rebuild_container,
    diff_offsets,
    verify_container,
    parse_sections,
    word_sum,
    sha256_hex,
    MAGIC,
    HEADER_SIZE,
    DECODED_PAYLOAD_BYTES,
)
from src.hlg_photo.patch_audit import (
    load_manifest,
    validate_baseline,
    validate_container_identity,
    validate_patched_payload,
)

RTOS_BASE = 0x53000000
RTOS_PAYLOAD_OFFSET = 0x17D10
RAM_VA = 0x55000000
RAM_LEN = 0x57480
RAM_IMG_VA = 0x5437B640

# Target slot: HDR Tone (toneId = 22 = 0x16, Text ID = 306)
TARGET_TONE_ID = 22
TARGET_TEXT_ID = 306

# Offsets and addresses in GR IV v1.11
COMP_VA = 0x54049394
COMP_PAYLOAD_OFF = RTOS_PAYLOAD_OFFSET + (COMP_VA - RTOS_BASE)  # 0x10610a4

# Landing block inside RTOS rodata zero padding (0x540db1aa .. 0x540df4ab)
LANDING_BASE_VA = 0x540DB200
HOOK_CODE_VA    = 0x540DB200  # 176 bytes (0xB0)
APP2_PAYLOAD_VA = 0x540DB2B0  # 14B header + 532B ICC + 2B pad = 548B (0x224)
HLG_CURVE_VA    = 0x540DB500  # 512 bytes (256-byte aligned)
HLG_GAM_DESC_VA = 0x540DB700  # 20 bytes (0x14)
HLG_MATRIX_VA   = 0x540DB720  # 18 bytes (0x12)
HLG_REC_VA      = 0x540DB740  # 84 bytes (0x54)
HLG_TEXT_VA     = 0x540DB7A0  # 8 bytes: UTF-16LE "HDR\0"
HLG_TEXT_DESC_VA= 0x540DB7A8  # 8 bytes: text descriptor struct
LANDING_END_VA  = 0x540DB7B0
LANDING_LEN     = LANDING_END_VA - LANDING_BASE_VA  # 1456 bytes (0x5B0)

# Style tables in RAM/ROM
T_REC_BASE = 0x55053780
T_GAM_BASE = 0x55053138
T_MA_BASE  = 0x55053504
STD_REC_VA = 0x5501ADBC
STD_MA_DESC_VA = 0x54049DE8
NATIVE_TEXT_ROOTS = 0x55002118
HOOK_SITE_VA = 0x5380BF50



def foff(va: int) -> int:
    """Map runtime Virtual Address to unpacked payload.bin file offset."""
    if RAM_VA <= va < RAM_VA + RAM_LEN:
        va = RAM_IMG_VA + (va - RAM_VA)
    return RTOS_PAYLOAD_OFFSET + (va - RTOS_BASE)


def assemble_hook(target_tone_id: int = TARGET_TONE_ID) -> bytes:
    """Assemble the in-camera APP2 ICC injection hook using arm-none-eabi-gcc."""
    asm_source = f"""
.syntax unified
.arch armv7-a
.arm
.text
.global hook_app2_inject
.type hook_app2_inject, %function

hook_app2_inject:
    ldr   r1, [fp, #-4]
    tst   r1, #0x200
    ldreq r1, [r4, #8]
    ldrne r1, [r4, #0xc]
    cmp   r1, #0
    beq   .Lexit_normal
    ldr   r1, [r1, #8]
    cmp   r1, #0
    beq   .Lexit_normal
    ldrb  r1, [r1, #0x79c]
    cmp   r1, #{target_tone_id}
    bne   .Lexit_normal

    ldr   r2, [r4, #0x18]
    ldr   r3, [r4, #0x48]
    add   r3, r2, r3
    ldr   r1, [r4, #0x4c]
    sub   r1, r1, #2
    str   r1, [r4, #0x4c]
    lsr   ip, r1, #8
    strb  ip, [r3, #2]
    strb  r1, [r3, #3]

    ldr   r1, [r4, #0x50]
    add   r3, r2, r1
    mov   r1, #0xff
    strb  r1, [r3]
    mov   r1, #0xe2
    strb  r1, [r3, #1]
    mov   r1, #2
    strb  r1, [r3, #2]
    mov   r1, #0x40
    strb  r1, [r3, #3]

    adr   r1, k_app2_payload
    add   r0, r3, #4
    mov   r2, #137
.Lcopy_loop:
    ldr   ip, [r1], #4
    str   ip, [r0], #4
    subs  r2, r2, #1
    bne   .Lcopy_loop

    ldr   r1, [r4, #0x50]
    add   r1, r1, #0x240
    str   r1, [r4, #0x50]

.Lexit_normal:
    mov   r0, #1
    sub   sp, fp, #0x14
    ldm   sp, {{r4, r5, fp, sp, pc}}

.align 2
k_app2_payload:
"""
    with tempfile.TemporaryDirectory() as td:
        s_file = Path(td) / "hook.s"
        o_file = Path(td) / "hook.o"
        bin_file = Path(td) / "hook.bin"
        s_file.write_text(asm_source, encoding="utf-8")
        subprocess.check_call(
            ["arm-none-eabi-gcc", "-mcpu=cortex-a9", "-marm", "-c", str(s_file), "-o", str(o_file)]
        )
        subprocess.check_call(
            ["arm-none-eabi-objcopy", "-O", "binary", "-j", ".text", str(o_file), str(bin_file)]
        )
        return bin_file.read_bytes()


def patch_payload(payload_bytes: bytes, target_tone_id: int = TARGET_TONE_ID) -> bytearray:
    """Apply all HLG Photo patches to payload.bin and restore word-sum to 0."""
    p = bytearray(payload_bytes)

    # 1. Load generated assets
    tables_dir = WORKTREE_ROOT / "assets" / "isp_tables"
    icc_dir = WORKTREE_ROOT / "assets" / "icc"

    matrix_bytes = (tables_dir / "ccm_rec709_to_rec2020_q13.bin").read_bytes()
    curve_bytes = (tables_dir / "arib_std_b67_hlg_256x14bit.bin").read_bytes()
    icc_bytes = (icc_dir / "bt2100_hlg_cicp.icc").read_bytes()

    assert len(matrix_bytes) == 18, f"Invalid matrix size: {len(matrix_bytes)}"
    assert len(curve_bytes) == 512, f"Invalid curve size: {len(curve_bytes)}"
    assert len(icc_bytes) == 532, f"Invalid ICC size: {len(icc_bytes)}"

    # 2. Populate Landing Block in RTOS rodata zero-padding (0x540db200)
    landing_off = foff(LANDING_BASE_VA)
    landing_buf = bytearray(LANDING_LEN)

    # 2a. Assemble and place APP2 injection hook code
    hook_code = assemble_hook(target_tone_id)
    assert len(hook_code) <= (APP2_PAYLOAD_VA - HOOK_CODE_VA), f"Hook code too large: {len(hook_code)}"
    landing_buf[0 : len(hook_code)] = hook_code

    # 2b. Place APP2 header and ICC profile at APP2_PAYLOAD_VA
    # Correct layout: exactly 14 bytes header, followed immediately by 532 bytes ICC, then 2 bytes trailing zero pad
    app2_hdr = b"ICC_PROFILE\x00\x01\x01"  # Exactly 14 bytes (NO PADDING BETWEEN HEADER AND ICC!)
    app2_data = app2_hdr + icc_bytes + b"\x00\x00"  # 14 + 532 + 2 = 548 bytes (137 words)
    assert len(app2_data) == 548
    app2_in_buf = APP2_PAYLOAD_VA - LANDING_BASE_VA
    landing_buf[app2_in_buf : app2_in_buf + len(app2_data)] = app2_data

    # 2c. Place 256-point 14-bit HLG Tone Curve at HLG_CURVE_VA
    curve_in_buf = HLG_CURVE_VA - LANDING_BASE_VA
    landing_buf[curve_in_buf : curve_in_buf + len(curve_bytes)] = curve_bytes

    # 2d. Place HLG Gamma Descriptor at HLG_GAM_DESC_VA
    gam_in_buf = HLG_GAM_DESC_VA - LANDING_BASE_VA
    struct.pack_into(
        "<IIIII",
        landing_buf,
        gam_in_buf,
        0x5407DEF4,
        0x00000001,
        HLG_CURVE_VA,
        HLG_CURVE_VA,
        HLG_CURVE_VA,
    )

    # 2e. Place Q13 Rec.2020 Color Matrix at HLG_MATRIX_VA
    mat_in_buf = HLG_MATRIX_VA - LANDING_BASE_VA
    landing_buf[mat_in_buf : mat_in_buf + len(matrix_bytes)] = matrix_bytes

    # 2f. Place Dedicated ToneRecord at HLG_REC_VA
    # Copy official Standard record (84 bytes) and repoint matrix pointer at +4
    std_rec_off = foff(STD_REC_VA)
    rec_bytes = bytearray(p[std_rec_off : std_rec_off + 84])
    struct.pack_into("<I", rec_bytes, 4, HLG_MATRIX_VA)
    rec_in_buf = HLG_REC_VA - LANDING_BASE_VA
    landing_buf[rec_in_buf : rec_in_buf + 84] = rec_bytes

    # 2g. Place UTF-16LE "HDR" string and text descriptor at HLG_TEXT_VA
    hdr_str = "HDR\x00".encode("utf-16-le")  # 8 bytes
    hdr_text_desc = struct.pack("<BBHI", len("HDR") + 1, 1, 0, HLG_TEXT_VA)  # 8 bytes
    text_in_buf = HLG_TEXT_VA - LANDING_BASE_VA
    desc_in_buf = HLG_TEXT_DESC_VA - LANDING_BASE_VA
    landing_buf[text_in_buf : text_in_buf + len(hdr_str)] = hdr_str
    landing_buf[desc_in_buf : desc_in_buf + len(hdr_text_desc)] = hdr_text_desc

    # Write entire landing block into payload
    p[landing_off : landing_off + LANDING_LEN] = landing_buf

    # 3. Hook ExifJpegWriter::SetupAppNInfo at HOOK_SITE_VA (0x5380bf50)
    # Replace sub sp, fp, #0x14 with b HOOK_CODE_VA
    disp = (HOOK_CODE_VA - (HOOK_SITE_VA + 8)) >> 2
    hook_insn = 0xEA000000 | (disp & 0x00FFFFFF)
    hook_site_off = foff(HOOK_SITE_VA)
    struct.pack_into("<I", p, hook_site_off, hook_insn)

    # 4. Repoint T_REC[target_tone_id] to HLG_REC_VA
    t_rec_off = foff(T_REC_BASE + target_tone_id * 4)
    struct.pack_into("<I", p, t_rec_off, HLG_REC_VA)

    # 5. Repoint T_GAM[target_tone_id] to HLG_GAM_DESC_VA
    t_gam_off = foff(T_GAM_BASE + target_tone_id * 4)
    struct.pack_into("<I", p, t_gam_off, HLG_GAM_DESC_VA)

    # 6. Repoint T_MA[target_tone_id] to Standard neutral multi-axis table (STD_MA_DESC_VA)
    t_ma_off = foff(T_MA_BASE + target_tone_id * 4)
    struct.pack_into("<I", p, t_ma_off, STD_MA_DESC_VA)

    # 7. Update Text Catalog across all 21 languages to name slot "HDR"
    for lang_idx in range(21):
        row_va = struct.unpack_from("<I", p, foff(NATIVE_TEXT_ROOTS + lang_idx * 4))[0]
        entry_off = foff(row_va + TARGET_TEXT_ID * 4)
        struct.pack_into("<I", p, entry_off, HLG_TEXT_DESC_VA)

    # 8. Dual 32-bit Word Sum Checksum Compensation
    # Checksum word is at COMP_PAYLOAD_OFF (0x10610a4)
    # Target: sum of all 32-bit little-endian words in payload must be 0
    cur_sum = word_sum(bytes(p))
    old_comp_word = struct.unpack_from("<I", p, COMP_PAYLOAD_OFF)[0]
    new_comp_word = (old_comp_word - cur_sum) & 0xFFFFFFFF
    struct.pack_into("<I", p, COMP_PAYLOAD_OFF, new_comp_word)

    final_sum = word_sum(bytes(p))
    assert final_sum == 0, f"Checksum compensation failed: final_sum={final_sum:#010x}"
    return p


def _atomic_write(path: Path, data: bytes) -> None:
    """Write only after all checks pass, then atomically replace the destination."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def patch_firmware(
    input_path: Path,
    output_path: Path,
    target_tone_id: int = TARGET_TONE_ID,
    manifest_path: Path | None = None,
):
    """Patch official v1.11 firmware after Gate 1 baseline and manifest checks."""
    manifest_path = manifest_path or WORKTREE_ROOT / "analysis" / "hlg_patch_manifest.json"
    manifest = load_manifest(manifest_path)
    in_bytes = input_path.read_bytes()
    is_container = in_bytes[:8] == MAGIC

    if input_path.resolve() == output_path.resolve():
        raise ValueError("Refusing to overwrite the input firmware")

    if is_container:
        print(f"Decoding firmware container: {input_path} ({len(in_bytes):,} bytes)")
        validate_container_identity(in_bytes, manifest)
        payload, frames, consumed = decode_container(in_bytes)
        verify_container(in_bytes, payload, consumed)
    else:
        print(f"Reading raw payload: {input_path} ({len(in_bytes):,} bytes)")
        payload = in_bytes

    if len(payload) != DECODED_PAYLOAD_BYTES:
        raise ValueError(f"Unexpected payload size: {len(payload)}")
    validate_baseline(payload, manifest, WORKTREE_ROOT)
    print(f"Gate 1 baseline validated with manifest: {manifest_path}")

    print("Applying BT.2100 HLG HDR Photo patches...")
    patched_payload = bytes(patch_payload(payload, target_tone_id))
    validate_patched_payload(payload, patched_payload, manifest)
    print(f"Patched payload word-sum: {word_sum(patched_payload):#010x} (MATCHES 0x0)")

    if is_container:
        print("Re-encoding into official RICOH LZSS firmware container...")
        changed_offsets = diff_offsets(payload, patched_payload)
        container_bytes, reemitted = rebuild_container(in_bytes, frames, consumed, patched_payload, changed_offsets)

        # Verification pass: decode back and compare
        print("Verifying re-encoded container integrity...")
        dec_test, _, used = decode_container(container_bytes)
        if dec_test != patched_payload:
            raise ValueError("Decoded test container mismatch with patched payload")
        verify_container(container_bytes, patched_payload, used)

        _atomic_write(output_path, container_bytes)
        print(f"Successfully generated custom firmware: {output_path}")
        print(f"  - Size: {len(container_bytes):,} bytes ({reemitted} frames re-emitted)")
        print(f"  - SHA-256: {sha256_hex(container_bytes)}")
    else:
        _atomic_write(output_path, patched_payload)
        print(f"Successfully generated custom payload: {output_path}")
        print(f"  - Size: {len(patched_payload):,} bytes")
        print(f"  - SHA-256: {sha256_hex(patched_payload)}")

    return 0


def main():
    parser = argparse.ArgumentParser(description="Ricoh GR IV v1.11 BT.2100 HLG Photo Firmware Patcher")
    parser.add_argument(
        "-i",
        "--input",
        help="Input official firmware container fwdc248b.bin or payload.bin",
        default=str(WORKTREE_ROOT.parent.parent / "firmware" / "official" / "v1.11" / "fwdc248b.bin"),
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Output custom firmware container fwdc248b.bin",
        default=str(WORKTREE_ROOT / "dist" / "fwdc248b_hlg.bin"),
    )
    parser.add_argument(
        "--target-tone-id",
        type=int,
        default=TARGET_TONE_ID,
        help="Target Image Control slot ID to transform (default: 19 = Cinema Green)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=WORKTREE_ROOT / "analysis" / "hlg_patch_manifest.json",
        help="Gate 1 machine-readable patch manifest",
    )
    args = parser.parse_args()

    in_path = Path(args.input)
    if not in_path.exists():
        # Fallback to unpacked payload if container not found
        unpacked_payload = WORKTREE_ROOT.parent.parent / "firmware" / "unpacked" / "v1.11" / "payload.bin"
        if unpacked_payload.exists():
            in_path = unpacked_payload
        else:
            print(f"Error: input firmware not found at {in_path}", file=sys.stderr)
            return 1

    out_path = Path(args.output)
    try:
        return patch_firmware(in_path, out_path, args.target_tone_id, args.manifest)
    except (ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
