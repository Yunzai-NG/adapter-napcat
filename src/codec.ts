/**
 * 模块职责：消息段在通用模型与 OneBot v11 报文之间的双向翻译
 * 依赖方向：依赖 media / 类型包与内核的 `seg`
 * 生命周期：纯函数
 * 注意事项：**收到的 `message` 可能是数组，也可能是一串 CQ 码**，取决于对端的 `messagePostFormat`，
 *          而适配器约束不了对端的配置。只支持数组的话，配成 string 的使用者会得到「机器人收到消息但
 *          内容全为空」—— 一种从日志里完全看不出原因的症状。故两种格式都解析。
 *
 *          **发送一律用数组格式。** 两种格式对端都收，而数组不必转义，也不会因使用者消息里出现 `[CQ:`
 *          而被误解析。
 *
 *          **合并转发的外显字段不在 node 之内。** `source` / `news` / `summary` / `prompt` 是
 *          `send_*_forward_msg` 报文的**顶层**字段，放进 node 的 data 里不报错、只是静默不生效。
 */
import type {
  FileSegment,
  ForwardNode,
  ForwardSegment,
  ImageSegment,
  MediaRef,
  PokeSegment,
  RecordSegment,
  Segment
} from "@yunzai-ng/types"
import { decodeMedia, encodeMedia } from "./media.js"
import type { MediaEncodeOptions } from "./media.js"
import { num, str } from "./fields.js"

/** OneBot 消息段 */
export interface OneBotSegment {
  /** 段类型名 */
  type: string
  /** 段数据 */
  data?: Record<string, unknown>
}

/** 平台标识，写入 raw 段以便原样透传 */
export const PLATFORM = "onebot11"

/* ────────────────────────────── 通用模型 → OneBot ────────────────────────────── */

/**
 * 编码一个媒体段
 * @param type OneBot 段类型名
 * @param file 媒体引用
 * @param extra 额外字段
 * @param opts 媒体编码参数
 * @returns OneBot 段
 */
async function mediaSegment(
  type: string,
  file: MediaRef,
  extra: Record<string, unknown>,
  opts: MediaEncodeOptions
): Promise<OneBotSegment> {
  const data: Record<string, unknown> = { file: await encodeMedia(file, opts) }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) data[key] = value
  }
  return { type, data }
}

/**
 * 编码单个消息段
 *
 * 返回 undefined 表示"该段在 OneBot 上不存在对应表达"，调用方直接丢弃。
 * 丢弃而非抛错为刻意设计：一条消息中含有一个键盘段不应导致整条消息无法发出。
 * @param segment 通用消息段
 * @param opts 媒体编码参数
 * @returns OneBot 段；无法表达时 undefined
 */
async function encodeSegment(segment: Segment, opts: MediaEncodeOptions): Promise<OneBotSegment | undefined> {
  switch (segment.type) {
    case "text":
      return { type: "text", data: { text: segment.text } }

    case "at":
      return { type: "at", data: segment.name === undefined ? { qq: segment.uid } : { qq: segment.uid, name: segment.name } }

    case "atAll":
      return { type: "at", data: { qq: "all" } }

    case "face":
      return { type: "face", data: { id: String(segment.id) } }

    case "reply":
      return { type: "reply", data: { id: segment.messageId } }

    case "image":
      return mediaSegment("image", segment.file, { summary: segment.summary, sub_type: segment.subType }, opts)

    case "record":
      return mediaSegment("record", segment.file, {}, opts)

    case "video":
      return mediaSegment(
        "video",
        segment.file,
        segment.thumb === undefined ? {} : { thumb: await encodeMedia(segment.thumb, opts) },
        opts
      )

    case "file":
      return mediaSegment("file", segment.file, { name: segment.name }, opts)

    case "json":
      return { type: "json", data: { data: segment.data } }

    case "xml":
      return { type: "xml", data: { data: segment.data } }

    case "dice":
      return { type: "dice", data: {} }

    case "rps":
      return { type: "rps", data: {} }

    case "poke":
      // 直发的戳一戳由 bot.ts 截取改走 send_poke；走到这里的只剩合并转发节点里的，
      // 而 NapCat 收到 poke 段一律转成空，编码出去也发不出
      return undefined

    case "contact":
      return { type: "contact", data: { type: segment.scene === "user" ? "qq" : "group", id: segment.id } }

    case "location":
      return {
        type: "location",
        data: { lat: String(segment.lat), lon: String(segment.lon), title: segment.title, content: segment.content }
      }

    case "share":
      return {
        type: "share",
        data: { url: segment.url, title: segment.title, content: segment.content, image: segment.image }
      }

    case "music":
      // 自定义卡片的音频直链字段名为 `audio` 而非 `url`（`url` 为点击后跳转的页面）。
      // 两者填写颠倒的表现为"卡片可正常显示但点击无声"
      return segment.platform === "custom"
        ? {
            type: "music",
            data: {
              type: "custom",
              url: segment.url,
              audio: segment.audio,
              title: segment.title,
              image: segment.image,
              singer: segment.singer
            }
          }
        : { type: "music", data: { type: segment.platform, id: segment.id } }

    case "markdown":
      return { type: "markdown", data: { content: segment.content } }

    case "forward":
      // 仅"引用一份已存在的转发"可作为段发出；携带 nodes 的转发须采用
      // send_*_forward_msg，由 bot.ts 在发送前截取
      return segment.id === undefined ? undefined : { type: "forward", data: { id: segment.id } }

    case "keyboard":
      // OneBot v11 不含按钮键盘。丢弃并使上层可见 —— 静默丢弃将使其误认为已发出
      return undefined

    case "raw":
      // 逃生舱：仅透传回同一平台，否则会将其他平台的私有结构发送至 NapCat
      return segment.platform === PLATFORM
        ? { type: segment.platformType, data: (segment.data ?? {}) as Record<string, unknown> }
        : undefined
  }
}

/** 编码结果 */
export interface EncodeResult {
  /** 可发送的 OneBot 段 */
  message: OneBotSegment[]
  /** 被丢弃的段类型，调用方应记录一条警告 */
  dropped: string[]
}

/**
 * 编码一串消息段
 * @param segments 通用消息段
 * @param opts 媒体编码参数
 * @returns 编码结果
 * @throws Error 媒体无法编码（文件无法读取、体积超限）时
 */
export async function encodeSegments(segments: readonly Segment[], opts: MediaEncodeOptions): Promise<EncodeResult> {
  const message: OneBotSegment[] = []
  const dropped: string[] = []
  for (const segment of segments) {
    const encoded = await encodeSegment(segment, opts)
    if (encoded === undefined) dropped.push(segment.type)
    else message.push(encoded)
  }
  return { message, dropped }
}

/**
 * 编码合并转发的节点
 *
 * 两种节点：引用已存在的消息（仅给出 `id`），或构造一条（`user_id` + `nickname` +
 * `content`）。两者混于同一数组之中是允许的。
 * @param nodes 转发节点
 * @param opts 媒体编码参数
 * @returns OneBot node 段数组
 */
export async function encodeNodes(nodes: readonly ForwardNode[], opts: MediaEncodeOptions): Promise<OneBotSegment[]> {
  const out: OneBotSegment[] = []
  for (const node of nodes) {
    if (node.messageId !== undefined) {
      out.push({ type: "node", data: { id: node.messageId } })
      continue
    }
    const { message } = await encodeSegments(node.message ?? [], opts)
    const data: Record<string, unknown> = {
      // 构造的节点必须含有发送者，否则 NapCat 侧将因缺少字段导致整条转发失败。
      // 给出一个占位 QQ 号优于使其报错：使用者所见为"名称不正确"而非"无法发出"
      user_id: node.uid ?? "10000",
      nickname: node.name ?? "匿名",
      content: message
    }
    if (node.time !== undefined) data["time"] = node.time
    out.push({ type: "node", data })
  }
  return out
}

/* ────────────────────────────── OneBot → 通用模型 ────────────────────────────── */

/**
 * 解码单个 OneBot 段
 * @param raw OneBot 段
 * @returns 通用消息段
 */
function decodeSegment(raw: OneBotSegment): Segment {
  const data = raw.data
  switch (raw.type) {
    case "text":
      return { type: "text", text: str(data, "text") ?? "" }

    case "at": {
      const qq = str(data, "qq") ?? ""
      if (qq === "all" || qq === "0") return { type: "atAll" }
      const name = str(data, "name")
      return name === undefined ? { type: "at", uid: qq } : { type: "at", uid: qq, name }
    }

    case "face":
      return { type: "face", id: num(data, "id") ?? 0 }

    case "reply":
      return { type: "reply", messageId: str(data, "id") ?? "" }

    case "image":
    case "mface": {
      // NapCat 在接收侧会将商城表情（mface）转换为 image，但旧版本仍可能直接给出 mface
      const out: ImageSegment = { type: "image", file: decodeMedia(data ?? {}) }
      const summary = str(data, "summary")
      if (summary !== undefined) out.summary = summary
      const subType = num(data, "sub_type")
      if (subType !== undefined) out.subType = subType
      return out
    }

    case "record": {
      const out: RecordSegment = { type: "record", file: decodeMedia(data ?? {}) }
      const duration = num(data, "duration")
      if (duration !== undefined) out.duration = duration
      return out
    }

    case "video":
      return { type: "video", file: decodeMedia(data ?? {}) }

    case "file": {
      const out: FileSegment = { type: "file", file: decodeMedia(data ?? {}) }
      const name = str(data, "file") ?? str(data, "name")
      if (name !== undefined) out.name = name
      const size = num(data, "file_size")
      if (size !== undefined) out.size = size
      return out
    }

    case "json":
      return { type: "json", data: str(data, "data") ?? "" }

    case "xml":
      return { type: "xml", data: str(data, "data") ?? "" }

    case "dice": {
      const result = num(data, "result")
      return result === undefined ? { type: "dice" } : { type: "dice", result }
    }

    case "rps": {
      const result = num(data, "result")
      return result === undefined ? { type: "rps" } : { type: "rps", result }
    }

    case "poke": {
      const out: PokeSegment = { type: "poke" }
      const uid = str(data, "id") ?? str(data, "qq")
      if (uid !== undefined) out.uid = uid
      const pokeType = num(data, "type")
      if (pokeType !== undefined) out.pokeType = pokeType
      return out
    }

    case "contact":
      return { type: "contact", scene: str(data, "type") === "group" ? "group" : "user", id: str(data, "id") ?? "" }

    case "location":
      return {
        type: "location",
        lat: num(data, "lat") ?? 0,
        lon: num(data, "lon") ?? 0,
        title: str(data, "title"),
        content: str(data, "content")
      }

    case "share":
      return {
        type: "share",
        url: str(data, "url") ?? "",
        title: str(data, "title") ?? "",
        content: str(data, "content"),
        image: str(data, "image")
      }

    case "forward": {
      const out: ForwardSegment = { type: "forward" }
      const id = str(data, "id")
      if (id !== undefined) out.id = id
      // `content` 为 NapCat 在启用 parseMultMsg 时附带的已展开内容。存在该字段时
      // 即无需再调用一次 get_forward_msg —— 那将是一次纯多余的往返
      const content = data?.["content"]
      if (Array.isArray(content)) out.nodes = decodeNodes(content)
      return out
    }

    case "markdown":
      return { type: "markdown", content: str(data, "content") ?? "" }

    default:
      // 通用模型未覆盖的类型原样保留，插件可按 platformType 自行处理
      return { type: "raw", platform: PLATFORM, platformType: raw.type, data: data ?? {} }
  }
}

/**
 * 判定一个值是否为 OneBot 段
 * @param value 待判定值
 * @returns 是否为段
 */
function isSegmentLike(value: unknown): value is OneBotSegment {
  return typeof value === "object" && value !== null && typeof (value as OneBotSegment).type === "string"
}

/**
 * 解码消息段数组
 * @param raw OneBot 段数组
 * @returns 通用消息段数组
 */
export function decodeSegments(raw: readonly unknown[]): Segment[] {
  return raw.filter(isSegmentLike).map(decodeSegment)
}

/**
 * 解码合并转发的节点数组
 * @param raw OneBot node 段数组
 * @returns 转发节点数组
 */
export function decodeNodes(raw: readonly unknown[]): ForwardNode[] {
  const out: ForwardNode[] = []
  for (const item of raw) {
    if (!isSegmentLike(item)) continue
    const data = item.data
    const node: ForwardNode = {}
    // NapCat 源码中 `uin`/`name` 为 `user_id`/`nickname` 的别名，两套字段名均须识别
    const uid = str(data, "user_id") ?? str(data, "uin")
    if (uid !== undefined) node.uid = uid
    const name = str(data, "nickname") ?? str(data, "name")
    if (name !== undefined) node.name = name
    const time = num(data, "time")
    if (time !== undefined) node.time = time
    const id = str(data, "id")
    if (id !== undefined) node.messageId = id
    const content = data?.["content"]
    if (Array.isArray(content)) node.message = decodeSegments(content)
    else if (typeof content === "string") node.message = decodeCq(content)
    out.push(node)
  }
  return out
}

/* ────────────────────────────── CQ 码 ────────────────────────────── */

/** CQ 码的实体转义表（解码方向） */
const CQ_UNESCAPE: readonly (readonly [RegExp, string])[] = [
  [/&#44;/g, ","],
  [/&#91;/g, "["],
  [/&#93;/g, "]"],
  // `&amp;` 必须最后还原，否则 `&amp;#91;` 这类"转义后的转义"将被多解析一层，
  // 使字面量 `&#91;` 变为 `[`
  [/&amp;/g, "&"]
]

/**
 * 还原 CQ 码中的转义
 * @param input 原文
 * @returns 还原后的文本
 */
function unescapeCq(input: string): string {
  let out = input
  for (const [pattern, replacement] of CQ_UNESCAPE) out = out.replace(pattern, replacement)
  return out
}

/** 匹配一个 CQ 码 */
const CQ_RE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^,\]]*)*)\]/g

/**
 * 解析 CQ 码字符串
 *
 * NapCat 的 `messagePostFormat: "string"` 将消息以该形式上报。其相较数组格式有损
 * （`text` 中的逗号、方括号依靠实体转义还原），但收到何种格式即须解析何种格式。
 * @param input CQ 码字符串
 * @returns 通用消息段数组
 */
export function decodeCq(input: string): Segment[] {
  const out: Segment[] = []
  let cursor = 0

  CQ_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CQ_RE.exec(input)) !== null) {
    if (match.index > cursor) {
      const text = unescapeCq(input.slice(cursor, match.index))
      if (text !== "") out.push({ type: "text", text })
    }
    cursor = match.index + match[0].length

    const data: Record<string, unknown> = {}
    for (const pair of (match[2] ?? "").split(",")) {
      if (pair === "") continue
      const at = pair.indexOf("=")
      if (at <= 0) continue
      data[pair.slice(0, at)] = unescapeCq(pair.slice(at + 1))
    }
    out.push(decodeSegment({ type: match[1] ?? "text", data }))
  }

  if (cursor < input.length) {
    const text = unescapeCq(input.slice(cursor))
    if (text !== "") out.push({ type: "text", text })
  }
  return out
}

/**
 * 解码 NapCat 送来的 `message` 字段
 *
 * 数组与 CQ 码字符串两种格式均予识别 —— 取决于对端的 `messagePostFormat`，而适配器
 * 无法约束对端的配置。参见文件头第 1 条。
 * @param message `message` 字段的原始值
 * @returns 通用消息段数组
 */
export function decodeMessage(message: unknown): Segment[] {
  if (Array.isArray(message)) return decodeSegments(message)
  if (typeof message === "string") return decodeCq(message)
  return []
}

/**
 * 把只给了 file_id 的媒体段归一成 `path` / `url`
 *
 * 有些平台在文件（乃至图片、语音、视频）里只给一个 `file_id`（解码后即 `kind: "id"` 的
 * `MediaRef`），插件要用内容还得自己去换地址、还得先判平台。这里用注入的 `resolve`
 * （适配器用 `get_file` 实现）把这类段就地换成 `path` / `url`，插件侧便无需再判平台。
 *
 * 几条分寸：
 * - **只动 `kind: "id"` 且 id 非空的媒体段**：已经是 url/path 的不重复解析,空 id 无从解析。
 * - **`resolve` 返回 undefined 时原样保留那一段**：一个文件换不到地址,不该毁掉整条消息里的
 *   其余内容 —— 与 `decodeMedia` 拿不到来源时返回空 id 而非抛错同一个取舍。`resolve` 抛错则
 *   如实冒泡（吞错是调用方的事,见 bot.ts 的 probeFile）。
 * - **纯函数,resolve 由调用方给**：解码层不认识 transport,归一化才能单测(注入一个假 resolve)。
 * @param segments 已解码的消息段
 * @param resolve 把 file_id 换成媒体引用；换不到时返回 undefined
 * @returns 归一化后的消息段（新数组）
 */
export async function normalizeFileSegments(
  segments: readonly Segment[],
  resolve: (fileId: string) => Promise<MediaRef | undefined>
): Promise<Segment[]> {
  const out: Segment[] = []
  for (const segment of segments) {
    // 类型联合先收窄到带 `file` 的四种段，`kind === "id"` 再把 `file` 收窄到 id 变体
    if (
      (segment.type === "image" ||
        segment.type === "record" ||
        segment.type === "video" ||
        segment.type === "file") &&
      segment.file.kind === "id" &&
      segment.file.id !== ""
    ) {
      const ref = await resolve(segment.file.id)
      out.push(ref === undefined ? segment : { ...segment, file: ref })
    } else {
      out.push(segment)
    }
  }
  return out
}
