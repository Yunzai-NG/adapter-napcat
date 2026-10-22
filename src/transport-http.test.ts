/**
 * 模块职责：HTTP 通道的测试 —— 调用失败时的错误归因
 * 依赖方向：测试文件，依赖 transport-http.ts、内核测试工具与类型包
 * 生命周期：每项用例各自构造通道与 HttpClient 替身
 * 注意事项：核心用例是"中止不得被包装成配置错误"。core 0.2.0 起 ctx.http 派生自插件的
 *          卸载信号，重载与停机都会中止在途请求；若把 AbortError 一并归因为「请检查
 *          NapCat 的网络配置」，使用者会去翻一个本来正常的 NapCat。
 *          该情形在正常收发中不显现，只在重载与停机时出现，故须有用例守住。
 */
import { describe, expect, it } from "vitest"
import { AbortError, TimeoutError } from "@yunzai-ng/core"
import { fakeLogger } from "@yunzai-ng/core/testing"
import type { HttpClient, HttpResponse, RouteHandler, RouteRequest, RouteResponse } from "@yunzai-ng/types"
import { createHttpTransport } from "./transport-http.js"

/**
 * 构造一个只会以指定错误失败的 HttpClient
 * @param err 每次请求抛出的错误
 * @returns 客户端替身
 */
function failingHttp(err: unknown): HttpClient {
  const fail = (): never => {
    throw err
  }
  const client: HttpClient = {
    request: fail,
    get: fail,
    post: fail,
    buffer: fail,
    download: fail,
    extend: () => client
  }
  return client
}

/**
 * 构造一个恒定返回同一响应的 HttpClient
 * @param res 响应
 * @returns 客户端替身
 */
function stubHttp(res: Partial<HttpResponse<unknown>>): HttpClient {
  const reply = async (): Promise<HttpResponse<unknown>> =>
    Promise.resolve({ status: 200, headers: {}, data: undefined, ...res } as HttpResponse<unknown>)
  const client: HttpClient = {
    request: reply as HttpClient["request"],
    get: reply as unknown as HttpClient["get"],
    post: reply as unknown as HttpClient["post"],
    buffer: reply as unknown as HttpClient["buffer"],
    download: reply as unknown as HttpClient["download"],
    extend: () => client
  }
  return client
}

/**
 * 构造一条 `http` 模式的通道（不挂载上报端点）
 * @param http 客户端替身
 * @returns 通道
 */
function setup(http: HttpClient) {
  return createHttpTransport({
    inbound: false,
    url: "http://127.0.0.1:3000",
    path: "/napcat",
    token: "",
    timeout: 1000,
    publicPostUrl: "http://127.0.0.1:2536/adapter/napcat/napcat",
    http,
    hooks: { logger: fakeLogger(), onEvent: () => undefined, onClosed: () => undefined },
    register: () => () => undefined
  })
}

describe("HTTP 通道的错误归因", () => {
  it("中止原样抛出，不归因为对端配置错误", async () => {
    const transport = setup(failingHttp(new AbortError("请求已被取消：POST http://127.0.0.1:3000/get_login_info")))

    await expect(transport.open()).rejects.toThrow(AbortError)
    // 归因错了的话，使用者会去翻一个本来正常的 NapCat
    await expect(transport.open()).rejects.not.toThrow(/请检查/)
  })

  it("其余网络错误仍归因到对端的网络配置", async () => {
    const transport = setup(failingHttp(new TimeoutError("连接超时")))

    await expect(transport.open()).rejects.toThrow(/请检查 NapCat \/ LLOneBot 的网络配置/)
    // 原始错误信息须保留，否则无从判断是超时还是拒绝连接
    await expect(transport.open()).rejects.toThrow(/连接超时/)
  })

  it("探活失败后通道不置为就绪", async () => {
    const transport = setup(failingHttp(new AbortError()))

    await expect(transport.open()).rejects.toThrow()
    expect(transport.ready).toBe(false)
    // 未就绪时调用直接报出，而非发出一个必然失败的请求
    await expect(transport.call("send_msg")).rejects.toThrow(/尚未就绪/)
  })

  it("鉴权失败的状态码指向 token 不一致，而非地址错误", async () => {
    const transport = setup(stubHttp({ status: 403 }))

    await expect(transport.open()).rejects.toThrow(/Access Token 与对端的取值不一致/)
  })

  it("响应不是 JSON 对象时指出对端可能不是 OneBot v11 实现", async () => {
    const transport = setup(stubHttp({ status: 200, data: "<html>404</html>" }))

    await expect(transport.open()).rejects.toThrow(/对端可能不是 OneBot v11 实现/)
  })

  it("404 带着 OneBot 报文时照报文说不支持该 API（LLOneBot 对不认识的 action 就这样回）", async () => {
    const transport = setup(
      stubHttp({ status: 404, data: { status: "failed", retcode: 404, data: null, message: "foo API 不存在", wording: "foo API 不存在" } })
    )
    await expect(transport.open()).rejects.toThrow(/get_login_info 失败（retcode=404）：foo API 不存在/)
  })

  it("404 不带 OneBot 报文时仍指出该地址可能指向了别的服务", async () => {
    const transport = setup(stubHttp({ status: 404, data: "Not Found" }))
    await expect(transport.open()).rejects.toThrow(/可能指向了其他服务/)
  })
})

describe("HTTP 上报端点", () => {
  /**
   * 挂好上报端点，返回它的处理函数与收到的事件
   * @param token 账号的 Access Token
   * @returns 处理函数与事件列表
   */
  async function mountReport(token: string) {
    const events: unknown[] = []
    let handler: RouteHandler | undefined
    const transport = createHttpTransport({
      inbound: true,
      url: "http://127.0.0.1:3000",
      path: "/napcat",
      token,
      timeout: 1000,
      publicPostUrl: "http://127.0.0.1:2536/adapter/napcat/napcat",
      http: stubHttp({ status: 200, data: { status: "ok", retcode: 0, data: { user_id: 1, nickname: "n" } } }),
      hooks: { logger: fakeLogger(), onEvent: p => events.push(p), onClosed: () => undefined },
      register: (_method, _path, h) => {
        handler = h
        return () => undefined
      }
    })
    await transport.open()
    if (handler === undefined) throw new Error("上报端点没挂上")
    const post = async (ip: string) =>
      (await handler!({ ip, headers: {}, query: {}, params: {}, body: { post_type: "message" }, rawBody: Buffer.from("{}") } as unknown as RouteRequest)) as RouteResponse
    return { post, events }
  }

  it("未配置 token 时只收本机的上报", async () => {
    const { post, events } = await mountReport("")
    expect((await post("127.0.0.1"))?.status).toBe(204)
    expect((await post("192.168.1.20"))?.status).toBe(403)
    expect(events).toHaveLength(1)
  })
})
