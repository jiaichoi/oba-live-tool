
## 安装与验证范围

- Apple 芯片 Mac：下载 `online-operations_1.0.23_macos_arm64.dmg`。
- Intel Mac：下载 `online-operations_1.0.23_macos_x64.dmg`。
- Windows 64 位：下载 `online-operations_1.0.23_windows_x64.exe`。
- 安装包已包含 Electron/Node、生产依赖和 Python 工作台，无需自行安装 Node、npm 或 Python。仍需已安装 Chrome 或 Edge，并由本人登录抖店官方页面。
- macOS 包使用本机临时签名，未进行 Apple 开发者签名或公证；Windows 安装包未购买代码签名证书。
- 每个平台均在原生架构构建机验证打包版本、Node 依赖加载及内置 Python 工作台健康检查。真实店铺功能验收在 Apple 芯片 Mac 完成，未声称 Intel Mac/Windows 已完成真实店铺验收。
- 「打单」「发货」是本机订单分类，不提交平台发货、打印或 ERP 操作。完整读取范围为平台近六个月待发货列表。
- 使用 `SHA256SUMS.txt` 核对下载文件。macOS 可运行 `shasum -a 256 文件路径`；Windows PowerShell 可运行 `Get-FileHash 文件路径 -Algorithm SHA256`。
