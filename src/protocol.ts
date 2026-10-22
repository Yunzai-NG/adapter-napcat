/**
 * 模块职责：OneBot v11 的 API 信封 —— 请求形状、响应形状、失败判定
 * 依赖方向：叶子模块，不依赖内核，亦不依赖本插件其他文件
 * 生命周期：纯函数与类型
 * 注意事项：**成败只看 `status`，不看 HTTP 状态码，也不看「收到回复了」。** 对端对不认识的
 *          action 会回一条 `status: "failed"` 的正常报文（NapCat 在 HTTP 模式下状态码甚至是 200），此时
 *          `data` 为 null —— 直接取用要到数层调用之后才以 "cannot read property of null" 显现。
 *          retcode 为何不参与判定，见 `unwrap()`。
 */

/** 一次 API 调用的请求报文 */
export interface ApiRequest {
  /** API 名，如 `send_group_msg` */
  action: string
  /** 参数 */
  params: Record<string, unknown>
  /** 用于关联响应的回声标记；HTTP 模式无需该字段 */
  echo?: string
}

/**
 * 一次 API 调用的响应报文
 *
 * 字段名沿用 OneBot v11 原样（下划线），不在该层改名 —— 此处为协议边界，
 * 与抓包结果完全一致可显著减少对照文档的耗时。
 */
export interface ApiResponse<T = unknown> {
  /** `"ok"` / `"failed"` / `"async"` */
  status: string
  /** 0 表示成功；1 表示已接受但异步执行 */
  retcode: number
  /** 成功时的数据；失败时通常为 null */
  data: T
  /** 英文错误标识 */
  message?: string
  /** 中文错误原因（NapCat 与 LLOneBot 都给），报错时优先采用 */
  wording?: string
  /** 回声标记，与请求中的一致 */
  echo?: string
}

/**
 * API 调用失败
 *
 * 携带 retcode 以使调用方可区分"权限不足"与"网络异常"—— 前者重试任意次数均无效。
 */
export class NapcatApiError extends Error {
  /** 错误名 */
  override readonly name = "NapcatApiError"
  /** 失败的 API 名 */
  readonly action: string
  /** 平台返回码 */
  readonly retcode: number

  /**
   * @param action API 名
   * @param retcode 平台返回码
   * @param reason 原因描述
   */
  constructor(action: string, retcode: number, reason: string) {
    super(`调用 ${action} 失败（retcode=${retcode}）：${reason}`)
    this.action = action
    this.retcode = retcode
  }
}

/**
 * 已知 retcode 对应的排查方向
 *
 * WS 上两家同用 1200 / 1400；HTTP 上 LLOneBot 改用 200 / 400 / 404，NapCat 出错时也常回 200。
 */
const RETCODE_HINTS: Readonly<Record<number, string>> = {
  200: "对端处理该请求时抛出异常",
  400: "参数不合法，或报文未能被解析",
  404: "对端不支持该 API",
  1200: "对端处理该请求时抛出异常",
  1400: "参数不合法，或报文未能被解析",
  1403: "Access Token 校验失败",
  1404: "对端不支持该 API"
}

/**
 * 判定一条已解析的报文是否为 API 响应
 *
 * 与事件报文的区别在于：响应含 `retcode`，事件含 `post_type`。同一条 WebSocket 上
 * 两者混合传输，据此区分。
 * @param payload 已解析的报文
 * @returns 是否为 API 响应
 */
export function isApiResponse(payload: unknown): payload is ApiResponse {
  if (typeof payload !== "object" || payload === null) return false
  const obj = payload as Record<string, unknown>
  return typeof obj["retcode"] === "number" && obj["post_type"] === undefined
}

/**
 * 自响应中取出数据，失败则抛错
 *
 * **成败仅依据 `status`，不依据 `retcode`。** NapCat 与 LLOneBot 的 retcode 编号都不遵循 OneBot v11
 * 标准，WS 与 HTTP 两条路径亦各不相同（HTTP 出错时甚至可能为 200），故其仅用于给出
 * 排查方向，不参与判定。
 * @param action API 名，用于错误信息
 * @param res 响应报文
 * @returns `data` 字段
 * @throws NapcatApiError `status` 非 ok/async 时
 */
export function unwrap<T>(action: string, res: ApiResponse<T>): T {
  if (res.status === "ok" || res.status === "async") return res.data

  const hint = RETCODE_HINTS[res.retcode]
  const reason = res.wording ?? res.message ?? hint ?? "对端未给出原因"
  const suffix = hint !== undefined && reason !== hint ? `（${hint}）` : ""
  throw new NapcatApiError(action, res.retcode, `${reason}${suffix}`)
}

/**
 * 解析一条收到的文本报文
 *
 * 解析失败返回 undefined 而非抛错：单条畸形报文不应导致整条连接断开。
 * @param raw 原始文本或字节
 * @returns 解析后的对象；非合法 JSON 对象时 undefined
 */
export function parsePayload(raw: string | Uint8Array): Record<string, unknown> | undefined {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
