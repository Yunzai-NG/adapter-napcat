/**
 * 模块职责：反向 WS 通道的测试 —— 固定端点挂载、握手鉴权、单连接约束与等待上限
 * 依赖方向：测试文件，依赖 transport-ws-reverse.ts、内核测试工具与类型包
 * 生命周期：每项用例各自构造通道与宿主替身；超时相关用例使用虚拟定时器并在 finally 中还原
 * 注意事项：其中两项用例针对的是启动阶段的阻塞风险与消息重复处理：等待第一条连接
 *          必须设定上限，否则内核将停留在启动阶段；第二条连接必须拒绝，否则同一条
 *          消息会被两条 socket 各投递一次。二者在单条连接的正常流程中均不显现。
 */
import { describe, expect, it, vi } from "vitest"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { Disposer, RouteRequest, WebSocketConnection, WebSocketHandler, WebSocketOptions } from "@yunzai-ng/types"
import { createWsReverseTransport } from "./transport-ws-reverse.js"

/** 模拟连接，另行提供若干操控用的成员 */
interface FakeConn extends WebSocketConnection {
  /** 已发出的报文 */
  sent: string[]
  /** 被关闭时的状态码 */
  closedWith: number[]
  /** 模拟对端发来一帧 */
  emit(text: string): void
  /** 模拟连接断开 */
  drop(code: number, reason: string): void
}

/**
 * 构造一条模拟连接
 * @param ip 客户端地址
 * @returns 模拟连接
 */
function fakeConn(ip = "127.0.0.1"): FakeConn {
  let open = true
  const messageCbs: ((data: string | Uint8Array, isBinary: boolean) => void)[] = []
  const closeCbs: ((code: number, reason: string) => void)[] = []

  const conn: FakeConn = {
    id: "c1",
    ip,
    headers: {},
    sent: [],
    closedWith: [],
    get open(): boolean {
      return open
    },
    send: (data: string | Uint8Array) => conn.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
    close: (code?: number) => {
      open = false
      conn.closedWith.push(code ?? 1000)
    },
    onMessage: cb => {
      messageCbs.push(cb)
      return () => undefined
    },
    onClose: cb => {
      closeCbs.push(cb)
      return () => undefined
    },
    onError: () => () => undefined,
    emit: text => {
      for (const cb of messageCbs) cb(text, false)
    },
    drop: (code, reason) => {
      open = false
      for (const cb of closeCbs) cb(code, reason)
    }
  }
  return conn
}

/** 一个被注册的端点 */
interface Endpoint {
  /** 路径 */
  path: string
  /** 连接处理函数 */
  handler: WebSocketHandler
  /** 注册选项 */
  opts: WebSocketOptions | undefined
  /** 是否已注销 */
  unregistered: boolean
}

/**
 * 构造一套通道与其宿主替身
 * @param token 期望的 Access Token
 * @returns 通道、端点与回调记录
 */
function setup(token = "") {
  const endpoints: Endpoint[] = []
  const events: Record<string, unknown>[] = []
  const closes: string[] = []
  const controller = new AbortController()

  const register = (path: string, handler: WebSocketHandler, opts?: WebSocketOptions): Disposer => {
    const endpoint: Endpoint = { path, handler, opts, unregistered: false }
    endpoints.push(endpoint)
    return () => {
      endpoint.unregistered = true
    }
  }

  const transport = createWsReverseTransport({
    path: "/napcat",
    token,
    timeout: 1000,
    idleTimeout: 0,
    prefix: "t",
    signal: controller.signal,
    publicWsUrl: "ws://127.0.0.1:2536/adapter/napcat/napcat",
    hooks: {
      logger: fakeLogger(),
      onEvent: payload => events.push(payload),
      onClosed: reason => closes.push(reason)
    },
    register
  })

  /** 取唯一的那个端点 */
  const endpoint = (): Endpoint => {
    const first = endpoints[0]
    if (!first) throw new Error("端点尚未注册")
    return first
  }

  return { transport, endpoint, endpoints, events, closes, controller }
}

/** 一个空的握手请求 */
const REQ = { headers: {}, query: {}, ip: "127.0.0.1" } as unknown as RouteRequest

describe("反向 WS 通道", () => {
  it("对端连入之后 open() 方予兑现 —— 内核随即会将账号标记为在线", async () => {
    const { transport, endpoint } = setup()
    const opening = transport.open()

    // 端点为同步挂载，但在第一条连接到达之前不视为就绪
    expect(endpoint().path).toBe("/napcat")
    expect(transport.ready).toBe(false)

    endpoint().handler(fakeConn(), REQ)
    await opening
    expect(transport.ready).toBe(true)
  })

  it("等待连接超时时，错误信息指明应在 NapCat 中填写的地址", async () => {
    vi.useFakeTimers()
    try {
      const { transport } = setup()
      const opening = transport.open()
      // 等待必须设定上限：内核启动时会 await 每个账号的 connect()，
      // 无上限等待将使整个框架停留在启动阶段，此时面板亦无法打开
      vi.advanceTimersByTime(15_001)
      await expect(opening).rejects.toThrow(/ws:\/\/127\.0\.0\.1:2536\/adapter\/napcat\/napcat/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("第二条连接被拒绝，不致出现两条 socket 向同一账号投递事件", async () => {
    const { transport, endpoint, events } = setup()
    const opening = transport.open()
    const first = fakeConn("10.0.0.1")
    endpoint().handler(first, REQ)
    await opening

    const second = fakeConn("10.0.0.2")
    endpoint().handler(second, REQ)
    expect(second.closedWith).toEqual([1008])

    // 第二条被拒绝之后，其发来的报文不应进入管线
    second.emit(JSON.stringify({ post_type: "message", message: [] }))
    expect(events).toHaveLength(0)

    first.emit(JSON.stringify({ post_type: "message", message: [] }))
    expect(events).toHaveLength(1)
  })

  it("握手校验 Access Token", async () => {
    const { transport, endpoint } = setup("s3cr3t")
    void transport.open().catch(() => undefined)

    const verify = endpoint().opts?.verify
    expect(verify).toBeDefined()
    expect(await verify!({ headers: { authorization: "Bearer s3cr3t" }, query: {}, ip: "1" } as unknown as RouteRequest)).toBe(true)
    // NapCat 反向客户端未配置 token 时亦会发送一个空的 `Bearer `，故裸值同样须识别
    expect(await verify!({ headers: { authorization: "s3cr3t" }, query: {}, ip: "1" } as unknown as RouteRequest)).toBe(true)
    expect(await verify!({ headers: { authorization: "Bearer 错误的令牌" }, query: {}, ip: "1" } as unknown as RouteRequest)).toBe(false)
    expect(await verify!(REQ)).toBe(false)
    await transport.close()
  })

  it("未配置 token 时只放本机连入：面板监听在 0.0.0.0 时，别人不能冒充对端", async () => {
    const { transport, endpoint } = setup()
    void transport.open().catch(() => undefined)
    const verify = endpoint().opts?.verify
    expect(await verify?.(REQ)).toBe(true)
    expect(await verify?.({ headers: {}, query: {}, ip: "::ffff:127.0.0.1" } as unknown as RouteRequest)).toBe(true)
    expect(await verify?.({ headers: {}, query: {}, ip: "::1" } as unknown as RouteRequest)).toBe(true)
    expect(await verify?.({ headers: {}, query: {}, ip: "172.17.0.2" } as unknown as RouteRequest)).toBe(false)
    expect(await verify?.({ headers: {}, query: {}, ip: "203.0.113.9" } as unknown as RouteRequest)).toBe(false)
    await transport.close()
  })

  it("对端断开时上报下线并注销端点，以供内核重新挂载", async () => {
    const { transport, endpoint, closes } = setup()
    const opening = transport.open()
    const conn = fakeConn()
    endpoint().handler(conn, REQ)
    await opening

    conn.drop(1006, "对端进程退出")
    expect(closes).toHaveLength(1)
    expect(closes[0]).toContain("对端进程退出")
    expect(transport.ready).toBe(false)
    // 端点必须撤销：内核重连时将构造新的驱动并挂载新的端点，
    // 保留旧端点会导致两个端点争用同一路径
    expect(endpoint().unregistered).toBe(true)
  })

  it("账号被停用时 open() 立即失败，不阻塞停机流程", async () => {
    const { transport, controller } = setup()
    const opening = transport.open()
    controller.abort()
    await expect(opening).rejects.toThrow(/账号已停用/)
  })

  it("close() 撤销端点并使等待中的 open() 失败", async () => {
    const { transport, endpoint } = setup()
    const opening = transport.open()
    await transport.close()
    await expect(opening).rejects.toThrow(/主动断开/)
    expect(endpoint().unregistered).toBe(true)
  })
})
