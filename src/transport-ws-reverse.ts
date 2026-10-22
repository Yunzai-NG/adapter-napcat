/**
 * 模块职责：反向 WebSocket —— 挂载一个端点，等待 NapCat 连入
 * 依赖方向：依赖 ws-session / transport；socket 由内核的共享 HTTP 服务器提供
 * 生命周期：`open()` 注册端点并等到第一条连接，`close()` 注销端点
 * 注意事项：**等待必须设定上限。** 内核启动时会 `await` 每个账号的 `connect()`
 *          （参见 adapter/accounts.ts 的 `start()`），一个无限期等待的反向账号将使
 *          整个框架停留在启动阶段 —— 此时面板亦无法打开，使用者无从着手排查。
 *          故此处仅等待一个较短的窗口即宣告失败，交由内核按退避重试；重试期间端点
 *          将短暂消失，而 NapCat 的反向客户端本身会持续重连，最终必可接入。
 *
 *          **一条端点同一时刻仅接受一条连接。** 第二条连接不予接管而直接拒绝：
 *          若予接管，将有两条 socket 向同一账号投递事件，同一条消息会被处理两次。
 */
import type { Disposer, RouteRequest, WebSocketConnection, WebSocketHandler, WebSocketOptions } from "@yunzai-ng/types"
import { PEER } from "./dialect.js"
import { TimeoutError } from "@yunzai-ng/core"
import { checkToken, headerOf, SELF_ID_HEADER } from "./transport.js"
import type { Transport, TransportHooks } from "./transport.js"
import { WsSession } from "./ws-session.js"
import type { Wire } from "./ws-session.js"

/**
 * 等待第一条连接的上限毫秒
 *
 * 取值原则为"NapCat 已在运行时必可连入，未在运行时亦不至于阻塞启动"。
 * NapCat 的反向客户端默认每数秒重试一次，故 15 秒足以使其落入该窗口。
 */
const WAIT_FIRST_MS = 15_000

/** 反向 WS 通道的构造参数 */
export interface WsReverseOptions {
  /** 监听路径（相对适配器作用域） */
  path: string
  /** 期望的 Access Token，空串表示不校验 */
  token: string
  /** API 调用超时毫秒 */
  timeout: number
  /** 静默超时毫秒 */
  idleTimeout: number
  /** `echo` 前缀 */
  prefix: string
  /** 账号被停用时触发 abort */
  signal: AbortSignal
  /** 完整的对外地址，仅用于提示使用者应在 NapCat 中填写的取值 */
  publicWsUrl: string
  /** 上层回调 */
  hooks: TransportHooks

  /**
   * 注册 WebSocket 端点（内核 `host.websocket`）
   * @param path 路径
   * @param handler 每条连接调用一次
   * @param wsOpts 选项
   * @returns 注销句柄
   */
  register(path: string, handler: WebSocketHandler, wsOpts?: WebSocketOptions): Disposer
}

/**
 * 创建反向 WS 通道
 * @param opts 构造参数
 * @returns 通道
 */
export function createWsReverseTransport(opts: WsReverseOptions): Transport {
  /** 端点注销句柄 */
  let unregister: Disposer | undefined
  /** 已接管的连接 */
  let active: WebSocketConnection | undefined
  /** 是否已执行过 close 流程 */
  let closed = false
  /** 等待第一条连接的兑现器 */
  let arrive: ((err?: Error) => void) | undefined

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
   * 收尾
   * @param reason 原因
   */
  const teardown = (reason: string): void => {
    session.dispose(reason)
    const conn = active
    active = undefined
    // 同样不将中文原因写入关闭帧：上限 123 字节，超出后底层将抛出异常
    if (conn?.open === true) conn.close(1000)
    unregister?.()
    unregister = undefined
  }

  /**
   * 接管一条新连接
   * @param conn 连接
   * @param req 握手请求
   */
  const accept = (conn: WebSocketConnection, req: RouteRequest): void => {
    if (active !== undefined && active.open) {
      opts.hooks.logger.warn(`已存在一条对端连接（来自 ${active.ip}），拒绝 ${conn.ip} 的重复接入`)
      conn.close(1008)
      return
    }

    const selfId = headerOf(req, SELF_ID_HEADER)
    opts.hooks.logger.info(`对端已连入（来自 ${conn.ip}${selfId === "" ? "" : `，账号 ${selfId}`}）`)

    active = conn
    const wire: Wire = {
      get open(): boolean {
        return conn.open
      },
      send: (text: string) => conn.send(text),
      close: () => {
        if (conn.open) conn.close(1000)
      }
    }
    session.attach(wire)

    conn.onMessage(data => session.feed(data))
    conn.onError(err => opts.hooks.logger.warn(`对端连接出错：${err.message}`))
    conn.onClose((code, reason) => {
      if (closed || active !== conn) return
      const detail = reason === "" ? "" : `：${reason}`
      const text = `对端断开了连接（code=${code}）${detail}`
      teardown(text)
      opts.hooks.onClosed(text)
    })

    arrive?.()
    arrive = undefined
  }

  return {
    mode: "ws-reverse",
    describe: `反向 WS ← ${opts.publicWsUrl}`,

    get ready(): boolean {
      return session.ready
    },

    async open(): Promise<void> {
      unregister = opts.register(opts.path, accept, {
        verify: (req: RouteRequest) => {
          if (checkToken(req, opts.token)) return true
          opts.hooks.logger.warn(
            opts.token === ""
              ? `拒绝了来自 ${req.ip} 的反向 WS 握手：账号没填 Access Token 时只接受本机连入。对端不在本机时，两边填上同一个 token`
              : `拒绝了来自 ${req.ip} 的反向 WS 握手：Access Token 不匹配`
          )
          return false
        }
      })
      opts.hooks.logger.info(`反向 WS 端点已挂载，请在 ${PEER} 的 WebSocket 客户端中将地址填写为 ${opts.publicWsUrl}`)

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          arrive = undefined
          reject(
            new TimeoutError(
              `等待 ${Math.round(WAIT_FIRST_MS / 1000)} 秒后仍无对端连入。` +
                `请确认 ${PEER} 的网络配置中存在一条 WebSocket 客户端指向 ${opts.publicWsUrl}，且 Access Token 一致（将自动重试）`
            )
          )
        }, WAIT_FIRST_MS)
        timer.unref?.()

        /**
         * 结束等待
         * @param err 有值表示失败
         */
        const finish = (err?: Error): void => {
          clearTimeout(timer)
          opts.signal.removeEventListener("abort", onAbort)
          if (err) reject(err)
          else resolve()
        }
        const onAbort = (): void => finish(new Error("账号已停用"))

        arrive = finish
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener("abort", onAbort, { once: true })
      })
    },

    async close(): Promise<void> {
      closed = true
      arrive?.(new Error("主动断开"))
      arrive = undefined
      teardown("主动断开")
      return Promise.resolve()
    },

    call<T>(action: string, params?: Record<string, unknown>): Promise<T> {
      return session.call<T>(action, params)
    }
  }
}
