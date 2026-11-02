// 手动实网回归：会发送图片对话请求并消费账号积分，不进入 npm test。
// LOOMY_AUTH_FILE=/path/to/plugin-auth.json node --test tests/vision-live.mjs
// MODEL_IDS=DeepSeek-V4.1-Flash REASONING_EFFORT=high LOOMY_AUTH_FILE=/path/to/plugin-auth.json node --test tests/vision-live.mjs

import fs from "node:fs/promises"
import assert from "node:assert/strict"
import test from "node:test"
import { LoomyAuthPlugin } from "../index.mjs"

const authFile = process.env.LOOMY_AUTH_FILE
assert.ok(authFile, "设置 LOOMY_AUTH_FILE，指向本地 Magpie plugin-auth.json；不要提交凭据")
const accounts = JSON.parse(await fs.readFile(authFile, "utf8"))
const auth = Object.entries(accounts).find(([key]) => key === "loomy" || key.startsWith("loomy#"))?.[1]
assert.ok(auth, "凭据文件中没有 Loomy 账号")

const plugin = await LoomyAuthPlugin({ client: {} })
const loader = await plugin.auth.loader(async () => auth, { id: "loomy" })
const models = await plugin.provider.models({ models: {} }, { auth })
const visionIds = Object.keys(models).filter((id) => models[id].capabilities.input.image)
const ids = process.env.MODEL_IDS?.split(",") ?? visionIds
const reasoningEffort = process.env.REASONING_EFFORT ?? "none"
assert.ok(ids.length, "没有找到视觉模型")
for (const id of ids) assert.ok(visionIds.includes(id), `${id} 未声明支持图片输入`)

const png = await fs.readFile(new URL("./fixtures/vision.png", import.meta.url))
const image = `data:image/png;base64,${png.toString("base64")}`
const prompt = "Read the five large characters in the image. Return only those five characters. If you cannot see the image, return IMAGE_UNAVAILABLE."

await test("视觉模型能识别真实图片中的文字", { concurrency: 2 }, async (t) => {
  await Promise.all(ids.map((model) => t.test(model, { timeout: 150_000 }, async () => {
    const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image } },
        ] }],
        stream: true,
        max_tokens: 8192,
        reasoning_effort: reasoningEffort,
      }),
    })
    assert.equal(response.status, 200, `${model}: HTTP ${response.status}`)
    const events = (await response.text()).split("\n")
      .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      .map((line) => JSON.parse(line.slice(5)))
    const answer = events.map((event) => event.choices?.[0]?.delta?.content ?? "").join("")
    const finish = events.findLast((event) => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason
    assert.match(answer, /\b2528F\b/, `${model}: finish=${finish}, answer=${JSON.stringify(answer)}`)
  })))
})
