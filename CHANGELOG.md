# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 未发布

### 变更

- 入口不再写 `version` 与 `description`，一律取 package.json。此前入口里的版本停在 0.1.0，面板与
  启动日志显示的都是这个旧号，内核 0.6.5 起还会为此警告。`name` 仍写在入口里：省掉它要内核 0.6.5。

## 0.4.0 — 2026-09-14

仍要求 `core >=0.6.0`（`getFileUrl` 的门面转发要那一版的 `OPTIONAL_METHODS`），peer 不变。

### 新增

- **实现 `getFileUrl(fileId)`：把平台的文件 id 换成可取用的地址，并上报 `getFileUrl` 能力。**
  有些消息（尤其群文件）只给一个 `file_id`、不给可下载链接，插件要拿内容就得先换。本方法调
  OneBot 的 `get_file`（参数 `{ file_id }`），从返回里**优先取直链 `url`、否则退回本机绝对路径
  `file`/`path`**（`get_file` 的返回里 `file` 是本地路径，与发送时语义相反），两者都没有就报错 ——
  不返回空串，空串会被下游当成一个合法但指向空的地址。解析抽成 `media.ts` 的 `fileRefFromGetFile`。

- **收消息时把只给了 file_id 的媒体段归一成 `path` / `url`（`codec.ts` 的 `normalizeFileSegments`）。**
  纯函数，`resolve` 由调用方注入（`bot.ts` 用 `get_file` 实现，失败即返回 undefined、原样保留那一段，
  不毁掉整条消息）。**应用在 `getMessage` 这条按需路径上，不挂到实时 `onEvent`** —— 后者要给每条含
  id 媒体的消息多打一次 `get_file`，还会打乱消息顺序（`onEvent` 是 fire-and-forget），与内核
  「引用只填 id、用时再补」同一分寸。插件要实时取文件用 `bot.getFileUrl(id)` 即可，平台无关。

  新增用例：能力上报、`get_file` 取直链 / 退路径 / 都无则报错、`getMessage` 归一化，以及
  `normalizeFileSegments` 八条（只动 kind:id、空 id 不解析、已是 url/path 不重复解析、resolve
  返回 undefined 原样保留、非媒体段穿过等）。

## 0.3.0 — 2026-09-14

> **BREAKING CHANGE**：要求 `core >=0.6.0`。内核自那一版起不再过滤自身消息，这道闸门只在本插件里。

### 新增

- **账号级配置项 `ignoreSelf`（缺省 true）：本账号自己发出的消息投不投进内核。**

  内核 0.6.0 把这道闸门下放给了适配器，理由是「平台会不会回报自身消息」只有适配器知道。此前
  `message_sent` 在本插件里是**无条件丢弃**的，现在成了每账号可配 —— 同一个实例上，一个号可以
  开着自我响应做复读，另一个号照旧忽略。

  缺省 true 与旧内核的 `bot.ignoreSelf` 一致，故升级后行为不变。关掉之前先确认插件能自行判断
  发送者，否则「复读」一类的命令会回复自己的回复，一条指令派生出无限条。

### 变更

- **peer 抬到 `core >=0.6.0`。** 不是「偏保守」：装在 0.5.x 上时那一侧仍在过滤自身消息，于是本
  插件的 `ignoreSelf` 关掉也不生效，而使用者看不出是版本问题。
- 删掉 `transport.ts`、`pending.ts`、`events.ts` 里重复论证同一判据的段落，保留判据本身。

109 条用例（原 108）：新增一条钉住 `ignoreSelf: false` 时 `message_sent` 确实会被投递。

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
