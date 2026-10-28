# Changelog

## v1.0.10

- 修复抖店待发货逐页读取时无关网络响应占用核验记录额度的问题，完整保留订单列表和店铺身份响应。
- 页面跳转取消的响应交由逐页订单对照判定；关键响应超限或过大时停止整理并保留上次有效快照。
- 增加多页响应覆盖及失败保护测试。订单、发货、ERP 和库存写入行为不变。

## v1.0.9

- 自动整理订单尺码格默认仅展示数量，点格后才展开本次例外数量输入；点击数量本身不改变例外。源订单量和本机批次确认规则保持不变。
- 当日已下单按货号或商品、颜色和尺码展示北京时间当日有效确认批次的实际下单件数；历史规格逐批从对应快照核对，缺失或冲突时单列待核，不猜填。
- 自动整理与当日已下单矩阵使用同一纵横滚动区域，向下滚动时固定尺码表头。保留批次摘要、明细和本机撤销入口。

此版本不含真实订单、买家资料、登录会话、密码或本机下单记录。

## v1.0.8

- 修复 v1.0.7 构建时新增数量测试的 TypeScript 类型错误；尺码格直接填写本次例外数量的功能和本地记账逻辑不变。
- 已验证完整 TypeScript 检查、数量分配测试及界面构建。v1.0.7 标签保留作为未完成构建记录，以 v1.0.8 安装包为准。

此版本不含真实订单、买家资料、登录会话、密码或本机下单记录。

## v1.0.7

- 待发货矩阵每个款色尺码格可直接填写本次不下单件数（0 至该格源数量），即时显示本次可确认件数；无需逐个子订单调整。
- 例外数稳定分配到本地子订单记账，沿用人工完成下单后的批次确认、撤销和当日累计；不改变源订单数量，不调用抖店或 ERP 下单接口。

此版本不含真实订单、买家资料、登录会话、密码或本机下单记录。

## v1.0.6

- 待发货矩阵新增“本次不下单”例外和“完成下单”确认，支持整格例外及逐子订单部分数量；确认只记录已在 ERP 人工下单的数量，不调用 ERP 或抖店业务接口。
- 将导航中的“当日已发货”替换为“当日已下单”，按北京时间的本机确认时间累计当天多个批次。已有发货导入数据仍保留在原本机数据库中。
- 每次成功整理生成独立快照和确认批次；同一快照重复确认会被拒绝，旧批次可撤销本机标记并留下撤销时间。待发货原始数量不因确认而减少。
- 下单记录绑定本机账号和核验店铺，单次写入采用临时文件原子替换；旧版未绑定账号的待发快照需要重新整理后才可确认。

此版本不含真实订单、买家资料、登录会话、密码或本机下单记录。

## v1.0.5

- 修复官方 SKU 颜色包含“【女款】”等款式前缀时，与页面简写颜色直接比较造成的误报。
- 以官方完整颜色和尺码为准，要求原始规格完整出现在对应商品行；页面无法拆分带括号的颜色时仍可逐行核验。规格、商品身份、数量或分页不一致时保留旧快照。
- 已用一份本机失败候选记录只读重放：103 个主订单、106 个商品行与官方子订单逐项对应；这不替代新安装包在实时店铺页面的现场验收。

此版本仅发布程序和空白数据目录，不包含真实订单、买家资料、登录会话、密码或诊断文件。

## v1.0.4

- 待发货订单双次核对只比较稳定状态，忽略页面每秒变化的发货倒计时；订单身份、商品、数量、售后状态和实际状态变化仍会阻止发布。
- 切换待发货筛选与翻页后，逐页等待表格主订单编号与该次官方列表响应完全对应；分页不可用或页面总数不符时保留旧快照。
- 安装包继续内置本机订单工作台；真实店铺读取仍须以安装后的逐页核对结果验收。

此版本仅包含程序与空白本机数据目录，不包含真实订单、买家资料、登录会话或诊断文件。

## v1.0.3

- 将本机订单工作台服务及其 Python 运行时封装进安装包，首次启动自动管理服务，数据保存在应用自己的本机目录；不再依赖开发源码目录或系统 Python。
- 修复官方 SKU 字段“尺码大小”附带体重说明时漏识别尺码的问题，保留原始规格供复核。
- 待发货矩阵改从应用本机数据读取，避免正式安装版的浏览器来源限制；店铺身份、两次逐页读取及商品子订单核对未通过时保留上次有效快照。
- 使用独立应用标识和数据目录，不覆盖旧版 OBA 的本机资料。
- 自动选择空闲的本机端口，避免既有 8765 工作台占用导致独立安装版无法启动内置服务。

此版本仅发布空白程序。真实订单、买家资料、密码、Cookie、登录会话及本机诊断文件不随安装包或源码发布。首次使用需自行登录店铺；订单获取结果以当次实际核验为准。

## v1.0.1

- 修复待发货标签已更新但表格仍显示旧状态订单时的读取竞态；只在商品行全部显示待发货后逐页核对和更新快照。
- 支持未预设的货号、颜色、尺码；商家编码缺失时保留商品身份，款式未标注颜色类型时按原始规格展示，例如“女-鸿运套装/2XL”。
- 按官方商品子订单逐项核对订单身份、状态、数量和分页，核对失败保留上次有效快照；工作台使用实际尺码生成横向矩阵。
- 更新检查以本仓库带安装包附件的正式 Release 为准。

2026-10-24 本机测试：近6个月待发货读取 19 个主订单、19 个商品子订单、19 件；随后只读逐页候选与工作台快照及捕获的官方列表响应逐项一致。这是读取时点的本机快照，店铺 ID 尚待核实；未接通抖店开放平台 API 或飞书自动同步，也未执行发货。此源码版本的安装包需单独构建并核对附件。

## v1.0.0

线上经营工具首个发布版。

- 新增独立抖店订单窗口与待发货订单只读整理。
- 在应用内显示订单核对结果和按颜色、尺码汇总的矩阵。
- 本机订单工作台支持抖店导出文件导入；实际发货仍由商家在官方后台完成。
- 更新检查只认本仓库已发布的安装包。

当前版本未接通抖店开放平台 API 或飞书自动同步；订单整理结果是读取时点的本机快照。

## v1.6.3

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.6.1...v1.6.3)

### 🐞 Bug Fixes

- **抖音小店:** 修复抖音小店中控台无法连接的问题 #320 ([#320](https://github.com/qiutongxue/oba-live-tool/issues/320))
- **抖音小店:** 修复抖店连接后功能无法正常使用的问题，#322 ([#322](https://github.com/qiutongxue/oba-live-tool/issues/322))

## v1.6.2

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.6.1...v1.6.2)

### 🐞 Bug Fixes

- **抖音小店:** 修复抖音小店中控台无法连接的问题 #320 ([#320](https://github.com/qiutongxue/oba-live-tool/issues/320))

## v1.6.1

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.6.0...v1.6.1)

### 🚀 Features

- 模型列表更新 DeepSeek-V4，（deepseek-chat 和 deepseek-reasoner 即将弃用）
- 将 AI 提供商的模型列表更新转移到线上 ([5e5ecf1](https://github.com/qiutongxue/oba-live-tool/commit/5e5ecf1))

## v1.6.0

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.24...v1.6.0)

### 🚀 Features

- **自动发言:** 增加解除字数限制的开关 ([#301](https://github.com/qiutongxue/oba-live-tool/pull/301))
- **自动弹窗:** 新增自动弹窗的单品循环功能（感谢 [@zuowangyan](https://github.com/zuowangyan)）
- **抖店/百应:** 增加发红包功能（感谢 [@zuowangyan](https://github.com/zuowangyan)）

## v1.5.24

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.23...v1.5.24)

### 🚀 Features

- 添加快手小店的自动回复功能 ([a0bfcca](https://github.com/qiutongxue/oba-live-tool/commit/a0bfcca))

## v1.5.23

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.22...v1.5.23)

### 🚀 Features

- 分离AI对话和自动回复的AI配置 ([2ec6cc2](https://github.com/qiutongxue/oba-live-tool/commit/2ec6cc2))
- 添加无效数据的清理功能 ([6f0e90b](https://github.com/qiutongxue/oba-live-tool/commit/6f0e90b))

### 🐞 Bug Fixes

- 修复在自动发言页面切换账号时对应的评论内容无法更新的问题 ([ad67174](https://github.com/qiutongxue/oba-live-tool/commit/ad67174))
- **小红书:** 修复小红书无法发送评论的问题 #283 ([#283](https://github.com/qiutongxue/oba-live-tool/issues/283))

## v1.5.22

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.21...v1.5.22)

### 🐞 Bug Fixes

- 修复设置页面外部链接无法打开的问题 ([0a176c7](https://github.com/qiutongxue/oba-live-tool/commit/0a176c7))

## v1.5.21

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.20...v1.5.21)

### 🚀 Features

- **淘宝:** 新增自动回复功能（仅简单的评论回复） ([450dba1](https://github.com/qiutongxue/oba-live-tool/commit/450dba1))

### 🐞 Bug Fixes

- 修正自动弹窗任务中注册快捷键的拼写错误 ([6e48bae](https://github.com/qiutongxue/oba-live-tool/commit/6e48bae))
- 修复目录不存在时截屏报错的问题 ([68abdb2](https://github.com/qiutongxue/oba-live-tool/commit/68abdb2))
- **淘宝:** 修复淘宝（企业店铺）自动弹窗时找不到商品ID的问题 ([ac10b8b](https://github.com/qiutongxue/oba-live-tool/commit/ac10b8b))
- 修复淘宝评论监听的昵称显示问题 ([2b6550a](https://github.com/qiutongxue/oba-live-tool/commit/2b6550a))

## v1.5.20

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.19...v1.5.20)

### 🐞 Bug Fixes

- **淘宝**: 修复淘宝初次登录时无法连接中控台的问题 ([0059158](https://github.com/qiutongxue/oba-live-tool/commit/0059158))

## v1.5.19

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.18...v1.5.19)

### 🚀 Features

- 大大减轻了应用体积（减少了约 100MB）！

### 🐞 Bug Fixes

- 修改日志的错误堆栈显示信息 ([e3aee11](https://github.com/qiutongxue/oba-live-tool/commit/e3aee11))
- **淘宝:** 修复淘宝直播找不到评论框的问题 ([5fb39c1](https://github.com/qiutongxue/oba-live-tool/commit/5fb39c1))
- **淘宝:** 修复淘宝无法获取用户名的问题 ([1ddf73e](https://github.com/qiutongxue/oba-live-tool/commit/1ddf73e))

## v1.5.18

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.17...v1.5.18)

### 🚀 Features

- **小红书:** 小红书千帆/蒲公英新增自动回复功能 ([3c0bcbc](https://github.com/qiutongxue/oba-live-tool/commit/3c0bcbc))

### 🐞 Bug Fixes

- **抖音小店:** 修改判断登录成功的方式 ([8a904c4](https://github.com/qiutongxue/oba-live-tool/commit/8a904c4))
- **ui**: 修复点击新版本弹窗通知里的外部链接无法在应用外打开的问题 ([a0fa1f8](https://github.com/qiutongxue/oba-live-tool/commit/a0fa1f8))
- 修复 MacOS 的更新问题，减小 MacOS 应用体积 ([#246](https://github.com/qiutongxue/oba-live-tool/pull/246))

## v1.5.17

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.16...v1.5.17)

### 🚀 Features

- **视频号:** 新增自动回复功能 ([954c4ec](https://github.com/qiutongxue/oba-live-tool/commit/954c4ec))
- **视频号:** 新增评论上墙功能 ([44b3a4a](https://github.com/qiutongxue/oba-live-tool/commit/44b3a4a))

### 🐞 Bug Fixes

- 修复因网络原因无法提示手动下载更新的问题 ([fa7f603](https://github.com/qiutongxue/oba-live-tool/commit/fa7f603))
- 修复部分类型错误 ([0cc922d](https://github.com/qiutongxue/oba-live-tool/commit/0cc922d))
- 修复在特定情况下某些不支持的平台能访问到自动回复页面的问题 ([f56213a](https://github.com/qiutongxue/oba-live-tool/commit/f56213a))
- **视频号:** 修复浏览器窗口过窄时视频号仍无法连接中控台的问题 ([977d194](https://github.com/qiutongxue/oba-live-tool/commit/977d194))

## v1.5.16

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.15...v1.5.16)

### 🚀 Features

- 使用日志记录 WebSocket 的错误 ([42ce04d](https://github.com/qiutongxue/oba-live-tool/commit/42ce04d))
- 在应用启动时使用日志记录相关应用信息 ([e18b83d](https://github.com/qiutongxue/oba-live-tool/commit/e18b83d))
- 优化软件更新逻辑及软件更新 UI 界面 ([02660a6](https://github.com/qiutongxue/oba-live-tool/commit/02660a6))
- 添加主进程未捕获异常和未处理拒绝的处理逻辑 ([0ef990a](https://github.com/qiutongxue/oba-live-tool/commit/0ef990a))

### 🐞 Bug Fixes

- **巨量百应:** 修复巨量百应中控台页面样式错误的问题 ([053cd53](https://github.com/qiutongxue/oba-live-tool/commit/053cd53))
- 修复评论监听和WebSocket无法正常关闭的问题 #231 ([#231](https://github.com/qiutongxue/oba-live-tool/issues/231))
- 改进错误日志记录以包含堆栈信息 ([c1ba0d3](https://github.com/qiutongxue/oba-live-tool/commit/c1ba0d3))
- 优化未捕获异常的错误处理和提示信息 ([c7d5472](https://github.com/qiutongxue/oba-live-tool/commit/c7d5472))
- 修复因意外错误导致无法正常停止任务的问题 ([d7aa0d9](https://github.com/qiutongxue/oba-live-tool/commit/d7aa0d9))
- 修复自动弹窗任务在手动停止或更新配置时无法及时中止的问题 ([dd32837](https://github.com/qiutongxue/oba-live-tool/commit/dd32837))

## v1.5.15

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.14...v1.5.15)

### 🚀 Features

- **ui:** 中控台平台选项持久化 ([80ae047](https://github.com/qiutongxue/oba-live-tool/commit/80ae047))
- **中控台:** 优化中控台的连接逻辑，加快连接速度，减少连接错误 ([18f83f5](https://github.com/qiutongxue/oba-live-tool/commit/18f83f5))

### 🐞 Bug Fixes

- **视频号:** 修复浏览器窗口过窄时无法获取用户名的问题 #226 ([#226](https://github.com/qiutongxue/oba-live-tool/issues/226))
- **ui:** 修复更新提示对话框无法通过右上角的 x 关闭的问题 ([d3ba6bb](https://github.com/qiutongxue/oba-live-tool/commit/d3ba6bb))
- **小红书:** 修复因浏览器视口调整导致小红书获取用户名失败的问题 #225 ([#225](https://github.com/qiutongxue/oba-live-tool/issues/225))

## v1.5.14

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.13...v1.5.14)

### 🐞 Bug Fixes

- **视频号:** 修复视频号重复弹窗失败的问题 #219 ([#219](https://github.com/qiutongxue/oba-live-tool/issues/219))
- 修复浏览器视口固定的问题 #219 ([#219](https://github.com/qiutongxue/oba-live-tool/issues/219))
- **小红书千帆&蒲公英:** 修复小红书千帆&蒲公英弹卡可能会失效的问题 #216 ([#216](https://github.com/qiutongxue/oba-live-tool/issues/216))

## v1.5.13

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.12...v1.5.13)

### 🚀 Features

- 新增在窗口标题中显示应用版本号 ([5aefaab](https://github.com/qiutongxue/oba-live-tool/commit/5aefaab))

### 🐞 Bug Fixes

- **千帆**: 修复小红书千帆登录无法获取用户名的问题 ([d086418](https://github.com/qiutongxue/oba-live-tool/commit/d086418))
- **抖音小店&巨量百应**: 修复找不到弹窗按钮的问题 ([48acc28](https://github.com/qiutongxue/oba-live-tool/commit/48acc28))

## v1.5.12

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.11...v1.5.12)

### 🚀 Features

- 新增小红书蒲公英平台 ([0e7bf11](https://github.com/qiutongxue/oba-live-tool/commit/0e7bf11))

### 🐞 Bug Fixes

- **小红书千帆:** 修复小红书千帆自动弹窗无效的问题 ([3ce60c5](https://github.com/qiutongxue/oba-live-tool/commit/3ce60c5))
- 修复部分类型错误以及遗留问题 ([c000776](https://github.com/qiutongxue/oba-live-tool/commit/c000776))
- 修复ipc传参缺失 accountId 的问题 ([3e7135c](https://github.com/qiutongxue/oba-live-tool/commit/3e7135c))
- 修复更新配置时计时器未重置的问题 ([12150cb](https://github.com/qiutongxue/oba-live-tool/commit/12150cb))
- 进一步补充连接中控台的功能 ([bc8f622](https://github.com/qiutongxue/oba-live-tool/commit/bc8f622))
- 优化一键发送时的日志提示内容 ([081cf3d](https://github.com/qiutongxue/oba-live-tool/commit/081cf3d))
- 修复定时任务的部分错误 ([a214d0d](https://github.com/qiutongxue/oba-live-tool/commit/a214d0d))
- 修复中控台连接中断时的部分错误 ([ae3b7d0](https://github.com/qiutongxue/oba-live-tool/commit/ae3b7d0))
- 修复无头模式登录报错的问题 ([89396de](https://github.com/qiutongxue/oba-live-tool/commit/89396de))

## v1.5.11

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.10...v1.5.11)

### 🐞 Bug Fixes

- **中控台:** 修复抖音小店&小红书打开新页面可能造成的问题 ([dc00ebb](https://github.com/qiutongxue/oba-live-tool/commit/dc00ebb))
- **中控台:** 修复巨量百应登录页面样式错误的问题 ([f184e34](https://github.com/qiutongxue/oba-live-tool/commit/f184e34))

## v1.5.10

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.9...v1.5.10)

### 🚀 Features

- **自动发言:** 优化自动发言的消息编辑界面 ([6424ef0](https://github.com/qiutongxue/oba-live-tool/commit/6424ef0))
- **自动回复:** 添加关键字回复的批量编辑功能 ([7a27d9c](https://github.com/qiutongxue/oba-live-tool/commit/7a27d9c))
- **自动发言&自动回复:** 支持在文本中使用形如 {选项A/选项B/选项C} 的变量 ([499d973](https://github.com/qiutongxue/oba-live-tool/commit/499d973))
- **中控台:** 添加无头模式开关 ([94587c3](https://github.com/qiutongxue/oba-live-tool/commit/94587c3))

### 🐞 Bug Fixes

- 修复抖音小店登录页面样式混乱的问题, fix #158 ([#158](https://github.com/qiutongxue/oba-live-tool/issues/158))

## v1.5.9

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.8...v1.5.9)

### 🐞 Bug Fixes

- 修复登录控制台成功以后页面状态更新问题, fix #154 ([#154](https://github.com/qiutongxue/oba-live-tool/issues/154))

## v1.5.8

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.7...v1.5.8)

### 🚀 Features

- 新增对淘宝直播平台的支持 ([30a7623](https://github.com/qiutongxue/oba-live-tool/commit/30a7623))
- **ui:** 添加连接到淘宝中控台时的提示 ([9ad7645](https://github.com/qiutongxue/oba-live-tool/commit/9ad7645))
- **中控台:** 连接中控台失败时自动关闭浏览器 ([996181f](https://github.com/qiutongxue/oba-live-tool/commit/996181f))

### 🐞 Bug Fixes

- **中控台:** 修复未直播状态下登录淘宝平台后错误提示异常问题 ([8f89ed2](https://github.com/qiutongxue/oba-live-tool/commit/8f89ed2))
- **中控台:** 优化登录逻辑，只要登录成功就保存登录状态 ([f888042](https://github.com/qiutongxue/oba-live-tool/commit/f888042))
- 修复账号管理的部分问题 ([887fa19](https://github.com/qiutongxue/oba-live-tool/commit/887fa19))
- 优化删除账号的逻辑 ([991a77f](https://github.com/qiutongxue/oba-live-tool/commit/991a77f))
- **ui:** 修复在中控台连接中切换到其它页面后连接状态失效的问题 ([75a254e](https://github.com/qiutongxue/oba-live-tool/commit/75a254e))
- 修复中控台连接失败后自动断开连接有延时的问题 ([01813fc](https://github.com/qiutongxue/oba-live-tool/commit/01813fc))

## v1.5.7

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.6...v1.5.7)

### 🚀 Features

- **ui:** API Key 输入栏添加隐藏/显示功能 ([66269aa](https://github.com/qiutongxue/oba-live-tool/commit/66269aa))

### 🐞 Bug Fixes

- **ui:** 修复火山引擎配置中可能会造成歧义的信息 ([10f65f3](https://github.com/qiutongxue/oba-live-tool/commit/10f65f3))
- **ai:** 修复 API Key 测试连接的部分问题 ([47a147a](https://github.com/qiutongxue/oba-live-tool/commit/47a147a))
- **中控台:** 修复视频号无法登录的问题 fix #149 ([#149](https://github.com/qiutongxue/oba-live-tool/issues/149))

## v1.5.6

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.5...v1.5.6)

### 🚀 Features

- **自动回复:** 添加 WebSocket 服务支持 ([46509f0](https://github.com/qiutongxue/oba-live-tool/commit/46509f0))

### 🐞 Bug Fixes

- **自动发言:** 修复小红书平台无法正常发送评论的问题 ([6bb4b71](https://github.com/qiutongxue/oba-live-tool/commit/6bb4b71))
- **中控台:** 增加小红书连接中控台的容错 ([932640f](https://github.com/qiutongxue/oba-live-tool/commit/932640f))
- **中控台:** 优化连接中控台时的提示内容 ([e5f226f](https://github.com/qiutongxue/oba-live-tool/commit/e5f226f))

## v1.5.5

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.4...v1.5.5)

### 🚀 Features

- **自动回复:** 添加了过滤器，可以设置满足过滤器条件时的回复信息 ([#130](https://github.com/qiutongxue/oba-live-tool/pull/130))

### 🐞 Bug Fixes

- **自动回复:** 修复了自动回复的设置在不同账号间切换导致的异常问题

## v1.5.4

[compare changes](https://github.com/qiutongxue/oba-live-tool/compare/v1.5.3...v1.5.4)

### 🚀 Features

- 新增快手小店登录 ([fb7d842](https://github.com/qiutongxue/oba-live-tool/commit/fb7d842))
- 新增快手小店的自动弹窗和自动发言 ([4bed9d7](https://github.com/qiutongxue/oba-live-tool/commit/4bed9d7))
- **自动回复:** 添加新设置-当订单已支付时才自动回复, fix #118 ([#118](https://github.com/qiutongxue/oba-live-tool/issues/118))
- **更新器:** 显示新版本的更新内容 #31 ([#31](https://github.com/qiutongxue/oba-live-tool/issues/31))

### 🐞 Bug Fixes

- 修复部分错误无法被正确捕捉的问题 ([c08c1e0](https://github.com/qiutongxue/oba-live-tool/commit/c08c1e0))
- **自动发言:** 降低随机空格中空格出现的概率，随机发送时不和上一条重复, fix #120 ([#120](https://github.com/qiutongxue/oba-live-tool/issues/120))

