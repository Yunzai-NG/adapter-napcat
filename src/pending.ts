/**
 * 模块职责：将"发送一条 API 报文并等待其响应"表达为一个 Promise
 * 依赖方向：仅依赖内核的 defer 工具与类型包；不涉及 WebSocket，亦不涉及 OneBot
 * 生命周期：一个连接对应一个实例；连接断开时必须调用 `abortAll()`
 * 注意事项：OneBot 的 WebSocket 是全双工，请求与响应靠同一个 `echo` 关联、无顺序保证。此处登记一个
 *          Promise、响应到达即 resolve，取代忙等轮询。代价是三项事务须自行管理，遗漏任一即泄漏或悬挂：
 *          超时（对端可能始终不响应）、断线（socket 关闭后须立即拒绝，否则调用方白等到超时）、
 *          发送失败（`send()` 抛错时要摘掉刚登记的条目）。
 */
import { TimeoutError } from "@yunzai-ng/core"

/** 一条挂起的调用 */
interface PendingEntry {
  /** API 名称，仅用于错误信息 */
  action: string
  /** 成功回调 */
  resolve: (value: unknown) => void
  /** 失败回调 */
  reject: (err: Error) => void
  /** 超时定时器 */
  timer: ReturnType<typeof setTimeout>
}

/** 挂起调用表的构造参数 */
export interface PendingCallsOptions {
  /** 单次调用的超时毫秒数 */
  timeout: number
  /**
   * `echo` 前缀
   *
   * 同一 NapCat 实例可能同时被多个框架实例连接（调试时较为常见）。前缀中带有账号标识，
   * 排查故障时可直接判定某条报文的发出方。
   */
  prefix?: string
}

/**
 * 按 `echo` 关联请求与响应的挂起调用表
 *
 * 线程模型：单线程，全部方法均在事件循环上同步执行，无需加锁。
 */
export class PendingCalls {
  /** echo → 挂起条目 */
  readonly #entries = new Map<string, PendingEntry>()
  /** 超时毫秒 */
  readonly #timeout: number
  /** echo 前缀 */
  readonly #prefix: string
  /** 自增序号 */
  #seq = 0

  /**
   * @param opts 构造参数
   */
  constructor(opts: PendingCallsOptions) {
    this.#timeout = opts.timeout
    this.#prefix = opts.prefix === undefined || opts.prefix === "" ? "yzng" : opts.prefix
  }

  /** 当前挂起的调用数 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 发起一次调用并等待响应
   *
   * 登记**先于**发送：顺序相反时，一条极快返回的响应将在登记完成前到达，
   * 从而被视为"无人认领的 echo"而丢弃，致使调用方持续等待至超时。
   * @param action API 名称，用于超时与断线时的错误信息
   * @param send 实际发出报文；参数为本次分配的 echo
   * @returns 平台返回的 `data` 字段
   * @throws TimeoutError 超时；Error 连接断开或发送失败
   */
  invoke<T>(action: string, send: (echo: string) => void): Promise<T> {
    this.#seq += 1
    const echo = `${this.#prefix}-${this.#seq}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#entries.delete(echo)
        reject(
          new TimeoutError(
            `NapCat 调用 ${action} 在 ${this.#timeout}ms 内未收到响应（echo=${echo}）。` +
              `常见原因：NapCat 侧不支持该接口，或连接已失效而 socket 尚未关闭`
          )
        )
      }, this.#timeout)
      // 一次挂起的 API 调用不应具备阻止整个进程退出的能力
      timer.unref?.()

      this.#entries.set(echo, { action, resolve: resolve as (value: unknown) => void, reject, timer })

      try {
        send(echo)
      } catch (err) {
        this.#discard(echo)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * 兑现一条响应
   * @param echo 响应中带回的 echo
   * @param data 平台返回的数据
   * @returns 是否命中对应的挂起调用
   */
  settle(echo: string, data: unknown): boolean {
    const entry = this.#discard(echo)
    if (!entry) return false
    entry.resolve(data)
    return true
  }

  /**
   * 使一条调用失败
   * @param echo 响应中带回的 echo
   * @param err 错误
   * @returns 是否命中对应的挂起调用
   */
  fail(echo: string, err: Error): boolean {
    const entry = this.#discard(echo)
    if (!entry) return false
    entry.reject(err)
    return true
  }

  /**
   * 拒绝全部挂起调用
   *
   * 连接断开时必须调用，理由见文件头的「断线」一项。
   * @param reason 原因，将拼接至每个调用方所见的错误信息中
   * @returns 被拒绝的调用数
   */
  abortAll(reason: string): number {
    const entries = [...this.#entries.entries()]
    this.#entries.clear()
    for (const [echo, entry] of entries) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`NapCat 调用 ${entry.action} 未能完成：${reason}（echo=${echo}）`))
    }
    return entries.length
  }

  /**
   * 摘除一个条目并停止其定时器
   * @param echo 键
   * @returns 被摘除的条目；不存在时 undefined
   */
  #discard(echo: string): PendingEntry | undefined {
    const entry = this.#entries.get(echo)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.#entries.delete(echo)
    return entry
  }
}
