/**
 * 模块职责：认出对端是哪一家 OneBot v11 实现（NapCat / LLOneBot / SnowLuma）
 * 依赖方向：仅依赖 fields
 * 生命周期：每次连接建立后探一次
 * 注意事项：**三家扩展出来的接口几乎是同一套**：`send_poke`、`set_msg_emoji_like`、
 *          `send_*_forward_msg`、`get_file`、`upload_group_file` 都同名、参数也对得上，故驱动里
 *          不按实现分岔 —— 仅有的几处出入在别处就地抹平：
 *          - `get_file`：LLOneBot 只认 `file`，NapCat 与 SnowLuma 两个都认，故两个一起送（见 bot.ts）；
 *          - 私聊戳一戳：LLOneBot 不给 `sender_id`，机器人戳好友时报成「好友戳好友」（见 events.ts 的 `pokeParties`）；
 *          - HTTP 下不认识的 action：LLOneBot 回真的 404 与一份 OneBot 报文（见 transport-http.ts）；
 *          - 鉴权：SnowLuma 给每条网络配置自动生成 token，这边留空必被拒（见 transport-ws.ts）。
 *
 *          认出来之后只用于日志与报错，好让人知道连上的是谁。认不出、或对端不回 `get_version_info`
 *          都不算连接失败 —— 那只是一个不认识的 OneBot v11 实现，标准部分照常可用。
 */
import { str } from "./fields.js"
import type { Fields } from "./fields.js"

/** 认得的实现；`other` 是回了版本信息、但不是这三家的 */
export type OneBotImpl = "napcat" | "llonebot" | "snowluma" | "other"

/** 一次探测的结果 */
export interface ImplInfo {
  /** 哪一家 */
  impl: OneBotImpl
  /** 对端自报的应用名；没回时 undefined */
  appName?: string
  /** 对端自报的版本；没回时 undefined */
  version?: string
}

/** 文案里提到对端时的称呼：认不出是谁的时候一律这么说 */
export const PEER = "NapCat / LLOneBot / SnowLuma"

/** 各家的显示名 */
const LABEL: Readonly<Record<OneBotImpl, string>> = {
  napcat: "NapCat",
  llonebot: "LLOneBot",
  snowluma: "SnowLuma",
  other: "OneBot v11 端"
}

/** 探测的等待上限：对端不回这个接口时，不该让连接干等一整个调用超时 */
const DETECT_TIMEOUT_MS = 3000

/**
 * 按 `get_version_info` 的 `app_name` 认实现
 *
 * NapCat 报 `NapCat.Onebot`，LLOneBot（现名 LuckyLilliaBot）报 `LLOneBot`，SnowLuma 报 `SnowLuma`；
 * 不区分大小写、只看前缀，免得哪天它们在后面加个后缀就认不出来。
 * @param appName 应用名
 * @returns 实现
 */
export function implOf(appName: string | undefined): OneBotImpl {
  const name = (appName ?? "").toLowerCase()
  if (name.startsWith("napcat")) return "napcat"
  if (name.startsWith("llonebot") || name.startsWith("luckylillia")) return "llonebot"
  if (name.startsWith("snowluma")) return "snowluma"
  return "other"
}

/**
 * 一家实现的显示名，带上它自报的版本
 * @param info 探测结果
 * @returns 形如 `LLOneBot 7.4.2`；认不出时带上它自报的应用名
 */
export function implLabel(info: ImplInfo): string {
  const name = info.impl === "other" && info.appName !== undefined ? info.appName : LABEL[info.impl]
  return info.version === undefined ? name : `${name} ${info.version}`
}

/**
 * 连上之后探一次对端是谁
 *
 * 失败与超时都退回 `other` 而不抛错，见文件头。
 * @param call 调一次 API
 * @param timeout 等待上限毫秒
 * @returns 探测结果
 */
export async function detectImpl(
  call: (action: string) => Promise<unknown>,
  timeout = DETECT_TIMEOUT_MS
): Promise<ImplInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = await Promise.race([
      call("get_version_info"),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), timeout)
      })
    ])
    if (typeof raw !== "object" || raw === null) return { impl: "other" }
    const fields = raw as Fields
    const appName = str(fields, "app_name")
    const version = str(fields, "app_version")
    return {
      impl: implOf(appName),
      ...(appName === undefined ? {} : { appName }),
      ...(version === undefined ? {} : { version })
    }
  } catch {
    return { impl: "other" }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
