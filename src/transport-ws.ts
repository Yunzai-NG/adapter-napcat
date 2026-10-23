/**
 * 模块职责：正向 WebSocket —— 由框架主动连接 NapCat 的 WS 服务器
 * 依赖方向：依赖 ws-session / transport / config
 * 生命周期：`open()` 建立一条 socket，`close()` 将其关闭
 * 注意事项：**握手失败的原因必须转换为可据以操作的说明。** `ws` 抛出的形式为
 *          `Error: connect ECONNREFUSED 127.0.0.1:3001` 或
 *          `Error: Unexpected server response: 403`，若直接写入账号状态，
 *          使用者所见仅为一串英文，而非"应修改哪一项设置"。这两类失败恰好对应
 *          NapCat 侧最常见的两处遗漏：该条网络配置未启用，以及 token 填写不一致。
 *
 *          本模块不自行实现重连：断线经 `onClosed` 上报至内核，内核具备带退避的
 *          统一重连机制（参见 adapter/accounts.ts）。适配器另行实现将导致两套
 *          相互冲突的重连逻辑。
 */
import WebSocket from "ws"
import { PEER } from "./dialect.js"
import type { Transport, TransportHooks } from "./transport.js"
import { WsSession } from "./ws-session.js"
import type { Wire } from "./ws-session.js"

/** 正向 WS 通道的构造参数 */
export interface WsClientOptions {
  /** NapCat 的 WebSocket 地址 */
  url: string
  /** Access Token，空串表示不携带 */
  token: string
  /** API 调用超时毫秒 */
  timeout: number
  /** 静默超时毫秒 */
  idleTimeout: number
  /** `echo` 前缀 */
  prefix: string
  /** 账号被停用时触发 abort */
  signal: AbortSignal
  /** 上层回调 */
  hooks: TransportHooks
}

/**
 * 将 `ws` 的握手错误转换为可据以操作的中文说明
 * @param url 目标地址
 * @param token 账号填的 Access Token
 * @param err 原始错误
 * @returns 错误信息
 */
function explain(url: string, token: string, err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)

  if (text.includes("ECONNREFUSED")) {
    return `无法连接 ${url}：对端未在该端口上监听。请检查 ${PEER} 的网络配置中该条 WebSocket 服务器是否已启用、端口是否与此处填写的一致`
  }
  if (text.includes("ENOTFOUND") || text.includes("EAI_AGAIN")) {
    return `无法解析 ${url} 的主机名：请检查地址是否有误，容器部署时须使用容器网络中的主机名`
  }
  if (text.includes("403") || text.includes("401")) {
    // SnowLuma 给每条网络配置自动生成 token，照「对端缺省不鉴权」留空的人都落在这里
    if (token === "") {
      return `${url} 拒绝了握手（${text}）：对端要求 Access Token，账号里却没填。SnowLuma 会自动生成 token，在它的 WebUI 或 config/onebot_<QQ号>.json 里找到该条 WebSocket 服务器的 accessToken 填进来`
    }
    return `${url} 拒绝了握手（${text}）：Access Token 与对端该条网络配置中的取值不一致`
  }
  // SnowLuma 对不认识的路径回 400 Bad path，其余两家回 404
  if (text.includes("404") || text.includes("400")) {
    return `${url} 拒绝了握手（${text}）：地址中的路径有误，正向 WS 通常无需路径，如 ws://127.0.0.1:3001`
  }
  if (text.includes("ETIMEDOUT") || text.includes("timeout")) {
    return `连接 ${url} 超时：目标不可达，请检查防火墙与容器端口映射`
  }
  return `连接 ${url} 失败：${text}`
}

/**
 * 创建正向 WS 通道
 * @param opts 构造参数
 * @returns 通道
 */
export function createWsClientTransport(opts: WsClientOptions): Transport {
  /** 当前 socket */
  let socket: WebSocket | undefined
  /** 是否已执行过 close 流程 */
  let closed = false

  const session = new WsSession({
    logger: opts.hooks.logger,
    timeout: opts.timeout,
    idleTimeout: opts.idleTimeout,
    prefix: opts.prefix,
    onEvent: payload => opts.hooks.onEvent(payload),
    onDead: reason => {
      session.dispose(reason)
      opts.hooks.onClosed(reason)
    }
  })

  /**
   * 收尾：关闭 socket 并拒绝挂起调用
   * @param reason 原因
   */
  const teardown = (reason: string): void => {
    session.dispose(reason)
    const current = socket
    socket = undefined
    if (current === undefined) return
    // 不将 reason 写入关闭帧：WebSocket 的 reason 上限为 123 字节，中文原因极易超出，
    // 超出后 ws 将抛出 RangeError —— 其结果是"正常关闭"转为一次异常
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) current.close(1000)
    else current.terminate()
  }

  return {
    mode: "ws",
    describe: `正向 WS → ${opts.url}`,

    get ready(): boolean {
      return session.ready
    },

    async open(): Promise<void> {
      const headers: Record<string, string> = {}
      if (opts.token !== "") headers["Authorization"] = `Bearer ${opts.token}`

      const next = new WebSocket(opts.url, { headers, handshakeTimeout: opts.timeout })
      socket = next

      await new Promise<void>((resolve, reject) => {
        /** 摘除握手期的三个一次性监听 */
        const done = (): void => {
          next.off("open", onOpen)
          next.off("error", onError)
          next.off("close", onClose)
        }
        const onOpen = (): void => {
          done()
          resolve()
        }
        const onError = (err: Error): void => {
          done()
          reject(new Error(explain(opts.url, opts.token, err)))
        }
        // 握手被拒时 ws 先触发 error 再触发 close；亦存在仅 error 而无 close 的情形（代理），
        // 故两者均须监听，否则 open() 存在永不兑现的可能
        const onClose = (code: number): void => {
          done()
          reject(new Error(`${opts.url} 在握手阶段即关闭了连接（code=${code}）`))
        }
        next.once("open", onOpen)
        next.once("error", onError)
        next.once("close", onClose)
      })

      const wire: Wire = {
        get open(): boolean {
          return next.readyState === WebSocket.OPEN
        },
        send: (text: string) => next.send(text),
        close: () => {
          if (next.readyState === WebSocket.OPEN) next.close(1000)
        }
      }
      session.attach(wire)

      next.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        session.feed(isBinary ? new Uint8Array(data as Buffer) : data.toString())
      })
      next.on("error", (err: Error) => {
        // 连接建立之后的 error 必然紧随一个 close，此处仅记录日志，下线由 close 统一上报
        opts.hooks.logger.warn(`与对端的连接出错：${err.message}`)
      })
      next.on("close", (code: number, reasonBuf: Buffer) => {
        if (closed) return
        const detail = reasonBuf.length > 0 ? `：${reasonBuf.toString()}` : ""
        const reason = `对端关闭了连接（code=${code}）${detail}`
        teardown(reason)
        opts.hooks.onClosed(reason)
      })

      if (opts.signal.aborted) teardown("账号已停用")
      else opts.signal.addEventListener("abort", () => teardown("账号已停用"), { once: true })
    },

    async close(): Promise<void> {
      closed = true
      teardown("主动断开")
      return Promise.resolve()
    },

    call<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      return session.call<T>(action, params)
    }
  }
}
