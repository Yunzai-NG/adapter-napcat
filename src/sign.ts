/**
 * 模块职责：校验 NapCat 上报请求的 HMAC-SHA1 签名
 * 依赖方向：仅依赖 node:crypto
 * 生命周期：纯函数
 * 注意事项：**密钥即 Access Token。** NapCat 的 `httpClients` 配置中不含独立的
 *          secret 字段（OneBot v11 标准中存在该字段），已配置 token 时即以其
 *          执行 HMAC-SHA1，结果置于 `x-signature: sha1=<hex>`。
 *
 *          单独成文件的目的在于可直接针对"字节 + 请求头 + 密钥"编写单元测试 ——
 *          若置于 transport 之中，则须先构造一个 RouteRequest 方能测试一行 HMAC。
 */
import { createHmac, timingSafeEqual } from "node:crypto"

/** 签名头的前缀 */
const PREFIX = "sha1="

/**
 * 校验上报签名
 *
 * 比较采用 `timingSafeEqual` 而非 `===`：上报端点可能对公网开放，逐字节短路比较
 * 会将"正确前缀的长度"泄漏为耗时差异。长度不等时直接判否 —— `timingSafeEqual`
 * 对长度不等的入参会抛错，该情形须由调用方自行拦截。
 * @param body 原始请求体字节；缺失时一律判否
 * @param header `x-signature` 头的值
 * @param token Access Token；空串表示不予校验，恒返回 true
 * @returns 是否通过
 */
export function verifySignature(body: Uint8Array | undefined, header: string, token: string): boolean {
  if (token === "") return true

  const given = (header.startsWith(PREFIX) ? header.slice(PREFIX.length) : header).trim().toLowerCase()
  if (given === "") return false

  // 无法取得原始字节即无法验签：将已解析的 body 重新序列化后计算的摘要几乎必然不同
  // （键序与空白均会变化），由此得到的"验签失败"并非真实结果，将导致正常上报被全部拒绝
  if (body === undefined) return false

  const expected = Buffer.from(createHmac("sha1", token).update(body).digest("hex"), "utf8")
  const actual = Buffer.from(given, "utf8")
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}
