/**
 * 模块职责：账号配置校验的测试 —— 固定四种网络模式各自的字段要求与报错文案
 * 依赖方向：测试文件，依赖 config.ts 与内核的 SchemaError
 * 生命周期：纯函数，无状态
 * 注意事项：报错文案本身即为断言对象。协议填写错误为最常见的配置错误，其提示中
 *          必须包含期望的协议与出错字段路径，否则面板无法将错误定位至具体输入框，
 *          使用者亦仅能看到"连接失败"而无从判断原因。
 */
import { describe, expect, it } from "vitest"
import { SchemaError } from "@yunzai-ng/core"
import { ACCOUNT_SCHEMA, isInbound, isOutbound, validateAccount } from "./config.js"

describe("账号配置", () => {
  it("仅填写 mode 亦可得到一份可用配置", () => {
    const account = validateAccount({ mode: "ws" })
    expect(account.url).toBe("ws://127.0.0.1:3001")
    expect(account.localFileAccess).toBe(true)
    expect(account.timeout).toBe("15s")
  })

  it("正向 WS 填入 http:// 时明确指出协议不匹配", () => {
    try {
      validateAccount({ mode: "ws", url: "http://127.0.0.1:3001" })
      expect.unreachable("应当抛出")
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaError)
      const issues = (err as SchemaError).issues
      // path 必须为 url，面板据此将错误标记至对应输入框
      expect(issues[0]?.path).toBe("url")
      expect(issues[0]?.message).toContain("ws://")
    }
  })

  it("HTTP 模式填入 ws:// 同样被拦截", () => {
    expect(() => validateAccount({ mode: "http", url: "ws://127.0.0.1:3000" })).toThrow(/http:\/\//)
  })

  it("反向 WS 不校验 url，但要求监听路径以 / 开头", () => {
    const ok = validateAccount({ mode: "ws-reverse", url: "该字段在此模式下不参与校验", listenPath: "/napcat" })
    expect(ok.listenPath).toBe("/napcat")
    expect(() => validateAccount({ mode: "ws-reverse", listenPath: "napcat" })).toThrow(/应以 \/ 开头/)
    expect(() => validateAccount({ mode: "ws-reverse", listenPath: "  " })).toThrow(/不能为空/)
  })

  it("http-post 同时须填写 NapCat 地址与本机监听路径", () => {
    const account = validateAccount({ mode: "http-post", url: "http://127.0.0.1:3000", listenPath: "/napcat" })
    expect(isOutbound(account.mode)).toBe(true)
    expect(isInbound(account.mode)).toBe(true)
    expect(() => validateAccount({ mode: "http-post", url: "", listenPath: "/napcat" })).toThrow(/不能为空/)
  })

  it("地址两端的空白被剔除", () => {
    // 自 NapCat 界面复制地址时极易带入尾随空格
    expect(validateAccount({ mode: "ws", url: "  ws://127.0.0.1:3001  " }).url).toBe("ws://127.0.0.1:3001")
  })

  it("条数一类的越界取值由 schema 拦截", () => {
    expect(() => validateAccount({ mode: "ws", memberCacheMax: -1 })).toThrow(SchemaError)
    expect(() => validateAccount({ mode: "ws", timeout: "半分钟" })).toThrow(SchemaError)
  })

  it("token 被标记为敏感项，面板与日志均予脱敏", () => {
    expect(ACCOUNT_SCHEMA.secretPaths()).toContain("token")
  })

  it("表单描述中包含四种模式与条件显隐信息", () => {
    const shape = ACCOUNT_SCHEMA.describe().properties
    expect(shape?.mode?.enum?.map(item => item.value)).toEqual(["ws", "ws-reverse", "http", "http-post"])
    // 数组形式的 showWhen 表示"取其中之一"：地址在三种主动连出的模式下均须填写
    expect(shape?.url?.showWhen).toEqual({ mode: ["ws", "http", "http-post"] })
    expect(shape?.listenPath?.showWhen).toEqual({ mode: ["ws-reverse", "http-post"] })
  })
})
