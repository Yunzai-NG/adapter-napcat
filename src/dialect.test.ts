/**
 * 模块职责：认实现的用例
 * 依赖方向：测试文件，只依赖 dialect.ts
 * 生命周期：纯函数，无夹具
 * 注意事项：应用名取自两家源码里 `get_version_info` 的返回值：NapCat 报 `NapCat.Onebot`，
 *          LLOneBot（现名 LuckyLilliaBot）报 `LLOneBot`。
 */
import { describe, expect, it } from "vitest"
import { detectImpl, implLabel, implOf } from "./dialect.js"

describe("implOf", () => {
  it("认得两家自报的应用名，不分大小写", () => {
    expect(implOf("NapCat.Onebot")).toBe("napcat")
    expect(implOf("LLOneBot")).toBe("llonebot")
    expect(implOf("luckylilliabot")).toBe("llonebot")
  })

  it("别家与没报的都是 other", () => {
    expect(implOf("Lagrange.OneBot")).toBe("other")
    expect(implOf(undefined)).toBe("other")
  })
})

describe("implLabel", () => {
  it("带上自报的版本；认不出的用它自报的名字", () => {
    expect(implLabel({ impl: "llonebot", appName: "LLOneBot", version: "7.4.2" })).toBe("LLOneBot 7.4.2")
    expect(implLabel({ impl: "other", appName: "Lagrange.OneBot", version: "0.0.3" })).toBe("Lagrange.OneBot 0.0.3")
    expect(implLabel({ impl: "other" })).toBe("OneBot v11 端")
  })
})

describe("detectImpl", () => {
  it("调 get_version_info 并认出实现", async () => {
    const seen: string[] = []
    const info = await detectImpl(action => {
      seen.push(action)
      return Promise.resolve({ app_name: "NapCat.Onebot", protocol_version: "v11", app_version: "4.8.0" })
    })
    expect(seen).toEqual(["get_version_info"])
    expect(info).toEqual({ impl: "napcat", appName: "NapCat.Onebot", version: "4.8.0" })
  })

  it("调用失败不抛错，退回 other", async () => {
    expect(await detectImpl(() => Promise.reject(new Error("不支持")))).toEqual({ impl: "other" })
  })

  it("对端不回时不干等，到点退回 other", async () => {
    expect(await detectImpl(() => new Promise(() => undefined), 20)).toEqual({ impl: "other" })
  })
})
