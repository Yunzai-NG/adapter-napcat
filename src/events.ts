/**
 * 模块职责：将 NapCat 的上报报文翻译为内核的 `IncomingEvent`
 * 依赖方向：依赖 codec / fields 与类型包
 * 生命周期：纯函数
 * 注意事项：**认不出的事件不丢弃，降级为 `GenericNotice`。** 通用模型只为常见通知定义了具体形状，
 *          而 notice 的种类还在增加；丢弃的话，插件要处理新增通知就得等框架更新，降级并带上原始
 *          data 之后它可以自行解析。
 *
 *          **`message_sent` 缺省丢弃**，由账号配置项 `selfMessages` 决定是否投递：内核已不再过滤
 *          自身消息，这道闸门只在此处。开启后机器人会看到自己发出的消息，复读类命令即自我触发成死循环。
 *
 *          **引用只填 `messageId`，不补全正文。** 取正文要多调一次 `get_msg`，为每条含引用的消息都加
 *          一次 API 调用不可接受；内核会在插件实际使用时经 `QuoteResolver` 补全。
 *
 *          **私聊戳一戳的 `user_id` 是会话对方，不是发起者。** NapCat 把发起者另放在 `sender_id`；
 *          LLOneBot 不给这个字段，见 `pokeParties`。群里的 `user_id` 才是发起者。
 */
import type {
  GroupInfo,
  GroupRole,
  IncomingEvent,
  IncomingMessageEvent,
  IncomingNoticeEvent,
  MemberInfo,
  MessageScene,
  UserInfo
} from "@yunzai-ng/types"
import { decodeMessage } from "./codec.js"
import { num, obj, str, timeMs } from "./fields.js"
import type { Fields } from "./fields.js"

/**
 * OneBot 的 role 字段 → 通用角色
 * @param raw 原始值
 * @returns 群角色，无法识别时按普通成员处理
 */
function roleOf(raw: string | undefined): GroupRole {
  return raw === "owner" || raw === "admin" ? raw : "member"
}

/**
 * 解析发送者
 *
 * 群消息给出 `MemberInfo`（含 gid 与 role），私聊给出 `UserInfo`。该区分具有实际
 * 影响：`e.isGroupAdmin` 判定权限时读取的即为 `sender.role`，若统一给出 UserInfo，
 * 则全部成员均将被视为普通成员，`.admin()` 命令对群管理员亦会拒绝执行。
 * @param payload 事件报文
 * @param gid 群 id；私聊时 undefined
 * @returns 发送者信息
 */
function senderOf(payload: Fields, gid: string | undefined): UserInfo | MemberInfo {
  const raw = obj(payload, "sender") ?? {}
  const uid = str(raw, "user_id") ?? str(payload, "user_id") ?? ""
  const name = str(raw, "nickname")
  const card = str(raw, "card")
  const title = str(raw, "title")

  if (gid === undefined) {
    const user: UserInfo = { uid }
    if (name !== undefined) user.name = name
    return user
  }

  const member: MemberInfo = { uid, gid, role: roleOf(str(raw, "role")) }
  if (name !== undefined) member.name = name
  if (card !== undefined) member.card = card
  if (title !== undefined) member.title = title
  return member
}

/**
 * 解析消息事件
 * @param payload 事件报文
 * @returns 消息事件
 */
function decodeMessageEvent(payload: Fields): IncomingMessageEvent {
  const scene: MessageScene = str(payload, "message_type") === "group" ? "group" : "private"
  const gid = scene === "group" ? str(payload, "group_id") : undefined
  const message = decodeMessage(payload["message"])

  const event: IncomingMessageEvent = {
    kind: "message",
    scene,
    messageId: str(payload, "message_id") ?? "",
    message,
    sender: senderOf(payload, gid),
    raw: payload
  }

  const subType = str(payload, "sub_type")
  if (subType !== undefined) event.subType = subType
  const time = timeMs(payload)
  if (time !== undefined) event.time = time

  if (gid !== undefined) {
    const group: GroupInfo = { gid }
    event.group = group
  }

  // 引用信息位于消息段之中（`reply` 段），提升至事件层是因插件均自 `e.quote` 读取。
  // 段本身予以保留：插件将 `e.message` 原样转发时应连同引用一并传递
  const reply = message.find(item => item.type === "reply")
  if (reply?.type === "reply" && reply.messageId !== "") event.quote = { messageId: reply.messageId }

  return event
}

/** 群成员减少的方式映射 */
const DECREASE_WAY: Readonly<Record<string, "leave" | "kick" | "kickMe" | "other">> = {
  leave: "leave",
  kick: "kick",
  kick_me: "kickMe",
  disband: "other"
}

/** notice_type / notify 的 sub_type → 通用模型的点分类型名 */
const GENERIC_NOTICE: Readonly<Record<string, string>> = {
  group_upload: "group.upload",
  group_card: "group.card",
  essence: "group.essence",
  group_msg_emoji_like: "group.reaction",
  friend_add: "friend.add",
  bot_offline: "bot.offline",
  lucky_king: "group.luckyKing",
  honor: "group.honor",
  title: "group.title",
  group_name: "group.name",
  profile_like: "friend.profileLike",
  input_status: "friend.inputStatus",
  gray_tip: "group.grayTip"
}

/**
 * 判定一条报文是否为戳一戳
 * @param payload 事件报文
 * @returns 是否为戳一戳
 */
export function isPoke(payload: Fields): boolean {
  return str(payload, "notice_type") === "notify" && str(payload, "sub_type") === "poke"
}

/**
 * 取戳一戳的双方，见文件头第 4 条
 *
 * 私聊而**没有 `sender_id`**（LLOneBot）时，`user_id` 一律是那位好友，于是「机器人戳好友」报成了
 * `user_id` 与 `target_id` 都是好友。照单取的话自戳过滤拦不住它，写成「谁戳就戳谁」的插件会自己
 * 跟自己来回戳下去，故两者相同时把发起者认作机器人自己。代价是好友戳他自己也会被认成机器人戳他 ——
 * 宁可错认这一种，也不放过前一种。
 * @param payload 戳一戳报文
 * @returns 发起者与被戳者
 */
export function pokeParties(payload: Fields): { uid: string; targetId: string } {
  const targetId = str(payload, "target_id") ?? ""
  if (str(payload, "group_id") !== undefined) return { uid: str(payload, "user_id") ?? "", targetId }
  const sender = str(payload, "sender_id")
  if (sender !== undefined) return { uid: sender, targetId }
  const peer = str(payload, "user_id") ?? ""
  const self = str(payload, "self_id")
  return { uid: peer === targetId && self !== undefined ? self : peer, targetId }
}

/**
 * 把戳一戳写成一行日志
 *
 * 动作词取自 `raw_info` 里的灰条文字（「戳了戳」「拍了拍」、对方自定义的后缀），取不到时用「戳了戳」。
 * @param payload 戳一戳报文
 * @param via 收到它的账号，形如 `onebot11:10000`
 * @returns 单行描述
 */
export function describePoke(payload: Fields, via: string): string {
  const { uid, targetId } = pokeParties(payload)
  const texts: string[] = []
  const info = payload["raw_info"]
  if (Array.isArray(info)) {
    for (const item of info as Fields[]) {
      if (str(item, "type") === "nor") {
        const text = str(item, "txt")?.trim()
        if (text !== undefined && text !== "") texts.push(text)
      }
    }
  }
  const [action = "戳了戳", ...suffix] = texts
  const gid = str(payload, "group_id")
  const scene = gid === undefined ? "[私聊]" : `[群 ${gid}]`
  const tail = suffix.length > 0 ? ` ${suffix.join(" ")}` : ""
  return `[${via}]${scene} ${uid} ${action} ${targetId}${tail}`
}

/**
 * 解析通知事件
 * @param payload 事件报文
 * @returns 通知事件
 */
function decodeNoticeEvent(payload: Fields): IncomingNoticeEvent {
  const type = str(payload, "notice_type") ?? "unknown"
  const subType = str(payload, "sub_type")
  const gid = str(payload, "group_id")
  const uid = str(payload, "user_id")
  const operatorId = str(payload, "operator_id")
  const time = timeMs(payload)

  /** 为每种通知补充公共字段 */
  const base = <T extends IncomingNoticeEvent>(event: T): T => {
    event.raw = payload
    if (time !== undefined) event.time = time
    return event
  }

  switch (type) {
    case "group_increase":
      return base({
        kind: "notice",
        noticeType: "group.increase",
        gid: gid ?? "",
        uid: uid ?? "",
        ...(operatorId === undefined ? {} : { operatorId }),
        way: subType === "invite" ? "invite" : subType === "approve" ? "approve" : "other"
      })

    case "group_decrease":
      return base({
        kind: "notice",
        noticeType: "group.decrease",
        gid: gid ?? "",
        uid: uid ?? "",
        ...(operatorId === undefined ? {} : { operatorId }),
        way: DECREASE_WAY[subType ?? ""] ?? "other"
      })

    case "group_admin":
      return base({
        kind: "notice",
        noticeType: "group.admin",
        gid: gid ?? "",
        uid: uid ?? "",
        // `set` 表示设为管理员，`unset` 表示取消。取消后的角色只能为普通成员
        role: subType === "set" ? "admin" : "member"
      })

    case "group_ban": {
      const duration = subType === "lift_ban" ? 0 : (num(payload, "duration") ?? 0)
      // OneBot 以 `user_id: 0` 表示全体禁言 —— 其含义并非"禁言了 0 号用户"
      const whole = uid === undefined || uid === "0"
      return base({
        kind: "notice",
        noticeType: "group.mute",
        gid: gid ?? "",
        ...(whole ? {} : { uid }),
        ...(operatorId === undefined ? {} : { operatorId }),
        duration,
        whole
      })
    }

    case "group_recall":
    case "friend_recall":
      return base({
        kind: "notice",
        noticeType: "message.recall",
        ...(gid === undefined ? {} : { gid }),
        uid: uid ?? "",
        ...(operatorId === undefined ? {} : { operatorId }),
        messageId: str(payload, "message_id") ?? ""
      })

    case "notify":
      if (subType === "poke") {
        return base({
          kind: "notice",
          noticeType: "poke",
          ...(gid === undefined ? {} : { gid }),
          ...pokeParties(payload)
        })
      }
      return base({
        kind: "notice",
        noticeType: GENERIC_NOTICE[subType ?? ""] ?? `notify.${subType ?? "unknown"}`,
        ...(gid === undefined ? {} : { gid }),
        ...(uid === undefined ? {} : { uid }),
        data: payload
      })

    default:
      return base({
        kind: "notice",
        noticeType: GENERIC_NOTICE[type] ?? `onebot.${type}`,
        ...(gid === undefined ? {} : { gid }),
        ...(uid === undefined ? {} : { uid }),
        data: payload
      })
  }
}

/**
 * 解析一条上报报文
 *
 * @param payload 已解析的报文
 * @param opts 选项
 * @param opts.selfMessages 是否把自身发出的消息（含自己戳出去的戳一戳）也投给内核，缺省不投
 * @returns 内核事件；无需处理或报文不合法时 undefined
 */
export function decodeEvent(payload: Fields, opts: { selfMessages?: boolean } = {}): IncomingEvent | undefined {
  const postType = str(payload, "post_type")
  const time = timeMs(payload)

  switch (postType) {
    case "message":
      return decodeMessageEvent(payload)

    case "message_sent":
      // 见文件头第 2 条：缺省丢弃，账号显式要求时才投
      return opts.selfMessages === true ? decodeMessageEvent(payload) : undefined

    case "notice":
      // 机器人自己戳出去的那一下也会上报。与 message_sent 同一道闸门：「被戳就戳回去」的插件若只判
      // 被戳者是不是自己倒没事，可一旦写成「谁戳就戳谁」，投进来就是自己跟自己没完没了
      if (opts.selfMessages !== true && isPoke(payload)) {
        const self = str(payload, "self_id")
        if (self !== undefined && pokeParties(payload).uid === self) return undefined
      }
      return decodeNoticeEvent(payload)

    case "request": {
      const kind = str(payload, "request_type")
      const subType = str(payload, "sub_type")
      const requestType =
        kind === "friend" ? "friend" : subType === "invite" ? "group.invite" : "group.add"
      const gid = str(payload, "group_id")
      const comment = str(payload, "comment")
      return {
        kind: "request",
        requestType,
        uid: str(payload, "user_id") ?? "",
        ...(gid === undefined ? {} : { gid }),
        ...(comment === undefined ? {} : { comment }),
        flag: str(payload, "flag") ?? "",
        raw: payload,
        ...(time === undefined ? {} : { time })
      }
    }

    case "meta_event": {
      const metaType = str(payload, "meta_event_type")
      const subType = str(payload, "sub_type")
      /** lifecycle 的三种 sub_type 与内核元事件的三种类型一一对应，直接映射 */
      const resolved =
        metaType === "heartbeat"
          ? "heartbeat"
          : subType === "connect" || subType === "enable" || subType === "disable"
            ? subType
            : "other"
      return {
        kind: "meta",
        metaType: resolved,
        data: payload,
        raw: payload,
        ...(time === undefined ? {} : { time })
      }
    }

    default:
      return undefined
  }
}
