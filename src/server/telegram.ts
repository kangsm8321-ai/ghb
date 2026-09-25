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
    ...(i === 0 ? { caption: caption.slice(0, 1000) } : {}),
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
