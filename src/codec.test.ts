/**
 * 模块职责：消息段编解码的测试 —— 固定通用模型与 OneBot v11 报文之间的双向映射
 * 依赖方向：测试文件，依赖 codec.ts / media.ts 与内核的 `seg`
 * 生命周期：本地文件相关的用例共用一个临时目录，于 afterAll 中删除
 * 注意事项：其中三项用例针对的是与其他 OneBot 实现的分歧，而非通用逻辑：本地路径
 *          禁止添加 `file://` 前缀、自定义音乐卡片的音频直链位于 `audio` 字段、
 *          CQ 码中 `&amp;` 必须最后还原。三者出错时均无异常抛出，仅表现为图片
 *          无法显示、卡片点击无声、文本内容被多解析一层。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { seg } from "@yunzai-ng/core"
import { decodeCq, decodeMessage, decodeNodes, decodeSegments, encodeNodes, encodeSegments, normalizeFileSegments } from "./codec.js"
import type { MediaEncodeOptions } from "./media.js"
import type { MediaRef, Segment } from "@yunzai-ng/types"

/** 同机部署：本地路径可以裸路径形式传递 */
const LOCAL: MediaEncodeOptions = { localFileAccess: true, maxInlineBytes: 1024 * 1024 }
/** NapCat 位于其他机器：本地路径必须编码为 base64 */
const REMOTE: MediaEncodeOptions = { localFileAccess: false, maxInlineBytes: 1024 * 1024 }

describe("编码：通用模型 → OneBot", () => {
  it("文本、at、@全体、表情、引用", async () => {
    const { message } = await encodeSegments(
      [seg.text("你好"), seg.at("10001"), seg.atAll(), seg.face(66), seg.reply("123456")],
      LOCAL
    )
    expect(message).toEqual([
      { type: "text", data: { text: "你好" } },
      { type: "at", data: { qq: "10001" } },
      { type: "at", data: { qq: "all" } },
      { type: "face", data: { id: "66" } },
      { type: "reply", data: { id: "123456" } }
    ])
  })

  it("网络图片原样给出 URL，既不下载亦不转码", async () => {
    const { message } = await encodeSegments([seg.image("https://example.com/a.png")], LOCAL)
    expect(message[0]?.data?.["file"]).toBe("https://example.com/a.png")
  })

  it("内存字节采用 base64://", async () => {
    const { message } = await encodeSegments([seg.image(new Uint8Array([1, 2, 3]))], LOCAL)
    expect(message[0]?.data?.["file"]).toBe(`base64://${Buffer.from([1, 2, 3]).toString("base64")}`)
  })

  it("合并转发节点采用 user_id / nickname / content", async () => {
    const nodes = await encodeNodes([seg.node("正文", { uid: "10001", name: "小明" })], LOCAL)
    expect(nodes).toEqual([
      { type: "node", data: { user_id: "10001", nickname: "小明", content: [{ type: "text", data: { text: "正文" } }] } }
    ])
  })

  it("引用已有消息的节点仅给出 id", async () => {
    const nodes = await encodeNodes([{ messageId: "888" }], LOCAL)
    expect(nodes).toEqual([{ type: "node", data: { id: "888" } }])
  })

  it("自定义音乐卡片的音频直链置于 audio 而非 url", async () => {
    const { message } = await encodeSegments(
      [seg.musicCustom({ url: "https://page", audio: "https://audio.mp3", title: "歌名" })],
      LOCAL
    )
    expect(message[0]?.data).toMatchObject({ type: "custom", url: "https://page", audio: "https://audio.mp3" })
  })

  it("OneBot 无法表达的段被丢弃并予报出，而非静默消失", async () => {
    const { message, dropped } = await encodeSegments(
      [seg.text("在"), seg.keyboard([[{ label: "点我", action: "input" }]])],
      LOCAL
    )
    expect(message).toHaveLength(1)
    expect(dropped).toEqual(["keyboard"])
  })

  it("携带 nodes 的合并转发不作为消息段编码（须采用 send_forward_msg）", async () => {
    const { message, dropped } = await encodeSegments([seg.forward([seg.node("一条")])], LOCAL)
    expect(message).toHaveLength(0)
    expect(dropped).toEqual(["forward"])
  })

  it("raw 段仅透传回同一平台", async () => {
    const mine = await encodeSegments([seg.raw("onebot11", "mface", { emoji_id: "x" })], LOCAL)
    expect(mine.message).toEqual([{ type: "mface", data: { emoji_id: "x" } }])
    const other = await encodeSegments([seg.raw("telegram", "sticker", {})], LOCAL)
    expect(other.dropped).toEqual(["raw"])
  })
})

describe("编码：本地文件的两条通道", () => {
  let dir = ""
  let file = ""

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "napcat-codec-"))
    file = join(dir, "a.png")
    await writeFile(file, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("同机时以裸路径传递 —— 不得添加 file:// 前缀", async () => {
    const { message } = await encodeSegments([seg.image(file)], LOCAL)
    // NapCat 的 file:// 指向其内部的文件哈希 id，而非文件系统路径。
    // 添加该前缀将使其查询一个不存在的哈希，并报告"文件不存在"
    expect(message[0]?.data?.["file"]).toBe(file)
    expect(String(message[0]?.data?.["file"])).not.toContain("file://")
  })

  it("异机时读盘并编码为 base64", async () => {
    const { message } = await encodeSegments([seg.image(file)], REMOTE)
    expect(message[0]?.data?.["file"]).toBe(`base64://${Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64")}`)
  })

  it("异机且文件不存在时，错误信息指明须调整的配置项", async () => {
    await expect(encodeSegments([seg.image(join(dir, "不存在的文件.png"))], REMOTE)).rejects.toThrow(
      /NapCat 可读取本机文件/
    )
  })

  it("超过直传上限时明确拒绝，而非导致连接中断", async () => {
    const big = join(dir, "big.bin")
    await writeFile(big, Buffer.alloc(2048))
    await expect(
      encodeSegments([seg.image(big)], { localFileAccess: false, maxInlineBytes: 1024 })
    ).rejects.toThrow(/超过 base64 直传上限/)
  })
})

describe("解码：OneBot → 通用模型", () => {
  it("数组格式的消息", () => {
    const segments = decodeSegments([
      { type: "text", data: { text: "你好" } },
      { type: "at", data: { qq: "10001", name: "小明" } },
      { type: "at", data: { qq: "all" } },
      { type: "face", data: { id: "66" } }
    ])
    expect(segments).toEqual([
      { type: "text", text: "你好" },
      { type: "at", uid: "10001", name: "小明" },
      { type: "atAll" },
      { type: "face", id: 66 }
    ])
  })

  it("图片优先取可下载的 url —— 插件识图依赖该字段", () => {
    const [image] = decodeSegments([
      {
        type: "image",
        data: { file: "abc.png", url: "https://gchat.qpic.cn/x.png", path: "C:/napcat/cache/x.png", file_size: 1024 }
      }
    ])
    expect(image).toMatchObject({ type: "image", file: { kind: "url", url: "https://gchat.qpic.cn/x.png" } })
  })

  it("无 url 时回落至 NapCat 侧路径，再回落至文件 id", () => {
    const [byPath] = decodeSegments([{ type: "image", data: { path: "/data/x.png", file: "x.png" } }])
    expect(byPath).toMatchObject({ file: { kind: "path", path: "/data/x.png" } })

    const [byId] = decodeSegments([{ type: "image", data: { file_id: "FILEID", file: "x.png" } }])
    expect(byId).toMatchObject({ file: { kind: "id", id: "FILEID" } })
  })

  it("商城表情（mface）按图片接收", () => {
    const [image] = decodeSegments([{ type: "mface", data: { url: "https://x/y.png", summary: "[表情]" } }])
    expect(image).toMatchObject({ type: "image", summary: "[表情]" })
  })

  it("无法识别的段类型降级为 raw 而非丢弃", () => {
    const [raw] = decodeSegments([{ type: "某个新类型", data: { a: 1 } }])
    expect(raw).toEqual({ type: "raw", platform: "onebot11", platformType: "某个新类型", data: { a: 1 } })
  })

  it("非法项被跳过，不影响同一条消息中的其他段", () => {
    expect(decodeSegments([null, 42, { type: "text", data: { text: "在" } }])).toEqual([{ type: "text", text: "在" }])
  })

  it("转发节点识别 uin / name 别名", () => {
    const nodes = decodeNodes([
      { type: "node", data: { uin: "10001", name: "小明", content: [{ type: "text", data: { text: "喵" } }] } }
    ])
    expect(nodes).toEqual([{ uid: "10001", name: "小明", message: [{ type: "text", text: "喵" }] }])
  })
})

describe("解码：CQ 码字符串", () => {
  it("文本与 CQ 码混排", () => {
    expect(decodeCq("你好[CQ:at,qq=10001]请看[CQ:image,url=https://x/y.png]")).toEqual([
      { type: "text", text: "你好" },
      { type: "at", uid: "10001" },
      { type: "text", text: "请看" },
      { type: "image", file: { kind: "url", url: "https://x/y.png" } }
    ])
  })

  it("还原实体转义", () => {
    // CQ 码中 & [ ] , 四个字符必须转义，否则无法区分其为内容抑或语法
    expect(decodeCq("&#91;不是CQ码&#93; a&amp;b")).toEqual([{ type: "text", text: "[不是CQ码] a&b" }])
  })

  it("&amp; 最后还原，避免将转义后的转义多解析一层", () => {
    // `&amp;#91;` 为"字面量 &#91;"，不应变为 `[`
    expect(decodeCq("&amp;#91;")).toEqual([{ type: "text", text: "&#91;" }])
  })

  it("纯文本不含 CQ 码时原样返回", () => {
    expect(decodeCq("#原神体力")).toEqual([{ type: "text", text: "#原神体力" }])
  })

  it("decodeMessage 识别两种上报格式", () => {
    // messagePostFormat 为对端的配置，适配器无法约束，两种格式均须解析
    expect(decodeMessage([{ type: "text", data: { text: "在" } }])).toEqual([{ type: "text", text: "在" }])
    expect(decodeMessage("在")).toEqual([{ type: "text", text: "在" }])
    expect(decodeMessage(undefined)).toEqual([])
  })
})

describe("消息段归一化：file_id → path / url", () => {
  /** 把 id 换成一条直链的假 resolver */
  const toUrl = (id: string): Promise<MediaRef | undefined> => Promise.resolve({ kind: "url", url: `https://cdn/${id}` })

  it("只给 file_id 的文件段被换成 url", async () => {
    const input: Segment[] = [{ type: "file", file: { kind: "id", id: "F1" }, name: "a.pdf" }]
    const out = await normalizeFileSegments(input, toUrl)
    expect(out[0]).toMatchObject({ type: "file", name: "a.pdf", file: { kind: "url", url: "https://cdn/F1" } })
  })

  it("图片、语音、视频同样归一", async () => {
    const input: Segment[] = [
      { type: "image", file: { kind: "id", id: "I" } },
      { type: "record", file: { kind: "id", id: "R" } },
      { type: "video", file: { kind: "id", id: "V" } }
    ]
    const out = await normalizeFileSegments(input, id => Promise.resolve({ kind: "path", path: `/data/${id}` }))
    expect(out.map(s => (s.type === "image" || s.type === "record" || s.type === "video" ? s.file : undefined))).toEqual([
      { kind: "path", path: "/data/I" },
      { kind: "path", path: "/data/R" },
      { kind: "path", path: "/data/V" }
    ])
  })

  it("已是 url / path 的段不再解析 —— 只动 kind:id", async () => {
    let calls = 0
    const spy = (id: string): Promise<MediaRef | undefined> => {
      calls += 1
      return toUrl(id)
    }
    const input: Segment[] = [
      { type: "image", file: { kind: "url", url: "https://x/y.png" } },
      { type: "file", file: { kind: "path", path: "/tmp/z" }, name: "z" }
    ]
    const out = await normalizeFileSegments(input, spy)
    expect(out).toEqual(input)
    expect(calls).toBe(0)
  })

  it("空 id 不解析：那本就是拿不到来源的兜底值", async () => {
    let calls = 0
    const input: Segment[] = [{ type: "file", file: { kind: "id", id: "" }, name: "空" }]
    const out = await normalizeFileSegments(input, id => {
      calls += 1
      return toUrl(id)
    })
    expect(out).toEqual(input)
    expect(calls).toBe(0)
  })

  it("resolve 返回 undefined 时原样保留那一段，不毁掉整条消息", async () => {
    const input: Segment[] = [
      { type: "text", text: "看这个文件" },
      { type: "file", file: { kind: "id", id: "F" }, name: "a" }
    ]
    const out = await normalizeFileSegments(input, () => Promise.resolve(undefined))
    expect(out).toEqual(input)
  })

  it("resolve 抛错时如实冒泡 —— 吞错是调用方（bot 的 probeFile）的事，归一化不替它兜底", async () => {
    const input: Segment[] = [{ type: "file", file: { kind: "id", id: "F" }, name: "a" }]
    // 归一化只忠实执行注入的 resolve：它抛，整个 promise 就 reject。真正「一个文件换不到
    // 也不毁掉整条消息」的兜底在 bot.ts 的 probeFile（get_file 失败即返回 undefined）
    await expect(normalizeFileSegments(input, () => Promise.reject(new Error("boom")))).rejects.toThrow(/boom/)
  })

  it("非媒体段原样穿过", async () => {
    const input: Segment[] = [{ type: "text", text: "喵" }, { type: "at", uid: "1" }]
    expect(await normalizeFileSegments(input, toUrl)).toEqual(input)
  })
})
