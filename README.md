# Ricoh GR IV BT.2100 HLG HDR Photo Firmware Mod (`ricoh-gr4-hlg-mod`)

> **硬件实机测试状态：已验证通过 (PASS)**  
> 经真机刷写验证：机内取景预览、回放正常；通过手机 RICOH GR World App 导出至支持 HDR/EDR 的设备（如 iPhone）原生触发高动态范围显示；导出至普通 SDR 笔记本显示色彩正常且文件完整无损。

本项目为 **理光 Ricoh GR IV (Standard Edition / 中国大陆版 v1.11 `fwdc248b.bin`)** 的机内直出 **BT.2100 HLG HDR 照片** 固件修改项目。

---

## 🌟 核心特性与设计

1. **传感器级单张直出 HDR (Zero Shutter Lag)**：
   - 摆脱传统多帧连拍曝光合成的鬼影和快门延迟，单次快门直接输出 14-bit 感光动态范围经 ARIB STD-B67 对数曲线压缩的高动态 JPEG。
2. **槽位替换方案：替换“HDR色调”（Slot 22）**：
   - 替代原本的“HDR色调”图像控制风格（`toneId = 22 = 0x16`）。
   - **完全恢复 Cinema Green**（`toneId = 19`）：Q13 矩阵、Gamma 描述符、8 路多轴表及图标完全恢复官方原厂基线。
   - **保留原厂图标**：完全沿用原厂“HDR色调”图标，`06_ICONBIN.bin` 保持 **0 字节修改**。
   - **菜单更名为“HDR”**：全球 21 种语言菜单中的 Text ID 306 统一重定向到 UTF-16LE 描述符 `"HDR\0"`。
3. **机内自动 APP2 CICP ICC Profile 注入**：
   - 在 RTOS `ExifJpegWriter::SetupAppNInfo`（`0x5380bf50`）安全挂载 Hook。
   - 当检测到使用 Slot 22 时，自动在 JPEG 比特流头部组装 576 字节 32 字节对齐的 APP2 Marker，内嵌包含 `cicp` `[9, 18, 0, 1]` 标签的 ICC v4.4 Display Profile。
   - 遵循严格的 Ricoh DMA 32 字节对齐规范，修正 APP7 长度，确保主流平台（Apple iOS/macOS Photos EDR、Windows WIC/HDR、Android）原生识别。
4. **安全无侵入驻留**：
   - 所有 Hook 代码、ICC 数据、14-bit 曲线、Q13 矩阵、专用 Rec 结构体和文本描述符均放置在 RTOS Rodata 官方连续 17 KB 零填充区（`0x540db200`，仅占用 1456 字节）。
   - 32-bit Word Sum 校验和在 `0x54049394` 精准平衡，确保解包 Payload Word-Sum 严格等于 `0x00000000`，保证刷机零风险。

---

## 🔬 固件处理管线架构

```
[Raw Bayer Sensor 14-bit]
       │
       ▼
[Socionext Milbeaut Hardware ISP (05_RTOS.bin)]
       ├─► 1. 3×3 CCM: M_HLG_Q13 (Rec.709 -> Rec.2020 @ M_STD)
       ├─► 2. 1D LUT: 256-point 14-bit ARIB STD-B67 HLG with S^-1 pre-compensation
       └─► 3. Neutral Multi-Axis: Repointed to Standard neutral descriptor (0x54049de8)
       │
       ▼
[Hardware JPEG DMA Engine (05_RTOS.bin)]
       │
       ▼
[Hook: SetupAppNInfo @ 0x5380bf50 -> 0x540db200]
       ├─► Checks [r1, #0x79c] == 22 (HDR Mode)
       ├─► Fixes APP7 Screennail segment length in m_workArea
       └─► Injects 576-byte 32-byte-aligned APP2 ICC Profile with CICP [9, 18, 0, 1]
       │
       ▼
[Complete Out-of-Camera .JPG on SD Card]
       ├─► FFD8 (SOI) + FFE1 (Exif) + FFE7 (Screennail) + FFE2 (APP2 CICP ICC)
       └─► Scans & renders natively in HDR on Apple / Windows 11 / Android!
```

---

## 📁 仓库目录结构

```
.
├── analysis/                     # 静态逆向审计与补丁清单
│   ├── hlg_patch_manifest.json   # 27 项机器可读原子补丁清单（Gate 1 审计依据）
│   └── sim_verification_report.md# 双系统闭环仿真与固件差异回归报告
├── assets/                       # 固件校准生成的二进制表与资产
│   ├── icc/                      # 内嵌 BT.2100 HLG CICP [9, 18, 0, 1] ICC v4.4 Profile
│   └── isp_tables/               # Q13 CCM 矩阵与 14-bit 256 点 HLG 曲线
├── docs/                         # 详细技术设计文档
│   └── FEAT_HLG_PHOTO.md         # HLG 照片功能完整工程设计规范与逆向分析
├── src/                          # 核心算法与固件补丁器源码
│   └── hlg_photo/
│       ├── build_bt2100_hlg_icc.py       # 构建 ICC v4.4 CICP Display Profile
│       ├── generate_hlg_lut_and_ccm.py   # 生成 Q13 矩阵与 ARIB STD-B67 曲线
│       ├── patch_audit.py                # Gate 1 补丁清单前置校验器
│       └── patch_firmware_hlg.py         # 固件解压、补丁、校验和平衡与重打包
├── tests/                        # 单元测试与回归套件
│   └── test_hlg_photo.py         # 8 项全自动单元测试（矩阵、曲线、ICC、解包、还原性）
└── tools/                        # 逆向与固件容器工具链
    ├── fw_container.py           # 官方 LZSS 固件容器解包与重打包工具
    ├── verify_hlg_patch.py       # 独立 Gate 1 固件候选包校验工具
    ├── rtos_analyzer.py          # RTOS 静态分析与符号扫描工具
    └── linux_analyzer.py         # Linux RootFS 分析工具
```

---

## 🛠️ 构建与刷机指南

### 1. 环境准备

需要 Python 3.9+ 以及相关依赖：
```bash
pip install pillow pyyaml
```
*(可选)* 若需重新汇编 Hook 机器码，需安装 `arm-none-eabi-gcc`。

### 2. 准备官方固件

将理光官方 v1.11 固件 `fwdc248b.bin` 放置于：
```
firmware/official/v1.11/fwdc248b.bin
```
*(SHA-256: `a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f`)*

### 3. 一键生成修改固件

执行固件补丁程序：
```bash
python -m src.hlg_photo.patch_firmware_hlg
```

生成的候选固件位于：
```
dist/fwdc248b_hlg.bin
```
- **文件大小**：38,811,368 字节
- **容器 SHA-256**：`64c5fd3968fb45f4bd73d7c03861d44790638078e5f87034ebf6baf679bb4057`
- **Decoded Payload Word Sum**：`0x00000000` (MATCHES 0x0)

### 4. 自动化测试与审计验证

```bash
# 1. 运行 Gate 1 独立清单校验器（27 项补丁无偏差校验）
python tools/verify_hlg_patch.py --official "firmware/official/v1.11/fwdc248b.bin" --candidate "dist/fwdc248b_hlg.bin" --manifest "analysis/hlg_patch_manifest.json"

# 2. 运行完整功能与回归测试套件（8/8 PASS）
python -m unittest tests/test_hlg_photo.py
```

### 5. 刷机与使用

1. 将 `dist/fwdc248b_hlg.bin` 重命名为 `fwdc248b.bin`，并拷贝至 SD 卡根目录；
2. 相机关机状态下，按住 `Playback`（回放）键开机，屏幕显示固件升级确认界面；
3. 确认版本升级并等待进度条完成（约 1-2 分钟），完成后自动关机；
4. 开机进入菜单：
   - 检查原 **Cinema Green** 已完全恢复原有色彩与图标；
   - 原 **“HDR色调”** 风格槽位已显示为 **“HDR”**（沿用原厂图标）；
5. 选择 **“HDR”** 拍摄，将生成的 `.JPG` 文件导入 iPhone、Mac（Photos / Preview）或 Windows 11 HDR 显示器，即刻呈现震撼的宽动态范围 HDR 照片！

---

## ⚖️ 免责声明

本代码与固件修改补丁仅供摄影工程爱好者与逆向研究使用。修改相机固件存在理论上的意外风险，刷机前请确保电池电量充足（建议 50% 以上）。作者与贡献者不对任何因自行修改或刷机导致的硬件故障负责。
