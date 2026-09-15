/**
 * 模块职责：通道抽象 —— 将"四种网络模式"收敛为一个"可调用 API、可接收事件"的接口
 * 依赖方向：依赖 protocol / config 与类型包；不涉及消息段，亦不涉及 BotApi
 * 生命周期：一个账号对应一条通道，`open()` 与 `close()` 各调用一次
 * 注意事项：四种模式实为两组正交的选择 —— 事件由哪方主动、API 走哪条通路：
 *
 *          | 模式 | 事件来源 | API 通路 |
 *          | --- | --- | --- |
 *          | ws | 框架连出的 socket | 同一条 socket |
 *          | ws-reverse | 对端连入的 socket | 同一条 socket |
 *          | http | 收不到 | HTTP 请求 |
 *          | http-post | 对端 POST 进来 | HTTP 请求 |
 *
 *          故只实现三个（两种 WS 共用报文层，两种 HTTP 共用调用层），否则会得到四份几乎相同的
 *          重连、鉴权与错误处理。
 */
import type { Logger, RouteRequest } from "@yunzai-ng/types"
import { tokenEquals } from "@yunzai-ng/core"
import type { NapcatMode } from "./config.js"

/** 通道向上层回报的事件 */
export interface TransportHooks {
  /** 通道专属日志器 */
  readonly logger: Logger

  /**
   * 收到一条事件报文（已确认非 API 响应）
   * @param payload 已解析的报文
   */
  onEvent(payload: Record<string, unknown>): void

  /**
   * 通道已断开
   *
   * 仅在"连接建立之后断开"时调用；`open()` 阶段的失败经 `open()` 抛错表达。
   * @param reason 原因，将展示于账号状态中
   */
  onClosed(reason: string): void
}

/** 通道 */
export interface Transport {
  /** 网络模式 */
  readonly mode: NapcatMode
  /** 可读的连接说明，用于日志与账号状态 */
  readonly describe: string
  /** 当前是否可发起调用 */
  readonly ready: boolean

  /**
   * 建立通道
   *
   * 对主动连出的模式即"完成连接"；对等待对端连入的模式即"挂载端点并等到第一条连接"。
   * 两者均须在**确实可以收发**之后方可返回 —— 内核随即会将账号标记为在线。
   * @throws 连接失败、鉴权失败或等待超时
   */
  open(): Promise<void>

  /** 关闭通道并释放全部资源（socket、定时器、路由） */
  close(): Promise<void>

  /**
   * 调用一次 API
   * @param action API 名
   * @param params 参数
   * @returns 响应中的 `data`
   * @throws NapcatApiError 平台返回失败；TimeoutError 超时；Error 通道未就绪
   */
  call<T>(action: string, params?: Record<string, unknown>): Promise<T>
}

/** 鉴权用的请求头名 */
export const AUTH_HEADER = "authorization"

/** 上报签名的请求头名 */
export const SIGNATURE_HEADER = "x-signature"

/** 对端在握手与上报中携带的账号 id 请求头 */
export const SELF_ID_HEADER = "x-self-id"

/**
 * 取一个请求头的单值形式
 *
 * 请求头可能为数组（同名头出现多次）。此处取第一项而非执行 join —— 鉴权头出现两次
 * 时，将其拼接后必然不等于任何一个合法取值，其结果为"配置正确却无法通过校验"。
 * @param req 请求
 * @param name 头名（小写）
 * @returns 头值；不存在时为空串
 */
export function headerOf(req: RouteRequest, name: string): string {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0] ?? ""
  return raw ?? ""
}

/**
 * 校验 Bearer 令牌
 *
 * 兼容三种写法：`Bearer x`、裸 `x`（部分 NapCat 版本采用该形式），以及 query 中的
 * `access_token=x`（OneBot v11 标准允许，但不推荐）。
 *
 * 比较采用内核的 `tokenEquals`（SHA-256 摘要 + `timingSafeEqual`）而非 `===`：
 * 该端点对公网开放时，逐字节短路比较会将令牌正确前缀的长度泄漏为耗时差异。
 * @param req 握手或上报请求
 * @param expected 期望的令牌；空串表示不予校验
 * @returns 是否通过
 */
export function checkToken(req: RouteRequest, expected: string): boolean {
  if (expected === "") return true

  const header = headerOf(req, AUTH_HEADER)
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header
  if (tokenEquals(expected, bearer)) return true

  const query = req.query["access_token"]
  const fromQuery = Array.isArray(query) ? query[0] : query
  return fromQuery !== undefined && tokenEquals(expected, fromQuery)
}
