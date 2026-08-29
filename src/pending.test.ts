/**
 * 模块职责：挂起调用表的测试 —— 固定"以 echo 关联请求与响应"的全部边界行为
 * 依赖方向：测试文件，依赖 pending.ts 与内核的 TimeoutError
 * 生命周期：纯内存，每个用例一个实例
 * 注意事项：五项行为逐一固定：乱序兑现、超时、断线拒绝、发送失败即时拒绝、
 *          无人认领的 echo。上述任一项缺失即表现为调用悬挂或条目泄漏，而两者
 *          在运行时均无显式报错，仅表现为"该命令无响应"。
 */
import { describe, expect, it } from "vitest"
import { TimeoutError } from "@yunzai-ng/core"
import { PendingCalls } from "./pending.js"

describe("PendingCalls", () => {
  it("按 echo 关联响应，乱序返回时亦各自兑现", async () => {
    const calls = new PendingCalls({ timeout: 1000 })
    const echoes: string[] = []
    const first = calls.invoke<string>("get_login_info", echo => echoes.push(echo))
    const second = calls.invoke<string>("get_group_list", echo => echoes.push(echo))

    expect(calls.size).toBe(2)
    // 后发者先返回：此即须依赖 echo 而不能按顺序配对的原因
    calls.settle(echoes[1]!, "群列表")
    calls.settle(echoes[0]!, "登录信息")

    await expect(first).resolves.toBe("登录信息")
    await expect(second).resolves.toBe("群列表")
    expect(calls.size).toBe(0)
  })

  it("超时抛出 TimeoutError，且不残留挂起条目", async () => {
    const calls = new PendingCalls({ timeout: 20 })
    const promise = calls.invoke("send_group_msg", () => undefined)
    await expect(promise).rejects.toThrow(TimeoutError)
    expect(calls.size).toBe(0)
  })

  it("abortAll 立即拒绝全部挂起调用", async () => {
    const calls = new PendingCalls({ timeout: 10_000 })
    const a = calls.invoke("get_msg", () => undefined)
    const b = calls.invoke("delete_msg", () => undefined)

    expect(calls.abortAll("连接已断开")).toBe(2)
    // 错误信息中必须带有具体 API 名称，否则日志中仅存"连接已断开"一句，无法判定丢失了哪些调用
    await expect(a).rejects.toThrow(/get_msg.*连接已断开/)
    await expect(b).rejects.toThrow(/delete_msg/)
    expect(calls.size).toBe(0)
  })

  it("发送失败时立即拒绝，不等待至超时", async () => {
    const calls = new PendingCalls({ timeout: 10_000 })
    const promise = calls.invoke("send_msg", () => {
      throw new Error("socket 已关闭")
    })
    await expect(promise).rejects.toThrow("socket 已关闭")
    expect(calls.size).toBe(0)
  })

  it("无人认领的 echo 返回 false，且不影响其余调用", async () => {
    const calls = new PendingCalls({ timeout: 1000 })
    const echoes: string[] = []
    const promise = calls.invoke<number>("get_status", echo => echoes.push(echo))

    expect(calls.settle("他方的-echo", 1)).toBe(false)
    expect(calls.fail("他方的-echo", new Error("x"))).toBe(false)
    expect(calls.size).toBe(1)

    calls.settle(echoes[0]!, 42)
    await expect(promise).resolves.toBe(42)
  })

  it("fail 将平台返回的失败原因传递给调用方", async () => {
    const calls = new PendingCalls({ timeout: 1000, prefix: "10001" })
    const echoes: string[] = []
    const promise = calls.invoke("set_group_ban", echo => echoes.push(echo))

    expect(echoes[0]).toMatch(/^10001-/)
    calls.fail(echoes[0]!, new Error("retcode=1200 权限不足"))
    await expect(promise).rejects.toThrow("权限不足")
  })
})
