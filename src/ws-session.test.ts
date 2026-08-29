/**
 * 模块职责：WebSocket 报文层的测试 —— 固定事件与响应的分流、异常报文的容错、静默检测
 * 依赖方向：测试文件，依赖 ws-session.ts 与内核测试工具
 * 生命周期：每项用例各自构造会话；静默检测相关用例使用虚拟定时器并在 finally 中还原
 * 注意事项：静默检测的两项用例针对的是一类无异常的故障：对端消失后 socket 仍保持
 *          ESTABLISHED，其表现为"机器人不响应而面板显示在线"。此类缺陷仅可由
 *          "在给定时长内未收到任何报文"这一判据发现，故须单独覆盖。
 */
import { describe, expect, it, vi } from "vitest"
import { fakeLogger } from "@yunzai-ng/core/testing"
import { WsSession } from "./ws-session.js"
import type { Wire } from "./ws-session.js"

/** 模拟 socket，另行提供若干供断言与操控的成员 */
interface FakeWire extends Wire {
  /** 已发出的报文 */
  sent: string[]
  /** 被要求关闭的原因 */
  closed: string[]
  /**
   * 模拟 socket 断开
   * @param value 是否仍然打开
   */
  setOpen(value: boolean): void
}

/**
 * 构造一条模拟 socket
 * @returns 模拟 socket
 */
function fakeWire(): FakeWire {
  // `open` 在 Wire 上为只读（对使用方而言其为观察到的状态，而非可写字段），
  // 故采用内部变量配合 getter，而不直接暴露可赋值的属性
  let open = true
  const wire: FakeWire = {
    sent: [],
    closed: [],
    get open(): boolean {
      return open
    },
    send: (text: string) => wire.sent.push(text),
    close: (reason: string) => wire.closed.push(reason),
    setOpen: (value: boolean) => {
      open = value
    }
  }
  return wire
}

/**
 * 构造一个会话
 * @param idleTimeout 静默超时毫秒
 * @returns 会话、模拟 socket 与收到的回调
 */
function setup(idleTimeout = 0) {
  const events: Record<string, unknown>[] = []
  const deaths: string[] = []
  const session = new WsSession({
    logger: fakeLogger(),
    timeout: 1000,
    idleTimeout,
    prefix: "t",
    onEvent: payload => events.push(payload),
    onDead: reason => deaths.push(reason)
  })
  const wire = fakeWire()
  session.attach(wire)
  return { session, wire, events, deaths }
}

describe("WsSession 报文分流", () => {
  it("携带 post_type 的为事件，携带 retcode 的为响应", async () => {
    const { session, wire, events } = setup()

    const pending = session.call<{ ok: number }>("get_status")
    const echo = JSON.parse(wire.sent[0]!).echo as string

    session.feed(JSON.stringify({ post_type: "message", message: [] }))
    expect(events).toHaveLength(1)

    session.feed(JSON.stringify({ status: "ok", retcode: 0, data: { ok: 1 }, echo }))
    await expect(pending).resolves.toEqual({ ok: 1 })
  })

  it("平台返回 failed 时抛出异常，且仅依据 status 而不依据 retcode", async () => {
    const { session, wire } = setup()
    const pending = session.call("send_msg")
    const echo = JSON.parse(wire.sent[0]!).echo as string

    // HTTP 通道上表示失败的 retcode 可能为 200，故判定不得依据该数值
    session.feed(JSON.stringify({ status: "failed", retcode: 200, data: null, wording: "群不存在", echo }))
    await expect(pending).rejects.toThrow(/send_msg.*群不存在/)
  })

  it("畸形报文仅记录日志，不断开连接", async () => {
    const { session, wire, events } = setup()
    session.feed("这不是 JSON")
    session.feed("[1,2,3]")
    session.feed("null")

    // 连接仍然存活，后续正常报文照常接收
    session.feed(JSON.stringify({ post_type: "notice", notice_type: "friend_add" }))
    expect(events).toHaveLength(1)
    expect(wire.closed).toEqual([])
  })

  it("无 echo 的响应被忽略，不影响挂起中的调用", async () => {
    const { session, wire } = setup()
    const pending = session.call("get_status")
    const echo = JSON.parse(wire.sent[0]!).echo as string

    session.feed(JSON.stringify({ status: "ok", retcode: 0, data: {} }))
    expect(session.inflight).toBe(1)

    session.feed(JSON.stringify({ status: "ok", retcode: 0, data: { v: 1 }, echo }))
    await expect(pending).resolves.toEqual({ v: 1 })
  })

  it("socket 未打开时立即拒绝调用，而非发出后等待超时", async () => {
    const { session, wire } = setup()
    wire.setOpen(false)
    await expect(session.call("send_msg")).rejects.toThrow(/尚未建立或已断开/)
  })

  it("dispose 之后不再就绪，挂起中的调用被拒绝", async () => {
    const { session } = setup()
    const pending = session.call("get_group_list")
    expect(session.ready).toBe(true)

    session.dispose("连接已断开")
    expect(session.ready).toBe(false)
    await expect(pending).rejects.toThrow(/get_group_list.*连接已断开/)
  })
})

describe("静默检测", () => {
  it("超过静默上限即判定连接已死并关闭 socket", async () => {
    vi.useFakeTimers()
    try {
      const { wire, deaths } = setup(1000)
      expect(deaths).toEqual([])

      vi.advanceTimersByTime(1001)
      // TCP 连接可在对端消失后长时间保持 ESTABLISHED，socket 不产生 close 事件。
      // 缺少该判据时，其症状即为"机器人不响应而面板显示在线"
      expect(deaths).toHaveLength(1)
      expect(deaths[0]).toContain("判定连接已死")
      expect(wire.closed).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("收到任何报文均会重置静默计时 —— 心跳即以此维持连接判定", () => {
    vi.useFakeTimers()
    try {
      const { session, deaths } = setup(1000)

      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(800)
        session.feed(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }))
      }
      // 共计经过 4 秒，但每 800ms 存在一次心跳，连接始终判定为存活
      expect(deaths).toEqual([])

      vi.advanceTimersByTime(1001)
      expect(deaths).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("取值 0 表示关闭静默检测", () => {
    vi.useFakeTimers()
    try {
      const { deaths } = setup(0)
      vi.advanceTimersByTime(600_000)
      expect(deaths).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
