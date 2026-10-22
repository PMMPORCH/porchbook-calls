// Porchbook Radio audio worker: evens out loudness and saves every upload in
// one standard format, so the station sounds consistent.
//
//   POST /fm/process {jobToken, trackId, sourceUrl, kind}
//
// Jobs run one at a time. When a job finishes, the worker asks Porchbook for a
// one-off upload pass (proving the job with its jobToken), uploads the result
// to Porchbook's audio storage, and reports back. No secrets live here:
// Porchbook checks every jobToken against its own records.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const PORCHBOOK = (process.env.PORCHBOOK_URL || "https://porchbook.vercel.app").replace(/\/+$/, "");
const SPEECH = new Set(["preaching", "news", "reading"]);
const queue = [];
let running = false;

function ffmpegPath() {
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    /* fall back to a system ffmpeg */
  }
  return "ffmpeg";
}

function allowedSource(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (/\.public\.blob\.vercel-storage\.com$/i.test(u.hostname)) return true;
    return u.origin === PORCHBOOK && u.pathname === "/api/fm-file";
  } catch {
    return false;
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk.toString();
      if (log.length > 200000) log = log.slice(-100000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(log) : reject(new Error(`ffmpeg exited ${code}: ${log.slice(-400)}`))));
  });
}

function lastTime(log) {
  const all = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const m = all[all.length - 1];
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

async function tell(body) {
  const response = await fetch(`${PORCHBOOK}/api/fm-worker`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Porchbook answered ${response.status}`);
  return data;
}

async function processJob(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fm-"));
  const input = path.join(dir, "in");
  const output = path.join(dir, "out.mp3");
  try {
    const source = await fetch(job.sourceUrl);
    if (!source.ok || !source.body) throw new Error(`download ${source.status}`);
    await pipeline(Readable.fromWeb(source.body), fs.createWriteStream(input));
    const speech = SPEECH.has(job.kind);
    const log = await run([
      "-hide_banner", "-y", "-i", input, "-vn",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "44100",
      "-ac", speech ? "1" : "2",
      "-codec:a", "libmp3lame", "-b:a", speech ? "64k" : "128k",
      output,
    ]);
    const durationSec = lastTime(log);
    if (durationSec < 0.5) throw new Error("no audio came out");
    const { clientToken, pathname } = await tell({ action: "token", jobToken: job.jobToken, trackId: job.trackId });
    const { put } = await import("@vercel/blob/client");
    const stored = await put(pathname, fs.createReadStream(output), {
      access: "public",
      token: clientToken,
      contentType: "audio/mpeg",
      multipart: fs.statSync(output).size > 8 * 1024 * 1024,
    });
    await tell({ action: "done", jobToken: job.jobToken, trackId: job.trackId, url: stored.url, durationSec });
    console.log(`[fm] track ${job.trackId} done (${Math.round(durationSec)}s)`);
  } catch (error) {
    console.error(`[fm] track ${job.trackId} failed:`, error.message);
    await tell({ action: "failed", jobToken: job.jobToken, trackId: job.trackId, error: String(error.message).slice(0, 300) }).catch(() => undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) await processJob(queue.shift());
  running = false;
}

function handleFmProcess(req, res) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 10000) req.destroy();
  });
  req.on("end", () => {
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "bad json" }));
    }
    const ok =
      job && typeof job.jobToken === "string" && job.jobToken.length >= 20 && Number.isInteger(job.trackId) && allowedSource(job.sourceUrl);
    if (!ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not a Porchbook job" }));
    }
    if (!queue.some((q) => q.trackId === job.trackId)) queue.push({ jobToken: job.jobToken, trackId: job.trackId, sourceUrl: job.sourceUrl, kind: String(job.kind || "") });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: queue.length }));
    void drain();
  });
}

module.exports = { handleFmProcess };
