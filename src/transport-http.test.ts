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
import type { HttpClient, HttpResponse } from "@yunzai-ng/types"
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
  it("中止原样抛出，不归因为 NapCat 配置错误", async () => {
    const transport = setup(failingHttp(new AbortError("请求已被取消：POST http://127.0.0.1:3000/get_login_info")))

    await expect(transport.open()).rejects.toThrow(AbortError)
    // 归因错了的话，使用者会去翻一个本来正常的 NapCat
    await expect(transport.open()).rejects.not.toThrow(/请检查 NapCat/)
  })

  it("其余网络错误仍归因到 NapCat 的网络配置", async () => {
    const transport = setup(failingHttp(new TimeoutError("连接超时")))

    await expect(transport.open()).rejects.toThrow(/请检查 NapCat 的「网络配置」/)
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

    await expect(transport.open()).rejects.toThrow(/Access Token 与 NapCat 侧的取值不一致/)
  })

  it("响应不是 JSON 对象时指出对端可能并非 NapCat", async () => {
    const transport = setup(stubHttp({ status: 200, data: "<html>404</html>" }))

    await expect(transport.open()).rejects.toThrow(/对端可能并非 NapCat/)
  })
})
