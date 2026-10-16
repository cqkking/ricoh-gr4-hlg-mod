#!/usr/bin/env python3
"""Ricoh GR IV (v1.11) BT.2100 HLG Photo Verification & Test Suite.

Runs comprehensive unit and integration tests on:
  1. Mathematical ISP calibration: Q13 CCM row sums, 14-bit tone curve monotonicity.
  2. ICC v4.4 CICP profile structure and LittleCMS compatibility.
  3. In-camera APP2 ICC profile injection into JPEG bitstream.
  4. Patched firmware payload and re-encoded container integrity.
"""
import io
import struct
import unittest
from pathlib import Path
from PIL import Image, ImageCms

WORKTREE_ROOT = Path(__file__).resolve().parent.parent
from src.hlg_photo.build_bt2100_hlg_icc import build_bt2100_hlg_icc
from src.hlg_photo.generate_hlg_lut_and_ccm import (
    BaseToneCurve,
    generate_precompensated_hlg_curve,
    compute_hlg_matrix,
    arib_std_b67_oetf,
    foff,
)
from tools.fw_container import (
    decode_container,
    verify_container,
    word_sum,
    DECODED_PAYLOAD_BYTES,
)


class TestHlgIspCalibration(unittest.TestCase):
    def test_hlg_oetf_reference_values(self):
        # ARIB STD-B67 reference test points
        self.assertAlmostEqual(arib_std_b67_oetf(0.0), 0.0, places=5)
        # At boundary E = 1/12: sqrt(3 * 1/12) = sqrt(0.25) = 0.5
        self.assertAlmostEqual(arib_std_b67_oetf(1.0 / 12.0), 0.5, places=5)
        # At nominal diffuse white 1.0: should be 1.0
        self.assertAlmostEqual(arib_std_b67_oetf(1.0), 1.0, places=4)

    def test_hlg_color_matrix_q13(self):
        m_std = [8736, 32, -576, 224, 8288, -320, -192, 448, 7936]
        m_hlg = compute_hlg_matrix(m_std)
        self.assertEqual(len(m_hlg), 3)
        for r in range(3):
            self.assertEqual(len(m_hlg[r]), 3)
            # Row sum MUST equal 8192 (Q13 1.0)
            self.assertEqual(sum(m_hlg[r]), 8192, f"Row {r} sum is {sum(m_hlg[r])}, expected 8192")
            for val in m_hlg[r]:
                self.assertGreaterEqual(val, -32768)
                self.assertLessEqual(val, 32767)

    def test_hlg_precompensated_curve(self):
        base_curve = BaseToneCurve()
        curve = generate_precompensated_hlg_curve(base_curve, headroom=1.0)
        self.assertEqual(len(curve), 256)
        self.assertEqual(curve[0], 0)
        self.assertGreaterEqual(curve[-1], 16000)
        self.assertLessEqual(curve[-1], 16383)
        # Monotonically non-decreasing
        for i in range(len(curve) - 1):
            self.assertLessEqual(
                curve[i],
                curve[i + 1],
                f"Curve decreases at index {i}: {curve[i]} > {curve[i+1]}",
            )


class TestHlgIccProfile(unittest.TestCase):
    def setUp(self):
        self.icc = build_bt2100_hlg_icc()

    def test_icc_header_and_size(self):
        self.assertEqual(len(self.icc), 532)
        total_size = struct.unpack(">I", self.icc[:4])[0]
        self.assertEqual(total_size, 532)
        self.assertEqual(self.icc[36:40], b"acsp")
        self.assertEqual(self.icc[16:20], b"RGB ")
        self.assertEqual(self.icc[20:24], b"XYZ ")

    def test_cicp_tag_values(self):
        # Tag directory starts at 128
        tag_count = struct.unpack(">I", self.icc[128:132])[0]
        cicp_entry = None
        for i in range(tag_count):
            sig, off, sz = struct.unpack(">4sII", self.icc[132 + i * 12 : 132 + (i + 1) * 12])
            if sig == b"cicp":
                cicp_entry = (off, sz)
                break
        self.assertIsNotNone(cicp_entry, "Missing 'cicp' tag in ICC profile")
        off, sz = cicp_entry
        self.assertEqual(sz, 12)
        cicp_data = self.icc[off : off + sz]
        sig, reserved, p, t, m, f = struct.unpack(">4sIBBBB", cicp_data)
        self.assertEqual(sig, b"cicp")
        self.assertEqual(p, 9)   # ITU-R BT.2020 / BT.2100
        self.assertEqual(t, 18)  # ARIB STD-B67 (HLG)
        self.assertEqual(m, 0)   # Identity / RGB
        self.assertEqual(f, 1)   # Full range

    def test_littlecms_parsing(self):
        desc = ImageCms.getProfileDescription(io.BytesIO(self.icc))
        self.assertEqual(desc.strip(), "Ricoh GR IV BT.2100 HLG")


class TestInCameraApp2Injection(unittest.TestCase):
    def test_jpeg_concatenation_with_swallowed_soi(self):
        # 1. Create dummy MainImage JPEG bitstream starting with FFD8 FFDB ...
        img = Image.new("RGB", (32, 32), color=(200, 100, 50))
        bio = io.BytesIO()
        img.save(bio, format="JPEG")
        raw_main_image = bio.getvalue()
        self.assertTrue(raw_main_image.startswith(b"\xff\xd8\xff"))

        # 2. Build Block 0: SOI + APP1 + APP7 + APP2
        soi = b"\xff\xd8"
        app1_data = b"Exif\x00\x00" + b"\x00" * 22
        app1 = b"\xff\xe1" + struct.pack(">H", len(app1_data) + 2) + app1_data
        pad1 = (32 - (len(soi) + len(app1)) % 32) % 32
        hdr_part1 = soi + app1 + b"\xff" * pad1

        # APP7 segment
        app7_payload = b"Pentax\x00" + b"\x00" * 20
        app7_len = 32
        app7 = b"\xff\xe7" + struct.pack(">H", app7_len - 2) + app7_payload
        pad7 = (32 - (len(hdr_part1) + len(app7)) % 32) % 32
        hdr_part2 = hdr_part1 + app7 + b"\xff" * pad7

        # Injected APP2 segment (len=576 = 0x240, 32-byte aligned)
        icc = build_bt2100_hlg_icc()
        app2_payload = b"ICC_PROFILE\x00\x01\x01" + icc  # 14 + 532 = 546
        app2_len = 576
        pad2 = app2_len - 2 - len(app2_payload) - 2  # subtract 2 bytes for swallowed FFD8
        app2 = b"\xff\xe2" + struct.pack(">H", app2_len) + app2_payload + (b"\xff" * pad2)

        block0 = hdr_part2 + app2
        self.assertEqual(len(block0) % 32, 0, "Block 0 must be 32-byte aligned for Ricoh DMA")

        # 3. Simulate camera file write: Block 0 + raw_main_image
        # (swallowed FFD8 of MainImage becomes the last 2 bytes of APP2 payload)
        simulated_jpeg = block0 + raw_main_image

        # 4. Parse with PIL
        pil_img = Image.open(io.BytesIO(simulated_jpeg))
        self.assertEqual(pil_img.format, "JPEG")
        self.assertEqual(pil_img.size, (32, 32))

        # 5. Verify embedded ICC profile is found and parsed by LittleCMS
        embedded_icc = pil_img.info.get("icc_profile")
        self.assertIsNotNone(embedded_icc, "Embedded ICC profile not detected by PIL")
        desc = ImageCms.getProfileDescription(io.BytesIO(embedded_icc))
        self.assertEqual(desc.strip(), "Ricoh GR IV BT.2100 HLG")


class TestCustomFirmwareContainer(unittest.TestCase):
    def test_dist_firmware_container(self):
        dist_fw = WORKTREE_ROOT / "dist" / "fwdc248b_hlg.bin"
        if not dist_fw.exists():
            self.skipTest(f"Custom firmware container not generated yet at {dist_fw}")

        data = dist_fw.read_bytes()
        self.assertTrue(data.startswith(b"RICOH\x00\x00\x00"))

        payload, frames, consumed = decode_container(data)
        self.assertEqual(len(payload), DECODED_PAYLOAD_BYTES)
        verify_container(data, payload, consumed)

        # Word-sum of payload MUST equal 0
        self.assertEqual(word_sum(payload), 0, "Patched payload word-sum must be exactly 0")


        # 1. Verify Cinema Green (Slot 19) is 100% restored to official factory baseline
        # Check factory Q13 Matrix at 0x5404952c (CG)
        cg_mat_off = foff(0x5404952C)
        cg_mat_vals = struct.unpack_from("<9h", payload, cg_mat_off)
        expected_cg_mat = (5536, 2464, 192, 192, 6496, 1504, -64, 2112, 6144)
        self.assertEqual(cg_mat_vals, expected_cg_mat, "Cinema Green Q13 matrix must be restored to factory original")

        # Check factory Gamma Descriptor at 0x5407decc (CG)
        cg_gam_off = foff(0x5407DECC)
        self.assertEqual(payload[cg_gam_off + 4], 1)
        self.assertEqual(payload[cg_gam_off + 5], 1, "Cinema Green desc[5] must be restored to factory 1")
        cg_rc, cg_gc, cg_bc = struct.unpack_from("<III", payload, cg_gam_off + 8)
        self.assertEqual((cg_rc, cg_gc, cg_bc), (0x5407F6B4, 0x5407EEB4, 0x5407D6B8))

        # Check factory Multi-Axis Array at 0x5501b814 (CG)
        cg_ma_off = foff(0x5501B814)
        cg_ma_blocks = struct.unpack_from("<8I", payload, cg_ma_off)
        self.assertEqual(cg_ma_blocks, (0x5404A6D4,) * 8, "Cinema Green multi-axis blocks must point to 0x5404A6D4")

        # 2. Verify Slot 22 (HDR Tone) is transformed into BT.2100 HLG HDR Still
        # Check T_REC[22] -> HLG_REC_VA (0x540db740)
        t_rec_off = foff(0x55053780 + 22 * 4)
        rec_va = struct.unpack_from("<I", payload, t_rec_off)[0]
        self.assertEqual(rec_va, 0x540DB740)
        mat_va = struct.unpack_from("<I", payload, foff(rec_va + 4))[0]
        self.assertEqual(mat_va, 0x540DB720)
        mat_vals = struct.unpack_from("<9h", payload, foff(mat_va))
        expected_hlg_mat = (5546, 2769, -123, 807, 7629, -244, -9, 1131, 7070)
        self.assertEqual(mat_vals, expected_hlg_mat, "Q13 matrix in HLG rec does not match expected values")

        # Check T_GAM[22] -> HLG_GAM_DESC_VA (0x540db700)
        t_gam_off = foff(0x55053138 + 22 * 4)
        gam_va = struct.unpack_from("<I", payload, t_gam_off)[0]
        self.assertEqual(gam_va, 0x540DB700)
        gam_off = foff(gam_va)
        self.assertEqual(payload[gam_off + 4], 1)
        self.assertEqual(payload[gam_off + 5], 0, "desc[5] must be 0 to bypass Cinema Toning override")
        r_c, g_c, b_c = struct.unpack_from("<III", payload, gam_off + 8)
        self.assertEqual((r_c, g_c, b_c), (0x540DB500, 0x540DB500, 0x540DB500))

        # Check T_MA[22] -> STD_MA_DESC_VA (0x54049de8)
        t_ma_off = foff(0x55053504 + 22 * 4)
        ma_va = struct.unpack_from("<I", payload, t_ma_off)[0]
        self.assertEqual(ma_va, 0x54049DE8, "T_MA[22] must point to Standard neutral multi-axis table")

        # Check hook instruction at 0x5380bf50: b 0x540db200
        hook_off = foff(0x5380BF50)
        hook_word = struct.unpack_from("<I", payload, hook_off)[0]
        expected_insn = 0xEA233CAA
        self.assertEqual(hook_word, expected_insn, f"Hook instruction {hook_word:#010x} != {expected_insn:#010x}")

        # Check UI Text ID 306 across 21 languages: points to descriptor for "HDR"
        for lang_idx in range(21):
            row_va = struct.unpack_from("<I", payload, foff(0x55002118 + lang_idx * 4))[0]
            desc_va = struct.unpack_from("<I", payload, foff(row_va + 306 * 4))[0]
            self.assertEqual(desc_va, 0x540DB7A8, f"Lang {lang_idx} Text 306 descriptor mismatch")



if __name__ == "__main__":
    unittest.main()
