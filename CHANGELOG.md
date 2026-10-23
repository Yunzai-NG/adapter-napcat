# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.7.0 — 2026-10-23

### 新增

- **支持 [SnowLuma](https://snowluma.github.io/zh/)。** 它的 OneBot v11 与 NapCat 同一套：缺省端口 3000 / 3001、
  路径 `/`、上报签名 `x-signature: sha1=…`、心跳 30 秒，扩展接口（`send_poke`、`set_msg_emoji_like`、
  合并转发、群文件、`get_file`）同名同参，私聊戳一戳也给 `sender_id`，故驱动不分岔。连上之后日志里写成
  「已接入 SnowLuma 2.1.1-node：昵称」。面板上的名字改为「OneBot v11（NapCat / LLOneBot / SnowLuma）」，
  适配器 id 仍是 `napcat`。
- 正向 WS 握手被拒（401 / 403）而账号没填 token 时，报错指明去哪儿抄：SnowLuma 给每条网络配置自动生成
  token，照「对端缺省不鉴权」留空的话一定被拒。Access Token 一栏的说明同样写上这一句。

### 修复

- 正向 WS 握手回 400 时也报成「路径有误」：SnowLuma 对不认识的路径回 `400 Bad path`，此前落到兜底的
  「连接失败」。
- 补上 SnowLuma 的 retcode 1401（鉴权失败）与 1413（请求体过大）的排查提示。

## 0.6.0 — 2026-10-22

### 变更

- **改名 adapter-onebot**，仓库迁到 [Yunzai-NG/adapter-onebot](https://github.com/Yunzai-NG/adapter-onebot)。
  **适配器 id 仍是 `napcat`**，已有账号原样认得；反向 WS 与 HTTP 上报的地址（`/adapter/napcat/…`）也不变，
  协议端那边不用改。从 adapter-napcat 换过来：在插件页删掉 adapter-napcat 的目录，再从插件市场装 adapter-onebot
  —— 两个同时在会抢同一个适配器 id，后加载的那个报错。
- 表单的「对端地址」拆成「WebSocket 地址」与「HTTP 地址」两栏，各按连接方式出现：此前一栏只能有一个缺省值，
  选了 HTTP 预填的仍是 `ws://127.0.0.1:3001`。HTTP 地址缺省 `http://127.0.0.1:3000`（两家 HTTP 服务器的缺省端口）。
  旧账号存在原来那栏里的 HTTP 地址照常认得，编辑时那一栏是空的，原样保存也不会丢。
- 只发不收的「HTTP」模式不再显示「忽略自身消息」；各栏说明补上协议端里对应项的位置与缺省端口、
  反向 WS / HTTP 上报的完整地址怎么拼、多个账号须各用一条监听路径。

### 修复

- **反向 WS 与 HTTP 上报没填 Access Token 时只接受本机连入。** 说明里一直写着「留空仅限本机回环」，
  实际却谁都放：面板监听在 `0.0.0.0` 时，能连到端口的人可以冒充协议端、伪造一条「主人发来的」消息。
  对端在容器或另一台机器上的，两边填上同一个 token；面板经反向代理对外时也必须填，那时连入的地址都是本机。

### 新增

- **支持 LLOneBot（现名 LuckyLilliaBot）。** 连接方式、鉴权、上报签名与 NapCat 一致，四种网络模式照常
  可用；两家扩展出来的接口（戳一戳、表情回应、合并转发、群文件、`get_file`）同名、参数也对得上，故不必
  选「连的是哪家」。连上之后调一次 `get_version_info` 认出对端，日志里写成「已接入 LLOneBot 7.x：昵称」。
  对端不认这个接口也照常连上，3 秒内不回就不等了。
- 面板上的名字改为「OneBot v11（NapCat / LLOneBot）」，表单里的「NapCat 地址」「NapCat 可读取本机文件」
  改称「对端地址」「对端可读取本机文件」。**适配器 id 仍是 `napcat`**，已有账号不受影响。

### 修复

- `get_file` 同时送 `file` 与 `file_id`：LLOneBot 只认前者，此前 `bot.getFileUrl()` 与取历史消息时的
  媒体归一在它上面全部失败。
- LLOneBot 的私聊戳一戳不带 `sender_id`，机器人戳好友时报成「好友戳了好友」，自戳过滤拦不住，写成
  「谁戳就戳谁」的插件会自己跟自己来回戳。现在私聊里发起者与被戳者相同、又没有 `sender_id` 时认作机器人
  自己戳的，缺省不投（`ignoreSelf` 关掉时照投）。
- HTTP 模式下 LLOneBot 对不认识的接口回真的 404，此前报成「该地址可能指向了其他服务」；现在照它回的
  报文说「不支持该 API」。
- 报错与日志里的「NapCat」改称「对端」，并补上 LLOneBot 在 HTTP 上用的 retcode（200 / 400 / 404）的
  排查提示。

## 0.5.0 — 2026-10-18

### 新增

- **机器人可以戳一戳了，`caps` 里多了 `poke`。** 消息里的 `seg.poke(uid?)` 被截下来改走 NapCat 的
  `send_poke`。此前它会被编进 `send_msg`，而 NapCat 收到 poke 段一律转成空：只发一个戳一戳时报
  「消息为空」，与文字同发时戳一戳被静默吞掉。私聊里不给被戳者时戳会话对方，故收到戳一戳后
  `e.reply(seg.poke())` 就是戳回去；群里须指明戳谁（`seg.poke(e.uid)`），否则报错，不发请求。与文字
  同发时先戳、文字照常发出，返回值取文字那条的消息 id。只发戳一戳时 `messageId` 为空串（`send_poke`
  不回 id）。`pokeType` 不起作用：NapCat 的接口没有这个参数。
- **收到戳一戳时记一行 info 日志**，格式与消息日志一致，例如
  `[onebot11:10000][群 700000] 10001 戳了戳 10000 的脑袋`。动作词和后缀取自灰条文字，取不到时写
  「戳了戳」。内核只给消息记「收到」，此前日志里只看得到机器人回应时那行「已发出」，看不出它在回应什么。

### 修复

- **私聊戳一戳的发起者取错了人。** NapCat 私聊戳一戳报文里的 `user_id` 是会话对方，发起者在
  `sender_id`。此前取的是 `user_id`，机器人戳好友会被读成「好友戳了好友」。群里的戳一戳不受影响。

### 变更

- **机器人自己戳出去的戳一戳也受 `ignoreSelf` 管，缺省不投。** NapCat 会把它当成一条普通的戳一戳上报。
  写成「谁戳就戳谁」的插件收到它，就会自己跟自己来回戳下去。

## 0.4.1 — 2026-10-18

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
