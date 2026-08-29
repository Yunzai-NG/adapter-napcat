/**
 * 模块职责：自 `unknown` 报文中安全取值
 * 依赖方向：叶子模块
 * 生命周期：纯函数
 * 注意事项：OneBot 报文中同一字段的类型在不同实现、不同版本之间存在差异 ——
 *          `message_id` 为数字，`user_id` 在 schema 中为字符串但传入数字亦会被接受，
 *          `face.id` 有时为字符串有时为数字。与其在每个调用点重复书写
 *          `typeof x === "string" ? x : String(x)`，不如于此处统一执行宽松取值。
 *
 *          全部函数在无法取值时返回 `undefined` 而非抛错：一条报文缺少某个字段
 *          不应导致整条消息无法继续处理，由调用方各自决定回落取值。
 */

/** 任意键值对象 */
export type Fields = Record<string, unknown>

/**
 * 取字符串
 *
 * 数字将被转换为字符串 —— OneBot 的 id 类字段（`message_id` / `user_id` / `group_id`）
 * 在报文中为数字，而通用模型中一律为字符串。
 * @param data 源对象
 * @param key 字段名
 * @returns 字符串；缺失或空串时 undefined
 */
export function str(data: Fields | undefined, key: string): string | undefined {
  const value = data?.[key]
  if (typeof value === "string") return value === "" ? undefined : value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/**
 * 取数字
 * @param data 源对象
 * @param key 字段名
 * @returns 数字；缺失或不可解析时 undefined
 */
export function num(data: Fields | undefined, key: string): number | undefined {
  const value = data?.[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * 取布尔
 * @param data 源对象
 * @param key 字段名
 * @returns 布尔；缺失时 undefined
 */
export function bool(data: Fields | undefined, key: string): boolean | undefined {
  const value = data?.[key]
  if (typeof value === "boolean") return value
  if (value === 1 || value === "true") return true
  if (value === 0 || value === "false") return false
  return undefined
}

/**
 * 取嵌套对象
 * @param data 源对象
 * @param key 字段名
 * @returns 对象；缺失或非对象时 undefined
 */
export function obj(data: Fields | undefined, key: string): Fields | undefined {
  const value = data?.[key]
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined
}

/**
 * 取数组
 * @param data 源对象
 * @param key 字段名
 * @returns 数组；缺失或非数组时 undefined
 */
export function arr(data: Fields | undefined, key: string): unknown[] | undefined {
  const value = data?.[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * 将秒级时间戳转换为毫秒
 *
 * OneBot 的 `time` 为秒级，通用模型统一采用毫秒。遗漏一次乘以 1000 的后果是全部
 * 事件的时间均显示为 1970 年 —— 而该缺陷在测试中往往不显现，因测试自行构造的
 * 事件通常不携带 time。
 * @param data 源对象
 * @param key 字段名，缺省 `time`
 * @returns 毫秒时间戳；缺失时 undefined
 */
export function timeMs(data: Fields | undefined, key = "time"): number | undefined {
  const seconds = num(data, key)
  return seconds === undefined ? undefined : seconds * 1000
}
