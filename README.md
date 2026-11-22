# Ricoh GR IV BT.2100 HLG HDR Photo Firmware Mod (`ricoh-gr4-hlg-mod`)

本项目为 **理光 Ricoh GR IV (`fwdc248b.bin`)** 的机内直出 **BT.2100 HLG HDR 照片** 固件修改项目，当前提供两条版本支持路径：

- **Ricoh GR IV v1.21（推荐）**：独立后置补丁工具 + 双模式 Windows 一键批处理（[GR4_v121_HLG_Patcher.bat](./GR4_v121_HLG_Patcher.bat) / [GR4_v121_HLG_Patcher_Classic.bat](./GR4_v121_HLG_Patcher_Classic.bat)），同时支持 **官方原版 v1.21** 与 **GRMod（0.8.15 / 0.8.16 / 后续版本）已构建的 v1.21 定制固件**。
  > **v1.21 验证状态**：
  > - 已完成 v1.21 `SetupAppNInfo` 调用点返回地址极性修复（`Write` `lr & 0x200` 与 v1.11/v1.20 反转），实机测试 Slot 22 `"HDR"`、Level 0 `OFF` 滑块及 APP2 BT.2100 HLG CICP 注入均正常触发。
  > - 提供 **`calibrated`（BT.2408 校准标准 HLG 版）** 与 **`classic`（经典 v1.11/v1.20 同款观感版）** 两种模式，均已通过 **9/9 容器与校验和自检**、`tools/fw_container.py info`（`Container : VALID`）、交叉模式防误刷检查及 Capstone 反汇编/表项检查。
- **Ricoh GR IV v1.11（历史基线 / Python 工具链）**：基于 v1.11 官方原版的完整 Python 构建、仿真与审计工具链。
  > **v1.11 硬件实机测试状态：已验证通过 (PASS)**  
  > 经真机刷写验证：机内取景预览、回放正常；通过手机 RICOH GR World App 导出至支持 HDR/EDR 的设备（如 iPhone）原生触发高动态范围显示；导出至普通 SDR 笔记本显示色彩正常且文件完整无损。

---

## 🚀 快速开始：GR IV v1.21 一键补丁（推荐）

无需绑定特定 GRMod 版本或自己配置编译环境。你可以先用最新官方原版或任意版本 **GRMod** 自由启用你所需的所有功能生成 `fwdc248b.bin`，再用本工具作为**后置步骤（Post-Patcher）**一键注入 BT.2100 HLG Photo 功能。

### 1. 适用范围与环境依赖

- **支持固件**：
  - 理光官方 **GR IV v1.21** 原版固件 `fwdc248b.bin`（已验证基线，容器内 `RTOS` 偏移 `0x17d28`、长 `0x140ce00`）
  - 经 **GRMod（0.8.15 / 0.8.16 / 后续版本）** 导出的任意 v1.21 固件（无论是否启用了 XPAN 65:24、额外胶片模拟槽位、柔焦/Halation、时间戳、黑白预设解锁、直闪模式、HDR Gain Map、曝光预览、8 ADJ 槽位等）
- **前置依赖**：仅需 **Node.js v18+**（[GR4_v121_HLG_Patcher.bat](./GR4_v121_HLG_Patcher.bat) 调用的 [gr4_v121_hlg_patcher.mjs](./tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs) 为零依赖独立 ESM 包，无需 `npm install` 或 Python）。

### 2. 双模式 Windows 一键批处理（拖拽 / 双击）

针对不同用户的观感偏好，提供两个一键批处理入口（均可直接把 v1.21 `fwdc248b.bin` 拖到脚本上，或双击在文件窗口中选择）：

| 批处理脚本 | 模式 (`--mode`) | 输出路径 | 机内特性与成片观感 |
| :--- | :--- | :--- | :--- |
| **[GR4_v121_HLG_Patcher.bat](./GR4_v121_HLG_Patcher.bat)** *(推荐)* | `calibrated` | `output\fwdc248b.bin` | **BT.2408 校准标准 HLG 版**：真实 Rec.2020 Q13 矩阵 + 按 BT.2408 重新校准的 14-bit HLG LUT（暗部黑位与中灰对齐原厂 Standard，高光平滑延伸至 HDR 峰值）+ 原厂中性 `T_MA[22]`（`0x54082b38`）+ APP2 CICP ICC。 |
| **[GR4_v121_HLG_Patcher_Classic.bat](./GR4_v121_HLG_Patcher_Classic.bat)** | `classic` | `output\classic\fwdc248b.bin` | **经典 v1.11 / v1.20 同款观感版**：完整复刻 v1.11/v1.20 实机运行时路径——保留原厂 Standard 矩阵/曲线/中性多轴表不变（机身预览/回放与 Standard 完全一致不偏灰），仅重命名 `"HDR"`、开启 Level 0 `OFF` 刻度并注入 APP2 HLG CICP ICC（iPhone 强反差高饱和观感）。 |

生成后将对应的 `fwdc248b.bin` 复制到 SD 卡根目录并按理光常规刷机流程升级（关机状态下按住 `Playback` 键开机确认升级）。

### 3. 跨平台命令行用法（Windows / macOS / Linux）

```bash
# 1) 默认 / BT.2408 校准标准 HLG 版 (--mode calibrated)
node tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs --mode calibrated <input.bin> [output.bin]

# 2) 经典 v1.11/v1.20 同款观感版 (--mode classic，也可简写为 --classic)
node tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs --mode classic <input.bin> [output.bin]

# 或通过 -o 指定输出路径（未指定时 calibrated 生成 <input>_hlg.bin，classic 生成 <input>_hlg_classic.bin）
node tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs --classic fwdc248b.bin -o output/classic/fwdc248b.bin

# 检查任意固件的容器有效性、v1.21 识别、安装模式 (calibrated/classic)、Hook 状态与 HDR Gain Map 共存状态
node tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs --inspect output/fwdc248b.bin
```

### 4. v1.21 新增特性与兼容性设计

- **与 GRMod 版本彻底解耦**：
  - 自动识别官方原版（`official`）与 GRMod 扩容布局（`grmod-grown`）：在现有 `05_RTOS.bin` 尾部动态追加 `+1 frame`（`0x6000` 字节），在 `06_ICONBIN.bin` 尾部追加 `+4 frames`（`0x18000` 字节），完整保留 `RES`、`LINUX`、`INITFS` 与全部非 HLG 分区零改动。
  - `calibrated` 模式下同时写入原生与 GRMod 重定位的 `T_REC` / `T_MA` / `T_GAM` 风格表，并完整覆盖全部 **3 组机内色彩变体（`VARIANTS = 3`）**；`classic` 模式下则保留 Slot 22 原厂三张风格表不动，仅注入 `"HDR"` 名称、Level 0 `OFF` 刻度与 APP2 CICP ICC Hook；自动扫描空闲图标槽位（优先 `800..989`）写入自适应合成刻度图并更新图标查表边界，避免覆盖 GRMod 新增槽位。
  - 仅修改 HDR 专用强度条与 ASCII 格式化判断站点（与 `halation-ui` 零重叠冲突）。
- **Level 0 `OFF` 旁路与原厂风格 `400×60` 三段刻度条**：
  - Slot 22（`HDR Tone` / `HDR色调`，v1.21 Text ID `323`）全球 21 种语言统一更名为 `"HDR"`。
  - 扩展 `HDR_INTENSE` 等级映射为 `[0, 1, 2, 0]` 并将 ASCII 格式化门限由 `0..2` 放宽至支持 `0`，实时读取机内原生图标 `0x261` 与 `0xd2` 合成为带 `OFF / 1-bar / 2-bars` 刻度的 `400×60` 图标，同时挂接**拍摄菜单**（`0x531ca7e8`）与 **RAW 机内显影菜单**（`0x531a9494`）。
- **多重安全防护**：
  - 严格验证容器帧头、GR IV v1.21 RAM 搬移描述块、`Write`/`Rewrite` 调用指令及全部目标特征字（若传入 v1.11/v1.20 等非 v1.21 固件将直接报错中止且不写入任何输出）。
  - 在 `RTOS` 尾部写入模式标记（`GR4HLG121A` / `GR4HLG121B`）：同模式重复运行自动 `[SKIP]` 跳过，跨模式切换或遇旧版 Hook 时会安全拦截并提示使用干净底包重打。
  - 写入输出前自动平衡 Payload 32-bit Word Sum 为 `0x00000000` 并通过 9/9 容器自检。
- **与 GRMod `HDR Gain Map` 共存提示**：
  - 本工具可与 GRMod 内置的 `HDR Gain Map` 安全共存于同一份固件。当你希望使用 **Slot 22（`影像控制 -> HDR`）直出 BT.2100 HLG** 拍摄时，请在相机菜单中关闭 `[拍摄菜单 > HDR]` 开关，以避免 Gain Map 与 HLG 管线叠加。

### 5. 源码与重新打包说明

- [`tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs`](./tools/hlg_patcher_v121/gr4_v121_hlg_patcher.mjs) 为预构建好的零依赖独立运行脚本，常规用户无需额外构建即可直接运行。
- [`tools/hlg_patcher_v121/patch_hlg_v121.ts`](./tools/hlg_patcher_v121/patch_hlg_v121.ts) 为对应 TypeScript 源码；若需修改并重新通过 `esbuild` 打包，需在同级工作目录保留 `Ricoh-GRMod` 仓库以提供底层的 `container` / `arm` / `hlg` 核心模块导入。

---

## 🌟 核心特性与设计

1. **传感器级单张直出 HDR (Zero Shutter Lag)**：
   - 摆脱传统多帧连拍曝光合成的鬼影和快门延迟，单次快门直接输出 14-bit 感光动态范围经 ARIB STD-B67 对数曲线压缩的高动态 JPEG。
2. **槽位替换方案：替换“HDR色调”（Slot 22）**：
   - 精准替代原本的“HDR色调”图像控制风格（`toneId = 22 = 0x16`），不改动任何其他原有风格。
   - 菜单在全部 **21 种语言**中统一更名为 `"HDR"`；v1.21 版本额外提供 Level 0 `OFF` 旁路刻度及独立合并的 `400×60` 三段图标（`06_ICONBIN.bin` 尾部安全扩展，v1.11 版本则对 `06_ICONBIN.bin` 保持 0 字节修改）。
3. **机内自动 APP2 CICP ICC Profile 注入**：
   - 在 RTOS `ExifJpegWriter::SetupAppNInfo` 安全挂载 Hook（v1.11 位于 `0x5380bf50`，v1.21 位于 `0x53833a28`）。
   - 当检测到使用 Slot 22 时，自动在 JPEG 比特流头部组装 576 字节 32 字节对齐的 APP2 Marker，内嵌包含 `cicp` `[9, 18, 0, 1]` 标签的 ICC v4.4 Display Profile。
   - 遵循严格的 Ricoh DMA 32 字节对齐规范，修正 APP7 长度，确保主流平台（Apple iOS/macOS Photos EDR、Windows WIC/HDR、Android）原生识别。
4. **安全校验和与无侵入驻留**：
   - v1.11 使用 RTOS Rodata 官方连续零填充区（`0x540db200`，仅占 1456 字节）；v1.21 改为动态追加 1 个 RTOS 帧（`0x6000` 字节）以兼容任意 GRMod 插件组合与重定位表。
   - 均通过末尾 32-bit Word Sum 补偿字精确平衡，保证解压 Payload Word-Sum 严格等于 `0x00000000`。

### v1.11 与 v1.21 关键站点对照

| 项目 | Ricoh GR IV v1.11（Python 工具链） | Ricoh GR IV v1.21（独立后置补丁） |
| :--- | :--- | :--- |
| **目标风格槽位** | Slot 22 (`toneId = 22`, HDR色调) | Slot 22 (`toneId = 22`, HDR色调) |
| **菜单文本 ID** | Text ID `306`（21 种语言 -> `"HDR"`） | Text ID `323`（21 种语言 -> `"HDR"`） |
| **APP2 Hook 站点** | `0x5380bf50`（驻留 `0x540db200`） | `0x53833a28`（动态追加至扩容 `RTOS` 尾部） |
| **风格基表定位** | 原生固定地址（`T_REC[11]` Standard） | 同时适配原生与 GRMod 重定位表，覆盖 3 组变体 |
| **强度刻度 UI** | 保留原厂 `06_ICONBIN.bin` 0 字节修改 | 拍摄/RAW 显影双入口扩展 Level 0 `OFF` 三段刻度 |
| **GRMod 兼容性** | 针对官方原版 v1.11 | 支持官方原版 v1.21 及任意 GRMod v1.21 导出固件 |

---

## 🔬 固件处理管线架构

```
[Raw Bayer Sensor 14-bit]
       │
       ▼
[Socionext Milbeaut Hardware ISP (05_RTOS.bin)]
       ├─► 1. 3×3 CCM: M_HLG_Q13 (Rec.709 -> Rec.2020 @ M_STD)
       ├─► 2. 1D LUT: 256-point 14-bit ARIB STD-B67 HLG with S^-1 pre-compensation
       └─► 3. Neutral Multi-Axis: Repointed to Standard neutral descriptor
       │
       ▼
[Hardware JPEG DMA Engine (05_RTOS.bin)]
       │
       ▼
[Hook: SetupAppNInfo (v1.11: 0x5380bf50 / v1.21: 0x53833a28)]
       ├─► Checks active toneId == 22 (HDR Mode)
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

```text
.
├── GR4_v121_HLG_Patcher.bat              # [v1.21] Windows 一键补丁 [BT.2408 校准标准 HLG 版 - 推荐]
├── GR4_v121_HLG_Patcher_Classic.bat      # [v1.21] Windows 一键补丁 [经典 v1.11/v1.20 同款观感版]
├── analysis/                             # 静态逆向审计与补丁清单（v1.11）
│   ├── hlg_patch_manifest.json           # 27 项机器可读原子补丁清单（Gate 1 审计依据）
│   └── sim_verification_report.md        # 双系统闭环仿真与固件差异回归报告
├── assets/                               # 固件校准生成的二进制表与资产
│   ├── icc/                              # 内嵌 BT.2100 HLG CICP [9, 18, 0, 1] ICC v4.4 Profile
│   └── isp_tables/                       # Q13 CCM 矩阵与 14-bit 256 点 HLG 曲线
├── docs/                                 # 详细技术设计文档
│   └── FEAT_HLG_PHOTO.md                 # HLG 照片功能完整工程设计规范与逆向分析
├── src/                                  # 核心算法与 v1.11 固件补丁器源码
│   └── hlg_photo/
│       ├── build_bt2100_hlg_icc.py       # 构建 ICC v4.4 CICP Display Profile
│       ├── generate_hlg_lut_and_ccm.py   # 生成 Q13 矩阵与 ARIB STD-B67 曲线
│       ├── patch_audit.py                # Gate 1 补丁清单前置校验器
│       └── patch_firmware_hlg.py         # v1.11 固件解压、补丁、校验和平衡与重打包
├── tests/                                # 单元测试与回归套件
│   └── test_hlg_photo.py                 # 8 项全自动单元测试（矩阵、曲线、ICC、解包、还原性）
└── tools/                                # 逆向、容器校验与 v1.21 后置补丁工具
    ├── hlg_patcher_v121/
    │   ├── gr4_v121_hlg_patcher.mjs      # [v1.21] 零依赖独立 ESM 后置补丁与 --inspect 工具
    │   └── patch_hlg_v121.ts             # [v1.21] 补丁器 TypeScript 源码
    ├── fw_container.py                   # 官方 LZSS 固件容器解包与重打包工具
    ├── verify_hlg_patch.py               # 独立 Gate 1 固件候选包校验工具
    ├── rtos_analyzer.py                  # RTOS 静态分析与符号扫描工具
    └── linux_analyzer.py                 # Linux RootFS 分析工具
```

---

## 🛠️ v1.11 构建与刷机指南（历史版本 / Python 工具链）

*(若使用最新的 GR IV **v1.21** 固件，请优先使用上方 **[GR4_v121_HLG_Patcher.bat](./GR4_v121_HLG_Patcher.bat)** 或 `gr4_v121_hlg_patcher.mjs`。以下说明适用于 v1.11 基线研发构建与验证。)*

### 1. 环境准备

需要 Python 3.9+ 以及相关依赖：
```bash
pip install pillow pyyaml
```
*(可选)* 若需重新汇编 Hook 机器码，需安装 `arm-none-eabi-gcc`。

### 2. 准备官方固件

将理光官方 v1.11 固件 `fwdc248b.bin` 放置于：
```text
firmware/official/v1.11/fwdc248b.bin
```
*(SHA-256: `a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f`)*

### 3. 一键生成修改固件

执行固件补丁程序：
```bash
python -m src.hlg_photo.patch_firmware_hlg
```

生成的候选固件位于：
```text
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

1. 将生成的修改固件重命名为 `fwdc248b.bin`，并拷贝至 SD 卡根目录；
2. 相机关机状态下，按住 `Playback`（回放）键开机，屏幕显示固件升级确认界面；
3. 确认版本升级并等待进度条完成（约 1-2 分钟），完成后自动关机；
4. 开机进入菜单：
   - 图像控制菜单中，原 **“HDR色调”** 风格槽位已更名为 **“HDR”**（提供机内单张直出 HDR 功能）；
   - 所有其他原厂色彩风格均完好保持官方出厂状态；
   - *(v1.21 用户可进一步将 HDR 强度滑块设为最低档 `OFF` 实现无效果旁路，或在 1 / 2 档使用 HLG 效果；若同时使用了 GRMod 的 HDR Gain Map 功能，请在拍摄 Slot 22 HLG 照片时关闭 `[拍摄菜单 > HDR]`。)*

5. 选择 **“HDR”** 拍摄，将生成的 `.JPG` 文件导入 iPhone、Mac（Photos / Preview）或 Windows 11 HDR 显示器，即可查看宽动态范围 HDR 照片效果！

---

## ⚖️ 免责声明

本代码与固件修改补丁仅供摄影工程爱好者与逆向研究使用。修改相机固件存在理论上的意外风险，刷机前请确保电池电量充足（建议 50% 以上）。作者与贡献者不对任何因自行修改或刷机导致的硬件故障负责。
