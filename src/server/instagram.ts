const IG = "https://graph.instagram.com/v26.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function igPost(path: string, token: string, params: Record<string, string>) {
  const res = await fetch(`${IG}/${path}`, {
    method: "POST",
    body: new URLSearchParams({ ...params, access_token: token }),
  });
  const j: any = await res.json();
  if (!res.ok || j.error) throw new Error(`IG ${path}: ${j.error?.message || res.status}`);
  return j;
}

async function igGet(path: string, token: string, fields: string) {
  const res = await fetch(`${IG}/${path}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
  return res.json() as Promise<any>;
}

async function waitFinished(id: string, token: string, interval = 5000, maxMs = 5 * 60_000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const s = await igGet(id, token, "status_code");
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`컨테이너 상태: ${s.status_code}`);
    await sleep(interval);
  }
  throw new Error("인스타 컨테이너 처리 시간 초과");
}

async function publish(igUserId: string, token: string, creationId: string) {
  const pub = await igPost(`${igUserId}/media_publish`, token, { creation_id: creationId });
  const info = await igGet(pub.id, token, "permalink");
  return { id: pub.id as string, permalink: info.permalink as string | undefined };
}

// imageUrls 는 인스타 서버가 직접 가져가야 하므로 공개 URL + JPEG 이어야 함
export async function publishCarousel(o: { igUserId: string; token: string; imageUrls: string[]; caption: string }) {
  const urls = o.imageUrls.slice(0, 10);
  if (urls.length === 1) {
    const c = await igPost(`${o.igUserId}/media`, o.token, { image_url: urls[0], caption: o.caption });
    await waitFinished(c.id, o.token);
    return publish(o.igUserId, o.token, c.id);
  }
  const children: string[] = [];
  for (const u of urls) {
    const c = await igPost(`${o.igUserId}/media`, o.token, { image_url: u, is_carousel_item: "true" });
    await waitFinished(c.id, o.token);
    children.push(c.id);
  }
  const car = await igPost(`${o.igUserId}/media`, o.token, {
    media_type: "CAROUSEL", children: children.join(","), caption: o.caption,
  });
  await waitFinished(car.id, o.token);
  return publish(o.igUserId, o.token, car.id);
}

export async function publishReel(o: { igUserId: string; token: string; videoUrl: string; caption: string; audioName?: string }) {
  const params: Record<string, string> = {
    media_type: "REELS", video_url: o.videoUrl, caption: o.caption, share_to_feed: "true",
  };
  if (o.audioName) params.audio_name = o.audioName.slice(0, 100);
  const c = await igPost(`${o.igUserId}/media`, o.token, params);
  await waitFinished(c.id, o.token, 15000, 6 * 60_000);
  return publish(o.igUserId, o.token, c.id);
}
