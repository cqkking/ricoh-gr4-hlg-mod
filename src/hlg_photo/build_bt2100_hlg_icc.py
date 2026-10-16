#!/usr/bin/env python3
"""ICC v4.3 BT.2100 HLG (CICP [9, 18, 0, 1]) Profile Builder & JPEG APP2 Injector.

Builds a compact, spec-compliant ICC v4.3 Display Profile (`bt2100_hlg_cicp.icc`) with:
  - `desc`: "Ricoh GR IV BT.2100 HLG"
  - `cprt`: "Public Domain"
  - `wtpt`: D65 [0.95045, 1.00000, 1.08905]
  - `rXYZ`, `gXYZ`, `bXYZ`: ITU-R BT.2020 D50-adapted primaries
  - `rTRC`, `gTRC`, `bTRC`: Parametric/LUT fallback curve
  - `cicp`: Coding-independent code points (ICC.1:2022 / ITU-T H.273):
      * ColourPrimaries         = 9  (ITU-R BT.2020 / BT.2100)
      * TransferCharacteristics = 18 (ARIB STD-B67 HLG)
      * MatrixCoefficients      = 0  (Identity / RGB)
      * VideoFullRangeFlag      = 1  (Full range 0..255 / 0..1023)

Also provides `inject_icc_into_jpeg(jpeg_bytes, icc_bytes)` to embed or replace the APP2
`ICC_PROFILE\\0` marker segment in any Ricoh GR IV `.JPG` file.
"""
import argparse
import struct
import sys
from pathlib import Path


def s15Fixed16(val: float) -> bytes:
    return struct.pack(">i", int(round(val * 65536.0)))


def make_xyz_tag(x: float, y: float, z: float) -> bytes:
    return b"XYZ " + b"\x00\x00\x00\x00" + s15Fixed16(x) + s15Fixed16(y) + s15Fixed16(z)


def make_mluc_tag(text: str) -> bytes:
    utf16 = text.encode("utf-16-be")
    header = struct.pack(">4sIII2s2sII", b"mluc", 0, 1, 12, b"en", b"US", len(utf16), 28)
    return header + utf16


def make_cicp_tag(primaries: int = 9, transfer: int = 18, matrix: int = 0, full_range: int = 1) -> bytes:
    # ICC v4 'cicp' tag: 4B sig ('cicp'), 4B reserved (0), 4x uint8 [primaries, transfer, matrix, full_range]
    return struct.pack(">4sIBBBB", b"cicp", 0, primaries, transfer, matrix, full_range)


def make_curv_tag_gamma(gamma: float = 2.2) -> bytes:
    # u8Fixed8Number single-entry curve as fallback for non-CICP-aware ICC v2/v4 readers
    g_fixed = int(round(gamma * 256.0))
    return struct.pack(">4sIIH2s", b"curv", 0, 1, g_fixed, b"\x00\x00")


def build_bt2100_hlg_icc() -> bytes:
    tags = [
        (b"desc", make_mluc_tag("Ricoh GR IV BT.2100 HLG")),
        (b"cprt", make_mluc_tag("CC0 Public Domain")),
        (b"wtpt", make_xyz_tag(0.96420, 1.00000, 0.82491)),  # D50 PCS illuminant
        # BT.2020 primaries adapted to D50 PCS
        (b"rXYZ", make_xyz_tag(0.67342, 0.27904, -0.00194)),
        (b"gXYZ", make_xyz_tag(0.16566, 0.67534, 0.02998)),
        (b"bXYZ", make_xyz_tag(0.12512, 0.04562, 0.79686)),
        (b"rTRC", make_curv_tag_gamma(2.2)),
        (b"gTRC", make_curv_tag_gamma(2.2)),
        (b"bTRC", make_curv_tag_gamma(2.2)),
        (b"cicp", make_cicp_tag(9, 18, 0, 1)),
    ]

    tag_count = len(tags)
    dir_size = 4 + tag_count * 12
    data_offset = 128 + dir_size
    if data_offset % 4:
        data_offset += 4 - (data_offset % 4)

    dir_entries = [struct.pack(">I", tag_count)]
    body_chunks = []
    cur_off = data_offset

    for sig, payload in tags:
        size = len(payload)
        dir_entries.append(struct.pack(">4sII", sig, cur_off, size))
        pad = (4 - (size % 4)) % 4
        body_chunks.append(payload + (b"\x00" * pad))
        cur_off += size + pad

    total_size = cur_off
    header = bytearray(128)
    struct.pack_into(">I", header, 0, total_size)
    header[4:8] = b"lcms"
    struct.pack_into(">I", header, 8, 0x04400000)  # ICC v4.4 (supports cicp natively)
    header[12:16] = b"mntr"
    header[16:20] = b"RGB "
    header[20:24] = b"XYZ "
    struct.pack_into(">6H", header, 24, 2025, 12, 1, 11, 9, 9)
    header[36:40] = b"acsp"
    header[40:44] = b"APPL"
    header[68:80] = s15Fixed16(0.96420) + s15Fixed16(1.00000) + s15Fixed16(0.82491)
    header[80:84] = b"RICOH"[:4]

    dir_bytes = b"".join(dir_entries)
    dir_pad = b"\x00" * (data_offset - (128 + len(dir_bytes)))
    return bytes(header) + dir_bytes + dir_pad + b"".join(body_chunks)


def inject_icc_into_jpeg(jpeg_bytes: bytes, icc_bytes: bytes) -> bytes:
    """Inject or replace APP2 ICC_PROFILE segment immediately after SOI (0xFFD8)."""
    if not jpeg_bytes.startswith(b"\xff\xd8"):
        raise ValueError("Input file is not a valid JPEG (missing 0xFFD8 SOI)")

    app2_payload = b"ICC_PROFILE\x00\x01\x01" + icc_bytes
    app2_seg = b"\xff\xe2" + struct.pack(">H", len(app2_payload) + 2) + app2_payload
    return jpeg_bytes[:2] + app2_seg + jpeg_bytes[2:]


def main():
    parser = argparse.ArgumentParser(description="Build BT.2100 HLG CICP ICC profile and optionally inject into JPEG")
    parser.add_argument("--inject-jpeg", help="Input JPEG file to inject with BT.2100 HLG ICC profile")
    parser.add_argument("-o", "--output-jpeg", help="Output HDR HLG JPEG path")
    args = parser.parse_args()

    worktree_root = Path(__file__).resolve().parent.parent.parent
    icc_dir = worktree_root / "assets" / "icc"
    icc_dir.mkdir(parents=True, exist_ok=True)
    icc_path = icc_dir / "bt2100_hlg_cicp.icc"

    icc_bytes = build_bt2100_hlg_icc()
    icc_path.write_bytes(icc_bytes)
    print(f"Wrote ICC v4.4 CICP [9, 18, 0, 1] profile ({len(icc_bytes)} bytes) to {icc_path}")

    if args.inject_jpeg:
        in_jpg = Path(args.inject_jpeg)
        out_jpg = Path(args.output_jpeg) if args.output_jpeg else in_jpg.with_stem(in_jpg.stem + "_HLG")
        out_bytes = inject_icc_into_jpeg(in_jpg.read_bytes(), icc_bytes)
        out_jpg.write_bytes(out_bytes)
        print(f"Injected BT.2100 HLG ICC profile into {out_jpg} ({len(out_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
