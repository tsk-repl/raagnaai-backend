/**
 * Raagnaai Ads — backend
 * The ONLY place secret keys live. The dashboard talks to this; this talks to the tools.
 *
 * Endpoints (match exactly what the dashboard POSTs):
 *   POST /generate-audio  {voiceId, language, text, voiceHint, estSeconds} -> {audioUrl, seconds}
 *   POST /render-video    {audioUrl, imageBrief, imageBase64, visualHint}  -> {videoUrl}
 *   POST /post            {channels, package, videoUrl}                    -> {posted}
 *   POST /brain           {dna, job}                                       -> content package (for the DEPLOYED dashboard)
 *   GET  /health
 *
 * Run:  npm i express cors  &&  node server.js     (Node 18+, has global fetch)
 * Set the env vars below, then in the dashboard Settings: paste this server's URL as
 * BACKEND_URL, add your cloned voice ID, and turn OFF Simulate mode.
 *
 * Deploy anywhere with a public HTTPS URL (Cloud Run / Render / Railway / Fly / a VPS).
 * For Firebase Functions: wrap `app` with functions.https.onRequest(app) and host media in
 * Firebase Storage instead of the local /media folder (see note in saveMedia()).
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { MongoClient } from "mongodb";

// ---------- keys & config (env only — never hard-code) ----------
const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`; // must be PUBLIC for JSON2Video to fetch media
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2"; // best Telugu/Hindi quality
const JSON2VIDEO_API_KEY = process.env.JSON2VIDEO_API_KEY;
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "instagram-story";          // vertical 1080x1920; change as needed
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;       // legacy Make.com scenario (now only used for the WordPress blog during transition)
const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;  // Upload-Post unified posting API (FB/IG/LinkedIn/YouTube/GMB)
// ---- brain: three models draft, Claude synthesises the final ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;    // Claude (draft + final synthesis)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;          // ChatGPT draft
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;          // Gemini draft
// Model IDs drift fast — confirm the exact current strings in each provider's console.
const CLAUDE_DRAFT_MODEL = process.env.CLAUDE_DRAFT_MODEL || "claude-sonnet-4-6";
const CLAUDE_SYNTH_MODEL = process.env.CLAUDE_SYNTH_MODEL || "claude-opus-4-8"; // does the final merge
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

// ---------- shared post storage (MongoDB Atlas) ----------
// Stores a LIGHTWEIGHT copy of each post so every device/teammate sees the same list.
// If MONGODB_URI is missing or the DB is unreachable, the rest of the app still works;
// only the cross-device sync endpoints return an error.
const MONGODB_URI = process.env.MONGODB_URI;
let _mongoClient = null, _postsColl = null, _settingsColl = null, _clientsColl = null, _mongoTried = false;
async function ensureMongo() {
  if (_postsColl) return true;
  if (!MONGODB_URI) return false;
  if (_mongoTried && !_mongoClient) return false; // earlier attempt failed; don't hammer
  _mongoTried = true;
  try {
    _mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await _mongoClient.connect();
    const db = _mongoClient.db("raagnaai");
    _postsColl = db.collection("posts");
    _settingsColl = db.collection("settings");
    _clientsColl = db.collection("clients");
    await _postsColl.createIndex({ owner: 1, createdAt: -1 });
    await _postsColl.createIndex({ owner: 1, id: 1 }, { unique: true });
    await _settingsColl.createIndex({ owner: 1 }, { unique: true });
    await _clientsColl.createIndex({ roster: 1 }, { unique: true });
    console.log("MongoDB connected — shared post sync is live");
    return true;
  } catch (e) {
    console.error("MongoDB connection failed:", e.message);
    _mongoClient = null;
    return false;
  }
}
async function postsCollection() { return (await ensureMongo()) ? _postsColl : null; }
async function settingsCollection() { return (await ensureMongo()) ? _settingsColl : null; }
async function clientsCollection() { return (await ensureMongo()) ? _clientsColl : null; }

const app = express();
app.use(cors());                         // PROD: restrict to your dashboard origin -> cors({ origin: "https://your-dashboard" })
app.use(express.json({ limit: "25mb" })); // images arrive as base64

// ---------- media hosting ----------
// Saves a buffer and returns a PUBLIC url. JSON2Video must be able to fetch it.
// PROD alternative: upload to Firebase Storage / S3 and return that signed/public URL instead.
const MEDIA_DIR = path.join(process.cwd(), "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use("/media", express.static(MEDIA_DIR));
function saveMedia(buffer, ext) {
  const name = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buffer);
  return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/media/${name}`;
}

// Read width/height from a JPEG or PNG buffer (no extra libraries). Returns {w,h} or null.
function imageDims(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) // PNG
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG — scan for the SOF marker
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) {}
  return null;
}

// ============================================================
// 1) AUDIO — ElevenLabs (own key + cloned voice). Standalone file so the operator
//    can listen and approve BEFORE the video is built. This is why we generate audio
//    here rather than inside the JSON2Video render — and it gives full model control,
//    which is the best Telugu quality.
// ============================================================
// Reusable ElevenLabs TTS → returns a hosted MP3 URL
async function elevenTTS(voiceId, text, voiceHint) {
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  if (!voiceId) throw new Error("No voiceId — set the cloned voice ID in the dashboard");
  const slower = /slow|clear|calm/i.test(voiceHint || "");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      text, model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: slower ? 0.6 : 0.4, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true },
    }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);
  return saveMedia(Buffer.from(await r.arrayBuffer()), "mp3");
}

// Spoken brand sign-off played over the logo end card (per language)
const TAGLINE = {
  te: "రాగ్నాయి యాడ్స్. రండి, కస్టమర్‌ని పలకరిద్దాం.",
  hi: "रागनाई ऐड्स. आइए, ग्राहक का स्वागत करते हैं.",
  en: "Raagnaai Ads. Come, let's greet the customer.",
};

app.post("/generate-audio", async (req, res) => {
  try {
    const { voiceId, text, voiceHint } = req.body;
    const audioUrl = await elevenTTS(voiceId, text, voiceHint);
    res.json({ audioUrl, seconds: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 2) VIDEO — JSON2Video. The audio drives the scene length; the image fills it.
//    audio duration -1 = the clip's real length (so the scene = the voiceover length);
//    image/text duration -2 = match the scene. This is the "voiceover length drives
//    video length" rule, enforced.
// ============================================================
app.post("/render-video", async (req, res) => {
  try {
    const { audioUrl, imageBrief, imageBase64, imageMediaType, visualHint, logoBase64, logoMediaType, voiceId, language, images, audioSeconds } = req.body;
    if (!JSON2VIDEO_API_KEY) throw new Error("JSON2VIDEO_API_KEY not set");
    if (!audioUrl) throw new Error("No approved audioUrl");

    // gather one or many activity photos, host each (JSON2Video needs URLs)
    const imgList = (Array.isArray(images) && images.length) ? images
      : (imageBase64 ? [{ base64: imageBase64, mediaType: imageMediaType }] : []);
    const hosted = imgList.map(im => saveMedia(Buffer.from(im.base64, "base64"), /png/i.test(im.mediaType || "") ? "png" : "jpg"));

    // match the video shape to the (first) photo so there are no black bars
    let resolution = VIDEO_RESOLUTION;
    if (imgList[0]) { const d = imageDims(Buffer.from(imgList[0].base64, "base64")); if (d) resolution = d.w > d.h * 1.15 ? "full-hd" : d.h > d.w * 1.15 ? "instagram-story" : "squared"; }
    const dimMap = { "full-hd": [1920, 1080], "instagram-story": [1080, 1920], "squared": [1080, 1080] };
    const [W, H] = dimMap[resolution] || [1920, 1080];

    // cinematic moves — gentle alternating zoom (kept modest so the whole photo stays visible)
    const zooms = [1, -1, 2, -2, 1, -2];
    const secs = Number(audioSeconds) > 0 ? Number(audioSeconds) : null;
    const movieElements = [];
    let contentScenes;

    // a soft, enlarged, blurred copy of the same photo fills the frame behind the full photo,
    // so nothing is ever cropped but there are no empty bars either
    const blurBg = (url, dur) => ({ type: "html", html: `<div style="margin:0;padding:0;position:absolute;top:0;left:0;width:${W}px;height:${H}px;background:#1a1714;overflow:hidden;"><div style="position:absolute;top:-10%;left:-10%;width:120%;height:120%;background:#1a1714 url('${url}') center center / cover no-repeat;filter:blur(34px) brightness(0.7);"></div></div>`, x: 0, y: 0, width: W, height: H, duration: dur });

    if (hosted.length > 1 && secs) {
      // slideshow: photos cover the voiceover PLUS a short silent hold at the end,
      // so the script fully finishes before the end card appears
      const hold = 1.3;
      const each = Math.max(2.0, (secs + hold) / hosted.length);
      contentScenes = hosted.map((url, i) => {
        const sc = { duration: each, elements: [blurBg(url, each), { type: "image", src: url, resize: "fit", zoom: zooms[i % zooms.length], duration: each }] };
        if (i > 0) sc.transition = { style: "fade", duration: 0.4 };
        return sc;
      });
      movieElements.push({ type: "audio", src: audioUrl, duration: -1 });          // voiceover across all photos
      if (imageBrief?.on_screen_text)
        movieElements.push({ type: "text", text: imageBrief.on_screen_text, position: "bottom-center", style: "005", duration: secs });
    } else {
      // single photo: voiceover plays, then a short silent hold before the end card
      const els = [];
      if (hosted[0]) { els.push(blurBg(hosted[0], -2)); els.push({ type: "image", src: hosted[0], duration: -2, resize: "fit", zoom: 2 }); }
      els.push({ type: "audio", src: audioUrl, duration: -1 });
      if (imageBrief?.on_screen_text) els.push({ type: "text", text: imageBrief.on_screen_text, duration: -2, position: "bottom-center", style: "005" });
      contentScenes = [secs ? { duration: secs + 1.3, elements: els } : { elements: els }];
    }

    // branded end card — your uploaded logo if provided, otherwise a text card,
    // with a spoken brand tagline over it (in the post's language, your cloned voice)
    let taglineUrl = null;
    if (voiceId) { try { taglineUrl = await elevenTTS(voiceId, TAGLINE[language] || TAGLINE.en); } catch (_) {} }
    const visDur = taglineUrl ? -2 : 2.6;   // if there's a tagline, the visual matches the audio length
    const outroEls = [];
    let outroBg = "#cf4a26";
    if (logoBase64) {
      outroBg = "#ffffff";
      const logoUrl = saveMedia(Buffer.from(logoBase64, "base64"), /png/i.test(logoMediaType || "") ? "png" : "jpg");
      outroEls.push({ type: "image", src: logoUrl, width: Math.round(W * 0.6), height: -1, position: "center-center", duration: visDur });
    } else {
      const outroHtml =
        `<div style="width:${W}px;height:${H}px;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#cf4a26;font-family:Inter,Arial,sans-serif;color:#fff;text-align:center;">`
        + `<div style="font-size:${Math.round(W * 0.07)}px;font-weight:800;letter-spacing:-2px;line-height:1;">Raagnaai Ads</div>`
        + `<div style="font-size:${Math.round(W * 0.028)}px;font-weight:500;margin-top:${Math.round(H * 0.03)}px;opacity:.92;">Traditional marketing. Real local dominance.</div>`
        + `</div>`;
      outroEls.push({ type: "html", html: outroHtml, x: 0, y: 0, width: W, height: H, duration: visDur });
    }
    if (taglineUrl) outroEls.push({ type: "audio", src: taglineUrl, start: 0.6, duration: -1 });
    const outroScene = taglineUrl
      ? { "background-color": outroBg, transition: { style: "fade", duration: 0.4 }, elements: outroEls }
      : { "background-color": outroBg, duration: 2.6, transition: { style: "fade", duration: 0.4 }, elements: outroEls };

    const movie = { resolution, quality: "high", scenes: [...contentScenes, outroScene] };
    if (movieElements.length) movie.elements = movieElements;

    const create = await fetch("https://api.json2video.com/v2/movies", {
      method: "POST",
      headers: { "x-api-key": JSON2VIDEO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(movie),
    });
    const created = await create.json();
    if (!created.success) throw new Error("JSON2Video create failed: " + JSON.stringify(created));
    const projectId = created.project;

    // poll until done (or switch to a webhook export for production — see note below)
    let videoUrl = null;
    for (let i = 0; i < 90; i++) {           // ~7.5 min max (slideshows + transitions render slower)
      await new Promise(r => setTimeout(r, 5000));
      const s = await fetch(`https://api.json2video.com/v2/movies?project=${projectId}`, {
        headers: { "x-api-key": JSON2VIDEO_API_KEY },
      });
      const data = await s.json();
      const status = data?.movie?.status;
      if (status === "done") { videoUrl = data.movie.url; break; }
      if (status === "error") throw new Error("JSON2Video render error: " + (data.movie.message || ""));
    }
    if (!videoUrl) throw new Error("Render timed out");
    res.json({ videoUrl, imageUrl: hosted[0] || null });
    // PRODUCTION TIP: instead of polling, add to `movie`:
    //   exports: [{ destinations: [{ type: "webhook", endpoint: `${PUBLIC_BASE_URL}/json2video-hook` }] }]
    // and return immediately; mark the job done when the hook fires. Cheaper and more reliable.
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 3) POST — hand the approved package + video to your Make.com scenario, which fans
//    out to the channels the operator selected.
// ============================================================
// ---- Upload-Post posting layer (replaces Make for the 5 social channels) ----
const UP_BASE = "https://api.upload-post.com/api";
// our channel id -> Upload-Post platform identifier
const UP_PLATFORM = { facebook: "facebook", instagram: "instagram", linkedin: "linkedin", youtube: "youtube", gmb: "google_business" };

// Post ONE channel via Upload-Post. Video channels -> /upload (video URL);
// Google Business -> /upload_photos, sending the image as an attached file
// (so Upload-Post never has to reach our backend, which can be asleep on the free tier).
function clip(s, n) { s = String(s || ""); const first = s.split("\n")[0]; const base = first.length >= 20 ? first : s; return base.length > n ? base.slice(0, n - 1).trimEnd() + "\u2026" : base; }

async function uploadPostOne(apikey, user, item) {
  const form = new FormData();
  form.append("user", user);
  form.append("async_upload", "true");
  try {
    let endpoint;
    if (item.channel === "gmb") {
      endpoint = `${UP_BASE}/upload_photos`;
      form.append("platform[]", "google_business");
      if (item.imageData) {
        // uploaded activity photo sent straight from the dashboard as base64 — no render, no hosting needed
        const blob = new Blob([Buffer.from(item.imageData, "base64")], { type: item.imageMediaType || "image/jpeg" });
        form.append("photos[]", blob, "post.jpg");
      } else if (item.imageUrl) {
        // fallback: download a hosted image and attach the bytes (avoids Upload-Post fetching our sleepy backend)
        const ir = await fetch(item.imageUrl);
        if (!ir.ok) throw new Error(`couldn't read image (${ir.status})`);
        const blob = new Blob([Buffer.from(await ir.arrayBuffer())], { type: ir.headers.get("content-type") || "image/jpeg" });
        form.append("photos[]", blob, "post.jpg");
      } else {
        throw new Error("no image for Google Business (upload a photo)");
      }
      form.append("title", item.text || item.title || "");
      if (item.cta && item.ctaUrl) { form.append("gbp_cta_type", item.cta); form.append("gbp_cta_url", item.ctaUrl); }
    } else {
      endpoint = `${UP_BASE}/upload`;
      form.append("platform[]", UP_PLATFORM[item.channel]);
      if (item.videoUrl) form.append("video", item.videoUrl);
      if (item.channel === "youtube") {
        form.append("title", clip(item.title || "Video", 90));            // YouTube title max 100
        if (item.description) form.append("description", item.description);
      } else if (item.channel === "facebook") {
        form.append("title", clip(item.text || item.title || "", 250));   // FB video title max 255
        form.append("description", item.text || "");                       // full caption shows as the post body
      } else {
        form.append("title", item.text || item.title || "");               // IG / LinkedIn caption
      }
    }
    const r = await fetch(endpoint, { method: "POST", headers: { Authorization: `Apikey ${apikey}` }, body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) return { channel: item.channel, ok: false, error: data.error || data.message || `HTTP ${r.status}` };
    return { channel: item.channel, ok: true, request_id: data.request_id || null };
  } catch (e) { return { channel: item.channel, ok: false, error: e.message }; }
}

app.post("/post", async (req, res) => {
  try {
    const { items, channels, package: pkg, videoUrl, imageUrl, owner } = req.body;
    const list = Array.isArray(items) ? items : [];
    const user = owner || "raagnaai";       // Upload-Post profile name = our client id

    // legacy single-payload callers (no items[]): keep old Make behaviour
    if (!list.length) {
      if (!MAKE_WEBHOOK_URL) throw new Error("No items and MAKE_WEBHOOK_URL not set");
      const r = await fetch(MAKE_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channels, package: pkg, videoUrl, imageUrl }) });
      if (!r.ok) throw new Error(`Make.com ${r.status}`);
      return res.json({ posted: channels || [] });
    }

    const upItems = list.filter(i => UP_PLATFORM[i.channel]);          // FB/IG/LinkedIn/YouTube/GMB -> Upload-Post
    const makeItems = list.filter(i => !UP_PLATFORM[i.channel]);       // blog (and anything else) -> Make for now
    const results = [];

    if (upItems.length) {
      if (!UPLOADPOST_API_KEY) throw new Error("UPLOADPOST_API_KEY not set on the server");
      for (const it of upItems) results.push(await uploadPostOne(UPLOADPOST_API_KEY, user, it));
    }
    if (makeItems.length && MAKE_WEBHOOK_URL) {
      try {
        const r = await fetch(MAKE_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: makeItems }) });
        makeItems.forEach(i => results.push({ channel: i.channel, ok: r.ok, via: "make", error: r.ok ? undefined : `Make ${r.status}` }));
      } catch (e) { makeItems.forEach(i => results.push({ channel: i.channel, ok: false, via: "make", error: e.message })); }
    } else if (makeItems.length) {
      makeItems.forEach(i => results.push({ channel: i.channel, ok: false, error: "Blog posting not configured (MAKE_WEBHOOK_URL missing)" }));
    }

    const posted = results.filter(r => r.ok).map(r => r.channel);
    if (posted.length === 0) return res.status(502).json({ error: "All channels failed", results });
    res.json({ posted, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 4) BRAIN — Gemini + ChatGPT + Claude each draft independently (in parallel),
//    then Claude synthesises one final package. The dashboard calls this whenever
//    BACKEND_URL is set; inside claude.ai with no backend it falls back to a
//    single-model Claude preview. ~4 model calls per post.
// ============================================================
const LANG_LABEL = { te: "Telugu", hi: "Hindi", en: "English" };

// Per-platform language policy: which language the VIDEO (voiceover) is in, and which
// language the TEXT (caption/description) is in. Edit any line to change the rule.
const POLICY = {
  facebook:  { video: "te", text: "te" },
  instagram: { video: "te", text: "te" },
  youtube:   { video: "te", text: "en" },
  linkedin:  { video: "en", text: "en" },
  gmb:       { video: "te", text: "te" },
  blog:      { video: "en", text: "en" },
};
const videoLangsOf = (plats) => [...new Set((plats || []).map(p => (POLICY[p] || {}).video).filter(Boolean))];

function systemPrompt(dna) {
  return `You are the marketing intelligence for Raagnaai Ads. Turn one activity (photo and/or idea) into a complete, on-strategy, multi-platform content package. You are the only strategist; the tools after you only execute.

BUSINESS DNA (ground truth, never contradict):
${dna}

Think silently then output ONLY JSON:
1. If a photo is attached, describe the ACTUAL activity (hoarding, bus wrap, wall painting, auto-top, location cues, scale) and write about THIS job, not generic copy.
2. One angle, one emotion, one CTA. Everything serves that single CTA.
3. Match each platform's native shape.

LANGUAGES — this is critical:
- You will be told which VIDEO languages to write voiceover scripts in, and which language each platform's TEXT must be in. Follow it exactly.
- Write each piece natively and conversationally in its language — never a translation, never robotic; use the borrowed English words people actually say; correct script.

VIDEO SCRIPTS: in "scripts", include ONE entry per requested video-language key (e.g. "te","en"). full_voiceover_text is ONLY spoken words (no stage directions), tight (15-40s). on_screen_text is a short overlay line in that same language.

Output ONLY this JSON (include captions/sections only for requested platforms; always strategy + scripts + image_brief):
{"strategy":{"angle":"","target_emotion":"","cta":""},"scripts":{"<langkey>":{"full_voiceover_text":"","on_screen_text":"","estimated_seconds":0}},"captions":{"facebook":{"text":"","hashtags":[]},"instagram":{"text":"","hashtags":[]},"linkedin":{"text":"","hashtags":[]}},"youtube":{"title":"","description":""},"gmb_post":{"text":"","cta_button_type":"CALL|BOOK|LEARN_MORE|ORDER"},"blog":{"title":"","body_html":"","focus_keyword":"","meta_description":"","seo_title":""},"image_brief":{"concept":"","style":""}}
Blog (SEO-ready, all fields required when blog is requested):
- focus_keyword: ONE short search phrase (2-4 words) a local customer would actually search (e.g. "auto top advertising Hyderabad"). Pick it FIRST, then build everything around it.
- body_html: valid HTML (<p>, <h2>, <strong>), no markdown, 600-750 words. The focus_keyword MUST appear in the FIRST sentence, in at least one <h2>, and naturally 3-5 times across the body. Use 2-3 <h2> subheadings. Substantive and specific to THIS activity, not padding.
- title: compelling headline that contains the focus_keyword.
- seo_title: <= 60 characters, contains the focus_keyword (this is the search-engine title; can differ slightly from title).
- meta_description: 140-156 characters, contains the focus_keyword, ends with a clear reason to click.`;
}
function synthPrompt(dna) {
  return `You are the chief editor of Raagnaai Ads' marketing brain. Several AI models each wrote an independent content package for the same brief. Produce ONE final package that is BETTER than any single draft. Do NOT average — choose the strongest strategic angle, the most natural-sounding wording in EACH language (must read like a real speaker, never translated), the sharpest hook, and the single clearest CTA, then combine the best parts. Keep the EXACT same JSON schema and the same language keys, and output ONLY JSON.

BUSINESS DNA (ground truth):
${dna}`;
}
function buildUserText(job) {
  const plats = job.input.platforms || [];
  const vlangs = (job.input.videoLangs && job.input.videoLangs.length) ? job.input.videoLangs : videoLangsOf(plats);
  const textLangOf = (p) => (job.input.chanLang && job.input.chanLang[p]) || (POLICY[p] || {}).text;
  const textLines = plats.map(p => `${p}: text in ${LANG_LABEL[textLangOf(p)] || "English"}`).join("; ");
  return `Idea: ${job.input.idea || "(work from the photo)"}\n`
    + `The idea may be spoken/typed in: ${LANG_LABEL[job.input.language] || "English"}.\n`
    + `Selected platforms: ${plats.join(", ")}.\n`
    + `Write voiceover scripts for these VIDEO languages (use these exact keys in "scripts"): ${vlangs.join(", ")} (${vlangs.map(l => LANG_LABEL[l]).join(", ")}).\n`
    + `Per-platform TEXT languages: ${textLines}.`
    + (job.feedback ? `\nCorrection requested: "${job.feedback}"\nPrevious draft: ${JSON.stringify(job.package)}` : "");
}
function parseJson(text) {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) {}
  // repair: escape raw line breaks/tabs that landed inside string values, drop trailing commas
  let out = "", inStr = false, prev = "";
  for (const ch of t) {
    if (ch === '"' && prev !== "\\") inStr = !inStr;
    if (inStr && ch === "\n") { out += "\\n"; prev = ch; continue; }
    if (inStr && ch === "\r") { out += "\\r"; prev = ch; continue; }
    if (inStr && ch === "\t") { out += "\\t"; prev = ch; continue; }
    out += ch; prev = ch;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

// Retry transient "busy / overloaded / rate-limited" replies from the AI providers
// (Gemini 503, OpenAI 429, Claude 529) a couple of times with a short backoff,
// so a momentary hiccup doesn't fail the whole post.
async function fetchRetry(url, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, opts);
    if (![429, 503, 529].includes(last.status)) return last;
    if (i < tries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return last;
}

// --- provider drafts (each returns the same JSON package) ---
async function callClaude(model, system, text, image) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
  content.push({ type: "text", text });
  const r = await fetchRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 8192, system, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return parseJson((d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"));
}
async function callOpenAI(model, system, text, image) {
  const uc = [{ type: "text", text }];
  if (image) uc.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } });
  const r = await fetchRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: uc }], response_format: { type: "json_object" }, max_completion_tokens: 8192 }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return parseJson(d.choices?.[0]?.message?.content);
}
async function callGemini(model, system, text, image) {
  const parts = [{ text }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  const r = await fetchRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GOOGLE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" } }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return parseJson((d.candidates?.[0]?.content?.parts || []).map(p => p.text).join("\n"));
}

// Three models draft in parallel, then Claude synthesises the final package.
app.post("/brain", async (req, res) => {
  try {
    const { dna, job } = req.body;
    const image = job.input.imageBase64 ? { mime: job.input.imageMediaType, data: job.input.imageBase64 } : null;
    const sys = systemPrompt(dna), ut = buildUserText(job);

    const tasks = [];
    if (ANTHROPIC_API_KEY) tasks.push(["claude", callClaude(CLAUDE_DRAFT_MODEL, sys, ut, image)]);
    if (OPENAI_API_KEY) tasks.push(["openai", callOpenAI(OPENAI_MODEL, sys, ut, image)]);
    if (GOOGLE_API_KEY) tasks.push(["gemini", callGemini(GEMINI_MODEL, sys, ut, image)]);
    if (!tasks.length) throw new Error("No model keys set (need at least one of ANTHROPIC/OPENAI/GOOGLE)");

    const settled = await Promise.allSettled(tasks.map(t => t[1]));
    const drafts = {}, ok = [];
    settled.forEach((s, i) => {
      const name = tasks[i][0];
      if (s.status === "fulfilled") { drafts[name] = s.value; ok.push(name); }
      else drafts[name] = { error: String(s.reason).slice(0, 300) };
    });
    if (!ok.length) throw new Error("All models failed: " + JSON.stringify(drafts));

    // Claude merges the successful drafts into one final (needs the Anthropic key).
    let final, synthBy = null;
    if (ANTHROPIC_API_KEY && ok.length > 1) {
      const draftText = `Original brief:\n${ut}\n\n` + ok.map((n, i) => `--- Draft ${i + 1} (${n}) ---\n${JSON.stringify(drafts[n])}`).join("\n\n");
      final = await callClaude(CLAUDE_SYNTH_MODEL, synthPrompt(dna), draftText, null);
      synthBy = CLAUDE_SYNTH_MODEL;
      final._meta = { models: ok, synthesizedBy: synthBy, drafts };
    } else {
      final = { ...drafts[ok[0]] }; // single model — clone so we never reference ourselves
      final._meta = { models: ok, synthesizedBy: null };
    }
    res.json(final);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ---------- shared post list (cross-device sync) ----------
// owner = a workspace id so multiple teammates share one list (and a future SaaS can
// keep different customers' posts separate). Defaults to "raagnaai".
const ownerOf = (req) => (req.query.owner || req.body?.owner || "raagnaai").toString().slice(0, 80);

// List every post for this workspace, newest first.
app.get("/posts", async (req, res) => {
  const coll = await postsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const docs = await coll.find({ owner: ownerOf(req) }).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(docs.map(({ _id, ...rest }) => rest)); // hide internal _id
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or update one post (upsert by owner+id).
app.put("/posts/:id", async (req, res) => {
  const coll = await postsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const owner = ownerOf(req);
    const id = req.params.id;
    const job = req.body?.job || req.body;
    if (!job || typeof job !== "object") return res.status(400).json({ error: "Missing post body" });
    const doc = { ...job, id, owner, updatedAt: Date.now() };
    delete doc._id;
    await coll.updateOne({ owner, id }, { $set: doc }, { upsert: true });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete one post.
app.delete("/posts/:id", async (req, res) => {
  const coll = await postsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    await coll.deleteOne({ owner: ownerOf(req), id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- shared settings (brand profile across devices) ----------
// Stores the team's shared brand settings (logo, voice id, Business DNA). The Backend URL
// and simulate flag are intentionally kept device-local by the dashboard, not stored here.
app.get("/settings", async (req, res) => {
  const coll = await settingsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const doc = await coll.findOne({ owner: ownerOf(req) });
    if (!doc) return res.json({});
    const { _id, owner, ...rest } = doc;
    res.json(rest);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/settings", async (req, res) => {
  const coll = await settingsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const owner = ownerOf(req);
    const settings = req.body?.settings || req.body || {};
    const doc = { ...settings, owner, updatedAt: Date.now() };
    delete doc._id;
    await coll.updateOne({ owner }, { $set: doc }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- client roster (multi-tenant) ----------
// The operator's list of clients/workspaces. Each client's posts & settings are already
// isolated by `owner` elsewhere; this just stores the roster so it syncs across devices.
// Single roster ("default") for now; becomes per-operator-account when self-serve auth lands.
app.get("/clients", async (req, res) => {
  const coll = await clientsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const roster = String(req.query.roster || "default");
    const doc = await coll.findOne({ roster });
    res.json({ clients: (doc && Array.isArray(doc.clients)) ? doc.clients : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/clients", async (req, res) => {
  const coll = await clientsCollection();
  if (!coll) return res.status(503).json({ error: "Shared storage is not configured (MONGODB_URI missing or unreachable)." });
  try {
    const roster = String(req.query.roster || req.body?.roster || "default");
    const clients = Array.isArray(req.body?.clients) ? req.body.clients : [];
    await coll.updateOne({ roster }, { $set: { roster, clients, updatedAt: Date.now() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Raagnaai backend on ${PUBLIC_BASE_URL}`));
