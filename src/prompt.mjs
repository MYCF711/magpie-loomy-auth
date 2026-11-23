// 官方「灵魂提示词」剥离。
//
// 事实（见 docs/internals.md §3）：官方那套人格提示词写在客户端的
// `opencode-home-template/opencode.json` 的 `agent.<id>.prompt` 里，**由客户端本地注入**；
// 服务端不注入（实测带 SENTINEL 的 system 被尊重，裸请求自我认同为讯飞星火）。
// 所以本插件默认**什么都不加**。
//
// 这个模块只防一种情况：有人把客户端那整段 soul prompt 抄进请求里发过来。
// 那时模型会变成「Loomy 办公助手」口吻，破坏「原生 API Key 体验」。
//
// ⚠ 性能：聊天体积可以到几 MB，所以**先用一次 IndexOf 快速判否**，
//   命中才 JSON 解析。绝大多数请求只多一次子串查找。

/** 官方 soul prompt 的特征串（逐字取自 opencode-home-template/opencode.json）。 */
const MARKERS = [
  "你是 Loomy，一位温柔细心、靠谱稳重的智能办公助手",
  "Loomy 办公助手 - 帮助用户完成各种办公任务",
]

/** 至少命中两个特征才认定为「官方 soul prompt」，避免用户聊到这句话时被误删。 */
const MIN_HITS = 2

function hits(text) {
  let n = 0
  for (const marker of MARKERS) if (text.includes(marker)) n += 1
  return n
}

function contentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("\n")
  }
  return ""
}

/**
 * 从请求体里剥掉官方 soul prompt。
 *
 * @param {string} bodyText 原始请求体（JSON 文本）
 * @returns {{ body: string, removed: number } | null} 没命中返回 `null`（调用方原样转发）
 */
export function stripOfficialSoulPrompt(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return null
  // 快路径：一次子串查找就能判否
  if (!MARKERS.some((marker) => bodyText.includes(marker))) return null

  let payload
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return null // 不是 JSON 就不是我们能安全改的东西
  }
  const messages = payload?.messages
  if (!Array.isArray(messages)) return null

  const kept = messages.filter((message) => {
    const role = message?.role
    if (role !== "system" && role !== "developer") return true
    return hits(contentText(message?.content)) < MIN_HITS
  })
  const removed = messages.length - kept.length
  if (!removed) return null
  return { body: JSON.stringify({ ...payload, messages: kept }), removed }
}

export const _internal = { MARKERS, MIN_HITS }
