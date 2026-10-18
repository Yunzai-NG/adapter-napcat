/**
 * 模块职责：账号配置的 schema、类型与跨字段校验
 * 依赖方向：仅依赖内核的 schema 工具与类型包
 * 生命周期：模块加载期构造一次 schema，之后只读
 * 注意事项：**该 schema 即为面板中的"添加账号"表单。** 不存在任何为 NapCat 单独
 *          编写的前端代码：字段标签、下拉项说明、条件显隐、密码脱敏均自此处推导，
 *          因此 `title` / `desc` 为最终用户所见文案，表述含糊等同于缺少文档。
 *
 *          四种模式的字段依赖关系以 `showWhen` 表达，而非"全部显示、填写错误后再报错"：
 *          反向 WS 模式下"NapCat 地址"一项不具备任何含义，将其显示只会导致使用者
 *          填入一个被忽略的值，进而无从判断连接失败的原因。
 */
import { s, SchemaError } from "@yunzai-ng/core"
import type { Infer, SchemaIssue } from "@yunzai-ng/core"

/**
 * 网络模式
 *
 * 与 NapCat 配置界面中的四种网络配置一一对应，命名沿用 OneBot 的既有表述，
 * 以使两侧界面中出现的为同一术语。
 */
export type NapcatMode = "ws" | "ws-reverse" | "http" | "http-post"

/** 由框架主动建立连接的模式（须填写 NapCat 地址） */
const OUTBOUND_MODES: readonly NapcatMode[] = ["ws", "http", "http-post"]

/** 由对端主动连入的模式（须占用本机一条路径） */
const INBOUND_MODES: readonly NapcatMode[] = ["ws-reverse", "http-post"]

/** 账号配置 schema */
export const ACCOUNT_SCHEMA = s.object({
  mode: s
    .select([
      {
        value: "ws",
        label: "正向 WebSocket",
        description: "框架主动连接 NapCat。配置最为简便，NapCat 与框架部署于同一台机器时为首选"
      },
      {
        value: "ws-reverse",
        label: "反向 WebSocket",
        description: "NapCat 主动连接框架。适用于 NapCat 位于容器或其他机器、框架无法连入的情形"
      },
      {
        value: "http",
        label: "HTTP（仅可发送，无法接收）",
        description: "仅调用 NapCat 的 HTTP 接口。无法接收任何消息与事件，仅适用于单向推送"
      },
      {
        value: "http-post",
        label: "HTTP + 事件上报",
        description: "NapCat 将事件 POST 至框架，框架经 HTTP 调用接口。等价于两条单向通道"
      }
    ])
    .default("ws")
    .title("连接方式")
    .desc("须与 NapCat「网络配置」中新建的对应项保持一致")
    .order(1),

  url: s
    .string()
    .default("ws://127.0.0.1:3001")
    .title("NapCat 地址")
    .desc("正向 WS 填写 NapCat 的 WebSocket 服务器地址；两种 HTTP 模式填写其 HTTP 服务器地址")
    .placeholder("ws://127.0.0.1:3001")
    .showWhen({ mode: OUTBOUND_MODES })
    .order(2),

  listenPath: s
    .string()
    .default("/napcat")
    .title("本机监听路径")
    .desc("NapCat 连入或上报的目标路径。完整地址将在账号连接成功后输出至日志")
    .placeholder("/napcat")
    .showWhen({ mode: INBOUND_MODES })
    .order(3),

  token: s
    .password()
    .default("")
    .title("Access Token")
    .desc(
      "须与 NapCat 对应网络配置中的 token 一致。留空表示不进行鉴权（仅限本机回环）。" +
        "「HTTP + 事件上报」模式下 NapCat 须建立两条配置（HTTP 服务器与 HTTP 客户端），" +
        "两侧 token 必须相同 —— 上报签名即以其计算"
    )
    .order(4),

  ignoreSelf: s
    .boolean()
    .default(true)
    .title("忽略自身消息")
    .desc(
      "开启后本账号自己发出的消息与自己戳出去的戳一戳不投进内核。关闭前先确认插件能自行判断发送者，" +
        "否则「复读」一类的命令会回复自己的回复，一条指令派生出无限条"
    )
    .order(5),

  localFileAccess: s
    .boolean()
    .default(true)
    .title("NapCat 可读取本机文件")
    .desc(
      "同机部署时保持开启：图片与语音以文件路径直接交由 NapCat，可省去 base64 编解码与一次全量传输。" +
        "NapCat 位于容器或其他机器时必须关闭，否则其将报告文件不存在"
    )
    .group("传输")
    .order(10),

  timeout: s
    .duration()
    .default("15s")
    .title("接口调用超时")
    .desc("单次 API 调用等待多久判定为失败")
    .group("传输")
    .order(11),

  idleTimeout: s
    .duration()
    .default("90s")
    .title("静默超时")
    .desc(
      "在该时长内未收到任何报文（含心跳）即判定连接已死并重连。填 0 表示关闭。" +
        "NapCat 默认每 30 秒发送一次心跳，取值小于该间隔将导致反复重连"
    )
    .showWhen({ mode: ["ws", "ws-reverse"] })
    .group("传输")
    .order(12),

  memberCacheMax: s
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(2000)
    .title("群成员缓存条数")
    .desc("按 LRU 淘汰。权限判定是最高频的查询，值得缓存；但千人群全量常驻会占数百 MB，故设上限")
    .group("缓存")
    .order(20),

  memberCacheTtl: s
    .duration()
    .default("10m")
    .title("群成员缓存有效期")
    .desc("超过该时长的条目将重新拉取，否则群名片变更、管理员变动须等到重启后方能生效")
    .group("缓存")
    .order(21)
})

/**
 * 账号配置
 *
 * 由 schema 推导而来，不另行手写第二份 —— 手写的定义必然与表单脱节。
 */
export type NapcatAccount = Infer<typeof ACCOUNT_SCHEMA>

/**
 * 该模式是否须由框架主动建立连接
 * @param mode 网络模式
 * @returns 是否须填写 `url`
 */
export function isOutbound(mode: NapcatMode): boolean {
  return OUTBOUND_MODES.includes(mode)
}

/**
 * 该模式是否须占用本机一条路径
 * @param mode 网络模式
 * @returns 是否须填写 `listenPath`
 */
export function isInbound(mode: NapcatMode): boolean {
  return INBOUND_MODES.includes(mode)
}

/**
 * 校验 `url` 的协议是否与模式匹配
 *
 * 协议填写错误（正向 WS 填入 `http://`）为最常见的配置错误，其表现为"连接持续失败"，
 * 无法自日志中判定根因，故此处直接指明具体字段与期望协议。
 * @param mode 网络模式
 * @param url 使用者填写的地址
 * @returns 问题描述；无问题时 undefined
 */
function checkUrl(mode: NapcatMode, url: string): string | undefined {
  if (url.trim() === "") return "不能为空：此处为 NapCat 侧监听的地址"

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `${url} 不是合法地址，应形如 ws://127.0.0.1:3001`
  }

  const wanted = mode === "ws" ? ["ws:", "wss:"] : ["http:", "https:"]
  if (!wanted.includes(parsed.protocol)) {
    return `${mode === "ws" ? "正向 WS" : "HTTP"} 模式的地址应以 ${wanted.map(p => `${p}//`).join(" 或 ")} 开头，当前为 ${parsed.protocol}//`
  }
  return undefined
}

/**
 * 校验并规范化账号配置
 *
 * 先执行 schema 校验（类型、范围、必填），再执行 schema 无法表达的跨字段检查 ——
 * 单个字段的 `check()` 无法读取同级字段的值，而"是否须填写 url"恰取决于 mode。
 * @param input 面板提交的原始对象
 * @returns 规范化后的配置
 * @throws SchemaError 校验不通过；`issues[].path` 与表单字段名对应，面板据此标记对应输入框
 */
export function validateAccount(input: unknown): NapcatAccount {
  const account = ACCOUNT_SCHEMA.parse(input)
  const mode = account.mode
  const issues: SchemaIssue[] = []

  if (isOutbound(mode)) {
    const problem = checkUrl(mode, account.url)
    if (problem !== undefined) issues.push({ path: "url", message: problem, severity: "error" })
  }

  if (isInbound(mode)) {
    const path = account.listenPath.trim()
    if (path === "") {
      issues.push({ path: "listenPath", message: "不能为空：NapCat 需要一条可连入的路径", severity: "error" })
    } else if (!path.startsWith("/")) {
      issues.push({ path: "listenPath", message: `应以 / 开头，如 /napcat（当前为 ${path}）`, severity: "error" })
    }
  }

  if (issues.length > 0) throw new SchemaError(issues)

  return { ...account, url: account.url.trim(), listenPath: account.listenPath.trim() }
}
