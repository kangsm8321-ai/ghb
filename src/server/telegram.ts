export const TG = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

export async function sendTelegramMessage(
  token: string,
  chatId: string | number,
  text: string,
  extra: Record<string, any> = {}
) {
  if (!token || !chatId) return { ok: false, description: "Token or Chat ID missing" };
  try {
    const res = await fetch(TG(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text,
        parse_mode: "HTML",
        ...extra,
      }),
    });
    return await res.json();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// 앨범 미리보기 전송 (Buffer 직접 멀티파트 전송으로 공개 URL 불필요, 최대 10장)
export async function sendAlbum(
  token: string,
  chatId: string | number,
  bufs: Buffer[],
  caption: string
) {
  if (!token || !chatId || !bufs.length) {
    return { ok: false, description: "Token, Chat ID or buffers missing" };
  }

  const validBufs = bufs.slice(0, 10);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));

  const media = validBufs.map((_, i) => ({
    type: "photo",
    media: `attach://p${i}`,
    ...(i === 0 ? { caption: caption.slice(0, 1000), parse_mode: "HTML" } : {}),
  }));
  fd.append("media", JSON.stringify(media));

  validBufs.forEach((b, i) => {
    fd.append(
      `p${i}`,
      new Blob([new Uint8Array(b)], { type: "image/jpeg" }),
      `p${i}.jpg`
    );
  });

  try {
    const res = await fetch(TG(token, "sendMediaGroup"), {
      method: "POST",
      body: fd,
    });
    return await res.json();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string
) {
  if (!token || !callbackQueryId) return;
  try {
    await fetch(TG(token, "answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
  } catch {}
}

export async function setupWebhook(
  token: string,
  publicBaseUrl: string,
  secretToken?: string
) {
  if (!token || !publicBaseUrl) return { ok: false, description: "Missing token or URL" };
  const webhookUrl = `${publicBaseUrl.replace(/\/+$/, "")}/tg/webhook`;
  try {
    const res = await fetch(TG(token, "setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken || undefined,
        allowed_updates: ["message", "callback_query"],
      }),
    });
    return await res.json();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function tgMultipart(
  token: string,
  method: string,
  fields: Record<string, any>,
  files: { field: string; buf: Buffer; name: string; mime: string }[]
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  for (const f of files)
    fd.append(f.field, new Blob([new Uint8Array(f.buf)], { type: f.mime }), f.name);
  const res = await fetch(TG(token, method), { method: "POST", body: fd });
  return res.json() as Promise<any>;
}

export const sendPhoto = (
  token: string,
  chatId: string | number,
  buf: Buffer,
  caption = "",
  reply_markup?: any
) =>
  tgMultipart(
    token,
    "sendPhoto",
    { chat_id: String(chatId), caption, parse_mode: "HTML", reply_markup },
    [{ field: "photo", buf, name: "slide.jpg", mime: "image/jpeg" }]
  );

// 같은 메시지의 사진만 바꿔서 조절할 때마다 새 메시지가 쌓이지 않게 함
export const editPhoto = (
  token: string,
  chatId: string | number,
  messageId: number,
  buf: Buffer,
  caption: string,
  reply_markup?: any
) =>
  tgMultipart(
    token,
    "editMessageMedia",
    {
      chat_id: String(chatId),
      message_id: String(messageId),
      media: { type: "photo", media: "attach://p", caption, parse_mode: "HTML" },
      reply_markup,
    },
    [{ field: "p", buf, name: "slide.jpg", mime: "image/jpeg" }]
  );

export const sendVideo = (
  token: string,
  chatId: string | number,
  buf: Buffer,
  caption = "",
  reply_markup?: any
) =>
  tgMultipart(
    token,
    "sendVideo",
    {
      chat_id: String(chatId),
      caption,
      parse_mode: "HTML",
      supports_streaming: "true",
      reply_markup,
    },
    [{ field: "video", buf, name: "reel.mp4", mime: "video/mp4" }]
  );

// 텔레그램 Bot API 는 20MB 이하 파일만 내려받을 수 있음
export async function downloadTelegramFile(
  token: string,
  fileId: string
): Promise<Buffer> {
  const r: any = await (
    await fetch(`${TG(token, "getFile")}?file_id=${encodeURIComponent(fileId)}`)
  ).json();
  if (!r.ok) throw new Error(r.description || "getFile 실패");
  const f = await fetch(
    `https://api.telegram.org/file/bot${token}/${r.result.file_path}`
  );
  if (!f.ok) throw new Error(`파일 다운로드 실패 (${f.status})`);
  return Buffer.from(await f.arrayBuffer());
}
