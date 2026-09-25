import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs/promises";
import os from "os";
import path from "path";

function run(bin: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))));
  });
}

export async function makeSlideshowReel(
  slides: Buffer[], audio: Buffer, opts: { secPerSlide?: number; audioStart?: number } = {}
): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reel-"));
  try {
    const sec = opts.secPerSlide ?? 3;
    const total = Math.max(6, slides.length * sec);
    await Promise.all(slides.map((b, i) => fs.writeFile(path.join(dir, `s${String(i).padStart(2, "0")}.jpg`), b)));
    await fs.writeFile(path.join(dir, "audio"), audio);
    const out = path.join(dir, "out.mp4");
    await run(ffmpegPath as unknown as string, [
      "-y", "-framerate", `1/${sec}`, "-i", path.join(dir, "s%02d.jpg"),
      "-ss", String(opts.audioStart ?? 0), "-i", path.join(dir, "audio"),
      "-vf",
      `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x080c18,fps=30,tpad=stop_mode=clone:stop_duration=${sec},format=yuv420p`,
      "-af", `apad,afade=t=out:st=${total - 1.5}:d=1.5`,
      "-map", "0:v", "-map", "1:a", "-t", String(total),
      "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-r", "30",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", out,
    ]);
    return await fs.readFile(out);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
