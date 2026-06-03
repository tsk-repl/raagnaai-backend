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

// ---------- keys & config (env only — never hard-code) ----------
const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`; // must be PUBLIC for JSON2Video to fetch media
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2"; // best Telugu/Hindi quality
const JSON2VIDEO_API_KEY = process.env.JSON2VIDEO_API_KEY;
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "instagram-story";          // vertical 1080x1920; change as needed
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;       // Make.com scenario that fans out to FB/IG/LinkedIn/YT/GMB/Blog
// ---- brain: three models draft, Claude synthesises the final ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;    // Claude (draft + final synthesis)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;          // ChatGPT draft
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;          // Gemini draft
// Model IDs drift fast — confirm the exact current strings in each provider's console.
const CLAUDE_DRAFT_MODEL = process.env.CLAUDE_DRAFT_MODEL || "claude-sonnet-4-6";
const CLAUDE_SYNTH_MODEL = process.env.CLAUDE_SYNTH_MODEL || "claude-opus-4-8"; // does the final merge
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

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
    const { audioUrl, imageBrief, imageBase64, visualHint, logoBase64, logoMediaType, voiceId, language } = req.body;
    if (!JSON2VIDEO_API_KEY) throw new Error("JSON2VIDEO_API_KEY not set");
    if (!audioUrl) throw new Error("No approved audioUrl");

    // host the operator's activity photo so JSON2Video can fetch it (needs a URL, not base64)
    let imageUrl = null, resolution = VIDEO_RESOLUTION;
    if (imageBase64) {
      const buf = Buffer.from(imageBase64, "base64");
      imageUrl = saveMedia(buf, "jpg");
      // match the video shape to the photo so there are no black bars
      const dims = imageDims(buf);
      if (dims) resolution = dims.w > dims.h * 1.15 ? "full-hd"
        : dims.h > dims.w * 1.15 ? "instagram-story" : "squared";
    }

    const elements = [];
    // resize:cover fills the frame; zoom gives a slow Ken-Burns motion so one photo isn't static
    if (imageUrl) elements.push({ type: "image", src: imageUrl, duration: -2, resize: "cover", zoom: 2 });
    elements.push({ type: "audio", src: audioUrl, duration: -1 });                  // sets the scene length
    if (imageBrief?.on_screen_text)                                                 // optional overlay
      elements.push({ type: "text", text: imageBrief.on_screen_text, duration: -2, position: "bottom-center", style: "005" });

    // branded end card — your uploaded logo if provided, otherwise a text card,
    // with a spoken brand tagline over it (in the post's language, your cloned voice)
    const dimMap = { "full-hd": [1920, 1080], "instagram-story": [1080, 1920], "squared": [1080, 1080] };
    const [W, H] = dimMap[resolution] || [1920, 1080];

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
    if (taglineUrl) outroEls.push({ type: "audio", src: taglineUrl, duration: -1 });
    const outroScene = taglineUrl
      ? { "background-color": outroBg, elements: outroEls }          // length follows the spoken tagline
      : { "background-color": outroBg, duration: 2.6, elements: outroEls };

    const movie = { resolution, quality: "high", scenes: [{ elements }, outroScene] };

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
    for (let i = 0; i < 60; i++) {           // ~5 min max at 5s intervals
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
    res.json({ videoUrl, imageUrl });
    // PRODUCTION TIP: instead of polling, add to `movie`:
    //   exports: [{ destinations: [{ type: "webhook", endpoint: `${PUBLIC_BASE_URL}/json2video-hook` }] }]
    // and return immediately; mark the job done when the hook fires. Cheaper and more reliable.
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 3) POST — hand the approved package + video to your Make.com scenario, which fans
//    out to the channels the operator selected.
// ============================================================
app.post("/post", async (req, res) => {
  try {
    const { channels, package: pkg, videoUrl, imageUrl } = req.body;
    if (!MAKE_WEBHOOK_URL) throw new Error("MAKE_WEBHOOK_URL not set");
    const r = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels, package: pkg, videoUrl, imageUrl }),
    });
    if (!r.ok) throw new Error(`Make.com ${r.status}`);
    res.json({ posted: channels });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 4) BRAIN — Gemini + ChatGPT + Claude each draft independently (in parallel),
//    then Claude synthesises one final package. The dashboard calls this whenever
//    BACKEND_URL is set; inside claude.ai with no backend it falls back to a
//    single-model Claude preview. ~4 model calls per post.
// ============================================================
const LANG_LABEL = { te: "Telugu", hi: "Hindi", en: "English" };
function systemPrompt(dna) {
  return `You are the marketing intelligence for Raagnaai Ads. Turn one activity (photo and/or idea) into a complete, on-strategy, multi-platform content package. You are the only strategist; the tools after you only execute.

BUSINESS DNA (ground truth, never contradict):
${dna}

Think silently then output ONLY JSON:
1. If a photo is attached, describe the ACTUAL activity (hoarding, bus wrap, wall painting, auto-top, location cues, scale) and write about THIS job, not generic copy.
2. One angle, one emotion, one CTA. Everything serves that single CTA.
3. Match each platform's native shape.
Language: write natively and conversationally in the requested language — never a translation, never robotic; use the borrowed English words people actually say; correct script.
Video: full_voiceover_text is ONLY spoken words (no stage directions). Tight, 15-40s.
Output ONLY this JSON (captions only for requested platforms; always strategy, video_script, image_brief):
{"language":"","activity_seen":"","strategy":{"angle":"","target_emotion":"","cta":""},"captions":{"facebook":{"text":"","hashtags":[]},"instagram":{"text":"","hashtags":[]},"linkedin":{"text":"","hashtags":[]}},"video_script":{"hook":"","body":"","cta":"","full_voiceover_text":"","estimated_seconds":0},"youtube":{"title":"","description":""},"gmb_post":{"text":"","cta_button_type":"CALL|BOOK|LEARN_MORE|ORDER"},"blog":{"title":"","body_html":""},"image_brief":{"concept":"","on_screen_text":"","style":""}}
Blog: body_html must be valid HTML (<p>, <h2>, <strong>), no markdown, ~130 words.`;
}
function synthPrompt(dna, language) {
  return `You are the chief editor of Raagnaai Ads' marketing brain. Several AI models each wrote an independent content package for the same brief. Produce ONE final package that is BETTER than any single draft. Do NOT average — choose the strongest strategic angle, the most natural-sounding ${LANG_LABEL[language]} (must read like a real speaker, never translated), the sharpest hook, and the single clearest CTA, then combine the best parts. Keep the EXACT same JSON schema and output ONLY JSON.

BUSINESS DNA (ground truth):
${dna}`;
}
function buildUserText(job) {
  return `Idea: ${job.input.idea || "(work from the photo)"}\nPlatforms: ${job.input.platforms.join(", ")}\nLanguage: ${LANG_LABEL[job.input.language]} (${job.input.language})` +
    (job.feedback ? `\nCorrection requested: "${job.feedback}"\nPrevious draft: ${JSON.stringify(job.package)}` : "");
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

// --- provider drafts (each returns the same JSON package) ---
async function callClaude(model, system, text, image) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
  content.push({ type: "text", text });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
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
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
      final = await callClaude(CLAUDE_SYNTH_MODEL, synthPrompt(dna, job.input.language), draftText, null);
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
app.listen(PORT, () => console.log(`Raagnaai backend on ${PUBLIC_BASE_URL}`));
