/**
 * 模块职责：媒体引用与 OneBot `file` 字段之间的互转
 * 依赖方向：依赖 node:fs 与类型包；不依赖内核
 * 生命周期：纯函数
 * 注意事项：**这里是「消除全链路 base64」的落点。** `file` 字段有三条通道，按代价自低至高：
 *          **裸本地绝对路径**（同机零拷贝）、**http(s) URL**（对端自行下载）、**`base64://`**
 *          （仅在前两项都不成立时 —— 一张 2MB 的图要读进内存、编码膨胀 1.34 倍、对端再解码）。
 *
 *          **NapCat 的 `file://` 不是文件路径**，而是它内部的文件哈希 id。给本地图片加该前缀
 *          会让它去查一个不存在的哈希并报「文件不存在」—— 本地路径必须裸传。
 */
import { readFile } from "node:fs/promises"
import type { MediaRef } from "@yunzai-ng/types"

/** base64 通道的前缀 */
const BASE64_PREFIX = "base64://"

/** 媒体编码的环境参数 */
export interface MediaEncodeOptions {
  /**
   * NapCat 是否可读取本机文件
   *
   * 同机部署时为真（默认）。为假时本地路径必须被读取并编码为 base64 —— 否则 NapCat
   * 将以一个在其文件系统中不存在的路径执行 open，并报告"文件不存在"。
   */
  localFileAccess: boolean
  /**
   * 允许直传的最大字节数
   *
   * 超过上限即拒绝，而非强制编码为 base64：一张 50MB 的图片经 base64 编码后为
   * 67MB 的 JSON 字符串，置于单帧 WebSocket 中通常直接导致连接中断，而"连接无故
   * 断开"的排查难度远高于"该图片过大"。
   */
  maxInlineBytes: number
}

/**
 * 将字节编码为 `base64://` 形式
 * @param data 字节
 * @returns file 字段值
 */
function inlineBase64(data: Uint8Array): string {
  return BASE64_PREFIX + Buffer.from(data).toString("base64")
}

/**
 * 将媒体引用转换为 NapCat 的 `file` 字段值
 * @param ref 媒体引用
 * @param opts 环境参数
 * @returns file 字段值
 * @throws Error 须读盘而无法读取，或体积超过上限时
 */
export async function encodeMedia(ref: MediaRef, opts: MediaEncodeOptions): Promise<string> {
  switch (ref.kind) {
    case "url":
      // 携带鉴权头的图床（米游社防盗链）NapCat 无法下载，而此处亦无法代其添加请求头 ——
      // 确有需要时由上层先下载为 buffer 再行传入
      return ref.url

    case "path": {
      if (opts.localFileAccess) return ref.path
      let data: Buffer
      try {
        data = await readFile(ref.path)
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        throw new Error(
          `读取 ${ref.path} 失败：${text}。` +
            `当前账号配置中「NapCat 可读取本机文件」处于关闭状态，故须由框架自行读取文件并编码为 base64`
        )
      }
      if (data.byteLength > opts.maxInlineBytes) {
        throw new Error(
          `${ref.path} 大小为 ${Math.round(data.byteLength / 1024)} KB，超过 base64 直传上限 ` +
            `${Math.round(opts.maxInlineBytes / 1024)} KB。若 NapCat 与框架部署于同一台机器，` +
            `请开启账号配置中的「NapCat 可读取本机文件」，即无需编码为 base64`
        )
      }
      return inlineBase64(data)
    }

    case "buffer":
      if (ref.data.byteLength > opts.maxInlineBytes) {
        throw new Error(
          `该内存数据大小为 ${Math.round(ref.data.byteLength / 1024)} KB，超过直传上限 ` +
            `${Math.round(opts.maxInlineBytes / 1024)} KB。请先写入磁盘，再以路径形式发送`
        )
      }
      return inlineBase64(ref.data)

    case "base64":
      // 已为 base64，仅补充前缀。以 `data:` 开头的整串 NapCat 同样接受，无需拆分
      return ref.base64.startsWith(BASE64_PREFIX) || ref.base64.startsWith("data:")
        ? ref.base64
        : BASE64_PREFIX + ref.base64

    case "id":
      // 平台侧资源 id 原样回传，不产生传输。NapCat 将按其自身规则解析
      return ref.id
  }
}

/** OneBot 侧媒体字段的宽松形状 */
export interface OneBotFileFields {
  /** 发送时的来源、接收时的文件名或哈希 id */
  file?: unknown
  /** 可下载直链（接收时通常存在） */
  url?: unknown
  /** NapCat 侧的绝对路径（同机时可直接读取） */
  path?: unknown
  /** 平台文件 id */
  file_id?: unknown
  /** 字节数 */
  file_size?: unknown
}

/**
 * 取一个字段的非空字符串形式
 * @param value 原始值
 * @returns 字符串；无法取得非空字符串时 undefined
 */
function str(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value
  if (typeof value === "number") return String(value)
  return undefined
}

/**
 * 将收到的媒体字段转换为媒体引用
 *
 * 优先级 `url` > `path` > `file_id` > `file`：
 * - `url` 位列第一，因其对下游最为有用 —— 插件执行识图须先取回图片，而 url
 *   在任意机器上均可下载。
 * - `path` 为 NapCat 侧的绝对路径，仅在同机时可读，故位列第二。
 * - `file` 位列最后：其内容在不同版本中可能为文件名、哈希 id 或路径，不具备可靠性。
 * @param data 消息段的 data 对象
 * @returns 媒体引用
 */
export function decodeMedia(data: OneBotFileFields): MediaRef {
  const url = str(data.url)
  if (url !== undefined && /^https?:\/\//i.test(url)) return { kind: "url", url }

  const path = str(data.path)
  if (path !== undefined) return { kind: "path", path }

  const fileId = str(data.file_id)
  if (fileId !== undefined) return { kind: "id", id: fileId }

  const file = str(data.file)
  if (file !== undefined) {
    if (/^https?:\/\//i.test(file)) return { kind: "url", url: file }
    return { kind: "id", id: file }
  }

  // 该媒体段不含任何来源。返回空 id 而非抛错：该消息的其余部分仍然可用，
  // 插件实际使用该图片时方会失败，且此时的报错更贴近现场
  return { kind: "id", id: "" }
}
