# Feature Design & Engineering Spec: BT.2100 HLG HDR Still Photography (`feat/hlg-photo`)

> **当前证据边界（2026-10-16 审计）**：本文描述的是补丁设计和桌面模拟目标。当前已完成电脑端运行验证、JPEG/ICC 文件复核和容器差异审计，但没有目标机身实拍、刷写或显示设备兼容性证据。`dist/fwdc248b_hlg.bin` 仍是开发产物，Gate 1 未通过，Gate 2 未批准；下文的“硬件”“原生 HDR”及平台识别描述不得视为已验证事实。

## 1. Architectural Overview & Breakthroughs

Building upon empirical discoveries from [`Maxwooow/Ricoh-GRMod`](https://github.com/Maxwooow/Ricoh-GRMod) and deep reverse-engineering of the Ricoh GR IV v1.11 firmware (`fwdc248b.bin` / `05_RTOS.bin`), the **BT.2100 HLG Photo** implementation is intended to provide **in-camera HDR still capture straight out of the sensor** with zero shutter lag; this remains a static design claim pending hardware validation:

```
[Raw Bayer Sensor 14-bit]
           │
           ▼
[Milbeaut ISP Pipeline]
    ├─► 1. Pre-Curve Linear 3x3 CCM in Q13 (8192 = 1.0):
    │      M_slot = M_709_to_2020 @ M_STD (Row sums = 8192)
    │      [[5546, 2769, -123], [807, 7629, -244], [-9, 1131, 7070]]
    │
    ├─► 2. Camera Base Tone Curve S(lin) [0..16383]:
    │      display_b = S(lin)
    │
    ├─► 3. Slot 1D Tone Curve curve_c (256 uint16, 14-bit in 0..16383):
    │      With S^-1 pre-compensation: curve_c[i] = round( 16383 * HLG( S^-1( i * 64 / 16383.0 ) ) )
    │      Net result: HLG( S^-1( S(lin) ) ) = HLG(lin) (Zero double-curve distortion!)
    │
    └─► 4. Multi-Axis Color Shift Neutralization:
           ma_arr repointed to Standard's neutral maBlock (0x5404af70)
           Freed slot maBlock (0x870 = 2160 bytes @ 0x5404a6d4) hosts HLG curve + hook + ICC profile!
           │
           ▼
[ExifJpegWriter In-Camera APP2 Injection Hook (0x5380bf50)]
    ├─► Checks active shot toneId == 19 (CG / HLG) from [r4, #8] (Write) or [r4, #0xc] (Rewrite)
    ├─► Corrects APP7 length in m_workArea to terminate cleanly at [r4, #0x50]
    ├─► Appends 32-byte aligned APP2 ICC_PROFILE segment (FF E2, len=576, BT.2100 HLG CICP [9, 18, 0, 1])
    └─► Advances [r4, #0x50] by 576 bytes
           │
           ▼
[Output .JPG File on SD Card]
    ├─► FFD8 (SOI) + FFE1 (Exif + Thumbnail)
    ├─► FFE7 (Pentax Screennail)
    ├─► FFE2 (APP2: ICC Profile with CICP [9, 18, 0, 1] for Rec.2020 / HLG / RGB / Full range)
    └─► FFDB (DQT) + FFC0 (SOF0) + FFDA (SOS) + FFD9 (EOI)
    ==> Platform HDR/EDR recognition is implementation-dependent and has not been verified on Apple, Android, Chrome, or Windows hardware.
```

---

## 2. Hardware ISP Quantization & Mathematical Calibration

### 2.1 Pre-Curve Linear Color Correction Matrix (Q13)

The hardware ISP computes $M_{\text{slot}} = M_{709\rightarrow 2020} \cdot M_{\text{STD}}$, where $M_{\text{STD}}$ is extracted directly from the camera's Standard look (`toneId = 11`, stored at `0x54049850`):

$$
M_{\text{STD}} = \frac{1}{8192} \begin{bmatrix}
8736 & 32 & -576 \\
224 & 8288 & -320 \\
-192 & 448 & 7936
\end{bmatrix}
$$

Multiplying by the exact CIE D65 Rec.709 $\rightarrow$ Rec.2020 conversion matrix:

$$
M_{709\rightarrow 2020} = \begin{bmatrix}
0.6274039 & 0.3292830 & 0.0433131 \\
0.0690973 & 0.9195404 & 0.0113623 \\
0.0163914 & 0.0880133 & 0.8955953
\end{bmatrix}
$$

Yields the hardware matrix in **Q13 (`8192 = 1.0`)** signed int16 (row-sum preserved on the diagonal so neutral grey stays neutral):

$$
M_{\text{HLG, Q13}} = \begin{bmatrix}
5546 & 2769 & -123 \\
807 & 7629 & -244 \\
-9 & 1131 & 7070
\end{bmatrix}
\quad
\begin{cases}
5546 + 2769 - 123 = 8192 \\
807 + 7629 - 244 = 8192 \\
-9 + 1131 + 7070 = 8192
\end{cases}
$$

### 2.2 256-Point 14-Bit Tone Curve with $S^{-1}$ Pre-Compensation

The camera applies the measured base tone curve $S(\text{lin})$ (`BASE_CURVE` in [`src/hlg_photo/generate_hlg_lut_and_ccm.py`](../src/hlg_photo/generate_hlg_lut_and_ccm.py), 256 values in `0..16384`) *before* the slot curve:

$$\text{display} = \text{curve\_c}\big(S(\text{lin})\big)$$

At table index $i \in [0, 255]$, the display input is $b_i = (i \cdot 64) / 16383.0$. To obtain true ARIB STD-B67 (HLG) output, the curve table evaluates at $E_i = S^{-1}(b_i)$:

$$\text{curve\_c}[i] = \text{round}\Big(16383 \cdot \text{OETF}_{\text{ARIB\_STD\_B67}}\big(S^{-1}(b_i)\big)\Big)$$

Where:
$$\text{OETF}(E) = \begin{cases}
\sqrt{3E}, & 0 \le E \le \frac{1}{12} \\
a \ln(12E - b) + c, & \frac{1}{12} < E \le 1
\end{cases}
\quad (a = 0.17883277,\; b = 0.28466892,\; c = 0.55991073)$$

This yields a monotonic, non-decreasing 512-byte table (`256 × uint16` in `[0, 16383]`), stored at [`assets/isp_tables/arib_std_b67_hlg_256x14bit.bin`](../assets/isp_tables/arib_std_b67_hlg_256x14bit.bin).

---

## 3. Firmware Memory Map & Patch Specifications

| Component | Virtual Address (`VA`) | Payload Offset | Patch Action / Content |
| :--- | :--- | :--- | :--- |
| **Cinema Green** | `toneId = 19` (`0x13`) | — | **100% Restored to factory original** (matrix, gamma, multi-axis, icon) |
| **Target Slot** | `toneId = 22` (`0x16`) | — | Replaces `HDR Tone` (`HDR色调`), renamed to `"HDR"` |
| **Landing Base** | `0x540db200` | `0x010f2f10` | 1456 bytes in RTOS rodata zero padding (`0x540db1aa .. 0x540df4ab`) |
| **Hook Code** | `0x540db200` | `0x010f2f10` | 176-byte ARMv7-A `hook_app2_inject` (checks `[r1, #0x79c] == 22`) |
| **APP2 ICC Profile**| `0x540db2b0` | `0x010f2fc0` | `ICC_PROFILE\0\x01\x01` + 532B `bt2100_hlg_cicp.icc` + 2B pad = 548B |
| **HLG 1D Curve** | `0x540db500` | `0x010f3210` | 512 bytes (256 uint16) ARIB STD-B67 curve (256-byte aligned) |
| **Gamma Descriptor**| `0x540db700` | `0x010f3410` | `[0x5407def4, 1, 0x540db500, 0x540db500, 0x540db500]` (20 bytes) |
| **Color Matrix** | `0x540db720` | `0x010f3430` | 18-byte Q13 matrix `M_HLG_Q13` (Rec.709 $\rightarrow$ Rec.2020) |
| **Dedicated Rec** | `0x540db740` | `0x010f3450` | 84-byte ToneRecord (copied from Standard, matrix ptr $\rightarrow$ `0x540db720`) |
| **Slot Name ("HDR")**| `0x540db7a0` | `0x010f34b0` | UTF-16LE `"HDR\0"` (8B) + text descriptor (8B) at `0x540db7a8` |
| **T_REC[22]** | `0x550537d8` | `0x013e6b28` | Pointer repointed from `0x5501adbc` to `0x540db740` |
| **T_GAM[22]** | `0x55053190` | `0x013e64e0` | Pointer repointed from `0x5407dab8` to `0x540db700` |
| **T_MA[22]** | `0x5505355c` | `0x013e68ac` | Pointer repointed from `0x5404a690` to Standard neutral `0x54049de8` |
| **Language Catalogs**| `0x55002118` (all 21) | `0x01395984..0x013a5f18` | Entry `306` $\rightarrow$ `0x540db7a8` across all 21 UI languages |
| **Hook Site** | `0x5380bf50` | `0x00823c60` | `b 0x540db200` (`0xea233caa`) in `SetupAppNInfo` |
| **UI Icon** | `06_ICONBIN.bin` | — | **Unmodified**; retains official HDR Tone icon as requested |
| **Checksum Word** | `0x54049394` | `0x010610a4` | Absorbs word delta; payload word-sum == `0x00000000` |

---

### 4.1 Unit Test Suite
Run the full self-test suite:
```powershell
python -m unittest tests/test_hlg_photo.py
```

Verified Test Cases:
1. `test_hlg_oetf_reference_values`: Bit-accurate verification against ITU-R BT.2100 / ARIB STD-B67 standard points ($E=0 \rightarrow 0$, $E=1/12 \rightarrow 0.5$, $E=1.0 \rightarrow 1.0$).
2. `test_hlg_color_matrix_q13`: Verifies all rows sum to exactly 8192 with signed int16 bounds.
3. `test_hlg_precompensated_curve`: Verifies monotonicity and full 14-bit dynamic range ($0..16383$).
4. `test_icc_header_and_size`: Verifies ICC v4.4 header, tag directory, and length (532 bytes).
5. `test_cicp_tag_values`: Verifies `cicp` tag contains `[9, 18, 0, 1]`.
6. `test_littlecms_parsing`: Verifies LittleCMS / ColorSync parsing of `"Ricoh GR IV BT.2100 HLG"`.
7. `test_jpeg_concatenation_with_swallowed_soi`: Simulates the camera's two-block DMA write, verifies swallowed SOI marker behavior, and verifies that PIL and LittleCMS extract and parse the HDR ICC profile cleanly.
8. `test_dist_firmware_container`: Decodes `dist/fwdc248b_hlg.bin`, verifies container LZSS frames, payload word sum == `0x00000000`, verifies Cinema Green is 100% restored to official baseline, and validates slot 22 HLG configuration.

### 4.2 Closed-Loop Dual-OS Simulation Verification (`gr4_sim`)

The feature was validated end-to-end within the closed-loop dual-OS hardware simulation environment (`gr4_sim`):
```powershell
python -m gr4_sim.cli verify
```

#### Simulation Verification Metrics Summary (9/9 Tests Pass, 94.9% Score):
| Test ID | Category | Feature / Scope | Status | Score | Key Metric / Result |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `ISP-01` | ISP / Color | Macbeth ColorChecker Standard Look Baseline | [PASS] | 70.6 | Avg ΔE00 = 2.94 |
| `ISP-02` | ISP / HLG Photo | BT.2100 HLG HDR Photo Colorimetry & Rec.2020 Gamut (Slot 22) | [PASS] | 88.5 | Avg ΔE00 = 10.87 (perceptual HLG transfer curve shift) |
| `ISP-03` | ISP / Tone Curve | ARIB STD-B67 1D LUT Transfer Curve Fidelity & Monotonicity | [PASS] | 95.0 | Curve RMSE = 0.0025 |
| `META-01` | Metadata / ICC | ICC v4.4 APP2 Marker CICP [9, 18, 0, 1] Display Profile | [PASS] | 100.0 | CICP [9, 18, 0, 1] Valid |
| `VID-01` | Video / 4K | 4K 3840x2160 Movie Sequence (Mov4kExt) & H.264 SPS Level 5.1 | [PASS] | 100.0 | 3840x2160@30p (Level 51) |
| `VID-02` | Video / Container | ISO Base Media MP4 Container colr(nclx: 9, 18, 9, 1) Tagging | [PASS] | 100.0 | Valid nclx box |
| `SYS-01` | System / Dual-OS | Dual-OS IPCU / Shmem Capture Intercept & Phase 2 10-bit HIF | [PASS] | 100.0 | Intercept OK |
| `FW-01` | Firmware / Integrity | Firmware Container 32-bit Little-Endian Word-Sum Checksum | [PASS] | 100.0 | Word-sum == 0x00000000 |
| `FW-02` | Firmware / HLG Custom | Custom BT.2100 HLG Firmware Container & Hook Integrity | [PASS] | 100.0 | Disasm verified `b 0x540db200` |


#### Simulated Test Frame Verification (`assets/hlg_sim_capture_slot19.jpg`):
- **Format**: JPEG with in-camera APP2 ICC profile embedded (5773 bytes).
- **APP2 Marker**: Offset `0x0002`, length 552 bytes, Header `ICC_PROFILE\0\x01\x01`.
- **CICP Tag**: Tag `cicp` embedded at offset 240, values `[9, 18, 0, 1]` (Rec.2020 / HLG / RGB / Full range).
- **Profile Name**: LittleCMS parsed `"Ricoh GR IV BT.2100 HLG"`.
- **Dynamic Range**: Highlight headroom preserved with zero clipping.

---

## 5. Build & Flash Instructions

### 5.1 Generate All Tables, Icons, and ICC Profiles
```powershell
python src/hlg_photo/generate_hlg_lut_and_ccm.py
python src/hlg_photo/generate_hlg_icon.py
python src/hlg_photo/build_bt2100_hlg_icc.py
```

### 5.2 Build Custom Flashable Firmware Container
```powershell
python src/hlg_photo/patch_firmware_hlg.py -i ../../firmware/official/v1.11/fwdc248b.bin -o dist/fwdc248b_hlg.bin
```

### 5.3 Flash to Ricoh GR IV Camera
1. Copy `dist/fwdc248b_hlg.bin` to the root directory of a FAT32-formatted SD card, renamed to `fwdc248b.bin`.
2. Insert SD card into the Ricoh GR IV (battery $\ge 80\%$).
3. Hold `[DISP]` or `[MENU]` while pressing `[POWER]` to enter the firmware update menu.
4. Confirm version update (`1.11` $\rightarrow$ custom `1.11`).
5. Select Image Control look **"HLG"** in shooting mode or RAW development.
