/**
 * 模块职责：`BotDriver` 实现 —— 将内核的通用能力面转换为 OneBot v11（NapCat / LLOneBot / SnowLuma）的 API 调用
 * 依赖方向：依赖 transport / codec / events / config 与类型包
 * 生命周期：一个账号对应一个实例，`connect()` 与 `disconnect()` 各调用一次
 * 注意事项：**`SendOptions` 里只有 `quote` 会传到本层。** 超长切分、`recallAfter`、`autoForward` 都由
 *          内核的 Bot 门面在调用本驱动之前处理完了，此处再实现一遍只会得到两套互相冲突的切分逻辑。
 *
 *          **`message_id` 在三家里都是数字**，而通用模型里一律是字符串，故回传时必须转数字 ——
 *          传字符串会被它的 schema 拒绝、返回 `retcode: 1400`，而那条错误信息完全看不出是类型问题。
 *
 *          **群成员按需拉取 + LRU/TTL。** 启动时全量写入且从不淘汰的话，数十个千人群就占几百 MB。
 *          `getGroupMemberList` 刻意**不**回填该缓存：一次「群签到排行」会把上千个冷条目挤进去，
 *          从而把真正高频的那几十个热条目全部挤出。
 *
 *          **携带 nodes 的合并转发须在此处截取。** OneBot 没有「消息中嵌入转发」这种表达，转发必须走
 *          `send_*_forward_msg`；不截取的话编码阶段会把它丢掉，表现为「调了 reply 却什么都没发出」。
 *
 *          **戳一戳段同样在此截取，改走 `send_poke`。** NapCat 的 send_msg 把 poke 段转成空（源码里
 *          `[OB11MessageDataType.poke]: async () => undefined`），只带它一段时报「消息为空」。LLOneBot
 *          的 send_msg 干脆不认 poke 段，同样得走 send_poke，参数两家一样。
 */
import type {
  AdapterHost,
  BotCapability,
  BotDriver,
  ForwardNode,
  GroupInfo,
  GroupRole,
  HttpClient,
  MediaRef,
  MemberInfo,
  MemberListOptions,
  MessageContent,
  MessageRecord,
  PokeSegment,
  SendOptions,
  SendResult,
  SendTarget,
  Segment,
  UserInfo
} from "@yunzai-ng/types"
import { parseDuration, seg, toSegments } from "@yunzai-ng/core"
import { encodeNodes, encodeSegments, normalizeFileSegments, PLATFORM } from "./codec.js"
import { decodeMessage } from "./codec.js"
import { detectImpl, implLabel } from "./dialect.js"
import { decodeEvent, describePoke, isPoke } from "./events.js"
import { isInbound, isOutbound, peerUrlOf } from "./config.js"
import type { NapcatAccount } from "./config.js"
import { num, obj, str } from "./fields.js"
import type { Fields } from "./fields.js"
import { fileRefFromGetFile } from "./media.js"
import type { MediaEncodeOptions, OneBotFileFields } from "./media.js"
import { createHttpTransport } from "./transport-http.js"
import { createWsClientTransport } from "./transport-ws.js"
import { createWsReverseTransport } from "./transport-ws-reverse.js"
import type { Transport } from "./transport.js"

/** 本适配器声明支持的可选能力 */
const CAPS: readonly BotCapability[] = [
  "recall",
  "forward",
  "groupCard",
  "groupMute",
  "groupWholeMute",
  "groupKick",
  "groupFile",
  "friendRequest",
  "groupRequest",
  "reaction",
  "getFileUrl",
  "poke"
]

/**
 * base64 直传的上限
 *
 * 单帧 WebSocket 无法承载过大的载荷，超出后通常表现为"连接无故断开"。设定一个明确的
 * 上限，可将其转化为一条可理解的错误。
 */
const MAX_INLINE_BYTES = 16 * 1024 * 1024

/**
 * QQ 头像地址
 *
 * 通用模型中 `avatar` 为可选项，但面板与多数插件均需显示头像。QQ 的头像具有稳定的
 * 公开地址，直接拼接的代价低于增加一次 API 调用。
 * @param uid QQ 号
 * @returns 头像地址
 */
function userAvatar(uid: string): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uid)}&s=640`
}

/**
 * 群头像地址
 * @param gid 群号
 * @returns 头像地址
 */
function groupAvatar(gid: string): string {
  return `https://p.qlogo.cn/gh/${encodeURIComponent(gid)}/${encodeURIComponent(gid)}/640`
}

/**
 * 将 NapCat 的消息 id 转换回数字
 *
 * 参见文件头第 2 条。无法转换为数字时原样传回 —— 该情形表明该 id 并非由 NapCat 生成
 * （例如由插件自行拼接），交由平台报错优于在此处伪装为成功。
 * @param messageId 通用模型中的消息 id
 * @returns 用于 API 参数的取值
 */
function messageIdParam(messageId: string): string | number {
  const parsed = Number(messageId)
  return Number.isSafeInteger(parsed) ? parsed : messageId
}

/**
 * `get_file` 的参数
 *
 * LLOneBot 只认 `file`，NapCat 与 SnowLuma 两个都认（`file` 为空时取 `file_id`），故两个一起送。
 * @param fileId 平台文件 id
 * @returns 参数
 */
function getFileParams(fileId: string): Record<string, unknown> {
  return { file: fileId, file_id: fileId }
}

/**
 * 解析成员信息
 * @param raw API 返回的成员对象
 * @param fallbackGid 返回值中未携带群号时采用的群号
 * @returns 成员信息
 */
function toMember(raw: Fields, fallbackGid: string): MemberInfo {
  const uid = str(raw, "user_id") ?? ""
  const role = str(raw, "role")
  const member: MemberInfo = {
    uid,
    gid: str(raw, "group_id") ?? fallbackGid,
    role: role === "owner" || role === "admin" ? (role as GroupRole) : "member",
    avatar: userAvatar(uid)
  }
  const name = str(raw, "nickname")
  if (name !== undefined) member.name = name
  const card = str(raw, "card")
  if (card !== undefined) member.card = card
  const title = str(raw, "title")
  if (title !== undefined) member.title = title
  const joinTime = num(raw, "join_time")
  if (joinTime !== undefined) member.joinTime = joinTime
  const lastSentTime = num(raw, "last_sent_time")
  if (lastSentTime !== undefined) member.lastSentTime = lastSentTime
  // NapCat 中的字段名为 shut_up_timestamp，通用模型中为 shutUpTime，二者均为禁言到期的秒级时间戳
  const shutUp = num(raw, "shut_up_timestamp")
  if (shutUp !== undefined) member.shutUpTime = shutUp
  return member
}

/**
 * 解析用户信息
 * @param raw API 返回的用户对象
 * @returns 用户信息
 */
function toUser(raw: Fields): UserInfo {
  const uid = str(raw, "user_id") ?? ""
  const user: UserInfo = { uid, avatar: userAvatar(uid) }
  const name = str(raw, "nickname")
  if (name !== undefined) user.name = name
  const remark = str(raw, "remark")
  if (remark !== undefined) user.remark = remark
  return user
}

/**
 * 解析群信息
 * @param raw API 返回的群对象
 * @returns 群信息
 */
function toGroup(raw: Fields): GroupInfo {
  const gid = str(raw, "group_id") ?? ""
  const group: GroupInfo = { gid, avatar: groupAvatar(gid) }
  const name = str(raw, "group_name")
  if (name !== undefined) group.name = name
  const count = num(raw, "member_count")
  if (count !== undefined) group.memberCount = count
  const max = num(raw, "max_member_count")
  if (max !== undefined) group.maxMemberCount = max
  return group
}

/** 创建驱动所需的外部依赖 */
export interface NapcatBotDeps {
  /** 适配器 id，用于拼接路由前缀 */
  adapterId: string
  /** 内核的 HTTP 客户端（HTTP 模式下使用） */
  http: HttpClient
}

/**
 * 按账号配置构造一条通道
 * @param account 账号配置
 * @param host 宿主
 * @param deps 外部依赖
 * @param hooks 通道回调
 * @returns 通道
 * @throws Error 需被动接入而未开启内置服务器时
 */
function buildTransport(
  account: NapcatAccount,
  host: AdapterHost,
  deps: NapcatBotDeps,
  hooks: { logger: AdapterHost["logger"]; onEvent: (p: Fields) => void; onClosed: (r: string) => void }
): Transport {
  const timeout = parseDuration(account.timeout, 15_000)
  const idleTimeout = parseDuration(account.idleTimeout, 0)
  const prefix = host.account.selfId ?? host.account.id.slice(0, 8)

  if (isInbound(account.mode) && !host.server.enabled) {
    // 于创建通道时即报出，而非等待对端连接失败后再行推断。ServerInfo.enabled 的注释中
    // 已专门说明该点：被动接入的适配器必须先检查该标志
    throw new Error(
      `「${account.mode === "ws-reverse" ? "反向 WebSocket" : "HTTP + 事件上报"}」模式需要内置服务器，` +
        `而其当前处于关闭状态。请在配置中开启 server.enable，或将连接方式改为正向 WS`
    )
  }

  /** 适配器路由的对外基址 */
  const scope = `/adapter/${deps.adapterId}`
  const httpBase = `${host.server.publicUrl.replace(/\/+$/, "")}${scope}${account.listenPath}`
  const wsBase = httpBase.replace(/^http/, "ws")

  switch (account.mode) {
    case "ws":
      return createWsClientTransport({
        url: account.url,
        token: account.token,
        timeout,
        idleTimeout,
        prefix,
        signal: host.signal,
        hooks
      })

    case "ws-reverse":
      return createWsReverseTransport({
        path: account.listenPath,
        token: account.token,
        timeout,
        idleTimeout,
        prefix,
        signal: host.signal,
        publicWsUrl: wsBase,
        hooks,
        register: (path, handler, wsOpts) => host.websocket(path, handler, wsOpts)
      })

    case "http":
    case "http-post":
      return createHttpTransport({
        inbound: account.mode === "http-post",
        url: account.httpUrl,
        path: account.listenPath,
        token: account.token,
        timeout,
        publicPostUrl: httpBase,
        http: deps.http,
        hooks,
        register: (method, path, handler, routeOpts) => host.route(method, path, handler, routeOpts)
      })
  }
}

/**
 * 创建一个 NapCat 账号驱动
 * @param account 已校验的账号配置
 * @param host 内核提供的宿主能力
 * @param deps 外部依赖
 * @returns 账号驱动（尚未连接）
 * @throws Error 配置与运行环境冲突（如被动模式而服务器处于关闭状态）时
 */
export function createNapcatBot(account: NapcatAccount, host: AdapterHost, deps: NapcatBotDeps): BotDriver {
  // 配置校验已执行过一次，此处为"被测试或其他插件直接构造"场景保留的断言 ——
  // 空地址将使 ws 客户端以一个含义不明的 URL 解析错误失败
  if (isOutbound(account.mode) && peerUrlOf(account) === "") {
    throw new Error(`${account.mode} 模式必须填写对端地址`)
  }

  /** 平台账号 id，连接建立后回填 */
  let selfId = host.account.selfId ?? ""
  /** 昵称，连接建立后回填 */
  let nickname = ""

  /** 群成员缓存：按需拉取，LRU + TTL（参见文件头第 3 条） */
  const members = host.createCache<MemberInfo>({
    max: account.memberCacheMax,
    // 先解析为毫秒数：配置中的时长为任意字符串（使用者可能填写 "10分钟"），而
    // `DurationLike` 为模板字面量类型，仅接受 `10m` 一类写法。`parseDuration`
    // 为内核统一的宽松解析入口，无法解析时退回默认值而不抛错
    ttl: parseDuration(account.memberCacheTtl, 600_000)
  })

  /** 媒体编码参数 */
  const mediaOpts: MediaEncodeOptions = {
    localFileAccess: account.localFileAccess,
    maxInlineBytes: MAX_INLINE_BYTES
  }

  const transport = buildTransport(account, host, deps, {
    logger: host.logger,
    onEvent: payload => {
      // 自身消息投不投由账号配置决定：内核已不再过滤，缺省不投
      const event = decodeEvent(payload, { selfMessages: !account.ignoreSelf })
      if (event === undefined) return
      // 内核只给消息记「收到」，通知不记；戳一戳是使用者会当成一条消息来看的那种，不记则日志里
      // 只有机器人戳回去的那行「已发出」，看不出它在回应什么
      if (event.kind === "notice" && isPoke(payload)) host.logger.info(describePoke(payload, `${PLATFORM}:${selfId}`))
      host.submit(event)
    },
    onClosed: reason => {
      // 交由内核执行完整的下线流程（摘除 Bot 注册表、发送 bot/offline、排入退避重连）
      host.setStatus("offline", { error: reason })
    }
  })

  /**
   * 调用一次 API
   * @param action API 名
   * @param params 参数
   * @returns 响应数据
   */
  const call = <T>(action: string, params?: Record<string, unknown>): Promise<T> => transport.call<T>(action, params)

  /**
   * 用 `get_file` 把一个 file_id 换成媒体引用
   *
   * **换不到就返回 undefined、不抛错** —— 这是给消息段归一化用的：一个文件换不到地址，
   * 不该毁掉整条消息里的其余内容。要在拿不到时报错的场合（`getFileUrl`）另走一条不吞错的路。
   * @param fileId 平台文件 id
   * @returns 媒体引用；换不到时 undefined
   */
  const probeFile = async (fileId: string): Promise<MediaRef | undefined> => {
    try {
      return fileRefFromGetFile((await call<Fields>("get_file", getFileParams(fileId))) as OneBotFileFields)
    } catch {
      return undefined
    }
  }

  /**
   * 取目标对应的发送参数
   * @param target 发送目标
   * @returns API 参数片段
   * @throws Error 目标为频道（OneBot v11 不含频道）时
   */
  const targetParams = (target: SendTarget): Record<string, unknown> => {
    if (target.scene === "group") return { message_type: "group", group_id: target.gid }
    if (target.scene === "private") {
      // 群临时会话须携带来源群，否则 NapCat 无法定位该会话
      return target.gid === undefined
        ? { message_type: "private", user_id: target.uid }
        : { message_type: "private", user_id: target.uid, group_id: target.gid }
    }
    throw new Error("本适配器不支持频道消息：OneBot v11 中不存在频道这一概念")
  }

  /**
   * 自发送结果中取消息 id
   * @param data API 返回
   * @returns 发送结果
   */
  const toSendResult = (data: unknown): SendResult => {
    const fields = (typeof data === "object" && data !== null ? data : {}) as Fields
    return {
      ok: true,
      messageId: str(fields, "message_id") ?? "",
      time: Date.now(),
      raw: data
    }
  }

  /**
   * 发送合并转发
   * @param target 发送目标
   * @param nodes 转发节点
   * @param display 外显字段
   * @returns 发送结果
   */
  const sendForwardTo = async (
    target: SendTarget,
    nodes: readonly ForwardNode[],
    display: { source?: string; summary?: string; prompt?: string } = {}
  ): Promise<SendResult> => {
    const messages = await encodeNodes(nodes, mediaOpts)
    const action = target.scene === "group" ? "send_group_forward_msg" : "send_private_forward_msg"
    const params: Record<string, unknown> = { messages }
    if (target.scene === "group") params["group_id"] = target.gid
    else if (target.scene === "private") params["user_id"] = target.uid
    else throw new Error("本适配器不支持向频道发送合并转发")

    // 外显字段位于**顶层**而非 node 之内 —— 置于 node 中不会报错，仅静默不生效
    if (display.source !== undefined) params["source"] = display.source
    if (display.summary !== undefined) params["summary"] = display.summary
    if (display.prompt !== undefined) params["prompt"] = display.prompt

    return toSendResult(await call(action, params))
  }

  /**
   * 发一次戳一戳
   *
   * 私聊不给被戳者时戳会话对方，`e.reply(seg.poke())` 即「戳回去」；群里没有这个缺省，得指明戳谁。
   * @param target 发送目标
   * @param poke 戳一戳段
   * @returns 发送结果；send_poke 不回消息 id，故 messageId 为空串
   * @throws Error 群里未指明被戳者、或目标为频道时
   */
  const sendPoke = async (target: SendTarget, poke: PokeSegment): Promise<SendResult> => {
    let params: Record<string, unknown>
    if (target.scene === "group") {
      if (poke.uid === undefined) throw new Error("群里戳一戳须指明被戳者：seg.poke(uid)")
      params = { group_id: target.gid, user_id: poke.uid }
    } else if (target.scene === "private") {
      params = { user_id: target.uid, target_id: poke.uid ?? target.uid }
    } else {
      throw new Error("本适配器不支持在频道里戳一戳")
    }
    return toSendResult(await call("send_poke", params))
  }

  const driver: BotDriver = {
    platform: PLATFORM,
    adapterId: deps.adapterId,
    caps: new Set(CAPS),

    get selfId(): string {
      return selfId
    },
    get nickname(): string {
      return nickname
    },
    get online(): boolean {
      return transport.ready
    },

    async connect(): Promise<void> {
      await transport.open()

      // 连接建立之后立即查询一次登录信息：内核需以 selfId 回填账号记录，面板需显示昵称。
      // 该调用同时验证了通道确可双向通行 —— socket 已连接并不代表 API 可用
      const info = await call<Fields>("get_login_info")
      selfId = str(info, "user_id") ?? selfId
      nickname = str(info, "nickname") ?? ""
      // 只为日志里说清连上的是谁；认不出也照常连，见 dialect.ts
      const peer = await detectImpl(action => call(action))
      host.logger.info(`已接入 ${implLabel(peer)}：${nickname || selfId}（${transport.describe}）`)
    },

    async disconnect(): Promise<void> {
      members.clear()
      await transport.close()
    },

    async sendMessage(target: SendTarget, content: MessageContent, opts?: SendOptions): Promise<SendResult> {
      const segments = toSegments(content)

      // 参见文件头第 4 条：携带 nodes 的转发必须经专门的 API 发送
      const forward = segments.find(item => item.type === "forward" && item.nodes !== undefined)
      if (forward?.type === "forward" && forward.nodes !== undefined) {
        const others = segments.filter(item => item !== forward && item.type !== "reply")
        if (others.length > 0) {
          host.logger.warn(
            `一条消息中同时存在合并转发与 ${others.length} 个其他消息段，` +
              `OneBot 不支持该组合，其他消息段已被丢弃`
          )
        }
        const display: { source?: string; summary?: string; prompt?: string } = {}
        if (forward.source !== undefined) display.source = forward.source
        if (forward.summary !== undefined) display.summary = forward.summary
        if (forward.prompt !== undefined) display.prompt = forward.prompt
        return sendForwardTo(target, forward.nodes, display)
      }

      // 参见文件头第 5 条。戳在前、其余内容在后，与消息里的书写顺序无关
      const pokes = segments.filter((item): item is PokeSegment => item.type === "poke")
      let poked: SendResult | undefined
      for (const poke of pokes) poked = await sendPoke(target, poke)
      const rest = pokes.length === 0 ? segments : segments.filter(item => item.type !== "poke")
      // 只剩引用段时不再发：一条只有引用、没有正文的消息不存在
      if (poked !== undefined && rest.every(item => item.type === "reply")) return poked

      // 引用回复在 OneBot 中为消息段而非发送参数，故置于消息序列首位
      const withQuote: Segment[] = opts?.quote === undefined ? rest : [seg.reply(opts.quote), ...rest]

      const { message, dropped } = await encodeSegments(withQuote, mediaOpts)
      if (dropped.length > 0) {
        host.logger.warn(`以下消息段在 OneBot v11 上不存在对应表达，已丢弃：${dropped.join("、")}`)
      }
      if (message.length === 0) throw new Error("消息为空，没有可发送的内容")

      return toSendResult(await call("send_msg", { ...targetParams(target), message }))
    },

    async sendForward(target: SendTarget, nodes: ForwardNode[]): Promise<SendResult> {
      return sendForwardTo(target, nodes)
    },

    async recallMessage(messageId: string): Promise<boolean> {
      await call("delete_msg", { message_id: messageIdParam(messageId) })
      return true
    },

    async getSelfInfo(): Promise<UserInfo> {
      return toUser(await call<Fields>("get_login_info"))
    },

    async getFriend(uid: string): Promise<UserInfo | undefined> {
      // no_cache 显式取 false：NapCat 在该字段省略时按 true 处理（强制拉取），
      // 而查询昵称一类的读取无需绕过其自身缓存
      const raw = await call<Fields>("get_stranger_info", { user_id: uid, no_cache: false })
      return toUser(raw)
    },

    async getFriendList(): Promise<UserInfo[]> {
      const list = await call<unknown>("get_friend_list", { no_cache: false })
      return Array.isArray(list) ? list.map(item => toUser(item as Fields)) : []
    },

    async getGroup(gid: string): Promise<GroupInfo | undefined> {
      return toGroup(await call<Fields>("get_group_info", { group_id: gid, no_cache: false }))
    },

    async getGroupList(): Promise<GroupInfo[]> {
      const list = await call<unknown>("get_group_list", { no_cache: false })
      return Array.isArray(list) ? list.map(item => toGroup(item as Fields)) : []
    },

    async getGroupMember(gid: string, uid: string): Promise<MemberInfo | undefined> {
      // `fetch` 自带并发去重：一条群消息中多处判定权限仅产生一次 API 调用
      return members.fetch(`${gid}:${uid}`, async () => {
        const raw = await call<Fields>("get_group_member_info", { group_id: gid, user_id: uid, no_cache: false })
        return toMember(raw, gid)
      })
    },

    async getGroupMemberList(gid: string, opts?: MemberListOptions): Promise<MemberInfo[]> {
      const list = await call<unknown>("get_group_member_list", {
        group_id: gid,
        no_cache: opts?.refresh === true
      })
      if (!Array.isArray(list)) return []
      const limited = opts?.limit === undefined ? list : list.slice(0, opts.limit)
      // 刻意不回填 members 缓存，参见文件头第 3 条
      return limited.map(item => toMember(item as Fields, gid))
    },

    async setGroupCard(gid: string, uid: string, card: string): Promise<void> {
      await call("set_group_card", { group_id: gid, user_id: uid, card })
      // 名片已变更，须立即失效缓存中的该条，否则后续十分钟内读到的仍为旧名片
      members.delete(`${gid}:${uid}`)
    },

    async muteGroupMember(gid: string, uid: string, seconds: number): Promise<void> {
      await call("set_group_ban", { group_id: gid, user_id: uid, duration: seconds })
      members.delete(`${gid}:${uid}`)
    },

    async muteGroupAll(gid: string, enable: boolean): Promise<void> {
      await call("set_group_whole_ban", { group_id: gid, enable })
    },

    async kickGroupMember(gid: string, uid: string, rejectAddAgain?: boolean): Promise<void> {
      await call("set_group_kick", { group_id: gid, user_id: uid, reject_add_request: rejectAddAgain === true })
      members.delete(`${gid}:${uid}`)
    },

    async quitGroup(gid: string): Promise<void> {
      await call("set_group_leave", { group_id: gid, is_dismiss: false })
    },

    async handleFriendRequest(flag: string, approve: boolean, remark?: string): Promise<void> {
      await call("set_friend_add_request", { flag, approve, remark: remark ?? "" })
    },

    async handleGroupRequest(flag: string, approve: boolean, reason?: string): Promise<void> {
      await call("set_group_add_request", { flag, approve, reason: reason ?? "" })
    },

    async setReaction(messageId: string, emojiId: string, add = true): Promise<void> {
      await call("set_msg_emoji_like", { message_id: messageIdParam(messageId), emoji_id: emojiId, set: add })
    },

    async uploadGroupFile(gid: string, file: string, name: string, folder?: string): Promise<void> {
      const params: Record<string, unknown> = { group_id: gid, file, name }
      if (folder !== undefined) params["folder"] = folder
      await call("upload_group_file", params)
    },

    async getMessage(messageId: string): Promise<MessageRecord | undefined> {
      const raw = await call<Fields>("get_msg", { message_id: messageIdParam(messageId) })
      const sender = obj(raw, "sender") ?? {}
      const gid = str(raw, "group_id")
      const record: MessageRecord = {
        messageId: str(raw, "message_id") ?? messageId,
        time: (num(raw, "time") ?? 0) * 1000,
        sender: gid === undefined ? toUser(sender) : toMember({ ...sender, group_id: gid }, gid),
        // 取一条历史消息本就在按需路径上（补全引用、翻历史），故顺手把只给了 file_id 的媒体段
        // 归一成 path/url，插件读到的引用内容便无需再判平台。实时收到的消息不在此处归一 ——
        // 那要给每条含 id 媒体的消息多打一次 get_file，与「引用只填 id、用时再补」同一分寸
        message: await normalizeFileSegments(decodeMessage(raw["message"]), probeFile)
      }
      if (gid !== undefined) record.group = { gid, avatar: groupAvatar(gid) }
      return record
    },

    async getFileUrl(fileId: string): Promise<string> {
      // 与 probeFile 不同,这里不吞错:网络失败该冒泡给调用方(BotApi 的约定)。
      // 拿不到可用地址时也明确抛错,不返回空串 —— 空串会被下游当成一个合法但指向空的地址
      const ref = fileRefFromGetFile((await call<Fields>("get_file", getFileParams(fileId))) as OneBotFileFields)
      if (ref === undefined) {
        throw new Error(`get_file 未返回可用的 url 或本地路径（file_id=${fileId}）`)
      }
      return ref.kind === "url" ? ref.url : ref.path
    },

    callApi<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      return call<T>(action, params)
    }
  }

  return driver
}
