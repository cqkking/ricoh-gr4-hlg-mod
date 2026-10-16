#!/usr/bin/env python3
"""Ricoh GR IV (v1.11 fwdc248b.bin) BT.2100 HLG HDR Photo Firmware Patcher.

Applies the verified empirical ISP calibration and in-camera APP2 ICC injection hook
to the Ricoh GR IV Standard Edition (China Mainland sales version) v1.11 firmware:
  1. In-Place Slot Transformation (Target: Cinema Green, toneId = 0x13 = 19):
     - Q13 Color Matrix (rec->matrix = 0x5404952c): Linear Rec.709 -> Rec.2020 @ M_STD
     - Gamma Descriptor (gam = 0x5407decc): desc[5] = 0 (bypasses Cinema toning override)
     - 14-bit Tone Curve (0x5404a9b0): 256 uint16 entries ARIB STD-B67 HLG with S^-1 pre-compensation
     - Multi-Axis Table (ma_arr = 0x5501b814): 8 pointers repointed to Standard's neutral maBlock (0x5404af70)
     - UI Name (Text ID 303 across all 21 languages): renamed to "HLG"
     - UI Icon (Icon ID 25 in 06_ICONBIN.bin at payload 0x03023af0): updated to 40x40 RGBA "HLG" badge
  2. In-Camera Automatic APP2 CICP ICC Profile Injection:
     - Hooks ExifJpegWriter::SetupAppNInfo at 0x5380bf50 (branching to 0x5404a6d4)
     - Fixes APP7 length in m_workArea to terminate cleanly at [r4, #0x50]
     - Appends 32-byte aligned APP2 ICC_PROFILE segment (FF E2, len=576, BT.2100 HLG CICP [9, 18, 0, 1])
     - Advances [r4, #0x50] by 576 bytes so every .JPG shot in HLG mode is an HDR HLG photo straight out of camera!
  3. Word-Sum Checksum Compensation:
     - Absorbs word delta at COMP_VA = 0x54049394 (payload 0x10610a4) so payload word-sum == 0.
  4. Packaging:
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

# Target slot: Cinema Green (toneId = 19 = 0x13)
TARGET_TONE_ID = 19
TARGET_TEXT_ID = 303
TARGET_ICON_ID = 25

# Offsets and addresses in GR IV v1.11
COMP_VA = 0x54049394
COMP_PAYLOAD_OFF = RTOS_PAYLOAD_OFFSET + (COMP_VA - RTOS_BASE)  # 0x10610a4

# Freed rodata block from CG's unused maBlock
FREED_RODATA_VA = 0x5404A6D4
FREED_RODATA_LEN = 0x870  # 2160 bytes

# Sub-allocations inside FREED_RODATA_VA
HOOK_CODE_VA = FREED_RODATA_VA               # 0x5404a6d4 (176 bytes)
APP2_PAYLOAD_VA = FREED_RODATA_VA + 0xB0     # 0x5404a784 (14B header + 2B pad + 532B ICC = 548B)
HLG_CURVE_VA = FREED_RODATA_VA + 0x2DC       # 0x5404a9b0 (512 bytes, 16-byte aligned)
HLG_TEXT_VA = FREED_RODATA_VA + 0x4DC        # 0x5404abb0 (8B UTF-16LE + 8B descriptor = 16B)

# Standard neutral pointers
STD_MA_BLOCK_VA = 0x5404AF70
CG_MA_ARRAY_VA = 0x5501B814
CG_MATRIX_VA = 0x5404952C
CG_GAM_DESC_VA = 0x5407DECC
NATIVE_TEXT_ROOTS = 0x55002118
ICONBIN_START = 0x02E93AF0
ICON_25_PAYLOAD_OFF = ICONBIN_START + 0x190000  # 0x03023af0 (6400 bytes)

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
    icon_dir = WORKTREE_ROOT / "assets" / "icons"

    matrix_bytes = (tables_dir / "ccm_rec709_to_rec2020_q13.bin").read_bytes()
    curve_bytes = (tables_dir / "arib_std_b67_hlg_256x14bit.bin").read_bytes()
    icc_bytes = (icc_dir / "bt2100_hlg_cicp.icc").read_bytes()
    icon_bytes = (icon_dir / "hlg_slot_icon_40x40.bin").read_bytes()

    assert len(matrix_bytes) == 18, f"Invalid matrix size: {len(matrix_bytes)}"
    assert len(curve_bytes) == 512, f"Invalid curve size: {len(curve_bytes)}"
    assert len(icc_bytes) == 532, f"Invalid ICC size: {len(icc_bytes)}"
    assert len(icon_bytes) == 6400, f"Invalid icon size: {len(icon_bytes)}"

    # 2. Patch Q13 Color Matrix at CG_MATRIX_VA
    mat_off = foff(CG_MATRIX_VA)
    p[mat_off : mat_off + 18] = matrix_bytes

    # 3. Patch Gamma Descriptor at CG_GAM_DESC_VA
    # desc[4]=1, desc[5]=0 (bypasses Cinema toning override so HLG curve applies directly)
    # desc[8..11] = R curve, desc[12..15] = G curve, desc[16..19] = B curve
    gam_off = foff(CG_GAM_DESC_VA)
    p[gam_off + 4] = 1
    p[gam_off + 5] = 0
    struct.pack_into("<III", p, gam_off + 8, HLG_CURVE_VA, HLG_CURVE_VA, HLG_CURVE_VA)

    # 4. Patch Multi-Axis Array at CG_MA_ARRAY_VA
    # Repoint all 8 multi-axis block pointers to Standard's neutral maBlock (0x5404af70)
    ma_off = foff(CG_MA_ARRAY_VA)
    for i in range(8):
        struct.pack_into("<I", p, ma_off + i * 4, STD_MA_BLOCK_VA)

    # 5. Populate Freed Rodata at FREED_RODATA_VA (0x5404a6d4)
    # Clear entire 0x870 bytes first
    rodata_off = foff(FREED_RODATA_VA)
    p[rodata_off : rodata_off + FREED_RODATA_LEN] = b"\x00" * FREED_RODATA_LEN

    # 5a. Assemble and place APP2 injection hook code
    hook_code = assemble_hook(target_tone_id)
    assert len(hook_code) <= (APP2_PAYLOAD_VA - HOOK_CODE_VA), f"Hook code too large: {len(hook_code)}"
    p[rodata_off : rodata_off + len(hook_code)] = hook_code

    # 5b. Place APP2 header and ICC profile at APP2_PAYLOAD_VA
    # Correct layout: exactly 14 bytes header, followed immediately by 532 bytes ICC, then 2 bytes trailing zero pad
    app2_hdr = b"ICC_PROFILE\x00\x01\x01"  # Exactly 14 bytes (NO PADDING BETWEEN HEADER AND ICC!)
    app2_data = app2_hdr + icc_bytes + b"\x00\x00"  # 14 + 532 + 2 = 548 bytes (137 words)
    assert len(app2_data) == 548
    app2_off = foff(APP2_PAYLOAD_VA)
    p[app2_off : app2_off + len(app2_data)] = app2_data

    # 5c. Place 256-point 14-bit HLG Tone Curve at HLG_CURVE_VA
    curve_off = foff(HLG_CURVE_VA)
    p[curve_off : curve_off + len(curve_bytes)] = curve_bytes

    # 5d. Place UTF-16LE "HLG" string and text descriptor at HLG_TEXT_VA
    hlg_str = "HLG\x00".encode("utf-16-le")  # 8 bytes
    hlg_text_desc = struct.pack("<BBHI", len("HLG") + 1, 1, 0, HLG_TEXT_VA)  # 8 bytes
    text_off = foff(HLG_TEXT_VA)
    p[text_off : text_off + 8] = hlg_str
    p[text_off + 8 : text_off + 16] = hlg_text_desc

    # 6. Hook ExifJpegWriter::SetupAppNInfo at HOOK_SITE_VA (0x5380bf50)
    # Replace sub sp, fp, #0x14 with b HOOK_CODE_VA
    disp = (HOOK_CODE_VA - (HOOK_SITE_VA + 8)) >> 2
    hook_insn = 0xEA000000 | (disp & 0x00FFFFFF)
    hook_site_off = foff(HOOK_SITE_VA)
    struct.pack_into("<I", p, hook_site_off, hook_insn)

    # 7. Update Text Catalog across all 21 languages to name slot "HLG"
    desc_va = HLG_TEXT_VA + 8
    for lang_idx in range(21):
        row_va = struct.unpack_from("<I", p, foff(NATIVE_TEXT_ROOTS + lang_idx * 4))[0]
        entry_off = foff(row_va + TARGET_TEXT_ID * 4)
        struct.pack_into("<I", p, entry_off, desc_va)

    # 8. Update Icon 25 in 06_ICONBIN.bin with 40x40 RGBA "HLG" badge
    p[ICON_25_PAYLOAD_OFF : ICON_25_PAYLOAD_OFF + len(icon_bytes)] = icon_bytes

    # 9. Dual 32-bit Word Sum Checksum Compensation
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
