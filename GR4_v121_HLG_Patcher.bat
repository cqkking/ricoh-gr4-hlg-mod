@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PATCHER=%SCRIPT_DIR%tools\hlg_patcher_v121\gr4_v121_hlg_patcher.mjs"
set "DEFAULT_OUT=%SCRIPT_DIR%output\fwdc248b.bin"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未找到 Node.js，请先安装 Node.js ^(v18+^) 或将其添加到 PATH。
    pause
    exit /b 1
)

if not exist "%PATCHER%" (
    echo [ERROR] 未找到补丁核心脚本: "%PATCHER%"
    pause
    exit /b 1
)

set "INPUT_FILE=%~1"
if "%INPUT_FILE%"=="" (
    echo ====================================================================
    echo   Ricoh GR IV v1.21 BT.2100 HLG Photo 定向补丁工具
    echo   支持：v1.21 官方原版固件 或 经 GRMod 0.8.15/0.8.16+ 导出的 v1.21 固件
    echo ====================================================================
    echo 请在弹出的文件窗口中选择要打入 HLG Photo 功能的 fwdc248b.bin 文件...
    for /f "usebackq delims=" %%F in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '选择 GR IV v1.21 固件 (fwdc248b.bin)'; $d.Filter = 'GR IV Firmware (*.bin)|*.bin|All Files (*.*)|*.*'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }"`) do (
        set "INPUT_FILE=%%F"
    )
)

if "%INPUT_FILE%"=="" (
    echo [取消] 未选择固件文件。
    pause
    exit /b 0
)

echo.
echo 输入固件: "%INPUT_FILE%"
echo 输出固件: "%DEFAULT_OUT%"
echo.

node "%PATCHER%" "%INPUT_FILE%" "%DEFAULT_OUT%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo [完成] 请将 "%DEFAULT_OUT%" 复制到相机 SD 卡根目录并重命名为 fwdc248b.bin（如已是该名称直接拷入）进行刷机。
) else (
    echo [失败] 补丁未应用，请检查上方错误信息（确认输入为理光 GR IV v1.21 固件）。
)
echo.
pause
exit /b %RC%
