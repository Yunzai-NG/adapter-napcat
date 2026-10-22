/**
 * 模块职责：插件入口 —— 将 OneBot v11 适配器（NapCat / LLOneBot）注册至内核
 * 依赖方向：仅依赖 `@yunzai-ng/core` 的公开入口与 `@yunzai-ng/types`
 * 生命周期：`setup` 在插件加载时执行一次，返回后适配器即可被账号引用
 * 注意事项：**本文件内容极少，此即"账号登录同为插件"这一设计所要达到的效果。**
 *
 *          内核对 QQ、OneBot 与 NapCat 均无认知：其仅知晓"某个插件注册了一个适配器，
 *          该适配器可将一份账号配置转换为一个可收发消息的驱动"。
 *
 *          因此新增一个平台（Telegram、Discord、QQ 官方 Bot）无须改动内核代码，
 *          亦无须改动面板代码 —— 面板的"添加账号"表单由 `accountSchema` 实时渲染。
 *
 *          **未实现 `login()`。** NapCat 与 LLOneBot 的登录（扫码）都发生于它们自身的 WebUI 中，
 *          不属于本框架的流程。另行构造一个"扫码登录"页面只会使使用者误认为在此处
 *          完成扫码后即无须再关注对端。账号配置中填写的是"如何连接一个已完成登录的
 *          对端"，故仅需 `accountSchema`。
 */
import { definePlugin } from "@yunzai-ng/core"
import type { AdapterHost, AdapterProvider, BotDriver, PluginDefinition } from "@yunzai-ng/types"
import { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
import type { NapcatAccount } from "./config.js"
import { createNapcatBot } from "./bot.js"
import { PLATFORM } from "./codec.js"

/**
 * 适配器 id；账号记录中引用该值，同时作为路由前缀 `/adapter/napcat`
 *
 * **支持了 LLOneBot 之后也不改名。** 已有的账号记录靠这个 id 找到适配器，改了它们就全成了
 * 「未注册的适配器」名下的号。
 */
export const ADAPTER_ID = "napcat"

export { ACCOUNT_SCHEMA, validateAccount } from "./config.js"
export type { NapcatAccount, NapcatMode } from "./config.js"

/**
 * 插件定义
 *
 * 显式标注类型而非直接 `export default definePlugin(...)`：返回类型 `PluginDefinition` 声明在
 * `@yunzai-ng/types` 内，而插件在使用者主目录里就地构建时，该包的真实路径落在宿主的
 * `node_modules/.pnpm/` 之下 —— tsc 生成 .d.ts 时无从以可移植的方式指称它，报 TS2742。
 * 标注后 .d.ts 直接写下这个名字，与宿主的安装布局无关。本插件未声明 configSchema，
 * 故配置类型即 `definePlugin` 在这一情形下推出的 `Record<string, never>`。
 */
const plugin: PluginDefinition<Record<string, never>> = definePlugin({
  // 版本与说明取 package.json；name 留着，省掉要内核 0.6.5
  name: "adapter-onebot",
  // 适配器须先于其他插件就绪：账号连接由内核在插件加载完成后统一发起，
  // 但注册时机越早，"适配器未注册"的时间窗口越短
  priority: 10,

  setup(ctx) {
    const provider: AdapterProvider<NapcatAccount> = {
      id: ADAPTER_ID,
      name: "OneBot v11（NapCat / LLOneBot）",
      description: "连接一个已完成登录的 NapCat 或 LLOneBot。登录过程在它们自身的 WebUI 中完成",
      platform: PLATFORM,
      accountSchema: ACCOUNT_SCHEMA.describe(),
      validateAccount,

      createBot(account: NapcatAccount, host: AdapterHost): BotDriver {
        return createNapcatBot(account, host, { adapterId: ADAPTER_ID, http: ctx.http })
      }
    }

    ctx.registerAdapter(provider as unknown as AdapterProvider)
    ctx.logger.info("OneBot v11 适配器（NapCat / LLOneBot）已注册，可在面板的账号页面添加账号")
  }
})

export default plugin
