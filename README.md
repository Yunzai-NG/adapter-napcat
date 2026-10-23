# adapter-onebot

Yunzai NG 的 OneBot v11 适配器，接 [NapCat](https://napneko.github.io/)、
[LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot)（现名 LuckyLilliaBot）与
[SnowLuma](https://snowluma.github.io/zh/)，支持正向 WebSocket、
反向 WebSocket、HTTP 与 HTTP 上报四种网络模式。原名 adapter-napcat；适配器 id 仍是 `napcat`，已有账号不受影响。

本仓库是 [Yunzai NG](https://github.com/Yunzai-NG/yunzai-ng) 的官方可选插件，不随内核分发。

## 安装

推荐经面板的插件市场安装：面板 → 插件市场 → 搜索 `adapter-onebot` → 安装。**装依赖与编译都由内核代跑**
（索引里声明了 `setup.scripts: ["build"]`），故这条路装完即可用 —— 本仓库的 `dist/` 不进 git，
不编译就没有入口。

亦可手工克隆至主目录的 `plugins/` 下，那时两步都要自己来：

```powershell
cd <主目录>\plugins
git clone https://github.com/Yunzai-NG/adapter-onebot.git
cd adapter-onebot
pnpm install
pnpm run build
```

随后在面板的插件页重载，或重启内核。

## 配置

本插件没有插件级配置，连接参数都在账号里：面板 → 账号 → 「OneBot v11（NapCat / LLOneBot / SnowLuma）」页签 → 添加账号。
连接方式与协议端那边怎么对应、各栏的缺省值，见[文档](https://yunzai-ng.github.io/plugins/adapter-onebot)。

从 adapter-napcat 换过来：在插件页删掉 adapter-napcat 的目录，再从插件市场装本插件。账号与协议端的配置都不用动。

## 开发

本插件依赖 `@yunzai-ng/core` 与 `@yunzai-ng/types`，两者声明为 `peerDependencies`
（运行期由宿主内核提供，插件目录内不应再装一份）。**框架发布至 npm 之前**，需先链接本地
框架 checkout：

```powershell
git clone https://github.com/Yunzai-NG/yunzai-ng.git
cd yunzai-ng
pnpm install
pnpm run build          # 必需：本插件的 tsc 读取框架的 dist/*.d.ts

cd ..\adapter-onebot
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
