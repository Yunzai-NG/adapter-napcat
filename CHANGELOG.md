# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.2.0 — 2026-08-30

### 变更

- **peer 范围抬到 `core >=0.2.0`、`types >=0.1.1`。** 原先的 `^0.1.0` 不是「偏保守」而是不可满足：
  semver 下它等于 `>=0.1.0 <0.2.0`，把当时的内核 0.2.0 排除在外。索引的 `minCore` 一并跟上 ——
  那道门是下限判定，留 0.1.0 会让市场把本插件装到一个它自己的 `package.json` 拒绝的内核上。
- **不再发 npm**：加 `private`，去掉 `files`。沿用 renderer-puppeteer 已有的做法 —— `files` 是
  发布清单，没有发布动作时它不描述任何事实。CI 里本来就没有 publish 步骤。
- 删掉 36 行重复的注释散文（签名密钥、http 收不到事件等各处的第二遍复述，改为指向首次说明处）。
  密度 35.3%，仍低于 core 43.1% 与 webui-plugin 48.2%，故未继续裁剪：剩下占比高的文件是 eslint
  要求的逐成员 TSDoc。
- README：市场安装现会自动装依赖并编译，手工两步只在从源码装时才需要。

### 修复

- **重载时的错误归因指错了地方。** 内核 0.2.0 起 `ctx.http` 派生自插件的卸载信号，重载或停机会
  中止在途请求；而 `transport-http` 的 `call()` 此前把 catch 到的一切都包成「请检查 NapCat 的
  网络配置是否已启用、端口是否一致」。于是每次重载都会在日志里留下一句指向 NapCat 的排查建议，
  而 NapCat 一切正常。改为 `AbortError` 原样抛出。新增 `transport-http.test.ts` 5 个用例覆盖这条
  与另外三条归因（401/403 归 token、404 归地址、非 JSON 归对端），已确认去掉该分支后中止那条
  会失败。

108 条用例（原 103）。

## 0.1.0 — 2026-08-29

以 OneBot v11 协议接入 NapCat，支持正向 WebSocket、反向 WebSocket、HTTP 与 HTTP 上报四种网络
模式。
