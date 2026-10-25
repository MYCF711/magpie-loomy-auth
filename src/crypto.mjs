// Loomy · 加密原语（账号接口签名用）
//
// 只用 node:crypto 的标准原语 —— HMAC-SHA1 与 MD5 在这里是**厂商客户端自己的
// 请求签名方案**（随 Loomy 客户端分发），不是我们在破解任何东西。
// 纯算法部分在 pure.mjs 的 `signedHeaders`，本文件只负责提供原语。

import { createHash, createHmac, randomUUID } from "node:crypto"
import { SIGN_ACCESS_KEY_ID, SIGN_ACCESS_KEY_SECRET } from "./constants.mjs"

export const secrets = {
  accessKeyId: SIGN_ACCESS_KEY_ID,
  accessKeySecret: SIGN_ACCESS_KEY_SECRET,
  md5Base64: (text) => createHash("md5").update(text, "utf8").digest("base64"),
  hmacSha1Base64: (key, text) => createHmac("sha1", key).update(text, "utf8").digest("base64"),
  utcnow: () => new Date().toUTCString(),
  uuid: () => randomUUID(),
}

/** 客户端用 uuid 去掉横线作为 traceid。 */
export function traceId() {
  return randomUUID().replace(/-/g, "")
}
