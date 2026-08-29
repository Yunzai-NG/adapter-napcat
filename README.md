# adapter-napcat

Yunzai NG 的 NapCat 适配器，以 OneBot v11 协议接入，支持正向 WebSocket、反向 WebSocket、
HTTP 与 HTTP 上报四种网络模式。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `adapter-napcat` → 安装。

亦可手工克隆至主目录的 `plugins/` 下：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-napcat.git
cd adapter-napcat
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

## 配置

首次加载后于 `<主目录>/config/adapter-napcat.yaml` 生成配置文件，亦可在面板的插件页直接编辑。
账号的连接方式与 NapCat 侧的对应关系见
[上手文档](https://github.com/Yunzai-NG/yunzai-ng/blob/main/docs/getting-started.md#添加-qq-账号)。

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\adapter-napcat
pnpm install
pnpm run link:framework # 在 node_modules/@yunzai-ng 下建立指向框架的链接
pnpm run verify         # build → typecheck:test → lint → test
```

`link:framework` 按 `YZNG_FRAMEWORK` 环境变量 → `../yunzai-ng` → `../../yunzai-ng` →
`../../code` 的顺序查找框架仓库。目录布局与上述不同时设置该环境变量即可：

```powershell
$env:YZNG_FRAMEWORK = "c:\path\to\yunzai-ng"
```

框架发布之后，`pnpm install` 即可满足依赖，该步骤不再必需。

## 许可

AGPL-3.0-or-later
