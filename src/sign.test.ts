/**
 * 模块职责：上报签名校验的测试 —— 固定 HMAC-SHA1 校验在各类输入下的判定结果
 * 依赖方向：测试文件，依赖 sign.ts 与 node:crypto
 * 生命周期：纯函数，无状态
 * 注意事项：其中两项用例针对的是安全缺陷而非功能缺陷：**无原始字节时必须判否**，
 *          以及**长度不等的签名不得使进程抛错**。二者在功能测试中均不显现，却分别
 *          对应"验签被绕过"与"构造畸形头部即可使上报端点崩溃"。
 */
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifySignature } from "./sign.js"

/** 构造一个正确的签名头值 */
const sign = (body: string, token: string): string => `sha1=${createHmac("sha1", token).update(body).digest("hex")}`

describe("上报签名校验", () => {
  const body = Buffer.from(JSON.stringify({ post_type: "message", user_id: 10001 }))
  const token = "s3cr3t"

  it("签名正确时通过", () => {
    expect(verifySignature(body, sign(body.toString(), token), token)).toBe(true)
  })

  it("允许省略 sha1= 前缀", () => {
    const bare = createHmac("sha1", token).update(body).digest("hex")
    expect(verifySignature(body, bare, token)).toBe(true)
    expect(verifySignature(body, bare.toUpperCase(), token)).toBe(true)
  })

  it("密钥不匹配时拒绝", () => {
    expect(verifySignature(body, sign(body.toString(), "其他密钥"), token)).toBe(false)
  })

  it("请求体被篡改时拒绝", () => {
    const tampered = Buffer.from(JSON.stringify({ post_type: "message", user_id: 99999 }))
    expect(verifySignature(tampered, sign(body.toString(), token), token)).toBe(false)
  })

  it("未配置 token 时不予校验", () => {
    expect(verifySignature(body, "", "")).toBe(true)
    expect(verifySignature(undefined, "", "")).toBe(true)
  })

  it("已配置 token 而请求未携带签名时拒绝", () => {
    expect(verifySignature(body, "", token)).toBe(false)
    expect(verifySignature(body, "sha1=", token)).toBe(false)
  })

  it("无法取得原始字节时拒绝，而非以重新序列化的结果参与计算", () => {
    // 重新序列化将改变键序与空白，由此计算的摘要几乎必然不同 ——
    // 其得出的"通过"与"失败"均不可信，故只能明确判否
    expect(verifySignature(undefined, sign(body.toString(), token), token)).toBe(false)
  })

  it("长度不等的签名不会使 timingSafeEqual 抛错", () => {
    expect(() => verifySignature(body, "sha1=abc", token)).not.toThrow()
    expect(verifySignature(body, "sha1=abc", token)).toBe(false)
  })
})
