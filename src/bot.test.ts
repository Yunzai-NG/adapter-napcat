/**
 * 模块职责：正向 WS 的端到端测试 —— 报文形态、echo 关联、消息 id 类型与缓存行为
 * 依赖方向：测试文件，依赖 bot.ts / config.ts、内核测试工具与 ws
 * 生命周期：每项用例各自启动一个 WebSocket 服务器与一个驱动，afterEach 中逆序清理
 * 注意事项：本测试不以模拟实现替换 transport。该链路上最易出错之处恰为"报文的具体
 *          形态" —— action 名、参数名、echo 关联、消息 id 的类型。以模拟实现替换
 *          transport 将使上述各项均无法覆盖，而其中任一项出错均表现为线上静默失败。
 */
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import type { WebSocket } from "ws"
import { createCache, seg } from "@yunzai-ng/core"
import { fakeHttp, fakeLogger } from "@yunzai-ng/core/testing"
import type {
  AccountRecord,
  AccountStatus,
  AdapterHost,
  BotDriver,
  IncomingEvent,
  ServerInfo
} from "@yunzai-ng/types"
import { createNapcatBot } from "./bot.js"
import { validateAccount } from "./config.js"

/** 模拟 NapCat 收到的一条请求 */
interface SeenRequest {
  /** API 名 */
  action: string
  /** 参数 */
  params: Record<string, unknown>
  /** 回声标记 */
  echo: string
}

/** 模拟 NapCat 服务器 */
interface FakeNapcat {
  /** 连接地址 */
  url: string
  /** 收到的全部请求 */
  requests: SeenRequest[]
  /** 客户端握手时携带的 Authorization 头 */
  authHeader: string | undefined
  /** 当前连接 */
  socket: WebSocket | undefined
  /** 每个 action 的应答；返回 undefined 表示不予应答（用于验证超时与乱序） */
  reply: (req: SeenRequest) => unknown
  /** 主动推送一条报文（模拟事件上报） */
  push(payload: unknown): void
  /** 关闭服务器 */
  close(): Promise<void>
}

/**
 * 启动一个模拟 NapCat
 * @returns 服务器句柄
 */
async function startFakeNapcat(): Promise<FakeNapcat> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>(resolve => server.once("listening", resolve))

  const fake: FakeNapcat = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: [],
    authHeader: undefined,
    socket: undefined,
    reply: req => (req.action === "get_login_info" ? { user_id: 10000, nickname: "测试机器人" } : {}),
    push: payload => fake.socket?.send(JSON.stringify(payload)),
    close: () =>
      new Promise<void>(resolve => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      })
  }

  server.on("connection", (socket, req) => {
    fake.authHeader = req.headers.authorization
    fake.socket = socket
    socket.on("message", raw => {
      const parsed = JSON.parse(raw.toString()) as SeenRequest
      fake.requests.push(parsed)
      const data = fake.reply(parsed)
      if (data === undefined) return
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: parsed.echo }))
    })
  })

  return fake
}

/** 测试用的宿主 */
interface TestHost extends AdapterHost {
  /** 已投递至内核的事件 */
  submitted: IncomingEvent[]
  /** 已上报的状态变化 */
  statuses: { status: AccountStatus; error?: string }[]
}

/**
 * 构造一个宿主
 * @param server 覆盖服务器信息
 * @returns 宿主
 */
function fakeHost(server?: ServerInfo): TestHost {
  const record: AccountRecord = {
    id: "acc-1",
    adapterId: "napcat",
    enabled: true,
    config: {},
    createdAt: 0,
    updatedAt: 0
  }
  const controller = new AbortController()
  const host: TestHost = {
    submitted: [],
    statuses: [],
    logger: fakeLogger(),
    kv: undefined as unknown as AdapterHost["kv"],
    account: record,
    policy: { masters: [], isMaster: () => false },
    server: server ?? { enabled: true, host: "127.0.0.1", port: 2536, publicUrl: "http://127.0.0.1:2536" },
    signal: controller.signal,
    submit: event => host.submitted.push(event),
    route: () => () => undefined,
    websocket: () => () => undefined,
    createCache: opts => createCache(opts),
    onDispose: () => undefined,
    setStatus: (status, detail) => host.statuses.push({ status, ...(detail?.error === undefined ? {} : { error: detail.error }) })
  }
  return host
}

/**
 * 等待条件成立
 * @param check 条件
 * @param label 超时错误中的说明
 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`等待 ${label} 超过 2 秒仍未发生`)
}

/** 待清理的资源 */
let cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/**
 * 启动服务器并连接一个驱动
 * @param token Access Token
 * @returns 服务器、宿主与驱动
 */
async function connected(token = ""): Promise<{ fake: FakeNapcat; host: TestHost; driver: BotDriver }> {
  const fake = await startFakeNapcat()
  cleanup.push(() => fake.close())

  const host = fakeHost()
  const account = validateAccount({ mode: "ws", url: fake.url, token })
  const driver = createNapcatBot(account, host, { adapterId: "napcat", http: fakeHttp() })
  cleanup.push(() => driver.disconnect())

  await driver.connect()
  return { fake, host, driver }
}

describe("正向 WS 端到端", () => {
  it("连接建立后调用一次 get_login_info，回填账号与昵称", async () => {
    const { driver, fake } = await connected()
    expect(driver.selfId).toBe("10000")
    expect(driver.nickname).toBe("测试机器人")
    expect(driver.online).toBe(true)
    expect(fake.requests.map(r => r.action)).toEqual(["get_login_info"])
  })

  it("配置 token 时以 Bearer 形式置于 Authorization 头", async () => {
    const { fake } = await connected("s3cr3t")
    expect(fake.authHeader).toBe("Bearer s3cr3t")
  })

  it("未配置 token 时不发送 Authorization 头", async () => {
    const { fake } = await connected()
    expect(fake.authHeader).toBeUndefined()
  })

  it("无法连接时报出应修改的配置项，而非仅返回 ECONNREFUSED", async () => {
    const host = fakeHost()
    // 先启动服务器再立即关闭，以取得一个确定无人监听的端口
    const dead = await startFakeNapcat()
    const url = dead.url
    await dead.close()

    const driver = createNapcatBot(validateAccount({ mode: "ws", url }), host, {
      adapterId: "napcat",
      http: fakeHttp()
    })
    await expect(driver.connect()).rejects.toThrow(/未在该端口上监听/)
  })

  it("群消息被转换为内核事件并投递至管线", async () => {
    const { fake, host } = await connected()
    fake.push({
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      time: 1_700_000_000,
      message_id: 1145141919,
      group_id: 700000,
      user_id: 10001,
      message: [{ type: "text", data: { text: "#ping" } }],
      sender: { user_id: 10001, nickname: "小明", role: "member" }
    })

    await until(() => host.submitted.length === 1, "事件投递")
    expect(host.submitted[0]).toMatchObject({
      kind: "message",
      scene: "group",
      messageId: "1145141919",
      sender: { uid: "10001", gid: "700000", role: "member" }
    })
  })

  it("心跳与生命周期事件予以投递，message_sent 不予投递", async () => {
    const { fake, host } = await connected()
    fake.push({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect" })
    await until(() => host.submitted.length === 1, "元事件投递")

    fake.push({ post_type: "message_sent", message_type: "group", message: [], sender: {} })
    fake.push({ post_type: "meta_event", meta_event_type: "heartbeat" })
    await until(() => host.submitted.length === 2, "第二条元事件")
    // 中间的 message_sent 已被丢弃，否则机器人将回复自身发出的消息
    expect(host.submitted.map(e => e.kind)).toEqual(["meta", "meta"])
  })

  it("发送群消息：action 与参数名均须一致", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => (req.action === "get_login_info" ? { user_id: 10000 } : { message_id: 987654 })

    const result = await driver.sendMessage({ scene: "group", gid: "700000" }, "喵")
    expect(result).toMatchObject({ ok: true, messageId: "987654" })

    const sent = fake.requests.find(r => r.action === "send_msg")
    expect(sent?.params).toEqual({
      message_type: "group",
      group_id: "700000",
      message: [{ type: "text", data: { text: "喵" } }]
    })
  })

  it("引用回复被编码为消息序列首位的 reply 段", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => (req.action === "get_login_info" ? { user_id: 10000 } : { message_id: 1 })

    await driver.sendMessage({ scene: "private", uid: "10001" }, "收到", { quote: "555" })
    const sent = fake.requests.find(r => r.action === "send_msg")
    expect(sent?.params["message"]).toEqual([
      { type: "reply", data: { id: "555" } },
      { type: "text", data: { text: "收到" } }
    ])
  })

  it("合并转发经 send_group_forward_msg 发送，外显字段位于顶层", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => (req.action === "get_login_info" ? { user_id: 10000 } : { message_id: 2, res_id: "RES" })

    await driver.sendMessage(
      { scene: "group", gid: "700000" },
      seg.forward([seg.node("第一条", { uid: "10001", name: "小明" })], { source: "群聊记录", summary: "查看 1 条" })
    )

    const sent = fake.requests.find(r => r.action === "send_group_forward_msg")
    expect(sent?.params).toMatchObject({
      group_id: "700000",
      // 外显字段置于 node 中不会报错，仅静默不生效，故须断言其位于顶层
      source: "群聊记录",
      summary: "查看 1 条",
      messages: [
        {
          type: "node",
          data: { user_id: "10001", nickname: "小明", content: [{ type: "text", data: { text: "第一条" } }] }
        }
      ]
    })
  })

  it("撤回时将消息 id 转换回数字", async () => {
    const { fake, driver } = await connected()
    await driver.recallMessage("1145141919")
    const sent = fake.requests.find(r => r.action === "delete_msg")
    // 传入字符串将被 NapCat 的 schema 拒绝，返回一个不显现类型问题的 retcode 1400
    expect(sent?.params["message_id"]).toBe(1145141919)
    expect(typeof sent?.params["message_id"]).toBe("number")
  })

  it("响应乱序返回时仍可各自关联 —— 此即不采用忙等轮询的依据", async () => {
    const { fake, driver } = await connected()
    /** 暂存请求以延后应答 */
    const held: SeenRequest[] = []
    fake.reply = req => {
      held.push(req)
      return undefined
    }

    const first = driver.getGroup("700001")
    const second = driver.getGroup("700002")
    await until(() => held.length === 2, "两条请求均到达")

    // 逆序应答：先应答后发出的那条
    const socket = fake.socket!
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { group_id: 700002 }, echo: held[1]!.echo }))
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { group_id: 700001 }, echo: held[0]!.echo }))

    expect(await first).toMatchObject({ gid: "700001" })
    expect(await second).toMatchObject({ gid: "700002" })
  })

  it("平台返回失败时抛出携带 API 名与原因的异常", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => {
      if (req.action === "get_login_info") return { user_id: 10000 }
      fake.socket?.send(
        JSON.stringify({
          status: "failed",
          retcode: 1404,
          data: null,
          message: "unsupported action",
          wording: "不支持的接口",
          echo: req.echo
        })
      )
      return undefined
    }
    await expect(driver.callApi("某个不存在的接口")).rejects.toThrow(/某个不存在的接口.*不支持的接口/)
  })

  it("群成员按需拉取且具备缓存：查询两次仅产生一次 API 调用", async () => {
    const { fake, driver } = await connected()
    fake.reply = req =>
      req.action === "get_login_info" ? { user_id: 10000 } : { user_id: 10001, group_id: 700000, role: "admin" }

    const first = await driver.getGroupMember("700000", "10001")
    const second = await driver.getGroupMember("700000", "10001")
    expect(first).toMatchObject({ uid: "10001", gid: "700000", role: "admin" })
    expect(second).toEqual(first)
    expect(fake.requests.filter(r => r.action === "get_group_member_info")).toHaveLength(1)
  })

  it("修改名片后立即失效对应的缓存条目", async () => {
    const { fake, driver } = await connected()
    let card = "旧名片"
    fake.reply = req => {
      if (req.action === "get_login_info") return { user_id: 10000 }
      if (req.action === "get_group_member_info") return { user_id: 10001, group_id: 700000, role: "member", card }
      card = "新名片"
      return {}
    }

    expect(await driver.getGroupMember("700000", "10001")).toMatchObject({ card: "旧名片" })
    await driver.setGroupCard?.("700000", "10001", "新名片")
    // 若不失效，后续十分钟内读到的仍为旧名片
    expect(await driver.getGroupMember("700000", "10001")).toMatchObject({ card: "新名片" })
  })

  it("群成员列表不回填单条缓存 —— 一次排行查询不应将热条目全部挤出", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => {
      if (req.action === "get_login_info") return { user_id: 10000 }
      if (req.action === "get_group_member_list") {
        return [
          { user_id: 10001, group_id: 700000, role: "member" },
          { user_id: 10002, group_id: 700000, role: "member" }
        ]
      }
      return { user_id: 10001, group_id: 700000, role: "owner" }
    }

    expect(await driver.getGroupMemberList("700000")).toHaveLength(2)
    // 列表中已含 10001，单条查询仍须发起一次 API 调用（且取得的是权威的 owner）
    expect(await driver.getGroupMember("700000", "10001")).toMatchObject({ role: "owner" })
    expect(fake.requests.filter(r => r.action === "get_group_member_info")).toHaveLength(1)
  })

  it("limit 于本地截断，避免将千人群成员表整份返回给插件", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => {
      if (req.action === "get_login_info") return { user_id: 10000 }
      return Array.from({ length: 50 }, (_, i) => ({ user_id: 20000 + i, group_id: 700000, role: "member" }))
    }
    expect(await driver.getGroupMemberList("700000", { limit: 5 })).toHaveLength(5)
  })

  it("对端断开时上报下线，由内核执行统一的退避重连", async () => {
    const { fake, host, driver } = await connected()
    // 采用 terminate 而非 close：模拟 NapCat 进程被终止这一最常见的断开方式
    fake.socket?.terminate()
    await until(() => host.statuses.some(s => s.status === "offline"), "下线上报")
    expect(driver.online).toBe(false)
  })

  it("断开后挂起中的调用立即失败，无须等待超时", async () => {
    const { fake, driver } = await connected()
    fake.reply = req => (req.action === "get_login_info" ? { user_id: 10000 } : undefined)

    const pending = driver.getGroupList()
    await until(() => fake.requests.length === 2, "请求到达")
    fake.socket?.terminate()

    // 若不主动拒绝，调用方须等满 15 秒超时才能得知该调用不再可能返回结果
    await expect(pending).rejects.toThrow(/get_group_list/)
  })

  it("频道消息被明确拒绝，而非发往一个不存在的目标", async () => {
    const { driver } = await connected()
    await expect(
      driver.sendMessage({ scene: "guild", guildId: "g", channelId: "c" }, "喵")
    ).rejects.toThrow(/不支持频道/)
  })
})

describe("需被动接入而服务器处于关闭状态", () => {
  it("于创建驱动时即报错，而非等待对端连接失败后再行推断", () => {
    const host = fakeHost({ enabled: false, host: "127.0.0.1", port: 2536, publicUrl: "http://127.0.0.1:2536" })
    expect(() =>
      createNapcatBot(validateAccount({ mode: "ws-reverse", listenPath: "/napcat" }), host, {
        adapterId: "napcat",
        http: fakeHttp()
      })
    ).toThrow(/需要内置服务器/)
  })
})
