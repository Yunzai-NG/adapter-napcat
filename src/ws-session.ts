/**
 * 模块职责：WebSocket 上的 OneBot 报文层 —— 收发、分流、静默检测
 * 依赖方向：依赖 pending / protocol；不涉及 socket 的建立方式
 * 生命周期：一条 socket 对应一个实例，socket 关闭时必须 `dispose()`
 * 注意事项：正向与反向 WS 的唯一区别是"由哪一方发起"，连接建立之后报文层完全相同，故两者共用本层。
 *
 *          **静默检测并非可选项。** 对端消失后 TCP 仍可长时间保持 ESTABLISHED（进程被 kill -9、
 *          宿主机休眠、NAT 表项过期）：socket 不产生 close 事件，发出的报文亦不报错，仅表现为
 *          永不返回响应，症状是"机器人不响应而面板显示在线"。NapCat 默认每 30 秒一次心跳，
 *          故"超过 N 秒未收到任何字节"是可靠得多的存活判据。
 */
import type { Logger } from "@yunzai-ng/types"
import { PendingCalls } from "./pending.js"
import { isApiResponse, parsePayload, unwrap } from "./protocol.js"
import type { ApiResponse } from "./protocol.js"

/** 报文层所需的最小 socket 能力 */
export interface Wire {
  /** 当前是否可发送 */
  readonly open: boolean

  /**
   * 发送一帧文本
   * @param text 报文
   */
  send(text: string): void

  /**
   * 主动关闭该条 socket
   * @param reason 原因
   */
  close(reason: string): void
}

/** 会话构造参数 */
export interface WsSessionOptions {
  /** 日志器 */
  logger: Logger
  /** API 调用超时毫秒 */
  timeout: number
  /** 静默超时毫秒；0 表示不检测 */
  idleTimeout: number
  /** `echo` 前缀，便于在 NapCat 侧日志中识别报文来源 */
  prefix: string

  /**
   * 收到事件报文
   * @param payload 已解析的报文
   */
  onEvent(payload: Record<string, unknown>): void

  /**
   * 判定连接已死
   * @param reason 原因
   */
  onDead(reason: string): void
}

/**
 * 一条 WebSocket 上的 OneBot 会话
 *
 * 线程模型：单线程，全部方法在事件循环上同步执行。
 */
export class WsSession {
  /** 挂起的调用 */
  readonly #pending: PendingCalls
  /** 构造参数 */
  readonly #opts: WsSessionOptions
  /** 底层 socket */
  #wire: Wire | undefined
  /** 静默检测定时器 */
  #idle: ReturnType<typeof setTimeout> | undefined
  /** 是否已上报过死亡，用于避免重复上报 */
  #dead = false

  /**
   * @param opts 构造参数
   */
  constructor(opts: WsSessionOptions) {
    this.#opts = opts
    this.#pending = new PendingCalls({ timeout: opts.timeout, prefix: opts.prefix })
  }

  /** 当前是否可以发起调用 */
  get ready(): boolean {
    return this.#wire?.open === true && !this.#dead
  }

  /** 挂起中的调用数，用于排障 */
  get inflight(): number {
    return this.#pending.size
  }

  /**
   * 绑定一条 socket
   *
   * 会话可先构造、后绑定：反向模式须在对端连入之前即将会话准备就绪，
   * 否则首帧报文将因"会话尚未创建"而被丢弃。
   * @param wire 底层 socket
   */
  attach(wire: Wire): void {
    this.#wire = wire
    this.#dead = false
    this.#touch()
  }

  /**
   * 送入一帧收到的数据
   *
   * 响应与事件在同一条 socket 上混合传输，依据是否存在 `retcode` 区分（参见 protocol.ts）。
   * @param raw 原始文本或字节
   */
  feed(raw: string | Uint8Array): void {
    this.#touch()

    const payload = parsePayload(raw)
    if (payload === undefined) {
      // 不断开连接：单帧畸形报文不影响后续帧，断开反而将丢失正常消息
      this.#opts.logger.debug("收到一帧无法解析为 JSON 对象的报文，已忽略")
      return
    }

    if (!isApiResponse(payload)) {
      this.#opts.onEvent(payload)
      return
    }

    const res = payload as unknown as ApiResponse
    const echo = res.echo
    if (typeof echo !== "string" || echo === "") {
      // NapCat 在部分主动推送中亦携带 retcode（如状态变更），无 echo 者不属于任何调用的响应
      this.#opts.logger.debug(`收到一条没有 echo 的响应报文（retcode=${res.retcode}），已忽略`)
      return
    }
    if (!this.#pending.settle(echo, res)) {
      // 最常见的来源为响应在超时之后才到达。此处予以记录，因其意味着超时值配置过小
      this.#opts.logger.debug(`响应 echo=${echo} 没有对应的挂起调用，可能是超时后才到达`)
    }
  }

  /**
   * 调用一次 API
   * @param action API 名
   * @param params 参数
   * @returns 响应中的 `data`
   * @throws Error 通道未就绪；NapcatApiError 平台返回失败；TimeoutError 超时
   */
  async call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const wire = this.#wire
    if (wire === undefined || !wire.open) {
      throw new Error(`无法调用 ${action}：与 NapCat 的连接尚未建立或已断开`)
    }
    const res = await this.#pending.invoke<ApiResponse<T>>(action, echo => {
      wire.send(JSON.stringify({ action, params, echo }))
    })
    return unwrap(action, res)
  }

  /**
   * 断开：停止定时器并拒绝全部挂起调用
   *
   * 该方法幂等。挂起调用必须于此处拒绝，而非交由其各自超时 —— 参见 pending.ts 第 2 条。
   * @param reason 原因
   */
  dispose(reason: string): void {
    this.#dead = true
    if (this.#idle !== undefined) {
      clearTimeout(this.#idle)
      this.#idle = undefined
    }
    this.#wire = undefined
    const aborted = this.#pending.abortAll(reason)
    if (aborted > 0) this.#opts.logger.debug(`连接断开，${aborted} 个挂起的调用已被拒绝：${reason}`)
  }

  /** 收到任何数据即重置静默计时 */
  #touch(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    if (this.#opts.idleTimeout <= 0) return

    this.#idle = setTimeout(() => {
      if (this.#dead) return
      this.#dead = true
      const seconds = Math.round(this.#opts.idleTimeout / 1000)
      const reason = `${seconds} 秒内没有收到任何报文（含心跳），判定连接已死`
      this.#wire?.close(reason)
      this.#opts.onDead(reason)
    }, this.#opts.idleTimeout)
    this.#idle.unref?.()
  }
}
