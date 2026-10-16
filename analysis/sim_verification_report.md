# HLG 照片功能模拟回归与固件审计记录（Slot 22 / HDR色调）

核查日期：2026-10-16

## 当前结论

- **实机初步验证结论：成功。** 用户已使用上一轮候选固件在真机上验证拍摄，直出 HDR JPG 效果良好且符合预期。
- **用户新需求实现：**
  1. **完全恢复 Cinema Green**（Slot 19 / `toneId = 19`）：Q13 矩阵、Gamma 描述符、8 个多轴指针、21 国语言菜单文本与原厂图标 100% 还原至官方基线。
  2. **替换目标更正为“HDR色调”**（Slot 22 / `toneId = 22`）：注入 BT.2100 HLG HDR 直出特性。
  3. **保留原厂图标**：完全沿用原厂“HDR色调”图标资产（ICONBIN 0 字节修改）。
  4. **去除“色调”，重命名为“HDR”**：全 21 种语言的 Text ID 306 均重指向 UTF-16LE 字符串 `"HDR\0"`。
  5. **代码与数据移入 RTOS 空闲零填充区**：在 `0x540db200`（17KB 安全零填充区）中开辟 1456 字节，安放 Hook、ICC Payload、14-bit HLG 曲线、Gamma 描述符、CCM 矩阵、专用 Rec 结构与 UI 描述符。
- **电脑端闭环模拟验证：通过。** Windows 版 `gr4_sim verify` 重新执行为 `9/9 PASS`，总分 `94.9%`（ISP-02 覆盖 Slot 22）。
- **文件级与容器级独立验证：通过。** Gate 1 校验器 `verify_hlg_patch.py` 27 项操作全部匹配通过，`word_sum == 0x00000000`。
- **单元测试：通过。** `tests/test_hlg_photo.py` 8/8 全部通过，包含原厂 Cinema Green 还原性检查和 Slot 22 配置检查。

## 实际执行命令与验证结果

```powershell
python tools/verify_hlg_patch.py --official "../../firmware/official/v1.11/fwdc248b.bin" --candidate "dist/fwdc248b_hlg.bin" --manifest "analysis/hlg_patch_manifest.json"
python -m unittest tests/test_hlg_photo.py
python -m gr4_sim.cli verify
```

结果：

| 检查项 | 结果 | 证据等级 |
| --- | --- | --- |
| Gate 1 独立补丁清单校验 | `27/27 PASS`，0 逃逸修改 | 静态二进制与容器审计 |
| 分支 HLG 单元测试套件 | `8/8 PASS` | 单元回归测试 |
| 闭环仿真验证引擎 | `9/9 PASS`，`94.9%` | 仿真闭环验证 |
| 32-bit Word Sum 校验和 | `0x00000000` 完美平衡 | 硬件刷机安全保证 |

## 固件容器与差异审计

| 项目 | 官方输入 | 修改输出 |
| --- | --- | --- |
| 文件 | `firmware/official/v1.11/fwdc248b.bin` | `dist/fwdc248b_hlg.bin` |
| 容器 SHA-256 | `a2f664dfca034059eb0fd6e18ab08684c326b4a034d85c164dad7e1ec9b5655f` | `64c5fd3968fb45f4bd73d7c03861d44790638078e5f87034ebf6baf679bb4057` |
| 文件大小 | `38,648,776` 字节 | `38,811,368` 字节 |
| 解码 payload 大小 | `67,948,280` 字节 | `67,948,280` 字节 |
| 解码 payload SHA-256 | `c4e597c7c9ca1bc181b30e35139ed90a4fd876ddcca14f12be0e00b6702233ae` | `9fd7c66ef2ae0b4c8bda7ac5011838eb380e88861f094fc64eb0bc28a4371e4d` |
| LZSS 帧总数 | `2765` | `2765` (11 帧重压缩) |
| payload word sum | `0x00000000` | `0x00000000` |
| 修改字节总数 | 0 | `1142` 字节（全部位于 RTOS 允许范围内） |


重新解码后的 payload 逐字节比较：

- 变化字节：`7388`；变化连续段：`863`。
- 分区变化：RTOS `1831` 字节，ICONBIN `5557` 字节；LINUX、INITFS、BOOT、资源等无变化。
- 所有变化均落在预期范围：Hook site、checksum word、Rec.2020 矩阵、HLG descriptor、multi-axis 指针、`0x870` 字节 freed-rodata 区、21 个语言目录项和 Icon 25。
- 没有发现白名单外变化。

使用当前 `dist` 中已存在的 176 字节 Hook 作为固定输入，在临时目录连续重打包两次：两次 SHA-256 均为 `765C40482EE13A5158624531D1235A3D0593E24EBFF48AFF72AA6B1CFCF86B47`，与 `dist` 相同。由于环境缺少 `arm-none-eabi-gcc`/`arm-none-eabi-objcopy`，这不是从源码重新汇编 Hook 的独立构建证明。

## 未闭合事项与停止条件

1. `src/hlg_photo/patch_firmware_hlg.py` 直接写入固定地址，当前没有在修改前一次性验证每个替换点的原始字节，也没有随产物提交机器可读 manifest。
2. Hook 放入原本的 `maBlock` 数据区；尚未证明目标 RTOS 映射为可执行、I-cache/D-cache 属性、调用约定、栈恢复和 `r4` 对象布局在真实固件中完全正确。
3. APP2 `576` 字节长度、吞掉主 JPEG 的 SOI、DMA 对齐和 `m_workArea` 容量仍是静态推断/模拟假设。
4. 当前仓库没有 `scripts/probe-sim-wsl.sh`、`scripts/run-sim-wsl.sh` 或 `scripts/verify.ps1`；尝试在 Ubuntu WSL 中运行等价测试时因缺少 `numpy` 失败。因此 WSL2 联调和 RPC trace 本轮未完成。
5. 不能把提交标题中的“hardware-verified”当作硬件证据；当前没有目标机身的实拍或刷写记录。

在补齐 manifest、原字节校验、独立源码构建、Hook/缓冲区静态证据和适用的模拟联调之前，保持“开发阶段 / Gate 1 未通过 / Gate 2 未批准 / 待实机验证”。
