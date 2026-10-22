/**
 * 模块职责：两种 HTTP 模式 —— 调用经 HTTP 请求发出，事件（可选）由对端 POST 送入
 * 依赖方向：依赖 protocol / events / transport 与内核的 HttpClient
 * 生命周期：`open()` 执行探活并（http-post 时）挂载上报端点，`close()` 注销端点
 * 注意事项：**`http` 模式无法接收任何事件，此为协议所决定，并非缺陷。** 对端的
 *          HTTP 服务器仅应答请求，不会主动推送。适配器必须在连接建立时明确警告一次，
 *          否则使用者将认为系自身配置错误，进而反复检查 NapCat 的设置。
 *
 *          **上报签名的密钥即为 token。** NapCat 与 LLOneBot 的上报配置里都没有独立的
 *          secret 字段（该点与 OneBot v11 标准不同）：已配置 token 时即以其计算
 *          HMAC-SHA1，签名置于 `x-signature: sha1=<hex>`。因此 http-post 模式下
 *          对端两条配置（HTTP 服务器与 HTTP 上报）的 token 必须填写为同一取值。
 *
 *          **HTTP 出错时亦可能返回 200。** NapCat 在 HTTP 通道上将"handler 抛出异常"
 *          与"不支持的 action"均表达为 `retcode: 200`，仅 `status` 字段可信。
 *          故此处不依据 HTTP 状态码作出结论，一律交由 `unwrap()` 判定。唯一的例外是 404：
 *          LLOneBot 对不认识的 action 回真的 404，同时带一份 OneBot 报文 —— 有报文就照报文说
 *          「不支持该 API」，没有才说「这地址可能指向了别的服务」。
 */
import { AbortError, isLoopbackAddress } from "@yunzai-ng/core"
import type {
  Disposer,
  HttpClient,
  RouteHandler,
  RouteOptions,
  RouteRequest,
  RouteResponse
} from "@yunzai-ng/types"
import { PEER } from "./dialect.js"
import { unwrap } from "./protocol.js"
import type { ApiResponse } from "./protocol.js"
import { verifySignature } from "./sign.js"
import { headerOf, SIGNATURE_HEADER } from "./transport.js"
import type { Transport, TransportHooks } from "./transport.js"

/** HTTP 通道的构造参数 */
export interface HttpTransportOptions {
  /** 是否接收对端 POST 送入的事件（`http-post` 为真，`http` 为假） */
  inbound: boolean
  /** 对端的 HTTP 服务器地址 */
  url: string
  /** 上报端点路径；`inbound` 为假时忽略 */
  path: string
  /** Access Token，空串表示不进行鉴权 */
  token: string
  /** 调用超时毫秒 */
  timeout: number
  /** 完整的对外上报地址，仅用于提示使用者应在对端填写的取值 */
  publicPostUrl: string
  /** 内核的 HTTP 客户端 */
  http: HttpClient
  /** 上层回调 */
  hooks: TransportHooks

  /**
   * 注册 HTTP 路由（内核 `host.route`）
   * @param method 方法
   * @param path 路径
   * @param handler 处理函数
   * @param routeOpts 选项
   * @returns 注销句柄
   */
  register(method: "GET" | "POST", path: string, handler: RouteHandler, routeOpts?: RouteOptions): Disposer
}

/**
 * 创建 HTTP 通道
 * @param opts 构造参数
 * @returns 通道
 */
export function createHttpTransport(opts: HttpTransportOptions): Transport {
  /** 上报端点注销句柄 */
  let unregister: Disposer | undefined
  /** 是否已就绪 */
  let live = false

  /** 调用时携带的请求头 */
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts.token !== "") headers["Authorization"] = `Bearer ${opts.token}`

  /** 去除末尾斜杠的基址，拼接路径时不致出现 `//action` */
  const base = opts.url.replace(/\/+$/, "")

  /**
   * 调用一次 API
   * @param action API 名
   * @param params 参数
   * @returns 响应中的 data
   */
  const call = async <T>(action: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!live) throw new Error(`无法调用 ${action}：HTTP 通道尚未就绪`)

    let res
    try {
      res = await opts.http.request<ApiResponse<T>>(`${base}/${action}`, {
        method: "POST",
        headers,
        // OneBot 的 HTTP 接口以请求体本身作为参数，不再额外包裹一层 `params`
        json: params,
        timeout: opts.timeout,
        responseType: "json",
        // 出错时返回 200 为常态（参见文件头），状态码不足以判定成败，统一交由 unwrap
        throwOnError: false
      })
    } catch (err) {
      // 中止原样抛出。core 0.2.0 起 ctx.http 派生自插件的卸载信号，重载或停机会中止在途请求 ——
      // 若一并包成下面那句，日志里就会出现「请检查网络配置」，而对端其实一切正常
      if (err instanceof AbortError) throw err
      const text = err instanceof Error ? err.message : String(err)
      throw new Error(
        `调用 ${action} 时无法连接 ${base}：${text}。` +
          `请检查 ${PEER} 的网络配置中该条 HTTP 服务器是否已启用、端口是否一致`
      )
    }

    if (res.status === 403 || res.status === 401) {
      throw new Error(`${base} 拒绝了调用 ${action}（HTTP ${res.status}）：Access Token 与对端的取值不一致`)
    }
    const body = res.data
    // 见文件头最后一条：带着 OneBot 报文的 404 是「对端不支持该 API」
    if (res.status === 404 && (typeof body !== "object" || body === null || typeof body.status !== "string")) {
      throw new Error(`${base} 上不存在 ${action} 接口（HTTP 404）：该地址可能指向了其他服务`)
    }
    if (typeof body !== "object" || body === null) {
      throw new Error(`调用 ${action} 得到的响应不是 JSON 对象（HTTP ${res.status}），对端可能不是 OneBot v11 实现`)
    }
    return unwrap(action, body)
  }

  /**
   * 处理一条上报
   * @param req 请求
   * @returns 响应
   */
  const onReport: RouteHandler = (req: RouteRequest): RouteResponse => {
    // 没有 token 就没有签名可验，此时只认本机，理由同 checkToken
    if (opts.token === "" && !isLoopbackAddress(req.ip)) {
      opts.hooks.logger.warn(
        `已拒收来自 ${req.ip} 的上报：账号没填 Access Token 时只接受本机上报。对端不在本机时，两边填上同一个 token`
      )
      return { status: 403, body: { error: "未配置 token 时只接受本机上报" } }
    }
    if (!verifySignature(req.rawBody, headerOf(req, SIGNATURE_HEADER), opts.token)) {
      opts.hooks.logger.warn(
        `已拒收来自 ${req.ip} 的上报：x-signature 校验失败。` +
          `请确认 ${PEER} 的 HTTP 服务器与 HTTP 上报两条配置中的 token 填写为同一取值`
      )
      return { status: 403, body: { error: "签名校验失败" } }
    }

    const payload = req.body
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      opts.hooks.logger.debug("收到一条 body 不是 JSON 对象的上报，已忽略")
      return { status: 204 }
    }

    opts.hooks.onEvent(payload as Record<string, unknown>)
    // 返回 204 空响应为刻意设计：对端会将上报的响应体解析为"快速操作"（自动同意
    // 加群、自动回复等），随意返回一个 JSON 可能触发预期之外的动作
    return { status: 204 }
  }

  return {
    mode: opts.inbound ? "http-post" : "http",
    describe: opts.inbound ? `HTTP → ${base}，事件 ← ${opts.publicPostUrl}` : `HTTP → ${base}（仅可发送，无法接收）`,

    get ready(): boolean {
      return live
    },

    async open(): Promise<void> {
      if (opts.inbound) {
        unregister = opts.register("POST", opts.path, onReport, {
          // 上报端点自带签名校验，不可要求面板令牌：对端无从得知该令牌
          auth: false,
          // 验签必须使用原始字节，重新序列化后计算的摘要将不匹配（参见 sign.ts）
          rawBody: true,
          // 一条合并转发的上报可能相当大，默认 1MB 会将其截断为畸形 JSON
          bodyLimit: 8 * 1024 * 1024
        })
        opts.hooks.logger.info(`上报端点已挂载，请在 ${PEER} 的 HTTP 上报配置中将地址填写为 ${opts.publicPostUrl}`)
      }

      // 探活：先调用一次代价最低的 API。由此可使"地址填写错误""token 不匹配"
      // "对端未启动"在连接阶段即报出，而非等到发送第一条消息时才失败
      live = true
      try {
        await call("get_login_info")
      } catch (err) {
        live = false
        unregister?.()
        unregister = undefined
        throw err
      }

      if (!opts.inbound) {
        opts.hooks.logger.warn(
          `账号以「HTTP（仅可发送，无法接收）」模式连接：对端的 HTTP 服务器不会主动推送事件，` +
            `故该账号无法接收任何消息，仅可用于单向推送。需要接收消息请改用正向或反向 WS，或增加一条 HTTP 上报配置`
        )
      }
    },

    async close(): Promise<void> {
      live = false
      unregister?.()
      unregister = undefined
      return Promise.resolve()
    },

    call
  }
}
