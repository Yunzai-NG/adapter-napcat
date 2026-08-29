/**
 * 模块职责：将 NapCat 的上报报文翻译为内核的 `IncomingEvent`
 * 依赖方向：依赖 codec / fields 与类型包
 * 生命周期：纯函数
 * 注意事项：**认不出的事件不丢弃，降级为 `GenericNotice`。** 通用模型只为常见通知定义了具体形状，
 *          而 notice 的种类还在增加；丢弃的话，插件要处理新增通知就得等框架更新，降级并带上原始
 *          data 之后它可以自行解析。
 *
 *          **`message_sent` 直接忽略。** 那是 `reportSelfMessage` 开启时回报的「机器人自己发出的消息」，
 *          投进管线的话机器人会回复自己的回复，一条指令派生出无限条。
 *
 *          **引用只填 `messageId`，不补全正文。** 取正文要多调一次 `get_msg`，为每条含引用的消息都加
 *          一次 API 调用不可接受；内核会在插件实际使用时经 `QuoteResolver` 补全。
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
          uid: uid ?? "",
          targetId: str(payload, "target_id") ?? ""
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
 * 解析一条 NapCat 上报报文
 *
 * @param payload 已解析的报文
 * @returns 内核事件；无需处理（如 `message_sent`）或报文不合法时 undefined
 */
export function decodeEvent(payload: Fields): IncomingEvent | undefined {
  const postType = str(payload, "post_type")
  const time = timeMs(payload)

  switch (postType) {
    case "message":
      return decodeMessageEvent(payload)

    case "message_sent":
      // 见文件头第 2 条
      return undefined

    case "notice":
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
