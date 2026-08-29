/**
 * 模块职责：上报报文翻译的测试 —— 固定消息、通知、请求、元事件四类的字段映射
 * 依赖方向：测试文件，依赖 events.ts
 * 生命周期：纯函数，无状态
 * 注意事项：其中两项映射错误不会产生异常，仅表现为功能失效：群消息的 sender 若非
 *          MemberInfo，全部群管理员权限判定将失效；`time` 若遗漏自秒转换为毫秒，
 *          全部事件的时间将显示为 1970 年。故两者各自单列一项用例。
 */
import { describe, expect, it } from "vitest"
import { decodeEvent } from "./events.js"

describe("消息事件", () => {
  it("群消息携带群号、成员角色与毫秒时间", () => {
    const event = decodeEvent({
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      time: 1_700_000_000,
      message_id: 1145141919,
      group_id: 700000,
      user_id: 10001,
      message: [{ type: "text", data: { text: "#原神体力" } }],
      sender: { user_id: 10001, nickname: "小明", card: "群名片小明", role: "admin", title: "头衔" }
    })

    expect(event).toMatchObject({
      kind: "message",
      scene: "group",
      subType: "normal",
      // 通用模型中的 id 一律为字符串，NapCat 上报的为数字
      messageId: "1145141919",
      // 秒级 → 毫秒，遗漏乘以 1000 将使全部事件的时间显示为 1970 年
      time: 1_700_000_000_000,
      group: { gid: "700000" },
      sender: { uid: "10001", gid: "700000", role: "admin", name: "小明", card: "群名片小明", title: "头衔" }
    })
  })

  it("群消息的 sender 必须为 MemberInfo，否则群管理员权限判定将全部失效", () => {
    const event = decodeEvent({
      post_type: "message",
      message_type: "group",
      group_id: 700000,
      user_id: 10001,
      message_id: 1,
      message: [],
      sender: { user_id: 10001, role: "owner" }
    })
    // 缺少 gid 或 role 时，`.admin()` 命令会将群主亦视为普通成员而拒绝执行
    expect(event).toMatchObject({ sender: { gid: "700000", role: "owner" } })
  })

  it("私聊消息不携带群号，sender 为 UserInfo", () => {
    const event = decodeEvent({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      user_id: 10001,
      message_id: 2,
      message: [{ type: "text", data: { text: "在" } }],
      sender: { user_id: 10001, nickname: "小明" }
    })
    expect(event).toMatchObject({ kind: "message", scene: "private", sender: { uid: "10001", name: "小明" } })
    expect((event as { group?: unknown }).group).toBeUndefined()
  })

  it("引用信息自 reply 段提升至事件层，段本身予以保留", () => {
    const event = decodeEvent({
      post_type: "message",
      message_type: "group",
      group_id: 700000,
      user_id: 10001,
      message_id: 3,
      message: [
        { type: "reply", data: { id: "999" } },
        { type: "text", data: { text: "看这个" } }
      ],
      sender: { user_id: 10001 }
    })
    // e.quote 为插件读取引用的位置；仅填写 messageId，正文由内核按需补全（可省去一次 get_msg）
    expect(event).toMatchObject({ quote: { messageId: "999" } })
    expect((event as { message: unknown[] }).message).toHaveLength(2)
  })

  it("CQ 码格式的上报同样可解析出内容", () => {
    const event = decodeEvent({
      post_type: "message",
      message_type: "private",
      user_id: 10001,
      message_id: 4,
      message: "你好[CQ:face,id=66]",
      raw_message: "你好[CQ:face,id=66]",
      sender: { user_id: 10001 }
    })
    expect((event as { message: unknown[] }).message).toEqual([
      { type: "text", text: "你好" },
      { type: "face", id: 66 }
    ])
  })

  it("message_sent 被忽略，否则机器人将回复自身的回复", () => {
    expect(decodeEvent({ post_type: "message_sent", message_type: "group", message: [] })).toBeUndefined()
  })

  it("无法识别的 post_type 返回 undefined", () => {
    expect(decodeEvent({ post_type: "某个新类型" })).toBeUndefined()
    expect(decodeEvent({})).toBeUndefined()
  })
})

describe("通知事件", () => {
  it("入群：携带邀请人与加入方式", () => {
    expect(
      decodeEvent({
        post_type: "notice",
        notice_type: "group_increase",
        sub_type: "invite",
        group_id: 700000,
        user_id: 10002,
        operator_id: 10001
      })
    ).toMatchObject({ noticeType: "group.increase", gid: "700000", uid: "10002", operatorId: "10001", way: "invite" })
  })

  it("退群：kick_me 映射为 kickMe", () => {
    expect(
      decodeEvent({ post_type: "notice", notice_type: "group_decrease", sub_type: "kick_me", group_id: 1, user_id: 2 })
    ).toMatchObject({ noticeType: "group.decrease", way: "kickMe" })
    expect(
      decodeEvent({ post_type: "notice", notice_type: "group_decrease", sub_type: "disband", group_id: 1, user_id: 2 })
    ).toMatchObject({ way: "other" })
  })

  it("管理员变动：unset 后的角色为普通成员", () => {
    expect(
      decodeEvent({ post_type: "notice", notice_type: "group_admin", sub_type: "set", group_id: 1, user_id: 2 })
    ).toMatchObject({ noticeType: "group.admin", role: "admin" })
    expect(
      decodeEvent({ post_type: "notice", notice_type: "group_admin", sub_type: "unset", group_id: 1, user_id: 2 })
    ).toMatchObject({ role: "member" })
  })

  it("禁言：user_id 为 0 表示全体禁言，而非禁言 0 号用户", () => {
    const whole = decodeEvent({
      post_type: "notice",
      notice_type: "group_ban",
      sub_type: "ban",
      group_id: 1,
      user_id: 0,
      operator_id: 10001,
      duration: 600
    })
    expect(whole).toMatchObject({ noticeType: "group.mute", whole: true, duration: 600 })
    expect((whole as { uid?: string }).uid).toBeUndefined()

    const single = decodeEvent({
      post_type: "notice",
      notice_type: "group_ban",
      sub_type: "ban",
      group_id: 1,
      user_id: 10002,
      duration: 60
    })
    expect(single).toMatchObject({ whole: false, uid: "10002", duration: 60 })
  })

  it("解除禁言的时长归零", () => {
    expect(
      decodeEvent({
        post_type: "notice",
        notice_type: "group_ban",
        sub_type: "lift_ban",
        group_id: 1,
        user_id: 2,
        duration: 600
      })
    ).toMatchObject({ duration: 0 })
  })

  it("撤回：群撤回携带群号，私聊撤回不携带", () => {
    expect(
      decodeEvent({
        post_type: "notice",
        notice_type: "group_recall",
        group_id: 1,
        user_id: 2,
        operator_id: 3,
        message_id: 456
      })
    ).toMatchObject({ noticeType: "message.recall", gid: "1", uid: "2", operatorId: "3", messageId: "456" })

    const priv = decodeEvent({ post_type: "notice", notice_type: "friend_recall", user_id: 2, message_id: 456 })
    expect(priv).toMatchObject({ noticeType: "message.recall", messageId: "456" })
    expect((priv as { gid?: string }).gid).toBeUndefined()
  })

  it("戳一戳", () => {
    expect(
      decodeEvent({ post_type: "notice", notice_type: "notify", sub_type: "poke", group_id: 1, user_id: 2, target_id: 3 })
    ).toMatchObject({ noticeType: "poke", gid: "1", uid: "2", targetId: "3" })
  })

  it("无具体形状的通知降级为点分类型名，并携带原始报文", () => {
    expect(
      decodeEvent({ post_type: "notice", notice_type: "group_msg_emoji_like", group_id: 1, message_id: 9 })
    ).toMatchObject({ noticeType: "group.reaction", gid: "1" })
    expect(decodeEvent({ post_type: "notice", notice_type: "friend_add", user_id: 2 })).toMatchObject({
      noticeType: "friend.add"
    })
    // 框架未收录的新增通知同样不予丢弃，插件可自行按 data 解析
    expect(decodeEvent({ post_type: "notice", notice_type: "某个新通知" })).toMatchObject({
      noticeType: "onebot.某个新通知"
    })
    expect(decodeEvent({ post_type: "notice", notice_type: "notify", sub_type: "input_status" })).toMatchObject({
      noticeType: "friend.inputStatus"
    })
  })
})

describe("请求与元事件", () => {
  it("好友请求", () => {
    expect(
      decodeEvent({ post_type: "request", request_type: "friend", user_id: 2, comment: "申请添加好友", flag: "FLAG" })
    ).toMatchObject({ kind: "request", requestType: "friend", uid: "2", comment: "申请添加好友", flag: "FLAG" })
  })

  it("加群申请与邀请入群为两种类型", () => {
    expect(
      decodeEvent({ post_type: "request", request_type: "group", sub_type: "add", group_id: 1, user_id: 2, flag: "F" })
    ).toMatchObject({ requestType: "group.add", gid: "1" })
    expect(
      decodeEvent({ post_type: "request", request_type: "group", sub_type: "invite", group_id: 1, user_id: 2, flag: "F" })
    ).toMatchObject({ requestType: "group.invite" })
  })

  it("生命周期与心跳", () => {
    expect(decodeEvent({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect" })).toMatchObject({
      kind: "meta",
      metaType: "connect"
    })
    expect(
      decodeEvent({ post_type: "meta_event", meta_event_type: "heartbeat", status: { online: true }, interval: 30000 })
    ).toMatchObject({ kind: "meta", metaType: "heartbeat" })
    expect(decodeEvent({ post_type: "meta_event", meta_event_type: "某个新元事件" })).toMatchObject({ metaType: "other" })
  })
})
