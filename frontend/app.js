const $ = (id) => document.getElementById(id);

/** Parse FastAPI / fetch error payloads into a user-facing string. */
function apiDetail(data, fallback = "Request failed") {
  if (!data) return fallback;
  const d = data.detail ?? data.message;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d) && d.length) {
    return d.map((x) => x.msg || x.message || String(x)).join("; ");
  }
  return fallback;
}

let selectedFile = null;
let topicPlanId = null;
let topicPlanData = null;
let topicSelected = new Set();

let selectedVoiceId = null; // id of a saved library voice applied to the whole video
let selectedVoicePreset = null; // Kokoro preset when Kokoro engine is selected
let selectedPocketVoice = "jane"; // Pocket catalog id (default: Jane)
let voicePresets = [];
let pocketPresets = [];
let pocketAvailable = false;
let voiceEngine = "pocket"; // pocket | kokoro | clones — Pocket is tab 1
let voiceFilter = "all"; // all | female | male (Kokoro gender filter)
let pocketFilter = "all";
try {
  const ve = localStorage.getItem("mms_voice_engine");
  if (ve === "kokoro" || ve === "clones" || ve === "pocket") voiceEngine = ve;
} catch (e) {}
let pendingVoiceFile = null; // staged clone JSON before saving to the library
let pendingVoiceRecordingBlob = null; // staged mic recording before saving
let voiceAddMode = "record"; // record | upload
let pendingPocketFile = null;
let pendingPocketRecordingBlob = null;
let pocketAddMode = "record";
let pocketLibRecorder = null;
let cloneRecordingText = "";
let voiceLibRecorder = null; // { rec, stream, chunks }
let voiceLibrary = [];
let voiceLimit = 0;
let manageVoiceId = null; // recording-only voice being previewed / set up (not used for narration)
const VOICE_SEL_KEY = "mms_selected_voice";
let publishOn = false;
let jobId = null;
let evtSource = null;
let lastJob = null;
let cacheBust = 0;

// Append a cache-busting token so regenerated files aren't served stale.
function bust(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url; // external (e.g. YouTube) links
  return url + (url.includes("?") ? "&" : "?") + "v=" + (cacheBust || Date.now());
}

// Video format state.
let videoFormats = [];
let selectedFormat = "youtube_video";
let selectedDuration = 480; // 8 min — matches cron default

// Video theme (color palette) state.
let videoThemes = [];
let selectedTheme = "snow";
let themeWasAuto = false;

// Visual style (typography / density) state.
let videoStyles = [];
let selectedStyle = "whiteboard"; // Teach · board
let styleWasAuto = false;

// Unified Visual style presets (layout + color — single picker for Studio + Admin).
let visualPresets = [];
let styleCategories = [];
let selectedPreset = "whiteboard:snow";
let visualStyleFilter = "featured"; // featured | all | auto | <category key>
let adminVisualStyleFilter = "featured";
let adminPreviewTheme = "snow";
let adminPreviewPreset = "whiteboard:snow";
let adminPreviewStyle = "whiteboard";
const VISUAL_SEL_KEY = "mms_visual_preset";
const DEFAULT_STUDIO_DURATION = 480;
const DEFAULT_STUDIO_PRESET = "whiteboard:snow";
// Featured order: keep teach classics (incl. whiteboard) near the top.
const FEATURED_STYLE_ORDER = [
  "auto", "whiteboard", "hybrid", "hybrid_kinetic", "hybrid_data", "hybrid_story",
  "swiss_pulse", "velvet_std", "maximalist", "data_drift", "soft_signal",
  "folk_freq", "shadow_cut", "deconstructed",
  "kinetic_center", "lower_third", "promo_sprint", "caption_pop", "chart_race", "logo_intro",
  "bento", "big_stat", "quote_pull", "timeline_rail", "split_media", "proof_duo", "kpi_strip", "stack_cards",
  "geo_navy", "coral_split", "mosaic", "process", "wave_soft", "agenda", "rainbow_bar",
  "gamma", "keynote", "slides", "explainer", "tutorial",
  "notion", "pitch", "corporate", "saas", "cards", "modern", "minimal",
  "glass", "editorial", "bold", "documentary", "teardown", "cinematic",
  "neon", "blueprint", "playful", "terminal", "kinetic", "dataviz",
  "device", "broadcast", "blush_soft", "circle_stack", "hex_grid",
];
const STYLE_CATEGORY_KEYS = new Set([
  "hybrid", "motion", "decks", "ppt", "modern_ppt", "hyper", "content", "teach", "story", "tech",
]);

const FORMAT_ICONS = {
  youtube_video: "youtube",
  youtube_shorts: "smartphone",
  instagram_reels: "instagram",
  tiktok: "music-2",
  instagram_square: "square",
  linkedin_video: "linkedin",
};

const FALLBACK_VIDEO_FORMATS = [
  {
    key: "youtube_video", label: "YouTube Video", aspect_ratio: "16:9",
    orientation: "landscape",
    description: "Standard 16:9 landscape video for full YouTube uploads.",
    duration_options: [0, 60, 180, 300, 480, 600, 900, 1200, 1800, 3600],
    recommended_duration: 480,
  },
  {
    key: "youtube_shorts", label: "YouTube Shorts", aspect_ratio: "9:16",
    orientation: "vertical",
    description: "Vertical 9:16 short-form lesson.",
    duration_options: [0, 15, 30, 45, 60, 90, 120, 180],
    recommended_duration: 60,
  },
  {
    key: "instagram_reels", label: "Instagram Reels", aspect_ratio: "9:16",
    orientation: "vertical",
    description: "Vertical 9:16 Reels export with punchy pacing.",
    duration_options: [0, 15, 30, 45, 60, 90, 120, 180],
    recommended_duration: 60,
  },
  {
    key: "tiktok", label: "TikTok", aspect_ratio: "9:16",
    orientation: "vertical",
    description: "Vertical 9:16 TikTok video — fast hook, mobile-first.",
    duration_options: [0, 15, 30, 45, 60, 90, 180, 300],
    recommended_duration: 45,
  },
  {
    key: "instagram_square", label: "Square (1:1)", aspect_ratio: "1:1",
    orientation: "square",
    description: "Square 1:1 feed video for Instagram/Facebook.",
    duration_options: [0, 30, 45, 60, 90, 120, 180, 300],
    recommended_duration: 60,
  },
  {
    key: "linkedin_video", label: "LinkedIn Video", aspect_ratio: "16:9",
    orientation: "landscape",
    description: "Landscape 16:9 video tuned for a professional LinkedIn audience.",
    duration_options: [0, 60, 120, 180, 300, 600],
    recommended_duration: 120,
  },
];

// Lucide icon name per stage status.
const STAGE_ICONS = {
  pending: "circle",
  running: "",
  done: "check",
  skipped: "minus",
  error: "triangle-alert",
};

// Map pipeline stage key -> flowstrip node index.
const STAGE_TO_NODE = { extract: 1, generate: 2, narrate: 3, capture: 4, merge: 4, publish_meta: 5, publish: 5 };

const STAGE_EDITORS = {
  extract: { key: "extracted_text", label: "Extracted content (edit, then regenerate downstream)" },
  narrate: { key: "narration", label: "Narration script (edit, then re-narrate)" },
};

const AUDIENCE_SEL_KEY = "mms_audience";
let audienceCatalog = { age_groups: [], knowledge_levels: [], prompts: {}, default_prompt: "" };
let audiencePromptDirty = false;
let audienceInferTimer = null;

function audiencePromptKey(age, knowledge) {
  return `${age || "auto"}:${knowledge || "auto"}`;
}

function currentAgeGroup() {
  return $("age-group")?.value || "auto";
}

function currentKnowledgeLevel() {
  return $("knowledge-level")?.value || "auto";
}

function currentCustomPrompt() {
  return ($("custom-prompt")?.value || "").trim();
}

function currentReviewNotes() {
  return ($("review-notes")?.value || "").trim();
}

function loadedAudiencePrompt(age, knowledge) {
  const prompts = audienceCatalog.prompts || {};
  return prompts[audiencePromptKey(age, knowledge)]
    || audienceCatalog.default_prompt
    || "";
}

function applyAudienceFromJob(job) {
  const o = (job && job.options) || {};
  if (o.age_group && $("age-group")) $("age-group").value = o.age_group;
  if (o.knowledge_level && $("knowledge-level")) $("knowledge-level").value = o.knowledge_level;
  if (o.review_notes && $("review-notes")) $("review-notes").value = o.review_notes;
  if (o.custom_prompt && $("custom-prompt")) {
    $("custom-prompt").value = o.custom_prompt;
    const loaded = loadedAudiencePrompt(o.age_group || "auto", o.knowledge_level || "auto");
    audiencePromptDirty = o.custom_prompt.trim() !== (loaded || "").trim();
  }
  updateAudienceHint();
}

function persistAudience() {
  try {
    localStorage.setItem(AUDIENCE_SEL_KEY, JSON.stringify({
      age_group: currentAgeGroup(),
      knowledge_level: currentKnowledgeLevel(),
      custom_prompt: currentCustomPrompt(),
      dirty: audiencePromptDirty,
      review_notes: currentReviewNotes(),
    }));
  } catch (e) { /* ignore */ }
}

function inferAudienceFromPrompt(text) {
  const blob = (text || "").toLowerCase();
  let age = "auto";
  let knowledge = "auto";
  const ageHints = [
    ["kids", ["kids", "children", "5–8", "5-8", "young children"]],
    ["tweens", ["tweens", "9–12", "9-12", "middle school"]],
    ["teens", ["teen", "13–17", "13-17", "high school"]],
    ["young_adults", ["young adult", "18–24", "18-24", "college"]],
    ["professionals", ["professional", "practitioner", "monday"]],
    ["all_ages", ["all ages", "family", "mixed-age", "mixed age"]],
    ["adults", ["adult learners", "busy adult"]],
  ];
  for (const [key, words] of ageHints) {
    if (words.some((w) => blob.includes(w))) { age = key; break; }
  }
  const knowHints = [
    ["beginner", ["beginner", "zero prior", "first principles", "101"]],
    ["intermediate", ["intermediate", "some background"]],
    ["advanced", ["advanced learners", "skip 101", "failure modes"]],
    ["expert", ["expert-to-expert", "expert", "no hand-holding"]],
  ];
  for (const [key, words] of knowHints) {
    if (words.some((w) => blob.includes(w))) { knowledge = key; break; }
  }
  return { age_group: age, knowledge_level: knowledge };
}

function applyLoadedPrompt({ force = false } = {}) {
  const ta = $("custom-prompt");
  if (!ta) return;
  if (audiencePromptDirty && !force) return;
  ta.value = loadedAudiencePrompt(currentAgeGroup(), currentKnowledgeLevel());
  audiencePromptDirty = false;
  const meta = $("custom-prompt-meta");
  if (meta) {
    meta.textContent = "Prompt loaded for this age group + knowledge. Edit to customize — we keep your version.";
  }
  persistAudience();
}

function updateAudienceHint() {
  const hint = $("audience-hint");
  if (!hint) return;
  const age = ($("age-group")?.selectedOptions[0]?.text || "Auto").split("—")[0].trim();
  const know = ($("knowledge-level")?.selectedOptions[0]?.text || "Auto").split("—")[0].trim();
  hint.textContent = `${age} · ${know}`;
}

function onAudienceSelectChange() {
  audiencePromptDirty = false;
  applyLoadedPrompt({ force: true });
  updateAudienceHint();
}

function onCustomPromptInput() {
  audiencePromptDirty = true;
  const meta = $("custom-prompt-meta");
  if (meta) meta.textContent = "Using your edited prompt. Age/knowledge still apply. Reload to restore the template.";
  persistAudience();
  clearTimeout(audienceInferTimer);
  audienceInferTimer = setTimeout(() => {
    const inferred = inferAudienceFromPrompt(currentCustomPrompt());
    const ageEl = $("age-group");
    const knowEl = $("knowledge-level");
    if (ageEl && inferred.age_group !== "auto" && ageEl.value === "auto") {
      ageEl.value = inferred.age_group;
    }
    if (knowEl && inferred.knowledge_level !== "auto" && knowEl.value === "auto") {
      knowEl.value = inferred.knowledge_level;
    }
  }, 400);
}

async function loadAudienceCatalog() {
  try {
    audienceCatalog = await (await fetch("/api/audience")).json();
  } catch (e) {
    audienceCatalog = { age_groups: [], knowledge_levels: [], prompts: {}, default_prompt: "" };
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(AUDIENCE_SEL_KEY) || "null"); } catch (e) { saved = null; }
  if (saved?.age_group && $("age-group")) $("age-group").value = saved.age_group;
  if (saved?.knowledge_level && $("knowledge-level")) $("knowledge-level").value = saved.knowledge_level;
  if (saved?.review_notes && $("review-notes")) $("review-notes").value = saved.review_notes;
  if (saved?.dirty && saved.custom_prompt) {
    audiencePromptDirty = true;
    if ($("custom-prompt")) $("custom-prompt").value = saved.custom_prompt;
  } else {
    applyLoadedPrompt({ force: true });
  }
  updateAudienceHint();
}

function audienceJobFields() {
  return {
    age_group: currentAgeGroup(),
    knowledge_level: currentKnowledgeLevel(),
    custom_prompt: currentCustomPrompt(),
    review_notes: currentReviewNotes(),
  };
}

function initAudience() {
  $("age-group")?.addEventListener("change", onAudienceSelectChange);
  $("knowledge-level")?.addEventListener("change", onAudienceSelectChange);
  $("custom-prompt")?.addEventListener("input", onCustomPromptInput);
  $("custom-prompt-reset")?.addEventListener("click", () => {
    audiencePromptDirty = false;
    applyLoadedPrompt({ force: true });
  });
  $("review-run-btn")?.addEventListener("click", runContentReview);
  $("review-notes")?.addEventListener("input", persistAudience);
  loadAudienceCatalog();
}

function reviewKindLabel(kind) {
  const map = {
    duplicate_heading: "Duplicate heading",
    duplicate_visual: "Duplicate slide",
    duplicate_narration: "Duplicate voiceover",
    repeat_layout: "Repeated layout",
    empty_narration: "Missing voiceover",
    narration_too_short: "Voice too short",
    narration_too_long: "Voice too long",
    voice_visual_mismatch: "Voice / slide mismatch",
    voice_too_fast_for_highlights: "Voice vs highlights",
    voice_order: "Voice order",
    empty: "Empty deck",
  };
  return map[kind] || kind.replace(/_/g, " ");
}

function renderContentReview(job) {
  const card = $("review-card");
  if (!card) return false;
  const slides = (job && job.content && job.content.slides) || [];
  const review = (job && job.content && job.content.content_review) || null;
  if (!slides.length && !review) {
    card.classList.add("hidden");
    return false;
  }
  card.classList.remove("hidden");
  const summary = $("review-summary");
  const scoreEl = $("review-score");
  const wrap = $("review-issues");
  const summaryText = review?.summary || (slides.length
    ? `${slides.length} slides ready — run Review to check duplicates and voice sync.`
    : "Generate slides to review them.");
  if (summary && summary.textContent !== summaryText) summary.textContent = summaryText;
  if (scoreEl) {
    if (review && Number.isFinite(review.score)) {
      const next = `Score ${review.score}`;
      if (scoreEl.textContent !== next) scoreEl.textContent = next;
      scoreEl.className = "card-desc " + (review.ok ? "review-score-ok" : "review-score-warn");
    } else {
      if (scoreEl.textContent) scoreEl.textContent = "";
      scoreEl.className = "card-desc";
    }
  }
  if (!wrap) return false;
  const issues = review?.issues || [];
  let html = "";
  if (!issues.length) {
    html = review ? `<p class="review-empty">No duplicate slides or voice-sync issues found.</p>` : "";
  } else {
    html = issues.map((iss) => {
      const sev = iss.severity || "info";
      const icon = sev === "error" ? "circle-alert" : (sev === "warning" ? "triangle-alert" : "info");
      return `<div class="review-issue ${escapeHtml(sev)}">
      <i data-lucide="${icon}"></i>
      <div>
        <div class="review-kind">${escapeHtml(reviewKindLabel(iss.kind))}${iss.slide ? ` · slide ${iss.slide}` : ""}</div>
        <div>${escapeHtml(iss.message || "")}</div>
      </div>
    </div>`;
    }).join("");
  }
  return setStableHtml(wrap, html);
}

async function runContentReview() {
  if (!jobId) {
    showAlert("Run the pipeline first so there are slides to review.");
    return;
  }
  const btn = $("review-run-btn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Reviewing…'; }
  persistAudience();
  try {
    const narr = document.querySelector('.editor[data-field="narration"]')?.value;
    const res = await fetch(`/api/jobs/${jobId}/review-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notes: currentReviewNotes(),
        narration: narr || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Review failed"));
    if (lastJob) {
      lastJob.content = lastJob.content || {};
      lastJob.content.content_review = data.review;
      renderContentReview(lastJob);
      icons();
    }
  } catch (e) {
    showAlert(e.message || "Review failed");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; icons(); }
  }
}

// Re-render Lucide icons after any DOM mutation that adds [data-lucide].
function icons() { if (window.lucide) window.lucide.createIcons(); }

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = str ?? ""; return d.innerHTML; }

function formatDuration(sec) {
  if (!sec) return "Auto";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m && s) return `${m}m ${s}s`;
  if (m) return `${m} min`;
  return `${s}s`;
}

// ----------------------------------------------------------- video formats ----

async function loadVideoFormats() {
  try {
    const res = await fetch("/api/video-formats");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `formats ${res.status}`);
    videoFormats = data.formats || [];
    videoThemes = data.themes || [];
    videoStyles = data.styles || [];
    visualPresets = data.visual_presets || [];
    styleCategories = data.style_categories || [];
  } catch (e) {
    videoFormats = [];
    videoThemes = [];
    videoStyles = [];
    visualPresets = [];
    styleCategories = [];
  }
  if (!videoFormats.length) {
    videoFormats = FALLBACK_VIDEO_FORMATS.map((f) => ({ ...f }));
  }
  if (!videoThemes.length) {
    videoThemes = [
      { key: "auto", label: "Auto", description: "Picks a color theme from content.",
        swatch: ["#6366f1", "#22d3ee", "#34d399"], dark: true },
      { key: "aurora", label: "Aurora (Dark)", description: "Dark node-graph aesthetic.",
        swatch: ["#a855f7", "#38bdf8", "#34d399"], dark: true },
    ];
  }
  if (!videoThemes.some((t) => t.key === "auto")) {
    videoThemes = [{
      key: "auto", label: "Auto",
      description: "Picks a color theme from document type and visual style.",
      swatch: ["#6366f1", "#22d3ee", "#34d399"], dark: true,
    }, ...videoThemes];
  }
  if (!videoStyles.length) {
    videoStyles = [
      { key: "auto", label: "Auto", description: "Picks the best template from content.",
        example: "Smart match", template: "Analyze → apply" },
      { key: "hybrid", label: "Hybrid", description: "Mix of all templates — rotate layouts by content format.",
        example: "Long-form channel video", template: "Hook → teach → evidence → close" },
      { key: "modern", label: "Modern", description: "Balanced, contemporary look.",
        example: "Tech explainer", template: "Title → bullets → diagram" },
    ];
  }
  // Prefer Auto first if the API somehow omitted it.
  if (!videoStyles.some((s) => s.key === "auto")) {
    videoStyles = [{
      key: "auto", label: "Auto",
      description: "Picks the best visual template from the document type, topic, and format.",
      example: "Smart match · from content", template: "Analyze → score styles → apply arc",
    }, ...videoStyles];
  }
  if (!visualPresets.length) {
    visualPresets = [{
      key: "auto", label: "Auto", style: "auto", theme: "auto",
      description: "Smart match — layout and colors from your document.",
      swatch: ["#6366f1", "#22d3ee", "#34d399"],
      style_label: "Auto", theme_label: "Auto", featured: true,
    }];
  }
  if (!styleCategories.length) {
    styleCategories = [
      { key: "hybrid", label: "Hybrid packs" },
      { key: "motion", label: "Motion · Remotion" },
      { key: "decks", label: "Decks · cards" },
      { key: "ppt", label: "PPT · Gamma" },
      { key: "modern_ppt", label: "Modern · PPT" },
      { key: "hyper", label: "Hyper · design" },
      { key: "content", label: "Content · layouts" },
      { key: "teach", label: "Teach · board" },
      { key: "story", label: "Story · film" },
      { key: "tech", label: "Tech · systems" },
    ];
  }
  restoreVisualSelection();
  renderFormats();
  renderThemes();
  renderStyles();
  renderVisualPresets();
  if (adminPanel === "visual") renderAdminVisualStyles();
  // Default to the first format; Studio default length is 8 min (cron-aligned).
  if (!jobId) {
    selectFormat(selectedFormat || videoFormats[0].key, { preserveDuration: true });
    // Studio default target length is 8 min when the format offers it.
    const optsDur = (currentFormat().duration_options || [0]);
    if (optsDur.includes(DEFAULT_STUDIO_DURATION)) {
      selectedDuration = DEFAULT_STUDIO_DURATION;
    } else if (selectedDuration == null || selectedDuration === undefined) {
      selectedDuration = DEFAULT_STUDIO_DURATION;
    }
    renderDurationChips();
  } else {
    selectFormat(selectedFormat || videoFormats[0].key, { preserveDuration: true });
  }
  const presetKey = selectedPreset || DEFAULT_STUDIO_PRESET;
  if ((visualPresets || []).some((p) => p.key === presetKey)) {
    selectVisualPreset(presetKey);
  } else if ((visualPresets || []).some((p) => p.style === "whiteboard" && p.theme === "snow")) {
    selectVisualPreset("whiteboard:snow");
  } else {
    selectVisualPreset(selectedPreset || "auto");
  }
  // Formats load races session restore — re-apply resolved Auto labels if a job is open.
  if (lastJob) {
    applyResolvedVisualFromJob(lastJob);
  }
}

function visualStyleFilterChips(activeFilter) {
  const cats = (styleCategories && styleCategories.length)
    ? styleCategories
    : [
        { key: "teach", label: "Teach" },
        { key: "motion", label: "Motion" },
        { key: "hyper", label: "HyperFrames" },
        { key: "decks", label: "Decks" },
        { key: "story", label: "Story" },
        { key: "data", label: "Data" },
        { key: "systems", label: "Code" },
      ];
  const chips = [
    { key: "featured", label: "Featured" },
    { key: "auto", label: "Auto only" },
    ...cats,
    { key: "all", label: "All layouts" },
  ];
  return chips.map((c) =>
    `<button type="button" class="vs-filter-chip${c.key === activeFilter ? " active" : ""}" data-vs-filter="${escapeHtml(c.key)}" role="tab" aria-selected="${c.key === activeFilter ? "true" : "false"}">${escapeHtml(c.label)}</button>`
  ).join("");
}

function styleCategoryOf(styleKey) {
  const s = (videoStyles || []).find((x) => x.key === styleKey);
  if (s && s.category) return s.category;
  const p = (visualPresets || []).find((x) => x.style === styleKey && x.category);
  return (p && p.category) || "";
}

function _uniqueLayouts(presets) {
  const byStyle = new Map();
  for (const p of presets) {
    const sk = p.key === "auto" ? "auto" : (p.style || p.key);
    if (sk === "auto") {
      if (!byStyle.has("auto")) byStyle.set("auto", p);
      continue;
    }
    if (sk === selectedStyle && selectedTheme && selectedTheme !== "auto") {
      const cur = (visualPresets || []).find(
        (x) => x.style === sk && x.theme === selectedTheme,
      );
      if (cur) {
        byStyle.set(sk, cur);
        continue;
      }
    }
    if (!byStyle.has(sk)) byStyle.set(sk, p);
  }
  const uniq = [...byStyle.values()];
  const rank = (p) => {
    const sk = p.key === "auto" ? "auto" : (p.style || "");
    const i = FEATURED_STYLE_ORDER.indexOf(sk);
    return i >= 0 ? i : 200;
  };
  uniq.sort((a, b) => rank(a) - rank(b));
  return uniq;
}

/** On-the-fly color picker — keeps the current layout, swaps palette only. */
function renderVisualColorStrip(swatchId, stripId) {
  const strip = $(stripId);
  const host = $(swatchId);
  if (!strip || !host) return;
  const styleKey = (selectedStyle && selectedStyle !== "auto")
    ? selectedStyle
    : (adminPreviewStyle && adminPreviewStyle !== "auto" ? adminPreviewStyle : "");
  if (!styleKey) {
    strip.hidden = true;
    host.innerHTML = "";
    return;
  }
  strip.hidden = false;
  const themesForStyle = (visualPresets || []).filter((p) => p.style === styleKey);
  // Fall back to global theme list if presets haven't loaded a cross-product yet.
  const themes = themesForStyle.length
    ? themesForStyle
    : (videoThemes || []).filter((t) => t.key !== "auto").map((t) => ({
        key: `${styleKey}:${t.key}`,
        style: styleKey,
        theme: t.key,
        theme_label: t.label,
        swatch: t.swatch || [],
        dark: t.dark,
      }));
  const activeTheme = (selectedStyle === styleKey ? selectedTheme : adminPreviewTheme) || "";
  host.innerHTML = "";
  themes.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "visual-color-chip" + (p.theme === activeTheme ? " active" : "");
    btn.title = p.theme_label || p.theme;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", p.theme === activeTheme ? "true" : "false");
    const dots = (p.swatch || []).slice(0, 3).map((c) =>
      `<i style="background:${escapeHtml(c)}"></i>`
    ).join("");
    btn.innerHTML =
      `<span class="visual-color-dots">${dots}</span>` +
      `<span class="visual-color-name">${escapeHtml(p.theme_label || p.theme)}</span>`;
    btn.addEventListener("click", () => selectColorOnFly(styleKey, p.theme));
    host.appendChild(btn);
  });
  icons();
}

function selectColorOnFly(styleKey, themeKey) {
  const key = `${styleKey}:${themeKey}`;
  if ((visualPresets || []).some((p) => p.key === key)) {
    selectVisualPreset(key);
  } else {
    // Defensive: set pieces even if preset list is incomplete.
    selectedStyle = styleKey;
    selectedTheme = themeKey;
    selectedPreset = key;
    styleWasAuto = false;
    themeWasAuto = false;
    adminPreviewStyle = styleKey;
    adminPreviewTheme = themeKey;
    adminPreviewPreset = key;
    persistVisualSelection();
  }
  renderVisualColorStrip("visual-color-swatches", "visual-color-strip");
  renderVisualColorStrip("admin-visual-color-swatches", "admin-visual-color-strip");
  if (typeof adminPanel !== "undefined" && adminPanel === "visual") {
    renderAdminSlidePreview();
  }
  updateVisualDesignHint();
}

function setVisualStyleFilter(f) {
  // Studio + Admin always share the same chip — never remap Auto → Featured.
  const next = f || "featured";
  visualStyleFilter = next;
  adminVisualStyleFilter = next;
}

function filterVisualPresets(filter) {
  const list = visualPresets || [];
  if (filter === "auto") {
    // Distinct from Featured: only the Smart Auto card.
    return list.filter((p) => p.key === "auto");
  }
  if (filter === "featured") {
    // Curated shortlist (not every layout) + Auto — same on Studio and Admin.
    const curatedKeys = new Set(
      FEATURED_STYLE_ORDER.filter((k) => k && k !== "auto").slice(0, 32),
    );
    const featured = list.filter(
      (p) => p.key === "auto"
        || (p.featured && curatedKeys.has(p.style)),
    );
    return _uniqueLayouts(featured);
  }
  if (filter === "all") {
    // All layouts (one card each) — colors picked via the strip.
    return _uniqueLayouts(list.filter((p) => p.key !== "auto"));
  }
  // Category chip → layouts in that group only.
  if (STYLE_CATEGORY_KEYS.has(filter) || (styleCategories || []).some((c) => c.key === filter)) {
    const inCat = list.filter(
      (p) => p.key !== "auto" && (p.category || styleCategoryOf(p.style)) === filter,
    );
    return _uniqueLayouts(inCat);
  }
  return list.filter((p) => (p.category || styleCategoryOf(p.style)) === filter);
}

function persistVisualSelection() {
  try {
    localStorage.setItem(VISUAL_SEL_KEY, JSON.stringify({
      preset: selectedPreset,
      style: selectedStyle,
      theme: selectedTheme,
      filter: visualStyleFilter,
    }));
  } catch (e) { /* ignore */ }
}

function restoreVisualSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(VISUAL_SEL_KEY) || "null");
    if (!saved || !saved.preset) return;
    if (!(visualPresets || []).some((p) => p.key === saved.preset)) return;
    selectedPreset = saved.preset;
    selectedStyle = saved.style || selectedStyle;
    selectedTheme = saved.theme || selectedTheme;
    styleWasAuto = selectedStyle === "auto";
    themeWasAuto = selectedTheme === "auto";
    if (saved.filter) setVisualStyleFilter(saved.filter);
    adminPreviewPreset = saved.preset;
    adminPreviewStyle = saved.style || adminPreviewStyle;
    adminPreviewTheme = saved.theme || adminPreviewTheme;
  } catch (e) { /* ignore */ }
}

function renderVisualStyleFilters(elId, activeFilter, onPick) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = visualStyleFilterChips(activeFilter);
  el.querySelectorAll("[data-vs-filter]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(btn.dataset.vsFilter || "featured"));
  });
}

function selectVisualPreset(key, opts = {}) {
  const p = visualPresets.find((x) => x.key === key) || visualPresets.find((x) => x.key === "auto");
  if (!p) return;
  selectedPreset = p.key;
  selectedStyle = p.style || "auto";
  selectedTheme = p.theme || "auto";
  styleWasAuto = selectedStyle === "auto";
  themeWasAuto = selectedTheme === "auto";
  // Keep Admin Visual styles in lockstep with Studio (and vice versa).
  adminPreviewPreset = p.key;
  adminPreviewStyle = p.style || adminPreviewStyle;
  adminPreviewTheme = p.theme || adminPreviewTheme;
  // Keep the pick visible in both Studio + Admin filters (same chip).
  const visibleIn = (f) => filterVisualPresets(f).some(
    (x) => x.key === p.key || (p.style && p.style !== "auto" && x.style === p.style),
  );
  if (!visibleIn(visualStyleFilter)) {
    setVisualStyleFilter(
      p.key === "auto"
        ? "auto"
        : (p.category || styleCategoryOf(p.style) || "featured"),
    );
    renderVisualPresets();
  } else {
    document.querySelectorAll(".visual-preset-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.preset === key);
    });
  }
  // Mirror Admin filter to Studio filter always.
  adminVisualStyleFilter = visualStyleFilter;
  document.querySelectorAll(".style-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.style === selectedStyle);
  });
  document.querySelectorAll(".theme-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.theme === selectedTheme);
  });
  document.querySelectorAll(".visual-preset-admin-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.preset === key);
  });
  updateVisualDesignHint();
  if ($("visual-preset-desc")) $("visual-preset-desc").textContent = p.description || "";
  persistVisualSelection();
  renderVisualColorStrip("visual-color-swatches", "visual-color-strip");
  renderVisualColorStrip("admin-visual-color-swatches", "admin-visual-color-strip");
  // Keep Admin Visual styles grid + carousel in lockstep with Studio.
  if (!opts.fromAdmin && typeof adminPanel !== "undefined" && adminPanel === "visual") {
    renderAdminVisualStyles();
  } else if (!opts.fromAdmin) {
    // Panel hidden — still refresh carousel meta if nodes exist.
    renderAdminSlidePreview();
  }
}

function updateVisualDesignHint() {
  const el = $("visual-design-hint");
  if (!el) return;
  if (selectedPreset === "auto" || (styleWasAuto && themeWasAuto)) {
    const fmt = (selectedFormat || "").toLowerCase();
    let hint = "Explainer · Midnight";
    if (/(shorts|reels|tiktok|square)/.test(fmt)) hint = "Bold · Sunset";
    else if (/linkedin/.test(fmt)) hint = "Modern · Aurora";
    el.textContent = `Auto · likely ${hint}`;
    return;
  }
  const p = visualPresets.find((x) => x.key === selectedPreset);
  if (p) {
    const layout = p.style_label || p.label || selectedStyle;
    const font = p.font_label ? ` · ${p.font_label}` : "";
    const theme = p.theme_label ? ` · ${p.theme_label}` : "";
    el.textContent = `${layout}${font}${theme}`;
    return;
  }
  el.textContent = `${selectedStyle} · ${selectedTheme}`;
}

function applyResolvedVisualFromJob(job) {
  const rs = job?.content?.video_style || job?.options?.video_style;
  const rt = job?.content?.video_theme || job?.options?.video_theme;
  const styleAuto = job?.options?.video_style_was_auto;
  const themeAuto = job?.options?.video_theme_was_auto;
  const wasAuto = (styleAuto || themeAuto) && (selectedPreset === "auto" || styleWasAuto || themeWasAuto);
  if (wasAuto && rs && rs !== "auto") {
    const sl = job?.options?.video_style_label
      || (videoStyles.find((s) => s.key === rs) || {}).label || rs;
    const tl = job?.options?.video_theme_label
      || (videoThemes.find((t) => t.key === rt) || {}).label || rt || "";
    if ($("visual-design-hint")) {
      $("visual-design-hint").textContent = tl ? `Auto → ${sl} · ${tl}` : `Auto → ${sl}`;
    }
    if ($("visual-preset-desc")) {
      $("visual-preset-desc").textContent =
        job?.options?.video_style_reason || job?.options?.video_theme_reason || "";
    }
    selectedPreset = "auto";
    selectedStyle = "auto";
    selectedTheme = "auto";
    styleWasAuto = true;
    themeWasAuto = true;
    document.querySelectorAll(".visual-preset-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.preset === "auto");
    });
    return;
  }
  if (rs && rt) {
    const key = `${rs}:${rt}`;
    if (visualPresets.some((x) => x.key === key)) {
      selectVisualPreset(key);
      return;
    }
  }
  if (rs) selectStyle(rs);
  if (rt) selectTheme(rt);
}

function currentStyle() {
  return videoStyles.find((s) => s.key === selectedStyle) || videoStyles[0];
}

const STYLE_ICONS = {
  auto: "wand-2",
  hybrid: "layers",
  hybrid_kinetic: "activity", hybrid_data: "bar-chart-3", hybrid_story: "book-open",
  modern: "sparkles", minimal: "minus", editorial: "newspaper",
  bold: "zap", explainer: "clapperboard", documentary: "film",
  teardown: "wrench", tutorial: "list-checks", whiteboard: "pen-line",
  cinematic: "aperture",
  neon: "flame", blueprint: "ruler", playful: "smile", terminal: "terminal",
  kinetic: "move", dataviz: "pie-chart", device: "smartphone", broadcast: "radio",
  cards: "layout-grid", pitch: "rocket", corporate: "briefcase",
  glass: "droplets", saas: "blocks",
  gamma: "layout-template", keynote: "presentation", slides: "gallery-vertical",
  notion: "notebook-text",
  geo_navy: "triangle", coral_split: "columns-2", blush_soft: "heart",
  mosaic: "layout-dashboard", process: "git-commit-horizontal", agenda: "list-ordered",
  rainbow_bar: "palette", circle_stack: "circle-dot", hex_grid: "boxes",
  wave_soft: "waves",
  swiss_pulse: "grid-3x3", velvet_std: "gem", deconstructed: "shuffle",
  maximalist: "type", data_drift: "sparkles", soft_signal: "flower-2",
  folk_freq: "music", shadow_cut: "moon",
  kinetic_center: "move", lower_third: "captions", promo_sprint: "rocket",
  caption_pop: "whole-word", chart_race: "bar-chart-2", logo_intro: "badge",
  bento: "layout-dashboard", big_stat: "hash", quote_pull: "quote",
  timeline_rail: "git-commit-horizontal", split_media: "columns-2",
  proof_duo: "scale", kpi_strip: "gauge", stack_cards: "layers",
};

/** Shared Studio + Admin layout card — preview + font + variety (not color-only). */
function visualLayoutCardHtml(p, opts) {
  if (typeof window.__layoutCardHtml === "function") return window.__layoutCardHtml(p, opts || {});
  const { admin = false } = opts || {};
  const sk = p.key === "auto" ? "auto" : (p.style || "explainer");
  const icon = STYLE_ICONS[sk] || "type";
  const previewCls = "style-preview style-preview-" + (sk === "auto" ? "modern" : sk);
  const sw = (p.swatch || []).slice(0, 3).map((c) =>
    `<i class="vp-dot" style="background:${escapeHtml(c)}"></i>`
  ).join("");
  const styleName = p.style_label || p.label || sk;
  const fontName = p.font_label || "";
  const variety = p.template || p.variety || "";
  const themeName = p.key === "auto" ? "Smart match" : (p.theme_label || "");
  const cat = p.category_label || "";
  return (
    `<span class="${previewCls}" aria-hidden="true">` +
      `<span class="sp-line sp-title"></span>` +
      `<span class="sp-line sp-body"></span>` +
      `<span class="sp-line sp-body short"></span>` +
    `</span>` +
    `<span class="vp-swatch">${sw}</span>` +
    `<span class="vp-label">${admin ? `<i data-lucide="${icon}"></i>` : ""}${escapeHtml(styleName)}</span>` +
    (fontName ? `<span class="vp-font">Aa · ${escapeHtml(fontName)}</span>` : "") +
    (themeName ? `<span class="vp-theme">${escapeHtml(themeName)}</span>` : "") +
    (cat && p.key !== "auto" ? `<span class="vp-cat">${escapeHtml(cat)}</span>` : "") +
    (variety ? `<span class="vp-variety">${escapeHtml(variety)}</span>` : "") +
    (p.example ? `<span class="vp-example">${escapeHtml(p.example)}</span>` : "")
  );
}

function renderVisualPresets() {
  const grid = $("visual-preset-grid");
  if (!grid) return;
  renderVisualStyleFilters("visual-style-filters", visualStyleFilter, (f) => {
    setVisualStyleFilter(f);
    renderVisualPresets();
    if (typeof adminPanel !== "undefined" && adminPanel === "visual") {
      renderAdminVisualStyles();
    }
  });
  grid.innerHTML = "";
  const shown = filterVisualPresets(visualStyleFilter);
  if (!shown.length) {
    grid.innerHTML = `<p class="format-desc">No styles in this filter.</p>`;
    icons();
    return;
  }
  shown.forEach((p) => {
    const card = document.createElement("button");
    card.type = "button";
    const active = p.key === selectedPreset
      || (p.style && p.style === selectedStyle && selectedStyle !== "auto" && p.key !== "auto");
    card.className = "visual-preset-card" + (active ? " active" : "");
    card.dataset.preset = p.key;
    card.dataset.style = p.style || "";
    card.title = [
      p.description || p.label,
      p.font_label ? `Font: ${p.font_label}` : "",
      p.template || "",
    ].filter(Boolean).join(" · ");
    card.innerHTML = visualLayoutCardHtml(p);
    card.addEventListener("click", () => selectVisualPreset(p.key));
    grid.appendChild(card);
  });
  renderVisualColorStrip("visual-color-swatches", "visual-color-strip");
  icons();
}

function renderStyles() {
  const grid = $("style-grid");
  if (!grid) return;
  grid.innerHTML = "";
  videoStyles.forEach((s) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "style-card" + (s.key === selectedStyle ? " active" : "");
    card.dataset.style = s.key;
    card.title = s.description || s.label;
    const icon = STYLE_ICONS[s.key] || "type";
    const previewCls = "style-preview style-preview-" + (s.key === "auto" ? "modern" : s.key);
    card.innerHTML =
      `<span class="${previewCls}" aria-hidden="true">` +
        `<span class="sp-line sp-title"></span>` +
        `<span class="sp-line sp-body"></span>` +
        `<span class="sp-line sp-body short"></span>` +
      `</span>` +
      `<span class="style-card-label"><i data-lucide="${icon}"></i>${escapeHtml(s.label)}</span>` +
      (s.example ? `<span class="style-card-example">${escapeHtml(s.example)}</span>` : "") +
      (s.template ? `<span class="style-card-template">${escapeHtml(s.template)}</span>` : "");
    card.addEventListener("click", () => selectStyle(s.key));
    grid.appendChild(card);
  });
  icons();
}

function selectStyle(key) {
  selectedStyle = key;
  styleWasAuto = key === "auto";
  const s = currentStyle();
  document.querySelectorAll(".style-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.style === key);
  });
  updateAutoStyleHint();
  if ($("style-name") && key !== "auto") $("style-name").textContent = s.label || "";
  if ($("style-desc") && key !== "auto") $("style-desc").textContent = s.description || "";
}

/** Live hint for Auto: format-aware guess before the pipeline analyzes the doc. */
function updateAutoStyleHint() {
  const nameEl = $("style-name");
  const descEl = $("style-desc");
  if (selectedStyle !== "auto") return;
  const fmt = (selectedFormat || "").toLowerCase();
  let hint = "Explainer";
  if (/(shorts|reels|tiktok|square)/.test(fmt)) hint = "Bold";
  else if (/linkedin/.test(fmt)) hint = "Modern";
  if (nameEl) nameEl.textContent = `Auto · likely ${hint}`;
  if (descEl) {
    descEl.textContent =
      `Picks after reading your document (type, topic cues, format). ` +
      `Current format leans ${hint}; papers → Documentary, how-tos → Tutorial, architecture → Teardown.`;
  }
}

function applyResolvedStyleFromJob(job) {
  const resolved = job?.content?.video_style || job?.options?.video_style;
  const reason = job?.content?.video_style_reason || job?.options?.video_style_reason || "";
  const flag = job?.options?.video_style_was_auto;
  // Explicit false means the user locked a style — don't treat client Auto state as override.
  const wasAuto = flag === true || (flag == null && (styleWasAuto || selectedStyle === "auto"));
  if (!resolved || resolved === "auto") return;
  if (wasAuto || selectedStyle === "auto") {
    // Keep Auto selected in the grid, but show what it resolved to.
    selectedStyle = "auto";
    styleWasAuto = true;
    document.querySelectorAll(".style-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.style === "auto");
    });
    const label = job?.options?.video_style_label
      || (videoStyles.find((s) => s.key === resolved) || {}).label
      || resolved;
    if ($("style-name")) $("style-name").textContent = `Auto → ${label}`;
    if ($("style-desc")) {
      $("style-desc").textContent = reason
        || `Resolved to ${label} from document analysis.`;
    }
  }
}

/* ---- Admin Visual styles (sample slide carousel) ---- */
let adminSlideIdx = 0;

/** Per-style slide kits — full templates with denser copy, visuals, and motion. */
const STYLE_PREVIEW_KITS = {
  modern: [
    { key: "cover", label: "Title card", html: () => `
      <div class="vs-lower-third vs-a-in">EP 12 · PRODUCT · 16:9</div>
      <div class="vs-card-panel vs-a-up">
        <div class="vs-kicker">Modern template</div>
        <div class="vs-title">Clean cards. Soft depth. Clear hierarchy.</div>
        <p class="vs-body">Balanced default for tech demos — rounded panels, soft shadows, and a calm sans that stays readable at 1080p.</p>
        <div class="vs-chip-row">
          <span class="vs-chip vs-a-stagger">Title</span>
          <span class="vs-chip vs-a-stagger">Bullets</span>
          <span class="vs-chip vs-a-stagger">Diagram</span>
          <span class="vs-chip vs-a-stagger">CTA</span>
        </div>
      </div>
      <div class="vs-progress vs-a-grow"><i style="--p:62%"></i><span>Slide 1 of arc</span></div>` },
    { key: "bullets", label: "Idea cards", html: () => `
      <div class="vs-kicker vs-a-in">Key ideas</div>
      <div class="vs-title vs-a-up">Three things that matter on screen</div>
      <p class="vs-body vs-a-fade">Keep each card to one verb and one outcome — the narration carries the rest.</p>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Hook fast</strong><span>Open with a number or tension in the first 3 seconds.</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>One idea</strong><span>Never crowd a slide — one claim, one visual.</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>03</b><strong>Land the beat</strong><span>Close with a takeaway chip the viewer can remember.</span></div>
      </div>` },
    { key: "compare", label: "Problem / fix", html: () => `
      <div class="vs-split">
        <div class="vs-split-a vs-a-left">
          <div class="vs-kicker">Problem</div>
          <div class="vs-title sm">Visual noise</div>
          <p class="vs-body">Crowded slides force the eye to hunt. Retention drops before the idea lands.</p>
          <ul class="vs-mini-list"><li>Too many bullets</li><li>Competing accents</li><li>No breathing room</li></ul>
        </div>
        <div class="vs-split-b vs-a-right">
          <div class="vs-kicker">Fix</div>
          <div class="vs-title sm">Modern space</div>
          <p class="vs-body">Rounded cards + soft depth create hierarchy without shouting.</p>
          <ul class="vs-mini-list"><li>One accent color</li><li>Card grouping</li><li>Clear CTA</li></ul>
        </div>
      </div>` },
    { key: "flow", label: "Story arc", html: () => `
      <div class="vs-kicker vs-a-in">Story arc</div>
      <div class="vs-title vs-a-up">Hook → teach → prove → close</div>
      <div class="vs-timeline vs-a-fade">
        <div class="vs-tl-item on"><b>1</b><span>Hook</span><small>Number / tension</small></div>
        <div class="vs-tl-item on"><b>2</b><span>Teach</span><small>Define terms</small></div>
        <div class="vs-tl-item"><b>3</b><span>Prove</span><small>Compare / flow</small></div>
        <div class="vs-tl-item"><b>4</b><span>Close</span><small>Takeaway CTA</small></div>
      </div>
      <p class="vs-body">Modern is the safe default when the content — not the skin — should lead.</p>` },
    { key: "diagram", label: "System map", html: () => `
      <div class="vs-kicker">Diagram</div>
      <div class="vs-title sm">How pieces connect</div>
      <div class="vs-sysmap">
        <div class="vs-node vs-a-pop">Input</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node accent vs-a-pop">Core</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node vs-a-pop">Output</div>
      </div>
      <div class="vs-chip-row"><span class="vs-chip">API</span><span class="vs-chip">Model</span><span class="vs-chip">UI</span></div>` },
    { key: "verdict", label: "Takeaway", html: () => `
      <div class="vs-card-panel center vs-a-up">
        <div class="vs-kicker">Takeaway</div>
        <div class="vs-title">Use Modern when you want polish without drama.</div>
        <p class="vs-body">Ideal for product demos, weekly digests, and any video where clarity beats spectacle.</p>
        <div class="vs-cta-pill vs-a-pulse">Watch next →</div>
      </div>` },
  ],
  minimal: [
    { key: "cover", label: "Quiet open", html: () => `
      <div class="vs-min-cover vs-a-fade">
        <div class="vs-title">Less ink.</div>
        <div class="vs-sub">More thinking.</div>
        <p class="vs-body" style="margin-top:18px;max-width:28ch">Whitespace is the design. Every line must earn its place.</p>
      </div>` },
    { key: "bullets", label: "Sparse list", html: () => `
      <div class="vs-min-list vs-a-up">
        <div class="vs-title sm">What stays on screen</div>
        <p><strong>One claim</strong> — the sentence that matters</p>
        <p><strong>One proof</strong> — a fact, not a lecture</p>
        <p><strong>One close</strong> — leave silence after it</p>
      </div>` },
    { key: "compare", label: "Hairline", html: () => `
      <div class="vs-min-rule vs-a-fade">
        <div><span class="vs-kicker">Before</span><div class="vs-title sm">Dense</div><p class="vs-body">Everything fights for attention.</p></div>
        <hr/>
        <div><span class="vs-kicker">After</span><div class="vs-title sm">Air</div><p class="vs-body">The idea finally has room.</p></div>
      </div>` },
    { key: "quote", label: "Single line", html: () => `
      <div class="vs-min-cover vs-a-up">
        <div class="vs-title sm">“If it doesn’t earn the pixel, cut it.”</div>
        <div class="vs-sub" style="margin-top:14px">— Minimal style rule</div>
      </div>` },
    { key: "flow", label: "Path", html: () => `
      <div class="vs-min-flow vs-a-draw"><span>Start</span><span class="vs-dot"></span><span>Middle</span><span class="vs-dot"></span><span>End</span></div>
      <p class="vs-body" style="margin-top:20px;text-align:center">Three beats. No ornament.</p>` },
    { key: "verdict", label: "Close", html: () => `
      <div class="vs-min-cover vs-a-fade">
        <div class="vs-title sm">Prefer Minimal for research summaries and whitepapers.</div>
      </div>` },
  ],
  editorial: [
    { key: "cover", label: "Magazine cover", html: () => `
      <div class="vs-ed-cover vs-a-up">
        <div class="vs-ed-kicker">ESSAY · VOL. 04 · LONGFORM</div>
        <div class="vs-title">The quiet power of restraint</div>
        <p class="vs-body" style="max-width:36ch;margin-top:12px">A visual essay for AI explainers that want magazine pacing — serif titles, pull-quotes, and chapter breath.</p>
        <div class="vs-ed-by">Narration may wander. On-screen text stays sparse.</div>
      </div>` },
    { key: "pull", label: "Pull quote", html: () => `
      <div class="vs-ed-cols">
        <blockquote class="vs-ed-pull vs-a-left">“Type is the voice of the piece.”</blockquote>
        <div class="vs-a-right">
          <div class="vs-kicker">Scene</div>
          <p class="vs-body">Serif headlines. Generous tracking. The eye reads like a spread, not a dashboard.</p>
          <p class="vs-body">Use for essays, paper walkthroughs, and opinionated tech writing.</p>
        </div>
      </div>` },
    { key: "spread", label: "Two-page", html: () => `
      <div class="vs-ed-spread">
        <div class="vs-ed-page vs-a-left"><span>01 · SETUP</span><p>Establish the thesis with a quiet cover and one framing question.</p><small>Keep body under 40 words.</small></div>
        <div class="vs-ed-page vs-a-right"><span>02 · TURN</span><p>Counterpoint lands. Evidence appears. The reader leans in.</p><small>Then resolve with one elegant line.</small></div>
      </div>` },
    { key: "chapter", label: "Chapter", html: () => `
      <div class="vs-ed-chapter vs-a-up">
        <div class="vs-ed-num">III</div>
        <div>
          <div class="vs-kicker">Chapter</div>
          <div class="vs-title sm">The turn</div>
          <p class="vs-body">Where the story flips — doubt, then clarity — before the closing page.</p>
        </div>
      </div>` },
    { key: "timeline", label: "Timeline", html: () => `
      <div class="vs-kicker">History of an idea</div>
      <div class="vs-ed-timeline">
        <div class="vs-a-stagger"><b>2017</b><span>Attention paper lands</span></div>
        <div class="vs-a-stagger"><b>2020</b><span>Scale becomes destiny</span></div>
        <div class="vs-a-stagger"><b>2024</b><span>Agents enter the chat</span></div>
        <div class="vs-a-stagger"><b>Now</b><span>What we still get wrong</span></div>
      </div>` },
    { key: "verdict", label: "Colophon", html: () => `
      <div class="vs-ed-cover vs-a-fade">
        <div class="vs-ed-kicker">CLOSE</div>
        <div class="vs-title sm">Leave them with one elegant line.</div>
        <p class="vs-body">Editorial wins when the script is literary and the visuals stay typographic.</p>
      </div>` },
  ],
  bold: [
    { key: "cover", label: "Huge hook", html: () => `
      <div class="vs-bold-hero">
        <div class="vs-stat mega vs-a-pop">10×</div>
        <div class="vs-title vs-a-up">FASTER. LOUDER. CLEARER.</div>
        <p class="vs-body vs-a-fade">High-impact social cuts — giant numbers, short sentences, almost no dense text.</p>
        <div class="vs-lower-third vs-a-in">HOOK · 0:00–0:03</div>
      </div>` },
    { key: "punch", label: "Punch list", html: () => `
      <div class="vs-bold-list">
        <div class="vs-a-stagger"><span>01</span> DROP THE NUMBER</div>
        <div class="vs-a-stagger"><span>02</span> PUNCH THE LINE</div>
        <div class="vs-a-stagger"><span>03</span> HARD CTA</div>
      </div>
      <p class="vs-body" style="margin-top:14px">If a word doesn’t hit, delete it.</p>` },
    { key: "bars", label: "Impact bars", html: () => `
      <div class="vs-kicker">Before / after</div>
      <div class="vs-title sm">Make the gap feel physical</div>
      <div class="vs-bold-bars">
        <div class="vs-bold-bar vs-a-bar" style="--w:35%"><span>OLD WAY</span></div>
        <div class="vs-bold-bar hot vs-a-bar" style="--w:95%"><span>NEW WAY</span></div>
      </div>` },
    { key: "statgrid", label: "Stat grid", html: () => `
      <div class="vs-stat-grid">
        <div class="vs-a-pop"><b>92%</b><span>retention lift</span></div>
        <div class="vs-a-pop"><b>3s</b><span>to first hook</span></div>
        <div class="vs-a-pop"><b>0</b><span>wasted words</span></div>
      </div>` },
    { key: "flow", label: "Beat sheet", html: () => `
      <div class="vs-bold-hero vs-a-up">
        <div class="vs-title">HOOK → HIT → CTA</div>
        <div class="vs-sub">Maximum visual weight. Minimum reading.</div>
      </div>` },
    { key: "verdict", label: "CTA", html: () => `
      <div class="vs-bold-cta vs-a-pulse">DO THIS NEXT</div>
      <p class="vs-body" style="text-align:center;margin-top:12px">Bold is for hooks, launches, and clips that must stop the scroll.</p>` },
  ],
  explainer: [
    { key: "cover", label: "Hook number", html: () => `
      <div class="vs-exp-hook">
        <div class="vs-lower-third vs-a-in">SYSTEM DESIGN · EXPLAINER</div>
        <div class="vs-stat vs-a-pop">10×</div>
        <div class="vs-title vs-a-up">Why transformers still win at scale</div>
        <p class="vs-body vs-a-fade">Tech YouTube pacing — kinetic numbers, compare bars, and a mechanism you can point at.</p>
      </div>` },
    { key: "define", label: "Define", html: () => `
      <div class="vs-kicker vs-a-in">Define</div>
      <div class="vs-title vs-a-up">What is attention?</div>
      <ul class="vs-bullets">
        <li class="vs-a-stagger"><strong>Look everywhere</strong> — every token can attend to every other token</li>
        <li class="vs-a-stagger"><strong>Learn weights</strong> — the model discovers which links matter</li>
        <li class="vs-a-stagger"><strong>Go parallel</strong> — no sequential bottleneck like RNNs</li>
      </ul>
      <div class="vs-callout vs-a-fade">Viewer should be able to repeat this definition out loud.</div>` },
    { key: "compare", label: "Compare", html: () => `
      <div class="vs-kicker">Compare</div>
      <div class="vs-title">RNN vs Transformer</div>
      <div class="vs-compare">
        <div class="vs-col vs-a-left">
          <div class="vs-col-h">Before</div>
          <div class="vs-bar vs-a-bar" style="--w:42%"></div>
          <div class="vs-col-t">Sequential · slow to train · hard to scale</div>
        </div>
        <div class="vs-col vs-a-right">
          <div class="vs-col-h">After</div>
          <div class="vs-bar tall vs-a-bar" style="--w:92%"></div>
          <div class="vs-col-t">Parallel · GPU-native · context grows</div>
        </div>
      </div>
      <p class="vs-body">Animated bars beat a paragraph every time.</p>` },
    { key: "flow", label: "Mechanism", html: () => `
      <div class="vs-kicker">Mechanism</div>
      <div class="vs-title">How a block runs</div>
      <div class="vs-flow">
        <span class="vs-a-stagger">Embed</span><i data-lucide="chevron-right"></i>
        <span class="vs-a-stagger">Attend</span><i data-lucide="chevron-right"></i>
        <span class="vs-a-stagger">FFN</span><i data-lucide="chevron-right"></i>
        <span class="vs-a-stagger">Residual</span>
      </div>
      <p class="vs-body">Repeat N times → next-token logits. Point at each node while you narrate.</p>` },
    { key: "catch", label: "Catch", html: () => `
      <div class="vs-kicker">The catch</div>
      <div class="vs-title sm">KV-cache cost at long context</div>
      <div class="vs-infographic">
        <div class="vs-ring vs-a-spin"><span>$$$</span></div>
        <div>
          <p class="vs-body">Memory grows with sequence length. Great for quality — expensive for serving.</p>
          <div class="vs-chip-row"><span class="vs-chip">Trade-off</span><span class="vs-chip">When to use</span><span class="vs-chip">When not</span></div>
        </div>
      </div>` },
    { key: "verdict", label: "Verdict", html: () => `
      <div class="vs-quote vs-a-up">“Attention is all you need” still explains most of modern LLM architecture.</div>
      <p class="vs-body">Explainer style = Vox/tech pacing: hook → define → compare → flow → catch → verdict.</p>
      <div class="vs-cta-pill vs-a-pulse">Subscribe for the next teardown →</div>` },
  ],
  documentary: [
    { key: "cover", label: "Cold open", html: () => `
      <div class="vs-doc-scene vs-a-fade">
        <div class="vs-doc-frame"></div>
        <div class="vs-doc-caption vs-a-in">SCENE 01 · NIGHT · 2017</div>
        <div class="vs-title">The night a paper changed everything</div>
        <p class="vs-body">Documentary pacing — context, characters (ideas), evidence, resolution. Think Vox / Johnny Harris energy without the maps… yet.</p>
      </div>` },
    { key: "cast", label: "Cast", html: () => `
      <div class="vs-kicker">Cast of ideas</div>
      <div class="vs-title sm">Who is in this story?</div>
      <div class="vs-doc-cast">
        <div class="vs-doc-char vs-a-stagger"><b>Attention</b><span>The protagonist — sees everything at once</span></div>
        <div class="vs-doc-char vs-a-stagger"><b>Memory</b><span>The constraint — context isn’t free</span></div>
        <div class="vs-doc-char vs-a-stagger"><b>Scale</b><span>The antagonist — and the prize</span></div>
      </div>` },
    { key: "map", label: "Map beat", html: () => `
      <div class="vs-doc-map vs-a-up">
        <div class="vs-map-grid"></div>
        <div class="vs-map-pin vs-a-pulse" style="--x:32%;--y:44%"><span>Lab</span></div>
        <div class="vs-map-pin vs-a-pulse" style="--x:58%;--y:38%"><span>Industry</span></div>
        <div class="vs-map-pin vs-a-pulse" style="--x:72%;--y:62%"><span>You</span></div>
        <div class="vs-doc-caption">CALL OUT · where the idea traveled</div>
      </div>` },
    { key: "evidence", label: "Evidence", html: () => `
      <div class="vs-doc-evidence vs-a-fade">
        <div class="vs-kicker">Evidence trail</div>
        <div class="vs-title sm">What the record shows</div>
        <ol>
          <li>Benchmarks moved within months of the paper</li>
          <li>Industry rewrote roadmaps around attention</li>
          <li>Trade-offs appeared later — cost, latency, safety</li>
        </ol>
      </div>` },
    { key: "timeline", label: "Timeline", html: () => `
      <div class="vs-doc-arc vs-a-draw">
        <span>Setup</span><span>Stakes</span><span>Evidence</span><span>Reveal</span><span>Resolve</span>
      </div>
      <p class="vs-body" style="margin-top:16px">Lower thirds and chapter cards keep the viewer oriented without breaking immersion.</p>` },
    { key: "verdict", label: "End card", html: () => `
      <div class="vs-doc-scene vs-a-up">
        <div class="vs-doc-caption">END CARD</div>
        <div class="vs-title sm">What changed — and what to watch next.</div>
        <p class="vs-body">Documentary style fits paper walkthroughs and “history of an idea” videos.</p>
      </div>` },
  ],
  teardown: [
    { key: "cover", label: "Promise", html: () => `
      <div class="vs-td-hero">
        <div class="vs-kicker vs-a-in">Product teardown</div>
        <div class="vs-title vs-a-up">Open the box. Score the guts.</div>
        <p class="vs-body">Surface → anatomy → internals → trade-offs → verdict. Honest architecture review energy.</p>
        <div class="vs-td-score vs-a-pop">8.4</div>
      </div>` },
    { key: "anatomy", label: "Anatomy", html: () => `
      <div class="vs-kicker">Anatomy</div>
      <div class="vs-title sm">Peel the layers</div>
      <div class="vs-td-layers">
        <div class="vs-td-layer vs-a-stagger"><strong>Surface API</strong> — what users touch first</div>
        <div class="vs-td-layer mid vs-a-stagger"><strong>Internals</strong> — how pieces actually connect</div>
        <div class="vs-td-layer deep vs-a-stagger"><strong>Trade-offs</strong> — what you pay for the wins</div>
      </div>` },
    { key: "guts", label: "Guts", html: () => `
      <div class="vs-kicker">Pipeline</div>
      <div class="vs-td-pipe vs-a-draw"><span>In</span>→<span>Core</span>→<span>Out</span>→<span>Score</span></div>
      <p class="vs-body">Name each hop. Viewers should be able to redraw this from memory.</p>` },
    { key: "tradeoffs", label: "Trade-offs", html: () => `
      <div class="vs-td-grid">
        <div class="good vs-a-stagger"><b>+</b> Throughput at scale</div>
        <div class="bad vs-a-stagger"><b>−</b> Latency tax on cold start</div>
        <div class="good vs-a-stagger"><b>+</b> Developer experience</div>
        <div class="bad vs-a-stagger"><b>−</b> Cost curve past 100k QPS</div>
      </div>` },
    { key: "score", label: "Scorecard", html: () => `
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>DX</b><i style="--p:88%"></i><span>8.8</span></div>
        <div class="vs-a-pop"><b>Perf</b><i style="--p:76%"></i><span>7.6</span></div>
        <div class="vs-a-pop"><b>Cost</b><i style="--p:54%"></i><span>5.4</span></div>
        <div class="vs-a-pop"><b>Ops</b><i style="--p:71%"></i><span>7.1</span></div>
      </div>` },
    { key: "verdict", label: "Verdict", html: () => `
      <div class="vs-td-hero vs-a-up">
        <div class="vs-td-score">VERDICT</div>
        <div class="vs-title sm">Use when you need an honest architecture review — not a hype reel.</div>
      </div>` },
  ],
  tutorial: [
    { key: "cover", label: "Goal", html: () => `
      <div class="vs-tut-goal vs-a-up">
        <div class="vs-kicker">You will learn</div>
        <div class="vs-title">Ship a working RAG loop in one sitting</div>
        <p class="vs-body">Do-this-now teaching — goals, steps, pitfalls, checklist. Coach energy, not lecture energy.</p>
        <div class="vs-tut-check">☑ Goal · ☑ Setup · ☐ Steps · ☐ Checklist</div>
      </div>` },
    { key: "prereqs", label: "Prereqs", html: () => `
      <div class="vs-kicker">Before you start</div>
      <div class="vs-title sm">Grab these first</div>
      <div class="vs-tut-prereq">
        <span class="vs-a-stagger">Python 3.11+</span>
        <span class="vs-a-stagger">API key</span>
        <span class="vs-a-stagger">15 minutes</span>
        <span class="vs-a-stagger">Terminal open</span>
      </div>
      <p class="vs-body">State prereqs early so nobody drops mid-tutorial.</p>` },
    { key: "steps", label: "Steps", html: () => `
      <div class="vs-tut-steps">
        <div class="vs-a-stagger"><b>1</b>Install deps</div>
        <div class="vs-a-stagger"><b>2</b>Index docs</div>
        <div class="vs-a-stagger"><b>3</b>Query loop</div>
        <div class="vs-a-stagger"><b>4</b>Evaluate hits</div>
      </div>
      <p class="vs-body" style="margin-top:12px">One major action per slide. Narration should sound like a patient coach.</p>` },
    { key: "pitfall", label: "Do / don’t", html: () => `
      <div class="vs-tut-dodont">
        <div class="do vs-a-left"><div class="vs-kicker">Do</div><p>One action per slide</p><small>Show the command, then the result.</small></div>
        <div class="dont vs-a-right"><div class="vs-kicker">Don’t</div><p>Skip the pitfall</p><small>Call out the failure mode out loud.</small></div>
      </div>` },
    { key: "checklist", label: "Checklist", html: () => `
      <div class="vs-kicker">Ship checklist</div>
      <div class="vs-tut-check-list">
        <div class="vs-a-stagger">☐ Works locally on a fresh shell</div>
        <div class="vs-a-stagger">☐ Handles empty retrieval hits</div>
        <div class="vs-a-stagger">☐ Logs token cost per query</div>
        <div class="vs-a-stagger">☐ Has a one-line README</div>
      </div>` },
    { key: "verdict", label: "Done", html: () => `
      <div class="vs-tut-goal vs-a-pulse">
        <div class="vs-title sm">You did it — now teach someone else.</div>
        <p class="vs-body">Tutorial style shines for labs, how-tos, and “follow along” videos.</p>
      </div>` },
  ],
  whiteboard: [
    { key: "cover", label: "Blank board", html: () => `
      <div class="vs-wb vs-a-fade">
        <div class="vs-wb-title">Q: How does caching work?</div>
        <p class="vs-body">Sketch-first teaching — diagrams grow while you talk. Text stays label-sized.</p>
        <div class="vs-wb-sketch vs-a-draw">▢ → ◯ → ▢</div>
        <div class="vs-wb-note">* draw live energy, even if it’s pre-built</div>
      </div>` },
    { key: "hub", label: "Hub", html: () => `
      <div class="vs-wb">
        <div class="vs-wb-hub vs-a-pop">Cache</div>
        <div class="vs-wb-nodes">
          <span class="vs-a-stagger">Hit</span>
          <span class="vs-a-stagger">Miss</span>
          <span class="vs-a-stagger">TTL</span>
          <span class="vs-a-stagger">Evict</span>
        </div>
        <p class="vs-body" style="text-align:center;margin-top:12px">Place the core node, then grow connections.</p>
      </div>` },
    { key: "build", label: "Build", html: () => `
      <div class="vs-wb vs-wb-build vs-a-draw">
        <span class="box">1</span><span class="line"></span>
        <span class="box">2</span><span class="line"></span>
        <span class="box">3</span><span class="line"></span>
        <span class="box">4</span>
      </div>
      <p class="vs-body" style="text-align:center;margin-top:14px">Progressive build — reveal one box at a time in the real video.</p>` },
    { key: "annotate", label: "Annotate", html: () => `
      <div class="vs-wb">
        <div class="vs-wb-arrow vs-a-up">Client ⇢ Edge ⇢ Origin</div>
        <div class="vs-wb-note vs-a-fade">* annotate constraints in the margins — latency, cost, consistency</div>
        <ul class="vs-mini-list" style="margin-top:14px">
          <li>What must be fresh?</li>
          <li>What can be stale?</li>
          <li>Who invalidates?</li>
        </ul>
      </div>` },
    { key: "alt", label: "Alt design", html: () => `
      <div class="vs-wb">
        <div class="vs-title sm" style="color:#334155">Alternate design</div>
        <div class="vs-split" style="margin-top:12px">
          <div class="vs-split-a" style="background:#fff;border-color:#94a3b8;color:#334155"><div class="vs-kicker">Write-through</div><p class="vs-body">Simpler mental model</p></div>
          <div class="vs-split-b" style="background:#fff;border-color:#94a3b8;color:#334155"><div class="vs-kicker">Write-back</div><p class="vs-body">Faster writes, harder ops</p></div>
        </div>
      </div>` },
    { key: "verdict", label: "Recap", html: () => `
      <div class="vs-wb vs-a-up">
        <div class="vs-wb-title">Board recap → takeaways</div>
        <div class="vs-wb-note">Sketch first. Polish later. Perfect for system-design interviews.</div>
      </div>` },
  ],
  cinematic: [
    { key: "cover", label: "Cold open", html: () => `
      <div class="vs-cin">
        <div class="vs-cin-letterbox vs-a-in"></div>
        <div class="vs-stat mega soft vs-a-fade">3…</div>
        <div class="vs-cin-title vs-a-up">Almost no text.</div>
        <p class="vs-body" style="text-align:center;max-width:34ch">High-drama pacing — big visuals, short titles, emotional beats. Launch-film energy.</p>
        <div class="vs-cin-letterbox vs-a-in"></div>
      </div>` },
    { key: "world", label: "World", html: () => `
      <div class="vs-cin vs-a-fade">
        <div class="vs-cin-title">Establish the world</div>
        <div class="vs-sub">One line. One feeling. Then move.</div>
        <p class="vs-body" style="text-align:center;max-width:36ch">Narration carries the story. On-screen text is a whisper, not a paragraph.</p>
      </div>` },
    { key: "tension", label: "Tension", html: () => `
      <div class="vs-cin vs-cin-turn">
        <div class="vs-cin-title vs-a-up">Rising tension</div>
        <div class="vs-sub vs-a-fade">The problem gets personal.</div>
        <div class="vs-cin-bars">
          <i class="vs-a-bar" style="--w:30%"></i>
          <i class="vs-a-bar" style="--w:55%"></i>
          <i class="vs-a-bar" style="--w:80%"></i>
        </div>
      </div>` },
    { key: "reveal", label: "Reveal", html: () => `
      <div class="vs-cin vs-cin-turn">
        <div class="vs-cin-title" style="opacity:.5">The turn</div>
        <div class="vs-cin-flash vs-a-pop">REVEAL</div>
        <p class="vs-body" style="text-align:center">One visual moment. Let it breathe.</p>
      </div>` },
    { key: "resolve", label: "Resolve", html: () => `
      <div class="vs-cin vs-a-up">
        <div class="vs-cin-title wide">From silence → impact</div>
        <div class="vs-sub">Max 3 on-screen items. Ever.</div>
      </div>` },
    { key: "verdict", label: "Fade", html: () => `
      <div class="vs-cin">
        <div class="vs-cin-letterbox"></div>
        <div class="vs-cin-title vs-a-fade">Fade on one emotional beat.</div>
        <p class="vs-body" style="text-align:center">Cinematic fits launch films and vision pieces — not dense tutorials.</p>
        <div class="vs-cin-letterbox"></div>
      </div>` },
  ],
  hybrid: [
    { key: "cover", label: "Bold hook", html: () => `
      <div class="vs-lower-third vs-a-in">HYBRID · CONTENT FORMAT PACK</div>
      <div class="vs-exp-hook">
        <div class="vs-stat vs-a-pop">MIX</div>
        <div class="vs-title vs-a-up">One video. Every content format.</div>
        <p class="vs-body vs-a-fade">Hybrid maps source beats to layouts — hook, define, compare, teach, evidence, code, transform, close.</p>
      </div>` },
    { key: "define", label: "Explain", html: () => `
      <div class="vs-kicker vs-a-in">Define · Explainer</div>
      <div class="vs-title vs-a-up">What is the hybrid pack?</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Hook</strong><span>Bold / cinematic opener</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>Teach</strong><span>Explainer + tutorial beats</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>03</b><strong>Close</strong><span>Minimal / cinematic land</span></div>
      </div>` },
    { key: "hub", label: "Concept hub", html: () => `
      <div class="vs-kicker vs-a-in">Format · Hub</div>
      <div class="vs-title sm vs-a-up">One center idea, many facets</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>●</b><strong>Core</strong><span>Named concept</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Part A</strong><span>Mechanism</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>Part B</strong><span>Trade-off</span></div>
      </div>
      <p class="vs-body" style="margin-top:10px">Use hub when the source defines a system with named pieces.</p>` },
    { key: "compare", label: "Score", html: () => `
      <div class="vs-kicker">Teardown beat</div>
      <div class="vs-title sm">Trade-offs stay honest</div>
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>HOOK</b><i style="--p:90%"></i><span>9.0</span></div>
        <div class="vs-a-pop"><b>TEACH</b><i style="--p:84%"></i><span>8.4</span></div>
        <div class="vs-a-pop"><b>DEPTH</b><i style="--p:78%"></i><span>7.8</span></div>
        <div class="vs-a-pop"><b>PACE</b><i style="--p:86%"></i><span>8.6</span></div>
      </div>` },
    { key: "bars", label: "Magnitude", html: () => `
      <div class="vs-kicker vs-a-in">Format · Bars</div>
      <div class="vs-title sm vs-a-up">Show scale, not slogans</div>
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>COST</b><i style="--p:92%"></i><span>High</span></div>
        <div class="vs-a-pop"><b>SPEED</b><i style="--p:55%"></i><span>Med</span></div>
        <div class="vs-a-pop"><b>QUALITY</b><i style="--p:88%"></i><span>High</span></div>
      </div>` },
    { key: "steps", label: "Teach", html: () => `
      <div class="vs-kicker">Tutorial beat</div>
      <div class="vs-tut-steps">
        <div class="vs-a-stagger"><b>1</b>Hook hard</div>
        <div class="vs-a-stagger"><b>2</b>Define once</div>
        <div class="vs-a-stagger"><b>3</b>Prove it</div>
        <div class="vs-a-stagger"><b>4</b>Land clean</div>
      </div>
      <p class="vs-body" style="margin-top:12px">Vary layout every 1–2 slides — never stay in one skin.</p>` },
    { key: "flow", label: "Pipeline", html: () => `
      <div class="vs-kicker vs-a-in">Format · Flow</div>
      <div class="vs-title sm vs-a-up">Causal stages with arrows</div>
      <div class="vs-sysmap">
        <div class="vs-node vs-a-pop">Ingest</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node accent vs-a-pop">Reason</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node vs-a-pop">Render</div>
      </div>
      <p class="vs-body" style="margin-top:12px">Prefer flow when steps are sequential and linked.</p>` },
    { key: "matrix", label: "Evidence", html: () => `
      <div class="vs-kicker vs-a-in">Format · Matrix</div>
      <div class="vs-title sm vs-a-up">Parallel facts, one frame</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>A</b><strong>Claim</strong><span>What we assert</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>B</b><strong>Evidence</strong><span>What supports it</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>C</b><strong>Limit</strong><span>Where it fails</span></div>
      </div>` },
    { key: "panel", label: "Code panel", html: () => `
      <div class="vs-kicker vs-a-in">Format · Panel</div>
      <div class="vs-card-panel vs-a-up">
        <div class="vs-kicker">terminal · api</div>
        <div class="vs-title sm">Show the config, not the lecture</div>
        <p class="vs-body"><code style="opacity:.9">POST /v1/generate</code> · schema · flags · one-liners the viewer can copy.</p>
        <div class="vs-chip-row">
          <span class="vs-chip vs-a-stagger">CLI</span>
          <span class="vs-chip vs-a-stagger">JSON</span>
          <span class="vs-chip vs-a-stagger">Prompt</span>
        </div>
      </div>` },
    { key: "transform", label: "Before → after", html: () => `
      <div class="vs-kicker vs-a-in">Format · Transform</div>
      <div class="vs-split">
        <div class="vs-card-panel vs-a-stagger"><div class="vs-kicker">From</div><div class="vs-title sm">Messy notes</div><p class="vs-body">Scattered claims, no structure.</p></div>
        <div class="vs-card-panel vs-a-stagger"><div class="vs-kicker">To</div><div class="vs-title sm">Clean model</div><p class="vs-body">Named parts, clear flow.</p></div>
      </div>` },
    { key: "quote", label: "Insight", html: () => `
      <div class="vs-kicker vs-a-in">Format · Quote</div>
      <div class="vs-title vs-a-up" style="font-size:clamp(22px,3.2vw,36px);line-height:1.25">“One pivotal line beats five vague bullets.”</div>
      <p class="vs-body vs-a-fade">Use quote when the source has a single insight worth lingering on.</p>` },
    { key: "board", label: "Diagram", html: () => `
      <div class="vs-wb vs-a-fade">
        <div class="vs-wb-title">Whiteboard beat → connect the pieces</div>
        <div class="vs-sysmap">
          <div class="vs-node vs-a-pop">Hook</div>
          <div class="vs-edge vs-a-draw"></div>
          <div class="vs-node accent vs-a-pop">Core</div>
          <div class="vs-edge vs-a-draw"></div>
          <div class="vs-node vs-a-pop">Close</div>
        </div>
      </div>` },
    { key: "verdict", label: "Close", html: () => `
      <div class="vs-cin">
        <div class="vs-cin-letterbox vs-a-in"></div>
        <div class="vs-title vs-a-up">Hybrid when the lesson needs range.</div>
        <p class="vs-body" style="text-align:center">Best default for long channel videos that teach and entertain.</p>
        <div class="vs-cta-pill vs-a-pulse">Watch the arc →</div>
        <div class="vs-cin-letterbox vs-a-in"></div>
      </div>` },
  ],
  neon: [
    { key: "cover", label: "Glow hook", html: () => `
      <div class="vs-lower-third vs-a-in">NEON · GLASSMORPHISM</div>
      <div class="vs-exp-hook">
        <div class="vs-stat vs-a-pop vs-neon-glow">2049</div>
        <div class="vs-title vs-a-up">The future looks like this.</div>
        <p class="vs-body vs-a-fade">Glowing edges, gradient accents, night-mode energy — built for launches and hype.</p>
      </div>` },
    { key: "bullets", label: "Neon cards", html: () => `
      <div class="vs-kicker vs-a-in">What glows</div>
      <div class="vs-title vs-a-up">Three luminous ideas</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger vs-neon-card"><b>01</b><strong>Contrast</strong><span>Dark glass, bright accent</span></div>
        <div class="vs-mini-card vs-a-stagger vs-neon-card"><b>02</b><strong>Gradient</strong><span>Indigo → cyan sweep</span></div>
        <div class="vs-mini-card vs-a-stagger vs-neon-card"><b>03</b><strong>Glow</strong><span>Soft bloom on edges</span></div>
      </div>` },
    { key: "stat", label: "Gradient stat", html: () => `
      <div class="vs-exp-hook">
        <div class="vs-stat vs-a-pop vs-neon-glow">10×</div>
        <div class="vs-title sm vs-a-up">One number, maximum bloom</div>
        <p class="vs-body vs-a-fade">Let a single glowing figure carry the slide.</p>
      </div>` },
    { key: "flow", label: "Neon flow", html: () => `
      <div class="vs-kicker vs-a-in">Method</div>
      <div class="vs-sysmap">
        <div class="vs-node vs-a-pop vs-neon-node">Spark</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node accent vs-a-pop vs-neon-node">Build</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node vs-a-pop vs-neon-node">Ship</div>
      </div>` },
    { key: "verdict", label: "CTA", html: () => `
      <div class="vs-card-panel center vs-a-up vs-neon-card">
        <div class="vs-kicker">Close</div>
        <div class="vs-title vs-neon-glow">Turn the lights on.</div>
        <div class="vs-cta-pill vs-a-pulse">Subscribe →</div>
      </div>` },
  ],
  blueprint: [
    { key: "cover", label: "Title block", html: () => `
      <div class="vs-bp-titleblock vs-a-in">
        <span>PROJECT</span><b>ATLAS-1</b><span>REV. 04</span>
      </div>
      <div class="vs-title vs-a-up">System schematic overview</div>
      <p class="vs-body vs-a-fade">Grid paper, hairline drawings, engineering annotations — read like a spec sheet.</p>` },
    { key: "diagram", label: "Schematic", html: () => `
      <div class="vs-kicker">Schematic</div>
      <div class="vs-sysmap vs-bp-map">
        <div class="vs-node vs-a-pop">IN</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node accent vs-a-pop">CORE</div>
        <div class="vs-edge vs-a-draw"></div>
        <div class="vs-node vs-a-pop">OUT</div>
      </div>
      <div class="vs-chip-row"><span class="vs-chip">A1</span><span class="vs-chip">B2</span><span class="vs-chip">C3</span></div>` },
    { key: "callouts", label: "Callouts", html: () => `
      <div class="vs-min-list vs-a-up">
        <div class="vs-title sm">Parts list</div>
        <p><strong>[1]</strong> Ingest — normalize inputs</p>
        <p><strong>[2]</strong> Core — the reasoning unit</p>
        <p><strong>[3]</strong> Output — render + verify</p>
      </div>` },
    { key: "compare", label: "Dimensions", html: () => `
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>LOAD</b><i style="--p:72%"></i><span>72%</span></div>
        <div class="vs-a-pop"><b>TOL</b><i style="--p:40%"></i><span>±0.4</span></div>
        <div class="vs-a-pop"><b>MASS</b><i style="--p:60%"></i><span>1.2kg</span></div>
      </div>` },
    { key: "verdict", label: "Sign-off", html: () => `
      <div class="vs-bp-titleblock center vs-a-up">
        <span>APPROVED</span><b>SHIP IT</b><span>QA ✓</span>
      </div>
      <p class="vs-body" style="text-align:center">Use Blueprint for architecture specs and system diagrams.</p>` },
  ],
  playful: [
    { key: "cover", label: "Friendly hook", html: () => `
      <div class="vs-play-cover vs-a-up">
        <div class="vs-title">Let's make this easy!</div>
        <p class="vs-body" style="max-width:30ch;margin-top:10px">Chunky shapes, bouncy accents, and plain language anyone can follow.</p>
        <div class="vs-chip-row"><span class="vs-chip vs-play-chip vs-a-stagger">Fun</span><span class="vs-chip vs-play-chip vs-a-stagger">Clear</span><span class="vs-chip vs-play-chip vs-a-stagger">Kind</span></div>
      </div>` },
    { key: "bullets", label: "Sticker cards", html: () => `
      <div class="vs-title vs-a-up">Three friendly ideas</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger vs-play-card"><b>😀</b><strong>Simple</strong><span>One idea per card</span></div>
        <div class="vs-mini-card vs-a-stagger vs-play-card"><b>👍</b><strong>Warm</strong><span>Encouraging tone</span></div>
        <div class="vs-mini-card vs-a-stagger vs-play-card"><b>✨</b><strong>Rounded</strong><span>Soft, chunky shapes</span></div>
      </div>` },
    { key: "steps", label: "Easy steps", html: () => `
      <div class="vs-tut-steps vs-play-steps">
        <div class="vs-a-stagger"><b>1</b>Start here</div>
        <div class="vs-a-stagger"><b>2</b>Try it out</div>
        <div class="vs-a-stagger"><b>3</b>You did it!</div>
      </div>` },
    { key: "compare", label: "This vs that", html: () => `
      <div class="vs-split">
        <div class="vs-split-a vs-a-left vs-play-card"><div class="vs-kicker">Before</div><div class="vs-title sm">Confusing</div><p class="vs-body">Too much jargon.</p></div>
        <div class="vs-split-b vs-a-right vs-play-card"><div class="vs-kicker">After</div><div class="vs-title sm">Friendly</div><p class="vs-body">Plain and cheerful.</p></div>
      </div>` },
    { key: "verdict", label: "Cheerful close", html: () => `
      <div class="vs-play-cover center vs-a-up">
        <div class="vs-title sm">Great job — now go build!</div>
        <div class="vs-cta-pill vs-a-pulse">More lessons →</div>
      </div>` },
  ],
  terminal: [
    { key: "cover", label: "Prompt", html: () => `
      <div class="vs-term vs-a-in">
        <div class="vs-term-bar"><i></i><i></i><i></i><span>~/project — zsh</span></div>
        <div class="vs-term-body vs-a-fade">
          <p><span class="vs-term-p">$</span> ./ship --goal "explain it"</p>
          <p class="vs-term-c"># dev console · monospace · IDE feel</p>
        </div>
      </div>` },
    { key: "panel", label: "Command", html: () => `
      <div class="vs-term vs-a-up">
        <div class="vs-term-bar"><i></i><i></i><i></i><span>build.sh</span></div>
        <div class="vs-term-body">
          <p><span class="vs-term-p">$</span> npm install</p>
          <p><span class="vs-term-p">$</span> npm run build</p>
          <p class="vs-term-ok">✓ built in 2.4s</p>
        </div>
      </div>` },
    { key: "steps", label: "Output", html: () => `
      <div class="vs-tut-steps vs-term-steps">
        <div class="vs-a-stagger"><b>1</b>Run the command</div>
        <div class="vs-a-stagger"><b>2</b>Read the output</div>
        <div class="vs-a-stagger"><b>3</b>Fix &amp; repeat</div>
      </div>` },
    { key: "compare", label: "Diff", html: () => `
      <div class="vs-term vs-a-up">
        <div class="vs-term-bar"><i></i><i></i><i></i><span>diff</span></div>
        <div class="vs-term-body">
          <p class="vs-term-del">- const x = slow()</p>
          <p class="vs-term-add">+ const x = fast()</p>
        </div>
      </div>` },
    { key: "verdict", label: "Recap", html: () => `
      <div class="vs-term center vs-a-up">
        <div class="vs-term-body">
          <p class="vs-term-c"># recap</p>
          <p><span class="vs-term-p">$</span> git commit -m "done"</p>
          <p class="vs-term-ok">✓ Terminal style — for coding tutorials &amp; CLI walkthroughs</p>
        </div>
      </div>` },
  ],
  hybrid_kinetic: [
    { key: "cover", label: "Word slam", html: () => `
      <div class="vs-exp-hook">
        <div class="vs-stat vs-a-pop" style="font-size:3.2em;letter-spacing:-.06em">MOVE</div>
        <div class="vs-title vs-a-up">Kinetic hybrid — words first.</div>
        <p class="vs-body vs-a-fade">Remotion-style type beats inside a full teaching arc.</p>
      </div>` },
    { key: "define", label: "Define", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Slam</strong><span>One huge word</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>Teach</strong><span>Short cards</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>03</b><strong>Land</strong><span>Sparse close</span></div>
      </div>` },
    { key: "flow", label: "Type build", html: () => `
      <div class="vs-sysmap">
        <div class="vs-node vs-a-pop">Hook</div><div class="vs-edge vs-a-draw"></div>
        <div class="vs-node accent vs-a-pop">Teach</div><div class="vs-edge vs-a-draw"></div>
        <div class="vs-node vs-a-pop">Cut</div>
      </div>` },
    { key: "verdict", label: "Close", html: () => `
      <div class="vs-cin"><div class="vs-title vs-a-up">Say less. Move more.</div>
      <div class="vs-cta-pill vs-a-pulse">Hybrid Kinetic →</div></div>` },
  ],
  hybrid_data: [
    { key: "cover", label: "KPI hook", html: () => `
      <div class="vs-exp-hook">
        <div class="vs-stat vs-a-pop">98.4%</div>
        <div class="vs-title vs-a-up">Hybrid Data — metrics lead.</div>
        <p class="vs-body">Scorecards, bars, gauges, then the method.</p>
      </div>` },
    { key: "score", label: "Scorecard", html: () => `
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>P50</b><i style="--p:42%"></i><span>42ms</span></div>
        <div class="vs-a-pop"><b>P99</b><i style="--p:78%"></i><span>180ms</span></div>
        <div class="vs-a-pop"><b>OK</b><i style="--p:96%"></i><span>96%</span></div>
      </div>` },
    { key: "bars", label: "Bars", html: () => `
      <div class="vs-bars">
        <div class="vs-a-grow"><span>A</span><i style="--p:88%"></i></div>
        <div class="vs-a-grow"><span>B</span><i style="--p:64%"></i></div>
        <div class="vs-a-grow"><span>C</span><i style="--p:41%"></i></div>
      </div>` },
    { key: "verdict", label: "Verdict", html: () => `
      <div class="vs-card-panel center vs-a-up"><div class="vs-title sm">Ship the number that matters.</div></div>` },
  ],
  hybrid_story: [
    { key: "cover", label: "Scene", html: () => `
      <div class="vs-lower-third vs-a-in">HYBRID STORY</div>
      <div class="vs-title vs-a-up">Scene, stakes, then teach.</div>
      <p class="vs-body vs-a-fade">Documentary pacing with explainer guts.</p>` },
    { key: "stakes", label: "Stakes", html: () => `
      <div class="vs-hub">
        <div class="vs-hub-core vs-a-pop">Idea</div>
        <div class="vs-hub-node vs-a-stagger">Why</div>
        <div class="vs-hub-node vs-a-stagger">Who</div>
        <div class="vs-hub-node vs-a-stagger">Cost</div>
      </div>` },
    { key: "teach", label: "Teach", html: () => `
      <div class="vs-tut-steps">
        <div class="vs-a-stagger"><b>1</b>Evidence</div>
        <div class="vs-a-stagger"><b>2</b>Mechanism</div>
        <div class="vs-a-stagger"><b>3</b>Trade-off</div>
      </div>` },
    { key: "verdict", label: "Land", html: () => `
      <div class="vs-quote vs-a-up">“Leave them with one clear next thought.”</div>` },
  ],
  kinetic: [
    { key: "cover", label: "Slam", html: () => `
      <div class="vs-exp-hook"><div class="vs-stat vs-a-pop" style="font-size:3.4em">NOW</div>
      <div class="vs-title vs-a-up">Kinetic type. Hard cuts.</div></div>` },
    { key: "type", label: "Type", html: () => `
      <div class="vs-title vs-a-up" style="font-size:1.6em">Build. the. line.</div>
      <p class="vs-body vs-a-fade">Typewriter energy — one phrase at a time.</p>` },
    { key: "stack", label: "Stack", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><strong>SHORT</strong></div>
        <div class="vs-mini-card vs-a-stagger"><strong>LOUD</strong></div>
        <div class="vs-mini-card vs-a-stagger"><strong>CLEAR</strong></div>
      </div>` },
    { key: "verdict", label: "Cut", html: () => `
      <div class="vs-cta-pill vs-a-pulse">CUT TO CTA →</div>` },
  ],
  dataviz: [
    { key: "cover", label: "KPI", html: () => `
      <div class="vs-exp-hook"><div class="vs-stat vs-a-pop">3.2×</div>
      <div class="vs-title vs-a-up">Data Viz — charts that teach.</div></div>` },
    { key: "bars", label: "Bars", html: () => `
      <div class="vs-bars">
        <div class="vs-a-grow"><span>Base</span><i style="--p:40%"></i></div>
        <div class="vs-a-grow"><span>Ours</span><i style="--p:92%"></i></div>
      </div>` },
    { key: "gauge", label: "Gauge", html: () => `
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>ACC</b><i style="--p:91%"></i><span>91%</span></div>
        <div class="vs-a-pop"><b>LAT</b><i style="--p:55%"></i><span>55ms</span></div>
      </div>` },
    { key: "verdict", label: "Takeaway", html: () => `
      <div class="vs-title sm vs-a-up">Caption the chart. Don't restate the paper.</div>` },
  ],
  device: [
    { key: "cover", label: "Device hero", html: () => `
      <div class="vs-device vs-a-up">
        <div class="vs-device-bezel"><div class="vs-device-screen">
          <div class="vs-kicker">APP</div><div class="vs-title sm">Feature, framed.</div>
        </div></div>
      </div>` },
    { key: "zoom", label: "Feature zoom", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>UI</b><strong>Inbox</strong><span>Zero clutter</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>AI</b><strong>Assist</strong><span>One tap</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>SYNC</b><strong>Live</strong><span>Everywhere</span></div>
      </div>` },
    { key: "flow", label: "User flow", html: () => `
      <div class="vs-tut-steps">
        <div class="vs-a-stagger"><b>1</b>Open</div>
        <div class="vs-a-stagger"><b>2</b>Act</div>
        <div class="vs-a-stagger"><b>3</b>Done</div>
      </div>` },
    { key: "verdict", label: "CTA", html: () => `
      <div class="vs-cta-pill vs-a-pulse">Try the product →</div>` },
  ],
  broadcast: [
    { key: "cover", label: "Lower-third", html: () => `
      <div class="vs-broadcast vs-a-in">
        <div class="vs-bc-badge">LIVE</div>
        <div class="vs-title">AI News Brief</div>
        <div class="vs-bc-ticker vs-a-fade">Breaking · models · papers · tools</div>
      </div>` },
    { key: "desk", label: "Desk split", html: () => `
      <div class="vs-split">
        <div class="vs-split-a vs-a-left"><div class="vs-kicker">HEADLINE</div><div class="vs-title sm">What shipped</div></div>
        <div class="vs-split-b vs-a-right"><div class="vs-kicker">NOTES</div><p class="vs-body">3 bullets. No fluff.</p></div>
      </div>` },
    { key: "ticker", label: "Ticker", html: () => `
      <div class="vs-chip-row">
        <span class="vs-chip vs-a-stagger">Fact 1</span>
        <span class="vs-chip vs-a-stagger">Fact 2</span>
        <span class="vs-chip vs-a-stagger">Fact 3</span>
      </div>` },
    { key: "verdict", label: "Recap", html: () => `
      <div class="vs-bc-badge vs-a-pop">RECAP</div>
      <div class="vs-title sm vs-a-up">Three things to remember.</div>` },
  ],
  cards: [
    { key: "cover", label: "Cover card", html: () => `
      <div class="vs-card-panel vs-a-up"><div class="vs-kicker">Gamma-style</div>
      <div class="vs-title">One idea. One card.</div>
      <p class="vs-body">Airy spacing, smart layouts, deck energy.</p></div>` },
    { key: "ideas", label: "Idea cards", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>A</b><strong>Clear</strong><span>Short copy</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>B</b><strong>Visual</strong><span>Icons optional</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>C</b><strong>Scannable</strong><span>Exec-ready</span></div>
      </div>` },
    { key: "split", label: "Split", html: () => `
      <div class="vs-split">
        <div class="vs-split-a vs-a-left"><div class="vs-title sm">Before</div></div>
        <div class="vs-split-b vs-a-right"><div class="vs-title sm">After</div></div>
      </div>` },
    { key: "verdict", label: "Summary", html: () => `
      <div class="vs-card-panel center vs-a-up"><div class="vs-title sm">Summary card · next action</div></div>` },
  ],
  pitch: [
    { key: "cover", label: "Problem", html: () => `
      <div class="vs-kicker vs-a-in">PITCH</div>
      <div class="vs-title vs-a-up">The problem in one line.</div>
      <p class="vs-body">Investor pacing — proof over fluff.</p>` },
    { key: "solution", label: "Solution", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>1</b><strong>Pillar</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>2</b><strong>Pillar</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>3</b><strong>Pillar</strong></div>
      </div>` },
    { key: "traction", label: "Traction", html: () => `
      <div class="vs-scorecard">
        <div class="vs-a-pop"><b>USERS</b><i style="--p:70%"></i><span>12k</span></div>
        <div class="vs-a-pop"><b>MRR</b><i style="--p:55%"></i><span>$48k</span></div>
      </div>` },
    { key: "verdict", label: "Ask", html: () => `
      <div class="vs-cta-pill vs-a-pulse">The ask →</div>` },
  ],
  corporate: [
    { key: "cover", label: "Agenda", html: () => `
      <div class="vs-kicker">QBR</div>
      <div class="vs-title vs-a-up">Agenda</div>
      <div class="vs-min-list vs-a-fade"><p>01 Goals</p><p>02 Results</p><p>03 Next steps</p></div>` },
    { key: "section", label: "Section", html: () => `
      <div class="vs-card-panel center vs-a-up"><div class="vs-kicker">SECTION 02</div>
      <div class="vs-title sm">Results</div></div>` },
    { key: "bullets", label: "Bullets", html: () => `
      <div class="vs-min-list vs-a-up">
        <p>• Clear hierarchy</p><p>• Boardroom-safe</p><p>• One chart max</p>
      </div>` },
    { key: "verdict", label: "Next", html: () => `
      <div class="vs-title sm vs-a-up">Next steps · owners · dates</div>` },
  ],
  glass: [
    { key: "cover", label: "Frost hero", html: () => `
      <div class="vs-glass vs-a-up"><div class="vs-kicker">GLASS</div>
      <div class="vs-title">Frosted panels. Soft blur.</div>
      <p class="vs-body">Gamma / web marketing energy.</p></div>` },
    { key: "cards", label: "Glass cards", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-glass vs-a-stagger"><strong>Light</strong><span>Airy</span></div>
        <div class="vs-mini-card vs-glass vs-a-stagger"><strong>Soft</strong><span>Blur</span></div>
        <div class="vs-mini-card vs-glass vs-a-stagger"><strong>Calm</strong><span>Brand</span></div>
      </div>` },
    { key: "feature", label: "Feature", html: () => `
      <div class="vs-glass vs-a-up"><div class="vs-title sm">One feature. Full focus.</div></div>` },
    { key: "verdict", label: "CTA", html: () => `
      <div class="vs-cta-pill vs-a-pulse">Explore →</div>` },
  ],
  saas: [
    { key: "cover", label: "Hero", html: () => `
      <div class="vs-kicker vs-a-in">SAAS</div>
      <div class="vs-title vs-a-up">Ship the benefit first.</div>
      <p class="vs-body">Hero → features → proof → CTA.</p>` },
    { key: "features", label: "Features", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>✓</b><strong>Fast</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>✓</b><strong>Simple</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>✓</b><strong>Trusted</strong></div>
      </div>` },
    { key: "proof", label: "Proof", html: () => `
      <div class="vs-chip-row">
        <span class="vs-chip vs-a-stagger">Logo</span>
        <span class="vs-chip vs-a-stagger">Logo</span>
        <span class="vs-chip vs-a-stagger">Logo</span>
      </div>` },
    { key: "verdict", label: "CTA", html: () => `
      <div class="vs-cta-pill vs-a-pulse">Start free →</div>` },
  ],
  gamma: [
    { key: "cover", label: "Soft cover", html: () => `
      <div class="vs-card-panel vs-a-up" style="border-radius:24px">
        <div class="vs-kicker">GAMMA</div>
        <div class="vs-title">Soft cards. Smart layouts.</div>
        <p class="vs-body">One idea per frame — pastel deck energy.</p>
      </div>` },
    { key: "ideas", label: "Idea cards", html: () => `
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger" style="border-radius:20px"><b>01</b><strong>Insight</strong><span>Short</span></div>
        <div class="vs-mini-card vs-a-stagger" style="border-radius:20px"><b>02</b><strong>Proof</strong><span>Visual</span></div>
        <div class="vs-mini-card vs-a-stagger" style="border-radius:20px"><b>03</b><strong>Action</strong><span>Clear</span></div>
      </div>` },
    { key: "matrix", label: "2×2", html: () => `
      <div class="vs-matrix">
        <div class="vs-a-stagger"><b>Fast</b><span>Cheap</span></div>
        <div class="vs-a-stagger"><b>Fast</b><span>Dear</span></div>
        <div class="vs-a-stagger"><b>Slow</b><span>Cheap</span></div>
        <div class="vs-a-stagger"><b>Slow</b><span>Dear</span></div>
      </div>` },
    { key: "verdict", label: "Close", html: () => `
      <div class="vs-card-panel center vs-a-up" style="border-radius:24px">
        <div class="vs-title sm">Leave one next step.</div>
      </div>` },
  ],
  keynote: [
    { key: "cover", label: "Giant title", html: () => `
      <div class="vs-cin">
        <div class="vs-title vs-a-up" style="font-size:clamp(28px,4vw,42px)">Almost empty.</div>
        <p class="vs-body vs-a-fade" style="text-align:center">Keynote sparsity — giant type, few words.</p>
      </div>` },
    { key: "line", label: "One line", html: () => `
      <div class="vs-title sm vs-a-up" style="text-align:center;max-width:20ch;margin:0 auto">One supporting line. Nothing else.</div>` },
    { key: "stat", label: "Stat beat", html: () => `
      <div class="vs-exp-hook"><div class="vs-stat vs-a-pop">3×</div>
      <div class="vs-title sm">The only number on the slide.</div></div>` },
    { key: "verdict", label: "Close", html: () => `
      <div class="vs-quote vs-a-up">“End quiet. Let them lean in.”</div>` },
  ],
  slides: [
    { key: "cover", label: "Title", html: () => `
      <div class="vs-kicker">TRAINING DECK</div>
      <div class="vs-title vs-a-up">Classic PowerPoint rhythm</div>
      <p class="vs-body">Title · section · bullets · chart · next</p>` },
    { key: "agenda", label: "Agenda", html: () => `
      <div class="vs-min-list vs-a-up">
        <p>1. Context</p><p>2. Findings</p><p>3. Plan</p><p>4. Ask</p>
      </div>` },
    { key: "bullets", label: "Bullets", html: () => `
      <div class="vs-title sm">Findings</div>
      <div class="vs-min-list vs-a-fade">
        <p>• Boardroom-safe hierarchy</p>
        <p>• 4–6 bullets max</p>
        <p>• One chart later</p>
      </div>` },
    { key: "verdict", label: "Next", html: () => `
      <div class="vs-title sm vs-a-up">Next steps</div>
      <div class="vs-min-list"><p>□ Owner</p><p>□ Date</p><p>□ Done-when</p></div>` },
  ],
  notion: [
    { key: "cover", label: "Page", html: () => `
      <div class="vs-kicker vs-a-in">DOC</div>
      <div class="vs-title vs-a-up">Notion-style page</div>
      <p class="vs-body">Calm wiki clarity — callouts, lists, light chrome.</p>` },
    { key: "callout", label: "Callout", html: () => `
      <div class="vs-card-panel vs-a-up">
        <div class="vs-kicker">CALLOUT</div>
        <div class="vs-title sm">The insight in one panel.</div>
        <p class="vs-body">Muted, readable, documentation-first.</p>
      </div>` },
    { key: "list", label: "List", html: () => `
      <div class="vs-min-list vs-a-up">
        <p>☐ Prerequisite</p><p>☐ Core step</p><p>☐ Edge case</p><p>☐ Ship note</p>
      </div>` },
    { key: "verdict", label: "Recap", html: () => `
      <div class="vs-title sm vs-a-up">Checklist recap</div>
      <p class="vs-body">Docs energy — leave a runnable next action.</p>` },
  ],
  geo_navy: [
    { key: "cover", label: "Geo title", html: () => `
      <div class="vs-kicker vs-a-in">GEO NAVY · MONTSERRAT</div>
      <div class="vs-title vs-a-up">Corner triangles. Boardroom clarity.</div>
      <p class="vs-body">Navy + cyan geometric frames — agenda, cards, SWOT.</p>` },
    { key: "agenda", label: "Agenda", html: () => `
      <div class="vs-kicker">Agenda</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Context</strong><span>Why now</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>System</strong><span>How it fits</span></div>
        <div class="vs-mini-card vs-a-stagger"><b>03</b><strong>Decision</strong><span>What ships</span></div>
      </div>` },
  ],
  coral_split: [
    { key: "cover", label: "Split hero", html: () => `
      <div class="vs-split">
        <div class="vs-split-a vs-a-left"><div class="vs-title sm">Creative business design</div><p class="vs-body">Poppins · coral energy</p></div>
        <div class="vs-split-b vs-a-right"><div class="vs-kicker">CTA</div><div class="vs-cta-pill">Begin →</div></div>
      </div>` },
  ],
  blush_soft: [
    { key: "cover", label: "Blush open", html: () => `
      <div class="vs-kicker vs-a-in">BLUSH · OUTFIT</div>
      <div class="vs-title vs-a-up">Soft bands. Thin icons. Calm grids.</div>` },
  ],
  mosaic: [
    { key: "cover", label: "Mosaic", html: () => `
      <div class="vs-kicker">MOSAIC · MANROPE</div>
      <div class="vs-title sm">Tile the story</div>
      <div class="vs-cards-3">
        <div class="vs-mini-card vs-a-stagger"><b>A</b><strong>Mood</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>B</b><strong>Proof</strong></div>
        <div class="vs-mini-card vs-a-stagger"><b>C</b><strong>Close</strong></div>
      </div>` },
  ],
  process: [
    { key: "flow", label: "Pills", html: () => `
      <div class="vs-kicker">PROCESS · DM SANS</div>
      <div class="vs-timeline vs-a-fade">
        <div class="vs-tl-item on"><b>1</b><span>Start</span></div>
        <div class="vs-tl-item on"><b>2</b><span>Build</span></div>
        <div class="vs-tl-item"><b>3</b><span>Ship</span></div>
        <div class="vs-tl-item"><b>4</b><span>End</span></div>
      </div>` },
  ],
  agenda: [
    { key: "cover", label: "Numbers", html: () => `
      <div class="vs-kicker">AGENDA GRID · SPACE GROTESK</div>
      <div class="vs-title">01 · 02 · 03</div>
      <p class="vs-body">Giant numerals as design — workshop pacing.</p>` },
  ],
  rainbow_bar: [
    { key: "cover", label: "Bar", html: () => `
      <div class="vs-kicker vs-a-in">RAINBOW BAR · NUNITO</div>
      <div class="vs-title vs-a-up">Bright multipurpose decks</div>
      <div class="vs-progress vs-a-grow"><i style="--p:70%;background:linear-gradient(90deg,#f4b400,#4285f4,#0f9d58,#db4437)"></i></div>` },
  ],
  circle_stack: [
    { key: "flow", label: "Circles", html: () => `
      <div class="vs-kicker">CIRCLE STACK · RUBIK</div>
      <div class="vs-sysmap">
        <div class="vs-node vs-a-pop">01</div>
        <div class="vs-edge"></div>
        <div class="vs-node accent vs-a-pop">02</div>
        <div class="vs-edge"></div>
        <div class="vs-node vs-a-pop">03</div>
      </div>` },
  ],
  hex_grid: [
    { key: "cover", label: "Hex", html: () => `
      <div class="vs-kicker">HEX GRID · WORK SANS</div>
      <div class="vs-title sm">Partners in cells</div>
      <div class="vs-chip-row"><span class="vs-chip">A</span><span class="vs-chip">B</span><span class="vs-chip">C</span><span class="vs-chip">D</span></div>` },
  ],
  wave_soft: [
    { key: "cover", label: "Wave", html: () => `
      <div class="vs-kicker">WAVE SOFT · FIGTREE</div>
      <div class="vs-title vs-a-up">Rounded bands. Fresh flat.</div>
      <p class="vs-body">Values → portfolio → growth → contact.</p>` },
  ],
};

/** Shared layout varieties (up to 20) — merged into every style kit for Admin preview. */
const UNIVERSAL_SLIDE_LIBRARY = [
  { key: "cover", label: "Cover", html: (s) => `
    <div class="vs-lower-third vs-a-in">${escapeHtml((s && s.label) || "STYLE")} · COVER</div>
    <div class="vs-title vs-a-up">Open with a clear promise.</div>
    <p class="vs-body vs-a-fade">Title + one-line stake. Sparse, readable, animation-ready.</p>` },
  { key: "hook", label: "Hook", html: () => `
    <div class="vs-exp-hook"><div class="vs-stat vs-a-pop">10×</div>
    <div class="vs-title sm vs-a-up">Kinetic number that stops the scroll.</div>
    <p class="vs-body">One metric. One punchline.</p></div>` },
  { key: "hub", label: "Hub", html: () => `
    <div class="vs-hub">
      <div class="vs-hub-core vs-a-pop">Core</div>
      <div class="vs-hub-node vs-a-stagger">A</div>
      <div class="vs-hub-node vs-a-stagger">B</div>
      <div class="vs-hub-node vs-a-stagger">C</div>
      <div class="vs-hub-node vs-a-stagger">D</div>
    </div>` },
  { key: "bullets", label: "Bullets", html: () => `
    <div class="vs-kicker vs-a-in">Key ideas</div>
    <div class="vs-min-list vs-a-up">
      <p>• Concrete fact one</p><p>• Mechanism two</p><p>• Example three</p><p>• Trade-off four</p>
    </div>` },
  { key: "compare", label: "Compare", html: () => `
    <div class="vs-split">
      <div class="vs-split-a vs-a-left"><div class="vs-kicker">Before</div><div class="vs-title sm">Old way</div></div>
      <div class="vs-split-b vs-a-right"><div class="vs-kicker">After</div><div class="vs-title sm">New way</div></div>
    </div>` },
  { key: "bars", label: "Bars", html: () => `
    <div class="vs-bars">
      <div class="vs-a-grow"><span>A</span><i style="--p:88%"></i></div>
      <div class="vs-a-grow"><span>B</span><i style="--p:62%"></i></div>
      <div class="vs-a-grow"><span>C</span><i style="--p:35%"></i></div>
    </div>` },
  { key: "stat", label: "Stats", html: () => `
    <div class="vs-scorecard">
      <div class="vs-a-pop"><b>P50</b><i style="--p:40%"></i><span>12ms</span></div>
      <div class="vs-a-pop"><b>P99</b><i style="--p:78%"></i><span>90ms</span></div>
      <div class="vs-a-pop"><b>OK</b><i style="--p:96%"></i><span>96%</span></div>
    </div>` },
  { key: "steps", label: "Steps", html: () => `
    <div class="vs-tut-steps">
      <div class="vs-a-stagger"><b>1</b>Setup</div>
      <div class="vs-a-stagger"><b>2</b>Run</div>
      <div class="vs-a-stagger"><b>3</b>Verify</div>
      <div class="vs-a-stagger"><b>4</b>Ship</div>
    </div>` },
  { key: "flow", label: "Flow", html: () => `
    <div class="vs-sysmap">
      <div class="vs-node vs-a-pop">In</div><div class="vs-edge vs-a-draw"></div>
      <div class="vs-node accent vs-a-pop">Core</div><div class="vs-edge vs-a-draw"></div>
      <div class="vs-node vs-a-pop">Out</div>
    </div>` },
  { key: "matrix", label: "Matrix", html: () => `
    <div class="vs-cards-3">
      <div class="vs-mini-card vs-a-stagger"><b>01</b><strong>Facet</strong><span>Detail</span></div>
      <div class="vs-mini-card vs-a-stagger"><b>02</b><strong>Facet</strong><span>Detail</span></div>
      <div class="vs-mini-card vs-a-stagger"><b>03</b><strong>Facet</strong><span>Detail</span></div>
      <div class="vs-mini-card vs-a-stagger"><b>04</b><strong>Facet</strong><span>Detail</span></div>
    </div>` },
  { key: "panel", label: "Panel", html: () => `
    <div class="vs-term vs-a-up">
      <div class="vs-term-bar"><i></i><i></i><i></i><span>panel</span></div>
      <div class="vs-term-body">
        <p><span class="vs-term-p">$</span> run --demo</p>
        <p class="vs-term-ok">✓ config / API / CLI</p>
      </div>
    </div>` },
  { key: "transform", label: "Transform", html: () => `
    <div class="vs-split">
      <div class="vs-split-a vs-a-left"><div class="vs-kicker">From</div><p class="vs-body">Messy input</p></div>
      <div class="vs-split-b vs-a-right"><div class="vs-kicker">To</div><p class="vs-body">Clean structure</p></div>
    </div>` },
  { key: "quote", label: "Quote", html: () => `
    <blockquote class="vs-quote vs-a-up">“One pivotal insight — leave the rest to narration.”</blockquote>` },
  { key: "timeline", label: "Timeline", html: () => `
    <div class="vs-tut-steps">
      <div class="vs-a-stagger"><b>T0</b>Problem</div>
      <div class="vs-a-stagger"><b>T1</b>Breakthrough</div>
      <div class="vs-a-stagger"><b>T2</b>Scale</div>
      <div class="vs-a-stagger"><b>Now</b>So what</div>
    </div>` },
  { key: "checklist", label: "Checklist", html: () => `
    <div class="vs-min-list vs-a-up">
      <p>✓ Prerequisite ready</p><p>✓ Core step done</p><p>✓ Edge case covered</p><p>□ Ship checklist</p>
    </div>` },
  { key: "agenda", label: "Agenda", html: () => `
    <div class="vs-kicker">Agenda</div>
    <div class="vs-title sm vs-a-up">What we'll cover</div>
    <div class="vs-chip-row">
      <span class="vs-chip vs-a-stagger">01 Hook</span>
      <span class="vs-chip vs-a-stagger">02 Teach</span>
      <span class="vs-chip vs-a-stagger">03 Proof</span>
      <span class="vs-chip vs-a-stagger">04 Close</span>
    </div>` },
  { key: "evidence", label: "Evidence", html: () => `
    <div class="vs-card-panel vs-a-up">
      <div class="vs-kicker">Evidence</div>
      <div class="vs-title sm">Claim → support → caveat</div>
      <p class="vs-body">Keep citations honest; mark uncertainty.</p>
    </div>` },
  { key: "pitfall", label: "Pitfall", html: () => `
    <div class="vs-split">
      <div class="vs-split-a vs-a-left"><div class="vs-kicker">Don't</div><p class="vs-body">Common mistake</p></div>
      <div class="vs-split-b vs-a-right"><div class="vs-kicker">Do</div><p class="vs-body">Correct pattern</p></div>
    </div>` },
  { key: "cta", label: "CTA", html: () => `
    <div class="vs-card-panel center vs-a-up">
      <div class="vs-title sm">One clear next action.</div>
      <div class="vs-cta-pill vs-a-pulse">Continue →</div>
    </div>` },
  { key: "close", label: "Close", html: (s) => `
    <div class="vs-cin">
      <div class="vs-title vs-a-up">Land the idea.</div>
      <p class="vs-body" style="text-align:center">${escapeHtml((s && s.label) || "Style")} · sparse final beat</p>
    </div>` },
];

const MAX_STYLE_PREVIEW_SLIDES = 20;

function adminSlideKit(styleKey) {
  if (typeof window.uniquePreviewKit === "function") return window.uniquePreviewKit(styleKey);
  const base = STYLE_PREVIEW_KITS[styleKey] || STYLE_PREVIEW_KITS.explainer || [];
  const seen = new Set(base.map((s) => s.key));
  const merged = base.slice();
  for (const slide of UNIVERSAL_SLIDE_LIBRARY) {
    if (merged.length >= MAX_STYLE_PREVIEW_SLIDES) break;
    if (seen.has(slide.key)) continue;
    seen.add(slide.key);
    merged.push(slide);
  }
  return merged.slice(0, MAX_STYLE_PREVIEW_SLIDES);
}

function renderAdminVisualStyles() {
  if (!videoStyles.length || !visualPresets.length) {
    // One retry only — avoid infinite loop if API returns empty.
    if (!renderAdminVisualStyles._retrying) {
      renderAdminVisualStyles._retrying = true;
      loadVideoFormats().finally(() => {
        renderAdminVisualStyles._retrying = false;
        renderAdminVisualStyles();
      });
    }
    return;
  }
  renderVisualStyleFilters("admin-visual-style-filters", adminVisualStyleFilter, (f) => {
    setVisualStyleFilter(f);
    renderAdminVisualStyles();
    renderVisualPresets();
  });
  // Identical list to Studio for the active chip (includes Auto when Featured / Auto only).
  let shown = filterVisualPresets(adminVisualStyleFilter);
  if (!shown.length && adminVisualStyleFilter !== "auto") {
    shown = filterVisualPresets("featured");
  }
  // Prefer Studio's current pick when it belongs in this filter.
  if (selectedPreset) {
    const studioPick = shown.find((p) => p.key === selectedPreset)
      || (selectedStyle !== "auto" && shown.find((p) => p.style === selectedStyle));
    if (studioPick) {
      adminPreviewPreset = studioPick.key;
      adminPreviewStyle = studioPick.style;
      adminPreviewTheme = studioPick.theme;
    }
  }
  if (!shown.find((p) => p.key === adminPreviewPreset)) {
    const match = shown.find((p) => p.style === adminPreviewStyle)
      || shown[0];
    if (match) {
      adminPreviewPreset = match.key;
      adminPreviewStyle = match.style;
      adminPreviewTheme = match.theme;
    }
  }
  const grid = $("admin-style-grid");
  if (grid) {
    grid.innerHTML = "";
    shown.forEach((p) => {
      const card = document.createElement("button");
      card.type = "button";
      const active = p.key === adminPreviewPreset || p.key === selectedPreset;
      card.className = "style-card visual-preset-admin-card visual-preset-card"
        + (active ? " active" : "");
      card.dataset.preset = p.key;
      card.dataset.style = p.style || "";
      card.title = [
        p.description || p.label,
        p.font_label ? `Font: ${p.font_label}` : "",
        p.template || "",
      ].filter(Boolean).join(" · ");
      card.innerHTML = visualLayoutCardHtml(p, { admin: true });
      card.addEventListener("click", () => {
        adminSlideIdx = 0;
        selectVisualPreset(p.key, { fromAdmin: true });
        setVisualStyleFilter(adminVisualStyleFilter);
        renderVisualPresets();
        renderAdminVisualStyles();
      });
      grid.appendChild(card);
    });
  }
  renderVisualColorStrip("admin-visual-color-swatches", "admin-visual-color-strip");
  renderAdminSlidePreview();
  icons();
}

function renderAdminSlidePreview() {
  const preset = (visualPresets || []).find((p) => p.key === adminPreviewPreset)
    || (visualPresets || []).find((p) => p.style === adminPreviewStyle && p.theme === adminPreviewTheme)
    || (visualPresets || []).find((p) => p.style === adminPreviewStyle)
    || { key: "explainer:midnight", style: "explainer", theme: "midnight",
         label: "Explainer · Midnight Blue", style_label: "Explainer",
         theme_label: "Midnight Blue", description: "", template: "", swatch: [] };
  const styleKey = preset.style || adminPreviewStyle || "explainer";
  const styleMeta = (videoStyles || []).find((s) => s.key === styleKey)
    || { key: styleKey, label: preset.style_label || styleKey, description: "", template: "" };
  const kit = adminSlideKit(styleKey);
  const mock = kit[adminSlideIdx] || kit[0];
  const name = $("admin-style-name");
  const desc = $("admin-style-desc");
  const tmpl = $("admin-style-template");
  const swatchEl = $("admin-style-swatch");
  if (name) name.textContent = preset.label || `${styleMeta.label} · ${preset.theme_label || ""}`;
  if (desc) {
    const fontName = preset.font_label || styleMeta.font_label || "";
    const rawDesc = preset.description || styleMeta.description || "";
    const already = fontName && rawDesc.toLowerCase().includes(fontName.toLowerCase());
    desc.textContent = (fontName && !already ? `Font: ${fontName}. ` : "") + rawDesc;
  }
  if (tmpl) {
    const variety = preset.variety || preset.template || styleMeta.template || "";
    tmpl.textContent = variety ? `Variety: ${variety}` : "";
  }
  if (swatchEl) {
    swatchEl.innerHTML = (preset.swatch || []).slice(0, 3).map((c) =>
      `<i class="vp-dot" style="background:${escapeHtml(c)}"></i>`
    ).join("");
  }

  const frame = $("admin-slide-frame");
  const canvas = $("admin-slide-canvas");
  const colors = preset.colors || {};
  if (frame) {
    frame.dataset.style = styleKey;
    frame.dataset.layout = (mock && mock.key) || "cover";
    frame.dataset.theme = preset.theme || "";
    frame.dataset.palette = colors.bg ? "1" : "";
    if (colors.bg) frame.style.setProperty("--palette-bg", colors.bg);
    if (colors.ink) frame.style.setProperty("--palette-ink", colors.ink);
    if (colors.accent) frame.style.setProperty("--palette-accent", colors.accent);
    if ((preset.swatch || [])[1]) frame.style.setProperty("--palette-b", preset.swatch[1]);
  }
  if (canvas) {
    canvas.className = "visual-slide visual-slide-" + styleKey
      + (preset.dark === false ? " visual-slide-light-palette" : "");
    canvas.innerHTML = mock.html(styleMeta);
    // Restart entrance animations on every slide change.
    canvas.classList.remove("vs-play");
    void canvas.offsetWidth;
    canvas.classList.add("vs-play");
  }

  const counter = $("admin-slide-counter");
  if (counter) counter.textContent = `${adminSlideIdx + 1} / ${kit.length} · ${mock.label}`;
  const range = $("admin-slide-range");
  if (range) {
    range.min = "0";
    range.max = String(Math.max(0, kit.length - 1));
    range.value = String(adminSlideIdx);
  }

  const dots = $("admin-slide-dots");
  if (dots) {
    dots.innerHTML = kit.map((m, i) =>
      `<button type="button" class="visual-slide-dot${i === adminSlideIdx ? " active" : ""}" data-idx="${i}" aria-label="${escapeHtml(m.label)}"></button>`
    ).join("");
    dots.querySelectorAll(".visual-slide-dot").forEach((btn) => {
      btn.addEventListener("click", () => {
        adminSlideIdx = Number(btn.dataset.idx) || 0;
        renderAdminSlidePreview();
        icons();
      });
    });
  }
  icons();
}

function adminSlideStep(delta) {
  const kit = adminSlideKit(adminPreviewStyle);
  const n = kit.length;
  adminSlideIdx = (adminSlideIdx + delta + n) % n;
  renderAdminSlidePreview();
}

function currentTheme() {
  return videoThemes.find((t) => t.key === selectedTheme) || videoThemes[0];
}

function renderThemes() {
  const grid = $("theme-grid");
  if (!grid) return;
  grid.innerHTML = "";
  videoThemes.forEach((t) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card" + (t.key === selectedTheme ? " active" : "");
    card.dataset.theme = t.key;
    card.title = t.description || t.label;
    if (t.swatch && t.swatch[0]) card.style.setProperty("--theme-accent", t.swatch[0]);
    const swatch = (t.swatch || []).slice(0, 3)
      .map((c) => `<span class="tsw-dot" style="background:${c}"></span>`).join("");
    card.innerHTML = `
      <span class="tsw ${t.dark ? "tsw-dark" : "tsw-light"}">${swatch}</span>
      <span class="theme-cardname">${escapeHtml(t.label)}</span>`;
    card.addEventListener("click", () => selectTheme(t.key));
    grid.appendChild(card);
  });
}

function selectTheme(key) {
  selectedTheme = key;
  themeWasAuto = key === "auto";
  const t = currentTheme();
  document.querySelectorAll(".theme-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.theme === key);
  });
  updateAutoThemeHint();
  if (key !== "auto") {
  if ($("theme-name")) $("theme-name").textContent = t.label || "";
  if ($("theme-desc")) $("theme-desc").textContent = t.description || "";
  const lookHint = $("look-summary-hint");
  if (lookHint) lookHint.textContent = t.label || "theme colors";
  }
}

function updateAutoThemeHint() {
  if (selectedTheme !== "auto") return;
  const fmt = (selectedFormat || "").toLowerCase();
  let hint = "Aurora";
  if (/(shorts|reels|tiktok)/.test(fmt)) hint = "Sunset";
  else if (/linkedin/.test(fmt)) hint = "Midnight";
  if ($("theme-name")) $("theme-name").textContent = `Auto · likely ${hint}`;
  if ($("theme-desc")) {
    $("theme-desc").textContent =
      "Picks after reading your document + visual style. Tutorials lean Emerald, papers Midnight, hooks Sunset.";
  }
  const lookHint = $("look-summary-hint");
  if (lookHint) lookHint.textContent = `Auto · ${hint}`;
}

function applyResolvedThemeFromJob(job) {
  const resolved = job?.content?.video_theme || job?.options?.video_theme;
  const reason = job?.content?.video_theme_reason || job?.options?.video_theme_reason || "";
  const flag = job?.options?.video_theme_was_auto;
  const wasAuto = flag === true || (flag == null && (themeWasAuto || selectedTheme === "auto"));
  if (!resolved || resolved === "auto") return;
  if (wasAuto || selectedTheme === "auto") {
    selectedTheme = "auto";
    themeWasAuto = true;
    document.querySelectorAll(".theme-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.theme === "auto");
    });
    const label = job?.options?.video_theme_label
      || (videoThemes.find((t) => t.key === resolved) || {}).label
      || resolved;
    if ($("theme-name")) $("theme-name").textContent = `Auto → ${label}`;
    if ($("theme-desc")) $("theme-desc").textContent = reason || `Resolved to ${label}.`;
    const lookHint = $("look-summary-hint");
    if (lookHint) lookHint.textContent = `Auto → ${label}`;
  }
}

function currentFormat() {
  return videoFormats.find((f) => f.key === selectedFormat) || videoFormats[0];
}

function renderFormats() {
  const grid = $("format-grid");
  if (!grid) return;
  grid.innerHTML = "";
  videoFormats.forEach((f) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "format-card" + (f.key === selectedFormat ? " active" : "");
    card.dataset.format = f.key;
    const icon = FORMAT_ICONS[f.key] || "video";
    const shape = f.orientation === "vertical" ? "shape-vertical"
      : f.orientation === "square" ? "shape-square" : "shape-landscape";
    card.innerHTML = `
      <span class="format-shape ${shape}"></span>
      <span class="format-ic"><i data-lucide="${icon}"></i></span>
      <span class="format-name">${escapeHtml(f.label)}</span>
      <span class="format-ar">${escapeHtml(f.aspect_ratio)}</span>`;
    card.addEventListener("click", () => selectFormat(f.key));
    grid.appendChild(card);
  });
  icons();
}

function selectFormat(key, opts = {}) {
  selectedFormat = key;
  const fmt = currentFormat();
  document.querySelectorAll(".format-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.format === key);
  });
  if ($("format-ratio")) $("format-ratio").textContent = fmt.aspect_ratio || "";
  if ($("format-desc")) $("format-desc").textContent = fmt.description || "";
  if (!opts.preserveDuration) {
    const optsDur = fmt.duration_options || [0];
    // Prefer Studio default (8 min) when the format supports it; else format recommend.
    const preferred = [DEFAULT_STUDIO_DURATION, fmt.recommended_duration, optsDur[0]];
    selectedDuration = preferred.find((s) => optsDur.includes(s)) ?? optsDur[0];
  } else if (
    selectedDuration != null
    && !(fmt.duration_options || [0]).includes(selectedDuration)
  ) {
    // Kept duration isn't offered for this format — fall back to Studio / recommend.
    const optsDur = fmt.duration_options || [0];
    const preferred = [DEFAULT_STUDIO_DURATION, fmt.recommended_duration, optsDur[0]];
    selectedDuration = preferred.find((s) => optsDur.includes(s)) ?? optsDur[0];
  }
  renderDurationChips();
  updateVisualDesignHint();
}

function renderDurationChips() {
  const fmt = currentFormat();
  const wrap = $("dur-chips");
  if (!wrap) return;
  wrap.innerHTML = "";
  (fmt.duration_options || [0]).forEach((sec) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (sec === selectedDuration ? " active" : "");
    chip.dataset.sec = String(sec);
    chip.textContent = sec === 0 ? "Auto" : formatDuration(sec);
    chip.addEventListener("click", () => {
      selectedDuration = sec;
      renderDurationChips();
    });
    wrap.appendChild(chip);
  });
  const durVal = $("dur-value");
  if (durVal) durVal.textContent = formatDuration(selectedDuration);
}

// ----------------------------------------------------------- capabilities ----

let appCaps = null;

function renderVoiceEngineStatus(caps) {
  const el = $("voice-engine-detail");
  if (!el || !caps) return;
  const parts = [];
  if (caps.kokoro) {
    parts.push(`Default: ${caps.voice_default_label || "Kokoro ONNX"}`);
  } else if (caps.tts) {
    parts.push(`Default: ${caps.tts_engine || "TTS"}`);
  } else {
    parts.push("Default TTS: not available");
  }
  if (caps.pocket) {
    parts.push(`Pocket: ${caps.voice_pocket_label || "Kyutai Pocket TTS"}`);
  } else {
    parts.push("Pocket: pip install pocket-tts");
  }
  if (caps.supertonic) {
    parts.push(`Clone: ${caps.voice_clone_label || "Supertonic 3"}`);
  } else {
    parts.push("Clone: install supertonic package");
  }
  const warm = caps.tts_warmup || {};
  if (warm.state === "running") {
    parts.push("Free models: warming…");
  } else if (warm.state === "ready") {
    const bits = [];
    if (warm.kokoro_warm) bits.push("Kokoro");
    if (warm.pocket_warm) bits.push("Pocket");
    if (bits.length) parts.push(`Cached: ${bits.join(" + ")}`);
  } else if (warm.state === "error" && warm.error) {
    parts.push("Warmup: retry on first use");
  }
  el.textContent = parts.join(" · ");
  const pocketDetail = $("voice-pocket-detail");
  if (pocketDetail) {
    pocketDetail.textContent = caps.pocket
      ? (warm.state === "running"
        ? "Loading Pocket model into memory (startup cache)…"
        : "Catalog voices + wav cloning (.safetensors). Preview, then run the pipeline.")
      : "Install Pocket TTS to enable this tab: pip install pocket-tts";
  }
  // Poll while background warmup is still running so the label flips to Cached.
  if (warm.state === "running" && !renderVoiceEngineStatus._poll) {
    renderVoiceEngineStatus._poll = setTimeout(async () => {
      renderVoiceEngineStatus._poll = null;
      try {
        const next = await (await fetch("/api/capabilities")).json();
        appCaps = next;
        renderVoiceEngineStatus(next);
      } catch (e) { /* ignore */ }
    }, 2500);
  }
}

async function loadCapabilities() {
  try {
    const caps = await (await fetch("/api/capabilities")).json();
    appCaps = caps;
    if (!caps.youtube) {
      const sw = $("publish-switch");
      if (sw) { sw.disabled = true; sw.classList.remove("on"); }
      const hint = $("yt-hint");
      if (hint) hint.textContent = "Add client_secrets.json to enable uploads";
      publishOn = false;
    }
    renderVoiceEngineStatus(caps);
    loadVoices();
    icons();
  } catch (e) { /* capabilities are best-effort */ }
}

function mediaBadge(ok) {
  return ok
    ? '<span class="ok">Available</span>'
    : '<span class="bad">Unavailable</span>';
}

async function loadMediaStatus() {
  const el = $("media-status");
  const hint = $("media-install-hint");
  if (!el) return;
  el.textContent = "Loading…";
  try {
    const data = await (await fetch("/api/media/status")).json();
    const b = data.backends || {};
    const nbModel = (data.models && data.models.nano_banana) || b.gemini_image_model || "gemini-3-pro-image";
    el.innerHTML =
      `<dl>` +
      `<dt>Nano Banana Pro (cloud, thumbnail only)</dt>` +
      `<dd>${mediaBadge(b.nano_banana)} ${escapeHtml(b.nano_banana_reason || "")}` +
      `<br><code>${escapeHtml(nbModel)}</code> — never used for slides/content</dd>` +
      `<dt>Local image models</dt>` +
      `<dd><span class="bad">Not installed</span> — can be added later</dd>` +
      `<dt>Thumbnail backend (.env)</dt><dd><code>${escapeHtml(data.thumbnail_backend || "auto")}</code></dd>` +
      `<dt>Slide AI images</dt><dd>default <code>${data.slide_ai_images_default ? "on" : "off"}</code> — toggle per job in Studio → More options</dd>` +
      `</dl>`;
    if (hint) hint.textContent = data.install_hint || "";
    await populateMediaSessions();
    icons();
  } catch (e) {
    el.textContent = e.message || "Failed to load media status.";
  }
}

async function populateMediaSessions() {
  const sel = $("media-session");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select session —</option>';
  try {
    const data = await (await fetch("/api/sessions")).json();
    (data.sessions || []).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = (s.title || s.filename || s.id).slice(0, 64);
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  } catch (e) { /* ignore */ }
}

async function generateTestImage() {
  const msgEl = $("media-gen-msg");
  const preview = $("media-preview");
  const previewEmpty = $("media-preview-empty");
  const btn = $("media-generate");
  const prompt = ($("media-prompt")?.value || "").trim();
  const backend = $("media-backend")?.value || "auto";
  if (btn) btn.disabled = true;
  if (msgEl) { msgEl.classList.remove("hidden"); msgEl.textContent = "Generating…"; }
  try {
    const res = await fetch("/api/media/test-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, backend, width: 1280, height: 720 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || data.detail || "Generation failed");
    if (msgEl) {
      msgEl.textContent = `${data.message || "Done."}${data.backend ? ` [${data.backend}]` : ""}`;
    }
    if (preview && data.image_b64) {
      preview.src = `data:${data.mime || "image/png"};base64,${data.image_b64}`;
      preview.classList.remove("hidden");
      if (previewEmpty) previewEmpty.classList.add("hidden");
      switchMediaPanel("test");
    }
  } catch (e) {
    if (msgEl) msgEl.textContent = e.message || "Failed.";
    if (preview) preview.classList.add("hidden");
    if (previewEmpty) previewEmpty.classList.remove("hidden");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function regenSessionThumbnail() {
  const jobId = $("media-session")?.value;
  const msgEl = $("media-regen-msg");
  if (!jobId) {
    if (msgEl) msgEl.textContent = "Select a session first.";
    return;
  }
  if (msgEl) msgEl.textContent = "Generating thumbnail…";
  try {
    const res = await fetch(`/api/jobs/${jobId}/generate-thumbnail`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.detail || "Thumbnail failed");
    }
    if (msgEl) msgEl.textContent = data.message || "Thumbnail ready — open the session in Studio to preview.";
  } catch (e) {
    if (msgEl) msgEl.textContent = e.message || "Failed.";
  }
}

function initMediaPanel() {
  document.querySelectorAll(".media-sub").forEach((btn) => {
    btn.addEventListener("click", () => switchMediaPanel(btn.dataset.media));
  });
  switchMediaPanel("status");
  const refresh = $("media-refresh");
  if (refresh) refresh.addEventListener("click", loadMediaStatus);
  const gen = $("media-generate");
  if (gen) gen.addEventListener("click", generateTestImage);
  const regen = $("media-regen-thumb");
  if (regen) regen.addEventListener("click", regenSessionThumbnail);
}

let mediaPanel = "status";

function switchMediaPanel(panel) {
  mediaPanel = panel || "status";
  document.querySelectorAll(".media-sub").forEach((b) =>
    b.classList.toggle("active", b.dataset.media === mediaPanel)
  );
  swapPanelGroup(".media-panel", (p) => p.id === "media-panel-" + mediaPanel);
  icons();
}

// -------------------------------------------------------- UI color palette ----

const UI_PALETTE_KEYS = [
  ["primary", "Primary"],
  ["primary_foreground", "Primary text"],
  ["brand", "Brand"],
  ["brand_2", "Brand gradient"],
  ["blue", "Accent"],
  ["blue_2", "Accent gradient"],
];

function applyUiPalette(palette) {
  if (!palette) return;
  const root = document.documentElement;
  const map = {
    primary: "--primary",
    primary_foreground: "--primary-foreground",
    brand: "--brand",
    brand_2: "--brand-2",
    blue: "--blue",
    blue_2: "--blue-2",
  };
  Object.entries(map).forEach(([k, cssVar]) => {
    const v = palette[k];
    if (v) root.style.setProperty(cssVar, v);
  });
  // Keep accent + ring in sync with primary.
  if (palette.primary) {
    root.style.setProperty("--accent", palette.primary);
    root.style.setProperty("--ring", palette.primary);
    root.style.setProperty("--blue", palette.primary);
  }
  if (palette.brand_2 || palette.blue_2) {
    root.style.setProperty("--blue-2", palette.brand_2 || palette.blue_2);
  }
  const bar = $("palette-preview-bar");
  if (bar) {
    bar.style.setProperty("--preview-primary", palette.primary || "217 91% 60%");
    bar.style.setProperty("--preview-brand-2", palette.brand_2 || palette.blue_2 || "221 83% 53%");
  }
}

async function loadUiPalette() {
  try {
    const data = await (await fetch("/api/ui-palette")).json();
    applyUiPalette(data.palette);
  } catch (e) { /* use CSS defaults */ }
}

async function loadAdminPalette() {
  const presetsEl = $("palette-presets");
  const fieldsEl = $("palette-fields");
  if (!presetsEl || !fieldsEl) return;
  let data = { palette: {}, presets: [] };
  try {
    data = await (await fetch("/api/admin/ui-palette")).json();
  } catch (e) { return; }
  applyUiPalette(data.palette);
  presetsEl.innerHTML = "";
  (data.presets || []).forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "palette-preset" + (p.name === data.palette.name ? " active" : "");
    btn.innerHTML =
      `<span class="palette-swatch" style="background:linear-gradient(135deg,hsl(${p.primary}),hsl(${p.brand_2}))"></span>` +
      `<span>${escapeHtml(p.name)}</span>`;
    btn.addEventListener("click", () => {
      applyUiPalette(p);
      renderPaletteFields(p);
      presetsEl.querySelectorAll(".palette-preset").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
    });
    presetsEl.appendChild(btn);
  });
  renderPaletteFields(data.palette || {});
  icons();
}

function renderPaletteFields(palette) {
  const fieldsEl = $("palette-fields");
  if (!fieldsEl) return;
  fieldsEl.innerHTML = UI_PALETTE_KEYS.map(([key, label]) => {
    const val = palette[key] || "";
    const id = `palette-${key}`;
    return `<label class="palette-field" for="${id}">` +
      `<span>${escapeHtml(label)}</span>` +
      `<input type="text" class="text-input palette-input" id="${id}" data-key="${key}" value="${escapeHtml(val)}" placeholder="e.g. 217 91% 60%" />` +
      `</label>`;
  }).join("");
  fieldsEl.querySelectorAll(".palette-input").forEach((inp) => {
    inp.addEventListener("input", () => {
      const next = collectPaletteFromForm();
      applyUiPalette(next);
    });
  });
}

function collectPaletteFromForm() {
  const palette = { name: "Custom" };
  document.querySelectorAll(".palette-input").forEach((inp) => {
    palette[inp.dataset.key] = inp.value.trim();
  });
  return palette;
}

async function saveAdminPalette() {
  const msg = $("palette-msg");
  const palette = collectPaletteFromForm();
  const nameEl = document.querySelector(".palette-preset.active span:last-child");
  if (nameEl && nameEl.textContent && palette.name === "Custom") {
    palette.name = nameEl.textContent.trim();
  }
  try {
    const res = await fetch("/api/admin/ui-palette", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(palette),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Save failed");
    applyUiPalette(data.palette);
    if (msg) {
      msg.textContent = `Saved “${data.palette.name}” — live for all users.`;
      msg.className = "palette-msg ok";
      msg.classList.remove("hidden");
    }
    loadAdminPalette();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || "Failed to save palette";
      msg.className = "palette-msg err";
      msg.classList.remove("hidden");
    }
  }
}

// ------------------------------------------------------------ voice library ----
// Cloning is user-level: a saved voice-style is reusable across all videos.
// Users pick one saved voice (or none => default Kokoro); no per-slide voices.

async function loadVoices() {
  let defaultPocket = "jane";
  let defaultPreset = "af_heart";
  try {
    const data = await (await fetch("/api/voices")).json();
    voiceLibrary = data.voices || [];
    voicePresets = data.presets || [];
    pocketPresets = data.pocket_presets || [];
    pocketAvailable = !!data.pocket_available;
    voiceLimit = data.limit || 0;
    defaultPocket = (data.default_pocket || "jane").trim() || "jane";
    defaultPreset = (data.default_preset || "af_heart").trim() || "af_heart";
    cloneRecordingText = data.clone_recording_text || cloneRecordingText;
    if (data.tts_warmup && appCaps) {
      appCaps.tts_warmup = data.tts_warmup;
      renderVoiceEngineStatus(appCaps);
    }
    const promptEl = $("voice-record-prompt");
    if (promptEl && cloneRecordingText) promptEl.textContent = cloneRecordingText;
    const pocketPrompt = $("voice-pocket-record-prompt");
    if (pocketPrompt && cloneRecordingText) pocketPrompt.textContent = cloneRecordingText;
  } catch (e) {
    voiceLibrary = [];
    voicePresets = [];
    pocketPresets = [];
  }
  _restoreVoiceSel();
  // No saved selection → Pocket · Jane (server default).
  if (!selectedVoiceId && !selectedPocketVoice && !selectedVoicePreset) {
    selectedPocketVoice = defaultPocket || "jane";
    selectedVoicePreset = null;
    voiceEngine = "pocket";
    _saveVoiceSel();
  } else if (!selectedVoiceId && selectedPocketVoice && !selectedVoicePreset && !_loadVoiceSel()) {
    // Init default with no localStorage yet — persist + align to server default.
    selectedPocketVoice = defaultPocket || "jane";
    voiceEngine = "pocket";
    _saveVoiceSel();
  }
  // Align preset fallback if somehow only kokoro selected without id
  if (!selectedVoiceId && !selectedPocketVoice && selectedVoicePreset === null) {
    selectedVoicePreset = defaultPreset;
  }
  sanitizeNarrationVoice();
  renderVoices();
}

function _loadVoiceSel() {
  try { return JSON.parse(localStorage.getItem(VOICE_SEL_KEY) || "null"); }
  catch (e) { return null; }
}

function _saveVoiceSel() {
  try {
    if (selectedVoiceId) {
      localStorage.setItem(VOICE_SEL_KEY, JSON.stringify({ kind: "clone", id: selectedVoiceId }));
    } else if (selectedPocketVoice) {
      localStorage.setItem(VOICE_SEL_KEY, JSON.stringify({ kind: "pocket", preset: selectedPocketVoice }));
    } else {
      localStorage.setItem(VOICE_SEL_KEY, JSON.stringify({ kind: "preset", preset: selectedVoicePreset || "af_heart" }));
    }
  } catch (e) { /* ignore */ }
}

function _restoreVoiceSel() {
  const saved = _loadVoiceSel();
  if (!saved) return;
  if (saved.kind === "clone" && saved.id && voiceLibrary.some((v) => v.id === saved.id)) {
    if (voiceHasTtsClone(voiceLibrary.find((v) => v.id === saved.id))) {
      selectedVoiceId = saved.id;
      selectedVoicePreset = null;
      selectedPocketVoice = null;
      return;
    }
  }
  if (saved.kind === "pocket" && saved.preset) {
    selectedVoiceId = null;
    selectedVoicePreset = null;
    // Migrate old defaults: alba → jane; keep explicit user picks otherwise.
    selectedPocketVoice = saved.preset === "alba" ? "jane" : saved.preset;
    voiceEngine = "pocket";
    if (saved.preset === "alba") _saveVoiceSel();
    return;
  }
  if (saved.kind === "preset" && saved.preset) {
    selectedVoiceId = null;
    selectedPocketVoice = null;
    selectedVoicePreset = saved.preset;
    voiceEngine = "kokoro";
  }
}

function voiceHasTtsClone(v) {
  if (!v) return false;
  // Only a real style JSON or cloud voice — not "recording that might clone later".
  return !!(v.has_style || v.has_cloud_voice);
}

function narrationVoiceReady() {
  if (!selectedVoiceId) return true;
  return voiceHasTtsClone(selectedVoiceRecord());
}

/** Keep narration selection limited to Default/preset or clone-ready voices. */
function sanitizeNarrationVoice() {
  if (selectedVoiceId && !narrationVoiceReady()) {
    selectedVoiceId = null;
    if (!selectedVoicePreset) selectedVoicePreset = "af_heart";
    _saveVoiceSel();
    return true;
  }
  return false;
}

function setNarrationVoice(id) {
  const vid = id || null;
  if (!vid) {
    selectedVoiceId = null;
    manageVoiceId = null;
    if (!selectedVoicePreset && !selectedPocketVoice) selectedVoicePreset = "af_heart";
    _saveVoiceSel();
    return true;
  }
  const v = voiceLibrary.find((x) => x.id === vid);
  if (!v) return false;
  if (!voiceHasTtsClone(v)) return false;
  selectedVoiceId = vid;
  selectedVoicePreset = null;
  selectedPocketVoice = null;
  manageVoiceId = null;
  voiceEngine = (v.kind === "pocket" || (v.style_source || "").startsWith("pocket"))
    ? "pocket"
    : "clones";
  _saveVoiceSel();
  return true;
}

function setVoicePreset(presetId) {
  const id = (presetId || "").trim();
  if (!id) return false;
  selectedVoiceId = null;
  selectedPocketVoice = null;
  selectedVoicePreset = id;
  manageVoiceId = null;
  voiceEngine = "kokoro";
  _saveVoiceSel();
  return true;
}

function setPocketVoice(presetId) {
  const id = (presetId || "").trim();
  if (!id) return false;
  selectedVoiceId = null;
  selectedVoicePreset = null;
  selectedPocketVoice = id;
  manageVoiceId = null;
  voiceEngine = "pocket";
  _saveVoiceSel();
  return true;
}

function selectedPresetRecord() {
  return voicePresets.find((p) => p.id === selectedVoicePreset) || null;
}

function selectedPocketRecord() {
  return pocketPresets.find((p) => p.id === selectedPocketVoice) || null;
}

function updateVoiceSelectedBar() {
  updateVoiceNowCard();
}

function updateVoiceNowCard() {
  const now = $("voice-now");
  const nameEl = $("voice-now-name");
  const subEl = $("voice-now-sub");
  if (!now || !nameEl) return;
  const narrating = selectedVoiceRecord();
  if (narrating && voiceHasTtsClone(narrating)) {
    nameEl.textContent = narrating.name;
    if (subEl) subEl.textContent = voiceCloneSub(narrating);
    return;
  }
  if (selectedPocketVoice) {
    const pocket = selectedPocketRecord();
    nameEl.textContent = (pocket && pocket.label) || selectedPocketVoice;
    if (subEl) {
      subEl.textContent = pocket
        ? `Pocket · ${pocket.vibe || pocket.accent || "catalog"}`
        : "Pocket · catalog voice";
    }
    return;
  }
  const preset = selectedPresetRecord();
  nameEl.textContent = (preset && preset.label) || "Heart";
  if (subEl) {
    subEl.textContent = preset
      ? `Kokoro · ${preset.vibe || preset.accent || "built-in"}`
      : "Kokoro · warm default";
  }
}

function selectedVoiceRecord() {
  return voiceLibrary.find((v) => v.id === selectedVoiceId) || null;
}

function updateVoiceSaveEnabled() {
  const btn = $("voice-save-btn");
  const name = ($("voice-name")?.value || "").trim();
  if (!btn) return;
  if (voiceAddMode === "record") {
    btn.disabled = !(name && pendingVoiceRecordingBlob);
  } else {
    btn.disabled = !(name && pendingVoiceFile);
  }
}

function voiceCloneSub(v) {
  const src = v.style_source || "";
  if (v.kind === "pocket" || src === "pocket_clone" || src === "pocket_upload") {
    return "Pocket TTS clone · .safetensors";
  }
  if (v.has_cloud_voice) return "Cloud clone · Supertone API";
  if (src === "optimized") return "Cloned from your recording · optimized";
  if (src === "voice_builder" || src === "voice_builder_cmd" || src === "upload") {
    return "Voice Builder JSON · ready for narration";
  }
  if (src === "preset_match") return "Weak clone · tap Rebuild to improve";
  if (v.has_style) return "Ready for narration · Supertonic 3";
  if (v.has_recording) {
    if (v.can_auto_clone || (appCaps && appCaps.voice_auto_clone)) {
      return "Recording saved · tap Rebuild to clone (or run pipeline)";
    }
    return "Recording saved · install Supertonic / set SUPERTONE_API_KEY to clone";
  }
  return "Saved voice";
}

function setVoiceEngine(engine) {
  const e = (engine || "").trim();
  voiceEngine = e === "clones" || e === "pocket" ? e : "kokoro";
  try { localStorage.setItem("mms_voice_engine", voiceEngine); } catch (err) {}
  document.querySelectorAll(".voice-engine-tab").forEach((btn) => {
    const on = (btn.dataset.engine || "") === voiceEngine;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-engine-pane]").forEach((pane) => {
    pane.classList.toggle("hidden", (pane.dataset.enginePane || "") !== voiceEngine);
  });
}

function renderVoices() {
  const presetGrid = $("voice-preset-grid");
  const pocketGrid = $("voice-pocket-grid");
  const cloneGrid = $("voice-clone-grid");
  const hint = $("voice-limit-hint");
  const tab = $("left-tab-voices");
  if (!presetGrid && !cloneGrid && !pocketGrid) return;

  // Keep engine sub-tab in sync with current narration selection when useful.
  if (selectedVoiceId && voiceHasTtsClone(selectedVoiceRecord())) {
    // stay on whichever tab user picked; don't force-switch mid-render
  }

  setVoiceEngine(voiceEngine);

  const sel = selectedVoiceRecord();
  let selectedName = (selectedPresetRecord() && selectedPresetRecord().label) || "Heart";
  if (selectedPocketVoice) {
    selectedName = (selectedPocketRecord() && selectedPocketRecord().label) || selectedPocketVoice;
  }
  if (selectedVoiceId && sel && voiceHasTtsClone(sel)) {
    selectedName = `${sel.name} · clone`;
  }
  if (hint) hint.textContent = `${voiceLibrary.length}/${voiceLimit} clones · ${selectedName}`;
  if (tab) {
    const badge = voiceLibrary.length ? ` (${voiceLibrary.length})` : "";
    tab.innerHTML = `<i data-lucide="mic"></i> Voices${badge}`;
  }

  document.querySelectorAll("#voice-filter .voice-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.filter || "all") === voiceFilter);
  });
  document.querySelectorAll(".voice-pocket-filter-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.filter || "all") === pocketFilter);
  });

  const labelPresets = $("voice-label-presets");
  const labelClones = $("voice-label-clones");
  // Labels live inside engine panes; keep visible within the active pane.
  if (labelPresets) labelPresets.classList.remove("hidden");
  if (labelClones) labelClones.classList.remove("hidden");

  if (presetGrid) {
    presetGrid.innerHTML = "";
    const presets = (voicePresets || []).filter((p) => {
      if (voiceFilter === "female") return p.gender === "female";
      if (voiceFilter === "male") return p.gender === "male";
      return true;
    });
    if (!presets.length) {
      presetGrid.innerHTML = `<div class="voice-empty-clones">No Kokoro voices match this filter.</div>`;
    }
    presets.forEach((p, i) => {
      const active = !selectedVoiceId && !selectedPocketVoice && selectedVoicePreset === p.id;
      const card = document.createElement("div");
      card.className = "voice-card" + (active ? " active" : "");
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.style.setProperty("--i", String(i));
      card.style.setProperty("--vh", String(p.hue || 262));
      const initial = (p.label || p.id || "?").slice(0, 1).toUpperCase();
      card.innerHTML =
        `<span class="voice-card-check" aria-hidden="true"><i data-lucide="check"></i></span>` +
        `<span class="voice-card-avatar">${escapeHtml(initial)}</span>` +
        `<span class="voice-card-name">${escapeHtml(p.label || p.id)}</span>` +
        `<span class="voice-card-vibe">${escapeHtml(p.vibe || "")}</span>` +
        `<span class="voice-card-meta">` +
        `<span class="voice-pill">${escapeHtml(p.gender || "")}</span>` +
        `<span class="voice-pill">${escapeHtml(p.accent || "")}</span>` +
        (p.tag ? `<span class="voice-pill rec">${escapeHtml(p.tag)}</span>` : "") +
        `</span>`;
      const pick = () => {
        setVoicePreset(p.id);
      renderVoices();
      if (lastJob) renderRecorder(lastJob);
      };
      card.addEventListener("click", pick);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
      presetGrid.appendChild(card);
    });
  }

  if (pocketGrid) {
    pocketGrid.innerHTML = "";
    if (!pocketAvailable && !(appCaps && appCaps.pocket)) {
      pocketGrid.innerHTML =
        `<div class="voice-empty-clones">Pocket TTS not installed. Run <code>pip install pocket-tts</code> then refresh.</div>`;
    } else {
      const presets = (pocketPresets || []).filter((p) => {
        if (pocketFilter === "female") return p.gender === "female";
        if (pocketFilter === "male") return p.gender === "male";
        return true;
      });
      if (!presets.length) {
        pocketGrid.innerHTML = `<div class="voice-empty-clones">No Pocket voices match this filter.</div>`;
      }
      presets.forEach((p, i) => {
        const active = !selectedVoiceId && selectedPocketVoice === p.id;
        const card = document.createElement("div");
        card.className = "voice-card" + (active ? " active" : "");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.style.setProperty("--i", String(i));
        card.style.setProperty("--vh", String(p.hue || 200));
        const initial = (p.label || p.id || "?").slice(0, 1).toUpperCase();
        card.innerHTML =
          `<span class="voice-card-check" aria-hidden="true"><i data-lucide="check"></i></span>` +
          `<span class="voice-card-avatar">${escapeHtml(initial)}</span>` +
          `<span class="voice-card-name">${escapeHtml(p.label || p.id)}</span>` +
          `<span class="voice-card-vibe">${escapeHtml(p.vibe || "")}</span>` +
          `<span class="voice-card-meta">` +
          `<span class="voice-pill">${escapeHtml(p.gender || "")}</span>` +
          `<span class="voice-pill">${escapeHtml(p.accent || "")}</span>` +
          (p.tag ? `<span class="voice-pill rec">${escapeHtml(p.tag)}</span>` : "") +
          `</span>`;
        const pick = () => {
          setPocketVoice(p.id);
          renderVoices();
          if (lastJob) renderRecorder(lastJob);
        };
        card.addEventListener("click", pick);
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        });
        pocketGrid.appendChild(card);
      });
    }
  }

  if (cloneGrid) {
    cloneGrid.innerHTML = "";
    if (!voiceLibrary.length) {
      cloneGrid.innerHTML = `<div class="voice-empty-clones">No clones yet — record or upload below to sound like you.</div>`;
    } else {
      voiceLibrary.forEach((v, i) => {
        const ready = voiceHasTtsClone(v);
        const active = selectedVoiceId === v.id;
        const card = document.createElement("div");
        card.className = "voice-card" + (active ? " active" : "") + (!ready ? " recording-only" : "");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        card.style.setProperty("--i", String(i));
        card.style.setProperty("--vh", String(ready ? 158 : 38));
        const initial = (v.name || "?").slice(0, 1).toUpperCase();
        card.innerHTML =
          `<span class="voice-card-check" aria-hidden="true"><i data-lucide="check"></i></span>` +
          `<span class="voice-card-avatar">${escapeHtml(initial)}</span>` +
          `<span class="voice-card-name">${escapeHtml(v.name || "Clone")}</span>` +
          `<span class="voice-card-vibe">${escapeHtml(voiceCloneSub(v))}</span>` +
          `<span class="voice-card-meta"><span class="voice-pill rec">${ready ? "Ready" : "Setup"}</span></span>` +
          `<span class="voice-card-actions"></span>`;
        const actions = card.querySelector(".voice-card-actions");
        if (v.has_recording) {
      const rebuild = document.createElement("button");
      rebuild.type = "button";
      rebuild.className = "voice-rebuild-btn";
      rebuild.innerHTML = '<i data-lucide="refresh-cw"></i> Rebuild';
      rebuild.addEventListener("click", (e) => {
        e.stopPropagation();
        rebuildVoiceStyle(v.id);
      });
          actions.appendChild(rebuild);
        }
        const del = document.createElement("button");
        del.type = "button";
        del.className = "voice-del";
        del.title = "Delete voice";
        del.innerHTML = '<i data-lucide="trash-2"></i>';
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteVoice(v.id);
        });
        actions.appendChild(del);
        const pick = () => {
          if (!ready) {
            showAlert("Rebuild this clone before using it for narration.");
            return;
          }
          setNarrationVoice(v.id);
          renderVoices();
          if (lastJob) renderRecorder(lastJob);
        };
        card.addEventListener("click", (e) => {
          if (e.target.closest(".voice-rebuild-btn, .voice-del")) return;
          pick();
        });
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        });
        cloneGrid.appendChild(card);
      });
    }
  }

  // Clone count badge on Clones engine tab
  document.querySelectorAll(".voice-engine-tab[data-engine='clones']").forEach((btn) => {
    const n = voiceLibrary.length;
    btn.innerHTML = n
      ? `<i data-lucide="user-round"></i> Clones (${n})`
      : `<i data-lucide="user-round"></i> Clones`;
  });

  const add = $("voice-add");
  if (add) {
    const full = voiceLibrary.length >= voiceLimit;
    add.classList.toggle("disabled", full);
    const sum = add.querySelector("summary");
    if (sum) sum.style.pointerEvents = full ? "none" : "";
  }
  updateVoiceNowCard();
  icons();
}

function setVoiceFile(file) {
  if (!file) return;
  pendingVoiceFile = file;
  $("voice-dropzone").classList.add("has-file");
  $("voice-dz-main").textContent = file.name;
  updateVoiceSaveEnabled();
}

function resetVoiceAddForm() {
  $("voice-name").value = "";
  $("voice-input").value = "";
  pendingVoiceFile = null;
  pendingVoiceRecordingBlob = null;
  $("voice-dropzone")?.classList.remove("has-file");
  const vm = $("voice-dz-main");
  if (vm) vm.textContent = "Upload a voice-style JSON";
  const playback = $("voice-rec-playback");
  if (playback) { playback.src = ""; playback.classList.add("hidden"); }
  $("voice-rec-start")?.classList.remove("hidden");
  $("voice-rec-stop")?.classList.add("hidden");
  updateVoiceSaveEnabled();
}

async function rebuildVoiceStyle(voiceId) {
  if (!voiceId) return;
  const bar = $("voice-status");
  const setBar = (html, kind) => {
    if (!bar) {
      if (kind === "warn") showAlert(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      return;
    }
    bar.classList.remove("hidden");
    bar.className = "voice-status " + (kind || "warn");
    bar.innerHTML = html;
    icons();
  };
  setBar('<span class="spinner"></span> Rebuilding voice clone from your recording…', "warn");
  try {
    const res = await fetch(`/api/voices/${voiceId}/rebuild-style`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Rebuild failed"));
    const v = data.voice || {};
    await loadVoices();
    if (v.id) setNarrationVoice(v.id);
    const src = v.style_source || "optimized";
    setBar(
      `<i data-lucide="check-circle"></i> <strong>${escapeHtml(v.name || "Voice")}</strong> rebuilt (${escapeHtml(src)}). Preview to compare.`,
      "ok"
    );
    updateVoiceNowCard();
  } catch (e) {
    setBar(`<i data-lucide="alert-circle"></i> ${escapeHtml(e.message || "Rebuild failed.")}`, "warn");
  }
}

async function saveVoice() {
  const name = ($("voice-name").value || "").trim();
  const msg = $("voice-add-msg");
  const show = (t, ok) => {
    if (msg) {
      msg.textContent = t;
      msg.classList.remove("hidden");
      msg.classList.toggle("err", !ok);
      msg.classList.toggle("ok", !!ok);
    }
  };
  if (!name) { show("Give the voice a name.", false); return; }
  if (voiceAddMode === "record") {
    if (!pendingVoiceRecordingBlob) { show("Record your voice reading the sample text first.", false); return; }
  } else if (!pendingVoiceFile) {
    show("Upload a voice-style JSON first.", false);
    return;
  }
  const btn = $("voice-save-btn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Saving & cloning…'; }
  try {
    const form = new FormData();
    form.append("name", name);
    if (voiceAddMode === "record") {
      form.append("recording", pendingVoiceRecordingBlob, "voice_sample.webm");
    } else {
      form.append("style", pendingVoiceFile);
    }
    const res = await fetch("/api/voices", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Save failed"));
    const saved = data.voice || {};
    if (voiceHasTtsClone(saved)) {
      setNarrationVoice(saved.id);
      show(`"${name}" saved and selected for narration.`, true);
    } else {
      show(`"${name}" saved, but auto-clone is unavailable. Install Supertonic or use Default voice.`, false);
    }
    resetVoiceAddForm();
    $("voice-add")?.removeAttribute("open");
    await loadVoices();
    const chip = document.querySelector(`.voice-chip[data-voice="${saved.id || ""}"]`);
    chip?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    chip?.classList.add("voice-chip-flash");
    setTimeout(() => chip?.classList.remove("voice-chip-flash"), 1800);
  } catch (e) {
    show(e.message || "Failed to save voice.", false);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; icons(); updateVoiceSaveEnabled(); }
  }
}

function setVoiceAddMode(mode) {
  voiceAddMode = mode === "upload" ? "upload" : "record";
  document.querySelectorAll("#voice-mode-tabs .voice-mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === voiceAddMode)
  );
  swapPanelGroup("#voice-record-panel, #voice-upload-panel", (p) =>
    (p.id === "voice-record-panel" && voiceAddMode === "record") ||
    (p.id === "voice-upload-panel" && voiceAddMode === "upload")
  );
  updateVoiceSaveEnabled();
}

function updatePocketSaveEnabled() {
  const btn = $("voice-pocket-save-btn");
  const name = ($("voice-pocket-name")?.value || "").trim();
  if (!btn) return;
  if (pocketAddMode === "record") {
    btn.disabled = !(name && pendingPocketRecordingBlob);
  } else {
    btn.disabled = !(name && pendingPocketFile);
  }
}

function setPocketFile(file) {
  if (!file) return;
  pendingPocketFile = file;
  $("voice-pocket-dropzone")?.classList.add("has-file");
  const main = $("voice-pocket-dz-main");
  if (main) main.textContent = file.name;
  updatePocketSaveEnabled();
}

function setPocketAddMode(mode) {
  pocketAddMode = mode === "upload" ? "upload" : "record";
  document.querySelectorAll("#voice-pocket-mode-tabs .voice-mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === pocketAddMode)
  );
  swapPanelGroup("#voice-pocket-record-panel, #voice-pocket-upload-panel", (p) =>
    (p.id === "voice-pocket-record-panel" && pocketAddMode === "record") ||
    (p.id === "voice-pocket-upload-panel" && pocketAddMode === "upload")
  );
  updatePocketSaveEnabled();
}

async function savePocketVoice() {
  const name = ($("voice-pocket-name")?.value || "").trim();
  const msg = $("voice-pocket-add-msg");
  const show = (t, ok) => {
    if (msg) {
      msg.textContent = t;
      msg.classList.remove("hidden");
      msg.classList.toggle("err", !ok);
      msg.classList.toggle("ok", !!ok);
    }
  };
  if (!name) { show("Give the voice a name.", false); return; }
  if (pocketAddMode === "record") {
    if (!pendingPocketRecordingBlob) { show("Record your voice first.", false); return; }
  } else if (!pendingPocketFile) {
    show("Upload a wav / mp3 / .safetensors file first.", false);
    return;
  }
  const btn = $("voice-pocket-save-btn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Cloning…'; }
  try {
    const form = new FormData();
    form.append("name", name);
    form.append("engine", "pocket");
    if (pocketAddMode === "record") {
      form.append("recording", pendingPocketRecordingBlob, "voice_sample.webm");
    } else {
      form.append("style", pendingPocketFile);
    }
    const res = await fetch("/api/voices", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Save failed"));
    const saved = data.voice || {};
    if (voiceHasTtsClone(saved)) {
      setNarrationVoice(saved.id);
      show(`"${name}" saved as Pocket clone and selected.`, true);
    } else {
      show(`"${name}" saved but not ready for narration.`, false);
    }
    pendingPocketFile = null;
    pendingPocketRecordingBlob = null;
    const nameEl = $("voice-pocket-name");
    if (nameEl) nameEl.value = "";
    $("voice-pocket-dropzone")?.classList.remove("has-file");
    const dz = $("voice-pocket-dz-main");
    if (dz) dz.textContent = "Upload wav / mp3 / .safetensors";
    const playback = $("voice-pocket-rec-playback");
    if (playback) { playback.src = ""; playback.classList.add("hidden"); }
    $("voice-pocket-add")?.removeAttribute("open");
    await loadVoices();
  } catch (e) {
    show(e.message || "Failed to save Pocket voice.", false);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; icons(); updatePocketSaveEnabled(); }
  }
}

async function togglePocketLibRecord() {
  const startBtn = $("voice-pocket-rec-start");
  const stopBtn = $("voice-pocket-rec-stop");
  const playback = $("voice-pocket-rec-playback");
  if (pocketLibRecorder && pocketLibRecorder.rec.state === "recording") {
    pocketLibRecorder.rec.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showAlert("Microphone recording is not supported in this browser.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showAlert("Microphone permission denied.");
    return;
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  pocketLibRecorder = { rec, stream, chunks };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    pendingPocketRecordingBlob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    if (playback) {
      playback.src = URL.createObjectURL(pendingPocketRecordingBlob);
      playback.classList.remove("hidden");
    }
    startBtn?.classList.remove("hidden");
    stopBtn?.classList.add("hidden");
    pocketLibRecorder = null;
    updatePocketSaveEnabled();
    icons();
  };
  rec.start();
  startBtn?.classList.add("hidden");
  stopBtn?.classList.remove("hidden");
  icons();
}

async function toggleVoiceLibRecord() {
  const startBtn = $("voice-rec-start");
  const stopBtn = $("voice-rec-stop");
  const playback = $("voice-rec-playback");
  if (voiceLibRecorder && voiceLibRecorder.rec.state === "recording") {
    voiceLibRecorder.rec.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showAlert("Microphone recording is not supported in this browser.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showAlert("Microphone permission denied.");
    return;
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  voiceLibRecorder = { rec, stream, chunks };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    startBtn?.classList.remove("hidden");
    stopBtn?.classList.add("hidden");
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    pendingVoiceRecordingBlob = blob;
    if (playback) {
      playback.src = URL.createObjectURL(blob);
      playback.classList.remove("hidden");
    }
    updateVoiceSaveEnabled();
    icons();
  };
  rec.start();
  startBtn?.classList.add("hidden");
  stopBtn?.classList.remove("hidden");
  icons();
}

async function previewVoice() {
  const btn = $("voice-preview-btn");
  const audio = $("voice-preview-audio");
  const now = $("voice-now");
  if (!audio) return;
  const previewId = (selectedVoiceId && narrationVoiceReady())
    ? selectedVoiceId
    : manageVoiceId;
  const sel = previewId ? voiceLibrary.find((v) => v.id === previewId) : null;
  const isPocketClone = !!(
    sel
    && (sel.kind === "pocket"
      || (sel.style_source || "").startsWith("pocket")
      || pendingPocketFile)
  );
  // Cloud clones only need SUPERTONE_API_KEY; local JSON needs the package.
  const needsLocalSupertonic = !!(
    pendingVoiceFile
    || (sel && sel.has_style && !sel.has_cloud_voice && !isPocketClone)
  );
  if (needsLocalSupertonic && appCaps && !appCaps.supertonic) {
    showAlert("Local clone preview needs Supertonic 3 (pip install supertonic). Cloud clones work with SUPERTONE_API_KEY.");
    return;
  }
  if ((selectedPocketVoice || isPocketClone || pendingPocketFile) && appCaps && !appCaps.pocket && !pocketAvailable) {
    showAlert("Pocket TTS is not installed. Run: pip install pocket-tts");
    return;
  }
  if (pendingVoiceRecordingBlob && !previewId && !pendingVoiceFile && voiceEngine !== "pocket") {
    audio.src = URL.createObjectURL(pendingVoiceRecordingBlob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
    return;
  }
  if (pendingPocketRecordingBlob && !previewId && !pendingPocketFile && voiceEngine === "pocket") {
    audio.src = URL.createObjectURL(pendingPocketRecordingBlob);
    audio.classList.remove("hidden");
    audio.play().catch(() => {});
    return;
  }
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Generating…`; }
  const form = new FormData();
  if (previewId) form.append("voice_id", previewId);
  else if (selectedPocketVoice) form.append("pocket_voice", selectedPocketVoice);
  else if (selectedVoicePreset) form.append("voice_preset", selectedVoicePreset);
  if (pendingPocketFile && voiceEngine === "pocket") {
    form.append("style", pendingPocketFile, pendingPocketFile.name);
  } else if (pendingVoiceFile) {
    form.append("style", pendingVoiceFile, pendingVoiceFile.name);
  }
  try {
    const res = await fetch("/api/voices/preview", { method: "POST", body: form });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(apiDetail(d, "Preview failed"));
    }
    const blob = await res.blob();
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove("hidden");
    now?.classList.add("playing");
    audio.onended = () => now?.classList.remove("playing");
    await audio.play();
  } catch (e) {
    now?.classList.remove("playing");
    showAlert(e.message || "Voice preview failed");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '<i data-lucide="play"></i> Preview'; icons(); }
  }
}

async function deleteVoice(id) {
  try { await fetch(`/api/voices/${id}`, { method: "DELETE" }); } catch (e) { /* ignore */ }
  if (selectedVoiceId === id) {
    selectedVoiceId = null;
    if (!selectedVoicePreset) selectedVoicePreset = "af_heart";
    _saveVoiceSel();
  }
  if (manageVoiceId === id) manageVoiceId = null;
  loadVoices();
}

function setFile(file) {
  if (!file) return;
  // Accept any document/image; the backend extracts what it can and warns
  // (in the Extract step) if a type isn't supported.
  selectedFile = file;
  topicPlanId = null;
  topicPlanData = null;
  topicSelected = new Set();
  $("dropzone").classList.add("has-file");
  $("dz-main").textContent = file.name;
  $("dz-sub").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB \u00b7 ready`;
  $("run-btn").disabled = false;
  hideAlert();
  const card = $("topic-plan-card");
  const body = $("topic-plan-body");
  if (card) {
    card.classList.remove("hidden");
    const big = file.size > 1.5 * 1024 * 1024; // ~1.5MB+ → likely long doc
    $("topic-plan-meta").textContent = big
      ? "Large file detected — plan topics so you can ship one video or many."
      : "Optional: classify into topics for one or multiple videos.";
    if (body) body.classList.add("hidden");
    $("topic-plan-refresh")?.setAttribute("hidden", "");
    $("topic-plan-list") && ($("topic-plan-list").innerHTML = "");
  }
  icons();
}

function topicMode() {
  return document.querySelector('input[name="topic-mode"]:checked')?.value || "per_topic";
}

function updateTopicCount() {
  const el = $("topic-selected-count");
  if (el) el.textContent = `${topicSelected.size} selected`;
}

function renderTopicPlan(breakdown) {
  const list = $("topic-plan-list");
  const body = $("topic-plan-body");
  const meta = $("topic-plan-meta");
  if (!list || !breakdown) return;
  body?.classList.remove("hidden");
  $("topic-plan-refresh")?.removeAttribute("hidden");
  const topics = breakdown.topics || [];
  const rec = new Set(breakdown.recommended_ids || []);
  if (!topicSelected.size) {
    topics.forEach((t) => {
      if (rec.has(t.id) || t.recommended) topicSelected.add(t.id);
    });
  }
  meta.textContent = `${breakdown.title || "Document"} · ${topics.length} topics · ~${breakdown.words || "?"} words`
    + (breakdown.grouping_note ? ` — ${breakdown.grouping_note}` : "");
  list.innerHTML = topics.map((t) => {
    const checked = topicSelected.has(t.id) ? "checked" : "";
    const recBadge = (t.recommended || rec.has(t.id))
      ? `<span class="topic-rec">rec</span>` : "";
    const mins = t.estimated_minutes ? `${t.estimated_minutes}m` : "";
    const focus = (t.focus || []).slice(0, 2).join(" · ");
    return `<label class="topic-item">
      <input type="checkbox" data-topic-id="${escAttr(t.id)}" ${checked} />
      <div class="topic-item-main">
        <div class="topic-item-title">${escapeHtml(t.name || "Topic")}${recBadge}</div>
        <div class="topic-item-sum">${escapeHtml(t.summary || "")}</div>
        ${focus ? `<div class="topic-item-focus">${escapeHtml(focus)}</div>` : ""}
      </div>
      <div class="topic-item-meta">L${escapeHtml(String(t.level || 1))}${mins ? ` · ${escapeHtml(mins)}` : ""}</div>
    </label>`;
  }).join("");
  list.querySelectorAll("[data-topic-id]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) topicSelected.add(cb.dataset.topicId);
      else topicSelected.delete(cb.dataset.topicId);
      updateTopicCount();
    });
  });
  updateTopicCount();
  icons();
}

function escAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function planDocumentTopics({ refresh = false } = {}) {
  if (!selectedFile && !topicPlanId) {
    showAlert("Drop a document first.");
    return;
  }
  const btn = $("topic-plan-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Planning…';
  }
  hideAlert();
  try {
    if (refresh && topicPlanId) {
      const res = await fetch(`/api/jobs/${topicPlanId}/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_topics: 80 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(apiDetail(err, "Reclassify failed"));
      }
      const data = await res.json();
      topicPlanData = data.topics || data;
      topicSelected = new Set();
      renderTopicPlan(topicPlanData);
      return;
    }
    const form = new FormData();
    form.append("file", selectedFile);
    form.append("video_format", selectedFormat);
    form.append("video_theme", selectedTheme);
    form.append("video_style", selectedStyle);
    form.append("target_duration", String(selectedDuration || 0));
    form.append("content_layout", $("content-layout")?.value || "auto");
    const res = await fetch("/api/jobs/plan", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiDetail(err, "Topic planning failed"));
    }
    const data = await res.json();
    topicPlanId = data.plan_id || data.job_id;
    topicPlanData = data.topics;
    topicSelected = new Set();
    renderTopicPlan(topicPlanData);
    $("topic-plan-card")?.classList.remove("hidden");
  } catch (e) {
    showAlert(e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="scan-search"></i> Plan topics';
      icons();
    }
  }
}

async function runFromTopicPlan() {
  if (!topicPlanId || !topicSelected.size) {
    showAlert("Select at least one topic (or run Plan topics first).");
    return;
  }
  const btn = $("run-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Queuing videos…';
  hideAlert();
  try {
    const groundingOn = $("topic-grounding-switch")?.classList.contains("on") !== false;
    const res = await fetch("/api/jobs/from-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan_id: topicPlanId,
        selected_ids: [...topicSelected],
        mode: topicMode(),
        video_format: selectedFormat,
        video_theme: selectedTheme,
        video_style: selectedStyle,
        target_duration: selectedDuration || 0,
        content_layout: $("content-layout")?.value || "auto",
        enable_web_research: groundingOn,
        deep_grounding: groundingOn,
        extra_topics: $("topics-input")?.value || "",
        ...audienceJobFields(),
        ...(selectedVoiceId ? { voice_id: selectedVoiceId } : {}),
        ...(selectedPocketVoice && !selectedVoiceId ? { pocket_voice: selectedPocketVoice } : {}),
        ...(selectedVoicePreset && !selectedVoiceId && !selectedPocketVoice
          ? { voice_preset: selectedVoicePreset } : {}),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiDetail(err, "Failed to create videos"));
    }
    const data = await res.json();
    jobId = data.primary_job_id || (data.job_ids || [])[0];
    try { localStorage.setItem("ms_studio_job_id", jobId); } catch (e) {}
    $("progress-card")?.classList.remove("hidden");
    if (jobId) connectStream(jobId);
    loadSessions();
    const n = (data.job_ids || []).length;
    showAlert(
      data.mode === "single"
        ? "Queued 1 combined video from your selected topics."
        : `Queued ${n} video${n === 1 ? "" : "s"} — one per topic. Visual style stays synced.`
    );
  } catch (e) {
    showAlert(e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="play"></i> Run pipeline';
    icons();
  }
}

function showAlert(msg) {
  const a = $("upload-alert");
  if (!a) { console.warn(msg); return; }
  a.textContent = msg;
  a.classList.remove("hidden");
}
function hideAlert() { $("upload-alert").classList.add("hidden"); }

function getOpenEditors() {
  const state = {};
  document.querySelectorAll(".editor").forEach((t) => {
    state[t.dataset.field] = {
      value: t.value,
      focused: document.activeElement === t,
      start: t.selectionStart,
      end: t.selectionEnd,
    };
  });
  return state;
}

/** Stable path without ?v= bust — used to avoid reloading images every SSE tick. */
function pathOnly(url) {
  return String(url || "").split("?")[0];
}

/** Set img/video src with bust only when the artifact path actually changed. */
function setStableMediaSrc(el, url) {
  if (!el || !url) return false;
  const nextPath = pathOnly(url);
  if (pathOnly(el.getAttribute("src")) === nextPath && el.getAttribute("src")) return false;
  el.setAttribute("src", bust(url));
  return true;
}

/** Write HTML only when it changed; returns true if DOM was mutated. */
function setStableHtml(el, html) {
  if (!el) return false;
  if (el.dataset.stableHtml === html) return false;
  el.dataset.stableHtml = html;
  el.innerHTML = html;
  return true;
}

/** Drop stable/icon caches so in-place spinner mutations cannot stick forever. */
function invalidateStable(el) {
  if (!el) return;
  delete el.dataset.stableHtml;
  delete el.dataset.iconHtml;
  el.querySelectorAll("[data-icon-html]").forEach((node) => {
    delete node.dataset.iconHtml;
  });
}

/**
 * Busy-state for buttons that may be destroyed by a re-render.
 * Restores by selector when the original node was replaced.
 */
function beginBusy(btn, html, { find } = {}) {
  if (!btn) return () => {};
  const orig = btn.innerHTML;
  const iconSnap = btn.dataset.iconHtml;
  btn.disabled = true;
  delete btn.dataset.iconHtml;
  btn.innerHTML = html;
  return () => {
    const live = (typeof find === "function" ? find() : null) || (btn.isConnected ? btn : null);
    if (!live) return;
    live.disabled = false;
    if (iconSnap != null) live.dataset.iconHtml = iconSnap;
    else delete live.dataset.iconHtml;
    live.innerHTML = orig;
    icons();
  };
}

/** Structure-only snap — status/detail patch in place to avoid SSE flicker. */
function stagesSnap(job) {
  const c = job.content || {};
  const o = job.options || {};
  return JSON.stringify({
    id: job.id || jobId,
    keys: (job.stages || []).map((s) => [s.key, s.label]),
    warn: c.extract_warning || "",
    extract: c.extracted_text != null,
    narr: c.narration != null,
    style: o.video_style || "",
    theme: o.video_theme || "",
    layout: o.content_layout || "",
    voice: o.voice_id || o.pocket_voice || o.voice_preset || "",
    age: o.age_group || "",
    knowledge: o.knowledge_level || "",
    review: (c.content_review && c.content_review.score) || "",
  });
}

function getStageLookState() {
  const style = $("stage-look-style");
  const theme = $("stage-look-theme");
  const voice = $("stage-look-voice");
  const layout = $("stage-look-layout");
  const age = $("stage-look-age");
  const knowledge = $("stage-look-knowledge");
  if (!style && !theme && !voice && !layout) return null;
  return {
    style: style?.value,
    theme: theme?.value,
    voice: voice?.value,
    layout: layout?.value,
    age_group: age?.value,
    knowledge_level: knowledge?.value,
  };
}

function jobVoiceSelectValue(job) {
  const o = (job && job.options) || {};
  if (o.voice_id) return `clone:${o.voice_id}`;
  if (o.pocket_voice) return `pocket:${o.pocket_voice}`;
  if (o.voice_preset) return `kokoro:${o.voice_preset}`;
  // Uploaded style JSON / safetensors without a library id — keep as-is on rebuild.
  if (o.voice_style_path || o.cloud_voice_id) return "keep:current";
  if (selectedVoiceId) return `clone:${selectedVoiceId}`;
  if (selectedPocketVoice) return `pocket:${selectedPocketVoice}`;
  if (selectedVoicePreset) return `kokoro:${selectedVoicePreset}`;
  return "pocket:jane";
}

function stageVoiceOptionsHtml(selected) {
  const opts = [];
  if (selected === "keep:current") {
    opts.push(
      `<option value="keep:current" selected>Current job voice (uploaded file)</option>`
    );
  }
  (pocketPresets || []).forEach((p) => {
    const v = `pocket:${p.id}`;
    opts.push(
      `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>` +
      `Pocket · ${escapeHtml(p.label || p.id)}</option>`
    );
  });
  (voicePresets || []).forEach((p) => {
    const v = `kokoro:${p.id}`;
    opts.push(
      `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>` +
      `Kokoro · ${escapeHtml(p.label || p.id)}</option>`
    );
  });
  (voiceLibrary || []).forEach((v) => {
    const val = `clone:${v.id}`;
    opts.push(
      `<option value="${escapeHtml(val)}"${val === selected ? " selected" : ""}>` +
      `Clone · ${escapeHtml(v.name || v.id)}</option>`
    );
  });
  if (!opts.length) {
    opts.push(`<option value="pocket:jane"${selected === "pocket:jane" ? " selected" : ""}>Pocket · Jane</option>`);
  }
  return opts.join("");
}

function stageLookControlsHtml(job, preserved) {
  const o = (job && job.options) || {};
  const styleVal = (preserved?.style ?? o.video_style) || selectedStyle || "auto";
  const themeVal = (preserved?.theme ?? o.video_theme) || selectedTheme || "auto";
  const layoutVal = (preserved?.layout ?? o.content_layout) || "auto";
  const ageVal = (preserved?.age_group ?? o.age_group) || currentAgeGroup() || "auto";
  const knowVal = (preserved?.knowledge_level ?? o.knowledge_level) || currentKnowledgeLevel() || "auto";
  const voiceVal = preserved?.voice ?? jobVoiceSelectValue(job);

  const styleOpts = [
    `<option value="auto"${styleVal === "auto" ? " selected" : ""}>Auto — match document</option>`,
    ...(videoStyles || [])
      .filter((s) => s.key && s.key !== "auto")
      .map((s) =>
        `<option value="${escapeHtml(s.key)}"${s.key === styleVal ? " selected" : ""}>` +
        `${escapeHtml(s.label || s.key)}</option>`
      ),
  ].join("");
  const themeOpts = (videoThemes || []).map((t) =>
    `<option value="${escapeHtml(t.key)}"${t.key === themeVal ? " selected" : ""}>` +
    `${escapeHtml(t.label || t.key)}</option>`
  ).join("");
  const layoutOpts = [
    ["auto", "Auto — match document"],
    ["teaching", "Teach — steps / flow"],
    ["story", "Story — hook / quote"],
    ["ppt", "PPT deck — Gamma"],
    ["modern_ppt", "Modern PPT"],
    ["hyper", "Hyper · design"],
    ["motion", "Motion · Remotion"],
    ["content", "Content · layouts"],
    ["diagram", "Diagram-heavy"],
    ["dense", "Dense brief"],
  ].map(([k, lab]) =>
    `<option value="${k}"${k === layoutVal ? " selected" : ""}>${escapeHtml(lab)}</option>`
  ).join("");
  const ageOpts = [
    ["auto", "Auto — from document or prompt"],
    ["kids", "Kids (5–8)"],
    ["tweens", "Tweens (9–12)"],
    ["teens", "Teens (13–17)"],
    ["young_adults", "Young adults (18–24)"],
    ["adults", "Adults"],
    ["professionals", "Professionals"],
    ["all_ages", "All ages / family"],
  ].map(([k, lab]) =>
    `<option value="${k}"${k === ageVal ? " selected" : ""}>${escapeHtml(lab)}</option>`
  ).join("");
  const knowOpts = [
    ["auto", "Auto — from document or prompt"],
    ["beginner", "Beginner"],
    ["intermediate", "Intermediate"],
    ["advanced", "Advanced"],
    ["expert", "Expert"],
  ].map(([k, lab]) =>
    `<option value="${k}"${k === knowVal ? " selected" : ""}>${escapeHtml(lab)}</option>`
  ).join("");

  return `
    <div class="stage-look" data-stage-look="1">
      <div class="stage-look-title"><i data-lucide="sliders-horizontal"></i> Style &amp; voice for rebuild</div>
      <p class="stage-look-hint">Applies to this job (upload or cron). Locked for slide rebuild — change anytime before Save &amp; rebuild / Regenerate.</p>
      <div class="stage-look-grid">
        <label class="stage-look-field">
          <span>Visual style</span>
          <select id="stage-look-style" class="text-input stage-look-select">${styleOpts}</select>
        </label>
        <label class="stage-look-field">
          <span>Colors</span>
          <select id="stage-look-theme" class="text-input stage-look-select">${themeOpts}</select>
        </label>
        <label class="stage-look-field">
          <span>Narration voice</span>
          <select id="stage-look-voice" class="text-input stage-look-select">${stageVoiceOptionsHtml(voiceVal)}</select>
        </label>
        <label class="stage-look-field">
          <span>Content layout</span>
          <select id="stage-look-layout" class="text-input stage-look-select">${layoutOpts}</select>
        </label>
        <label class="stage-look-field">
          <span>Age group</span>
          <select id="stage-look-age" class="text-input stage-look-select">${ageOpts}</select>
        </label>
        <label class="stage-look-field">
          <span>Knowledge</span>
          <select id="stage-look-knowledge" class="text-input stage-look-select">${knowOpts}</select>
        </label>
      </div>
    </div>`;
}

function collectStageLookPatch() {
  const style = $("stage-look-style")?.value;
  const theme = $("stage-look-theme")?.value;
  const layout = $("stage-look-layout")?.value;
  const voiceRaw = $("stage-look-voice")?.value || "";
  const patch = {};
  if (style) patch.video_style = style;
  if (theme) patch.video_theme = theme;
  if (layout) patch.content_layout = layout;
  const age = $("stage-look-age")?.value;
  const knowledge = $("stage-look-knowledge")?.value;
  if (age) patch.age_group = age;
  if (knowledge) patch.knowledge_level = knowledge;
  if (!audiencePromptDirty && age && knowledge) {
    patch.custom_prompt = loadedAudiencePrompt(age, knowledge);
  } else {
    const custom = currentCustomPrompt();
    if (custom) patch.custom_prompt = custom;
  }
  const notes = currentReviewNotes();
  if (notes) patch.review_notes = notes;
  if (voiceRaw === "keep:current" || voiceRaw.startsWith("keep:")) {
    // Leave existing voice_style_path / cloud voice untouched.
  } else if (voiceRaw.startsWith("pocket:")) {
    patch.pocket_voice = voiceRaw.slice(7);
  } else if (voiceRaw.startsWith("kokoro:")) {
    patch.voice_preset = voiceRaw.slice(7);
  } else if (voiceRaw.startsWith("clone:")) {
    patch.voice_id = voiceRaw.slice(6);
  }
  return patch;
}

function applyStageLookToStudio(patch) {
  if (!patch) return;
  if (patch.video_style) {
    const preset = (visualPresets || []).find(
      (p) => p.style === patch.video_style && (
        !patch.video_theme || p.theme === patch.video_theme || p.theme === "auto"
      ),
    ) || (visualPresets || []).find((p) => p.style === patch.video_style);
    if (preset) selectVisualPreset(preset.key);
    else {
      selectedStyle = patch.video_style;
      styleWasAuto = patch.video_style === "auto";
      if (patch.video_theme) {
        selectedTheme = patch.video_theme;
        themeWasAuto = patch.video_theme === "auto";
      }
    }
  } else if (patch.video_theme) {
    selectedTheme = patch.video_theme;
    themeWasAuto = patch.video_theme === "auto";
  }
  if (patch.voice_id) {
    selectedVoiceId = patch.voice_id;
    selectedPocketVoice = null;
    selectedVoicePreset = null;
    voiceEngine = "clones";
  } else if (patch.pocket_voice) {
    selectedPocketVoice = patch.pocket_voice;
    selectedVoiceId = null;
    selectedVoicePreset = null;
    voiceEngine = "pocket";
  } else if (patch.voice_preset) {
    selectedVoicePreset = patch.voice_preset;
    selectedPocketVoice = null;
    selectedVoiceId = null;
    voiceEngine = "kokoro";
  }
  try { _saveVoiceSel(); } catch (e) { /* ignore */ }
  if (typeof renderVoices === "function") renderVoices();
  if (typeof updateVoiceNowCard === "function") updateVoiceNowCard();
}

function stageIconHtml(status) {
  return status === "running"
    ? '<span class="spinner"></span>'
    : `<i data-lucide="${STAGE_ICONS[status] || "circle"}"></i>`;
}

function updateFlowstrip(job) {
  const nodes = [...document.querySelectorAll("#flowstrip .node")];
  nodes.forEach((n) => n.classList.remove("active", "done"));
  job.stages.forEach((s) => {
    const idx = STAGE_TO_NODE[s.key];
    if (idx == null || !nodes[idx]) return;
    if (s.status === "done") nodes[idx].classList.add("done");
    if (s.status === "running") nodes[idx].classList.add("active");
  });
  // Mark the document node done once we have started.
  if (job.stages.some((s) => s.status !== "pending")) nodes[0]?.classList.add("done");
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderStages(job) {
  const editorState = getOpenEditors();
  const lookState = getStageLookState();
  const wrap = $("stages");
  if (!wrap) return false;
  const running = job.status === "running";
  const snap = stagesSnap(job);

  // Patch in place when structure is unchanged — avoids Lucide flicker on every SSE tick.
  if (wrap.dataset.snap === snap && wrap.children.length === (job.stages || []).length) {
    let dirty = false;
    job.stages.forEach((s, i) => {
      const row = wrap.children[i];
      if (!row) return;
      const nextClass = "stage " + s.status;
      if (row.className !== nextClass) row.className = nextClass;
      dirty = setIconHtml(row.querySelector(".ic"), stageIconHtml(s.status)) || dirty;
      const body = row.querySelector(".body");
      if (!body) return;
      let detail = body.querySelector(".detail");
      const detailText = s.detail || "";
      if (detailText) {
        if (!detail) {
          detail = document.createElement("div");
          detail.className = "detail";
          const name = body.querySelector(".name");
          if (name && name.nextSibling) body.insertBefore(detail, name.nextSibling);
          else body.appendChild(detail);
        }
        if (detail.textContent !== detailText) detail.textContent = detailText;
      } else if (detail) {
        detail.remove();
      }
      body.querySelectorAll("[data-run]").forEach((b) => { b.disabled = running; });
    });
    return dirty;
  }

  wrap.dataset.snap = snap;
  wrap.innerHTML = "";

  job.stages.forEach((s) => {
    const row = document.createElement("div");
    row.className = "stage " + s.status;
    const icon = stageIconHtml(s.status);

    let editorHtml = "";
    const ed = STAGE_EDITORS[s.key];
    if (ed && job.content && job.content[ed.key] != null) {
      const fieldState = editorState[ed.key];
      const val = fieldState ? fieldState.value : job.content[ed.key];
      editorHtml = `
        <div class="editor-label">${ed.label}</div>
        <textarea class="editor" data-field="${ed.key}">${escapeHtml(val)}</textarea>`;
    }

    // Style + voice after VLM extract (manual upload + cron jobs).
    let lookHtml = "";
    if (s.key === "extract" && job.content && job.content.extracted_text != null) {
      lookHtml = stageLookControlsHtml(job, lookState);
    }

    let actionsHtml = "";
    const dis = running ? "disabled" : "";
    if (s.key === "extract") {
      actionsHtml = `
        <button class="btn-sm" data-run="extract" data-mode="single" ${dis}><i data-lucide="rotate-cw"></i>Re-extract</button>
        <button class="btn-sm accent" data-save="extracted_text" data-run="generate" data-mode="from" data-save-look="1" ${dis}><i data-lucide="save"></i>Save & rebuild</button>`;
    } else if (s.key === "generate") {
      actionsHtml = `
        <button class="btn-sm" data-run="generate" data-mode="from" data-save-look="1" ${dis}><i data-lucide="refresh-cw"></i>Regenerate slides</button>
        <button class="btn-sm" type="button" data-review="1" ${dis}><i data-lucide="scan-search"></i>Review duplicates &amp; sync</button>`;
    } else if (s.key === "narrate") {
      actionsHtml = `<button class="btn-sm accent" data-save="narration" data-run="narrate" data-mode="from" ${dis}><i data-lucide="mic"></i>Save & re-narrate</button>`;
    } else if (s.key === "capture") {
      actionsHtml = `<button class="btn-sm" data-run="capture" data-mode="from" ${dis}><i data-lucide="camera"></i>Re-capture</button>`;
    } else if (s.key === "merge") {
      actionsHtml = `<button class="btn-sm" data-run="merge" data-mode="from" ${dis}><i data-lucide="film"></i>Re-assemble</button>`;
    } else if (s.key === "publish") {
      actionsHtml = `<button class="btn-sm" data-run="publish" data-mode="single" ${dis}><i data-lucide="upload"></i>Upload now</button>`;
    }

    let warnHtml = "";
    if (s.key === "extract" && job.content && job.content.extract_warning) {
      warnHtml = `<div class="warn-banner"><i data-lucide="alert-triangle"></i><span>${escapeHtml(job.content.extract_warning)}</span></div>`;
    }

    row.innerHTML = `
      <div class="ic">${icon}</div>
      <div class="body">
        <div class="name">${s.label}</div>
        ${s.detail ? `<div class="detail">${escapeHtml(s.detail)}</div>` : ""}
        ${warnHtml}
        ${editorHtml}
        ${lookHtml}
        <div class="actions">${actionsHtml}</div>
      </div>`;
    wrap.appendChild(row);
  });

  Object.entries(editorState).forEach(([field, st]) => {
    if (st.focused) {
      const t = document.querySelector(`.editor[data-field="${field}"]`);
      if (t) {
        t.focus();
        const start = Number.isFinite(st.start) ? st.start : t.value.length;
        const end = Number.isFinite(st.end) ? st.end : t.value.length;
        try { t.setSelectionRange(start, end); } catch (_) { /* ignore */ }
      }
    }
  });

  wrap.querySelectorAll("[data-run]").forEach((btn) => {
    btn.addEventListener("click", () => onStageAction(btn));
  });
  wrap.querySelectorAll("[data-review]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("review-card")?.classList.remove("hidden");
      $("review-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      runContentReview();
    });
  });
  return true;
}

function renderPages(job) {
  const art = job.artifacts || {};
  const pages = art.pages_shots?.length ? art.pages_shots : (art.pages || []);
  const card = $("pages-card");
  if (!card) return false;
  if (!pages.length) { card.classList.add("hidden"); return false; }
  card.classList.remove("hidden");
  const wrap = $("pages");
  if (!wrap) return false;
  // Vertical formats get a vertical thumbnail layout.
  const vertical = (job.options && job.options.orientation === "vertical");
  wrap.classList.toggle("vertical", !!vertical);
  const key = JSON.stringify(pages.map(pathOnly)) + "|" + (vertical ? "v" : "h");
  if (wrap.dataset.pagesKey === key) return false;
  wrap.dataset.pagesKey = key;
  wrap.innerHTML = "";
  pages.forEach((src) => {
    const a = document.createElement("a");
    a.href = bust(src); a.target = "_blank"; a.rel = "noopener";
    a.innerHTML = `<img src="${bust(src)}" alt="slide" />`;
    wrap.appendChild(a);
  });
  return false;
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderArtifacts(job) {
  const a = job.artifacts || {};
  const items = [];
  if (a.html) items.push(["Open slideshow", a.html, "layout-template"]);
  if (a.audio) items.push(["Slide voiceover", a.audio, "volume-2"]);
  if (a.video_final) items.push(["Download video", a.video_final, "download"]);
  if (a.thumbnail) items.push(["Download thumbnail", a.thumbnail, "image"]);
  if (a.youtube?.url) items.push(["YouTube link", a.youtube.url, "youtube"]);

  const card = $("artifacts-card");
  const wrap = $("artifacts");
  const vid = $("preview-video");
  const thumb = $("preview-thumb");
  if (!card) return false;

  if (!items.length) { card.classList.add("hidden"); return false; }
  card.classList.remove("hidden");
  const key = JSON.stringify(items.map(([label, href, icon]) => [label, pathOnly(href), icon]));
  let dirty = false;
  if (wrap && wrap.dataset.artKey !== key) {
    wrap.dataset.artKey = key;
  wrap.innerHTML = "";
  items.forEach(([label, href, icon]) => {
    const link = document.createElement("a");
    link.className = "artifact"; link.href = bust(href); link.target = "_blank"; link.rel = "noopener";
    link.innerHTML = `<i data-lucide="${icon}"></i>${label}`;
    wrap.appendChild(link);
  });
    dirty = true;
  }

  if (a.video_final && vid) {
    // Poster while the MP4 buffers so the player isn't a black spinner.
    if (a.thumbnail) vid.setAttribute("poster", bust(a.thumbnail));
    else vid.removeAttribute("poster");
    if (setStableMediaSrc(vid, a.video_final)) {
      vid.preload = "metadata";
      vid.load();
    }
    // Constrain vertical previews so they don't dominate the layout.
    const vertical = (job.options && job.options.orientation === "vertical");
    vid.classList.toggle("vertical", !!vertical);
    vid.classList.remove("hidden");
    if (thumb) thumb.classList.add("hidden");
  } else {
    if (vid) {
    vid.classList.add("hidden");
      if (vid.getAttribute("src")) vid.removeAttribute("src");
    }
    // After finalize (or before merge), show the retained thumbnail as a preview.
    if (a.thumbnail && thumb) {
      setStableMediaSrc(thumb, a.thumbnail);
      thumb.classList.remove("hidden");
    } else if (thumb) {
      thumb.classList.add("hidden");
      if (thumb.getAttribute("src")) thumb.removeAttribute("src");
    }
  }
  return dirty;
}

// Once-only listeners for the Publish details controls.
let publishWired = false;
function wirePublish() {
  if (publishWired) return;
  publishWired = true;
  const save = $("pub-save");
  const regenText = $("pub-regen-text");
  const regenThumb = $("pub-regen-thumb");
  if (save) save.addEventListener("click", savePublish);
  if (regenText) regenText.addEventListener("click", () => regenerateMeta("text"));
  if (regenThumb) regenThumb.addEventListener("click", generateThumbnailOnDemand);
  wireSocial();
}

async function savePublish() {
  if (!jobId) return;
  const btn = $("pub-save");
  const tags = ($("pub-tags").value || "")
    .split(",").map((t) => t.trim()).filter(Boolean);
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving\u2026'; }
  try {
    const res = await fetch(`/api/jobs/${jobId}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publish_title: $("pub-title").value,
        publish_description: $("pub-desc").value,
        publish_tags: tags,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, res.status === 409 ? "Job is busy — try again." : "Save failed"));
    if (btn) { btn.innerHTML = '<i data-lucide="check"></i> Saved'; icons(); }
    updateYtChecklist();
    renderSocialReadyBar();
  } catch (e) {
    if (btn) { btn.innerHTML = '<i data-lucide="triangle-alert"></i> Failed'; icons(); }
    showAlert(e.message || "Save failed");
  } finally {
    if (btn) setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; icons(); }, 1400);
  }
}

async function regenerateMeta(scope) {
  if (!jobId) return;
  const btn = $("pub-regen-text");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working\u2026'; }
  try {
    await fetch(`/api/jobs/${jobId}/regenerate-metadata?scope=${scope || "text"}`, { method: "POST" });
  } catch (e) { /* stream will reflect the result */ }
  if (btn) setTimeout(() => { btn.disabled = false; btn.innerHTML = orig; icons(); }, 1600);
}

async function generateThumbnailOnDemand() {
  if (!jobId) return;
  const btn = $("pub-regen-thumb");
  const orig = btn ? btn.innerHTML : "";
  const empty = $("thumb-empty");
  const img = $("thumb-img");
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating\u2026'; }
  if (img) img.classList.add("hidden");
  if (empty) {
    empty.classList.remove("hidden");
    empty.innerHTML = '<i data-lucide="loader"></i>Generating thumbnail\u2026';
  }
  icons();
  try {
    const res = await fetch(`/api/jobs/${jobId}/generate-thumbnail`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const err = data.message || data.detail || (res.status === 409 ? "Job is busy — try again when idle." : "Thumbnail failed");
      if (empty) {
        empty.classList.remove("hidden");
        empty.innerHTML = `<i data-lucide="image-off"></i>${escapeHtml(err)}`;
      }
      icons();
      return;
    }
    // Force a fresh cache token — thumbnail path is stable across regenerations.
    cacheBust = Date.now();
    const refresh = await fetch(`/api/jobs/${jobId}`);
    const job = await refresh.json().catch(() => ({}));
    if (!refresh.ok || !job.id) {
      throw new Error(apiDetail(job, "Thumbnail saved but refresh failed — reload the session."));
    }
    if (img) {
      img.removeAttribute("src");
      img.classList.add("hidden");
    }
    renderPublish(job);
    if (lastJob) lastJob = { ...lastJob, ...job, artifacts: { ...(lastJob.artifacts || {}), ...(job.artifacts || {}) } };
    renderArtifacts(job);
  } catch (e) {
    if (empty) {
      empty.classList.remove("hidden");
      empty.innerHTML = `<i data-lucide="image-off"></i>${escapeHtml(e.message || "Thumbnail failed")}`;
      icons();
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig || '<i data-lucide="image"></i> Generate thumbnail'; icons(); }
  }
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderPublish(job) {
  const card = $("publish-card");
  if (!card) return false;
  wirePublish();
  const c = job.content || {};
  const a = job.artifacts || {};
  // Show the card once the video is assembled (or metadata already exists).
  const ready = !!a.video_final || c.publish_title != null || c.thumbnail != null;
  if (!ready) { card.classList.add("hidden"); return false; }
  card.classList.remove("hidden");

  let dirty = renderSocial(job);

  const setIfIdle = (id, val) => {
    const el = $(id);
    if (!el) return;
    // Don't stomp on the field while the user is editing it.
    if (document.activeElement === el) return;
    const next = val == null ? "" : val;
    if (el.value !== next) el.value = next;
  };
  setIfIdle("pub-title", c.publish_title);
  setIfIdle("pub-desc", c.publish_description);
  setIfIdle("pub-tags", Array.isArray(c.publish_tags) ? c.publish_tags.join(", ") : "");

  const msg = $("publish-msg");
  if (msg) {
    const text = c.publish_meta_message || "";
    msg.textContent = text;
    msg.classList.toggle("hidden", !text);
  }

  const img = $("thumb-img");
  const empty = $("thumb-empty");
  if (a.thumbnail && img) {
    // Only change src when the thumbnail path changes (not every SSE cacheBust tick).
    setStableMediaSrc(img, a.thumbnail);
    img.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
  } else if (img) {
    if (img.getAttribute("src")) img.removeAttribute("src");
    img.classList.add("hidden");
    if (empty) {
      empty.classList.remove("hidden");
      dirty = setStableHtml(empty, '<i data-lucide="image"></i>No thumbnail yet — click Generate') || dirty;
    }
  }
  return dirty;
}

function render(job) {
  lastJob = job;
  // Bust browser caching of regenerated artifacts (video/slides keep the same
  // URL across re-runs) using the latest stage timestamp as a version token.
  cacheBust = job.stages.reduce(
    (m, s) => Math.max(m, s.ended_at || s.started_at || 0), 0
  );
  $("empty-state").classList.add("hidden");
  updateFlowstrip(job);
  let dirty = false;
  dirty = renderStages(job) || dirty;
  renderPages(job);
  dirty = renderContentReview(job) || dirty;
  dirty = renderArtifacts(job) || dirty;
  dirty = renderRecorder(job) || dirty;
  dirty = renderPublish(job) || dirty;
  applyResolvedVisualFromJob(job);

  const sub = $("progress-sub");
  if (job.status === "done") sub.textContent = "Idle \u2014 edit any step and re-run.";
  else if (job.status === "error") sub.textContent = "Error: " + (job.error || "unknown");
  else sub.textContent = "Processing\u2026";

  // Progress bar: fraction of stages that have reached a terminal state.
  const total = job.stages.length || 1;
  const settled = job.stages.filter((s) => ["done", "skipped", "error"].includes(s.status)).length;
  const anyRunning = job.stages.some((s) => s.status === "running");
  const pct = Math.round((settled / total) * 100);
  const fill = $("progress-fill");
  if (fill) {
    fill.style.width = (job.status === "done" ? 100 : pct) + "%";
    fill.classList.toggle("shimmer", anyRunning || job.status === "running");
  }

  $("live-dot").classList.toggle("hidden", job.status !== "running");
  const btn = $("run-btn");
  btn.disabled = job.status === "running" || !selectedFile;
  dirty = setIconHtml(
    btn,
    job.status === "running"
    ? '<span class="spinner"></span> Running\u2026'
      : '<i data-lucide="play"></i> Run pipeline'
  ) || dirty;
  if (dirty) icons();
}

async function onStageAction(btn) {
  const stage = btn.dataset.run;
  const mode = btn.dataset.mode || "single";
  const saveField = btn.dataset.save;
  const saveLook = btn.dataset.saveLook === "1";

  const patch = {};
  if (saveField) {
    const textarea = document.querySelector(`.editor[data-field="${saveField}"]`);
    if (textarea) patch[saveField] = textarea.value;
  }
  if (saveLook) {
    Object.assign(patch, collectStageLookPatch());
  }
  if (Object.keys(patch).length) {
    applyStageLookToStudio(patch);
    const res = await fetch(`/api/jobs/${jobId}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showAlert(apiDetail(err, "Could not save style / voice"));
      return;
    }
  }
  await fetch(`/api/jobs/${jobId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage, mode }),
  });
}

function connectStream(id) {
  if (evtSource) evtSource.close();
  let lastStatus = null;
  evtSource = new EventSource(`/api/jobs/${id}/stream`);
  evtSource.onmessage = (e) => {
    try {
      const job = JSON.parse(e.data);
      if (job.id !== jobId) return;
      render(job);
      // Refresh tabs when the active run changes state.
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        loadSessions();
      }
    } catch (err) { /* ignore partial frames */ }
  };
  evtSource.onerror = () => { /* browser auto-reconnects */ };
}

async function runPipeline() {
  if (!selectedFile && !topicPlanId) return;
  // If a topic plan is ready with selections, spawn one or many videos from it.
  if (topicPlanId && topicSelected.size) {
    return runFromTopicPlan();
  }
  if (!selectedFile) return;
  const btn = $("run-btn");
  hideAlert();
  sanitizeNarrationVoice();
  const sv = selectedVoiceRecord();
  const usingPocket =
    !!(selectedPocketVoice
      || (sv && (sv.kind === "pocket" || (sv.style_source || "").startsWith("pocket"))));
  if (usingPocket && appCaps && !appCaps.pocket && !pocketAvailable) {
    showAlert("Pocket TTS is not installed. Run: pip install pocket-tts — or pick a Kokoro voice.");
    return;
  }

  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Uploading\u2026';

  const form = new FormData();
  form.append("file", selectedFile);
  form.append("publish", publishOn ? "true" : "false");
  form.append("video_format", selectedFormat);
  form.append("video_theme", selectedTheme);
  form.append("video_style", selectedStyle);
  form.append("target_duration", String(selectedDuration || 0));
  form.append("extra_topics", $("topics-input")?.value || "");
  form.append(
    "enable_web_research",
    $("web-research-switch")?.classList.contains("on") ? "true" : "false",
  );
  form.append(
    "slide_ai_images",
    $("slide-ai-images-switch")?.classList.contains("on") ? "true" : "false",
  );
  const aud = audienceJobFields();
  form.append("age_group", aud.age_group);
  form.append("knowledge_level", aud.knowledge_level);
  form.append("custom_prompt", aud.custom_prompt);
  form.append("review_notes", aud.review_notes);
  if (selectedVoiceId && sv && voiceHasTtsClone(sv)) {
    form.append("voice_id", selectedVoiceId);
  } else if (selectedPocketVoice) {
    form.append("pocket_voice", selectedPocketVoice);
  } else if (selectedVoicePreset) {
    form.append("voice_preset", selectedVoicePreset);
  }

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiDetail(err, "Upload failed"));
    }
    jobId = (await res.json()).id;
    try { localStorage.setItem("ms_studio_job_id", jobId); } catch (e) {}
    $("progress-card").classList.remove("hidden");
    connectStream(jobId);
    loadSessions();
  } catch (e) {
    showAlert(e.message);
    btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Run pipeline'; icons();
  }
}

function initDropzone() {
  const dz = $("dropzone");
  const input = $("file-input");
  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => setFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
  );
  dz.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

  // Optional Supertonic voice-style upload (hidden unless supertonic is available).
  const vdz = $("voice-dropzone");
  const vinput = $("voice-input");
  if (vdz && vinput) {
    vdz.addEventListener("click", () => vinput.click());
    vinput.addEventListener("change", (e) => setVoiceFile(e.target.files[0]));
    ["dragenter", "dragover"].forEach((ev) =>
      vdz.addEventListener(ev, (e) => { e.preventDefault(); vdz.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      vdz.addEventListener(ev, (e) => { e.preventDefault(); vdz.classList.remove("drag"); })
    );
    vdz.addEventListener("drop", (e) => setVoiceFile(e.dataTransfer.files[0]));
  }
  const vname = $("voice-name");
  if (vname) vname.addEventListener("input", updateVoiceSaveEnabled);
  const vsave = $("voice-save-btn");
  if (vsave) vsave.addEventListener("click", saveVoice);
  document.querySelectorAll("#voice-mode-tabs .voice-mode").forEach((btn) => {
    btn.addEventListener("click", () => setVoiceAddMode(btn.dataset.mode));
  });
  $("voice-rec-start")?.addEventListener("click", toggleVoiceLibRecord);
  $("voice-rec-stop")?.addEventListener("click", toggleVoiceLibRecord);

  const pdz = $("voice-pocket-dropzone");
  const pinput = $("voice-pocket-input");
  if (pdz && pinput) {
    pdz.addEventListener("click", () => pinput.click());
    pinput.addEventListener("change", (e) => setPocketFile(e.target.files[0]));
    ["dragenter", "dragover"].forEach((ev) =>
      pdz.addEventListener(ev, (e) => { e.preventDefault(); pdz.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      pdz.addEventListener(ev, (e) => { e.preventDefault(); pdz.classList.remove("drag"); })
    );
    pdz.addEventListener("drop", (e) => setPocketFile(e.dataTransfer.files[0]));
  }
  $("voice-pocket-name")?.addEventListener("input", updatePocketSaveEnabled);
  $("voice-pocket-save-btn")?.addEventListener("click", savePocketVoice);
  document.querySelectorAll("#voice-pocket-mode-tabs .voice-mode").forEach((btn) => {
    btn.addEventListener("click", () => setPocketAddMode(btn.dataset.mode));
  });
  $("voice-pocket-rec-start")?.addEventListener("click", togglePocketLibRecord);
  $("voice-pocket-rec-stop")?.addEventListener("click", togglePocketLibRecord);
}

function initSwitch() {
  const sw = $("publish-switch");
  if (sw) {
  sw.addEventListener("click", () => {
    if (sw.disabled) return;
    publishOn = !publishOn;
    sw.classList.toggle("on", publishOn);
  });
  }
  // Slide AI images — experimental, default OFF until Image lab quality checks pass.
  const slideAi = $("slide-ai-images-switch");
  if (slideAi) {
    slideAi.classList.remove("on");
    slideAi.setAttribute("aria-pressed", "false");
    slideAi.addEventListener("click", () => {
      const on = !slideAi.classList.contains("on");
      slideAi.classList.toggle("on", on);
      slideAi.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  // Force live web research on the topics — default OFF (topic-only jobs still research automatically).
  const webResearch = $("web-research-switch");
  if (webResearch) {
    webResearch.classList.remove("on");
    webResearch.setAttribute("aria-pressed", "false");
    webResearch.addEventListener("click", () => {
      const on = !webResearch.classList.contains("on");
      webResearch.classList.toggle("on", on);
      webResearch.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // Topic plan (large docs → selectable topics → 1 or N videos)
  $("topic-plan-btn")?.addEventListener("click", () => planDocumentTopics());
  $("topic-plan-refresh")?.addEventListener("click", () => planDocumentTopics({ refresh: true }));
  $("topic-select-rec")?.addEventListener("click", () => {
    topicSelected = new Set(topicPlanData?.recommended_ids || []);
    (topicPlanData?.topics || []).forEach((t) => {
      if (t.recommended) topicSelected.add(t.id);
    });
    renderTopicPlan(topicPlanData);
  });
  $("topic-select-all")?.addEventListener("click", () => {
    topicSelected = new Set((topicPlanData?.topics || []).map((t) => t.id));
    renderTopicPlan(topicPlanData);
  });
  $("topic-select-none")?.addEventListener("click", () => {
    topicSelected = new Set();
    renderTopicPlan(topicPlanData);
  });
  const groundSw = $("topic-grounding-switch");
  if (groundSw) {
    groundSw.addEventListener("click", () => {
      const on = !groundSw.classList.contains("on");
      groundSw.classList.toggle("on", on);
      groundSw.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initUiZoom();
  await initAuth();
  loadUiPalette();
  initNav();
  initMediaPanel();
  initLeftTabs();
  initDropzone();
  initAudience();
  initSwitch();
  initSessionTabs();
  loadVideoFormats();
  loadCapabilities();
  loadSessions();
  const runBtn = $("run-btn");
  if (runBtn) runBtn.addEventListener("click", runPipeline);
  const vprev = $("voice-preview-btn");
  if (vprev) vprev.addEventListener("click", previewVoice);
  document.querySelectorAll("#voice-filter .voice-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      voiceFilter = btn.dataset.filter || "all";
      renderVoices();
    });
  });
  document.querySelectorAll(".voice-pocket-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      pocketFilter = btn.dataset.filter || "all";
      renderVoices();
    });
  });
  document.querySelectorAll(".voice-engine-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      setVoiceEngine(btn.dataset.engine || "kokoro");
      renderVoices();
    });
  });
  icons();
  if (window.CHITTI) {
    let chittiPendingRun = false;
    const chittiPickDoc = () => {
      if (typeof window.CHITTI.pickDocument === "function") {
        window.CHITTI.pickDocument();
        return true;
      }
      $("file-input")?.click?.();
      return true;
    };
    window.CHITTI.init({
      product: "multimodal",
      getSessionId: () => jobId,
      onPickFile: (file) => {
        try { switchView("studio"); } catch (e) {}
        setFile(file);
        if (chittiPendingRun) {
          chittiPendingRun = false;
          window.CHITTI.say(`Got ${file.name}. Starting the video pipeline.`);
          runPipeline();
        } else {
          window.CHITTI.say(`${file.name} is ready. Say “create a video” or hit Run.`);
        }
      },
      onCommand: async (raw, meta = {}) => {
        const t = String(raw || "").toLowerCase().trim();
        const speak = meta.fromLive ? false : undefined;
        const standDown = /^(stop|cancel|quiet|silence|close|stand down|never ?mind)( please)?$/.test(
          t.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim()
        );
        if (standDown) {
          window.CHITTI.say("Standing down.", { closeAfter: 1400, speak });
          return true;
        }
        if (/\bhelp\b|\bwho are you\b|\bwhat can you do\b/.test(t)) {
          if (!meta.fromLive) {
            window.CHITTI.say(
              "C.H.I.T.T.I. I can upload a document, start a video, report status, or open History. Type it, or tap File / Respond."
            );
          }
          return true;
        }
        if (/\bstatus\b|\bwhat.?s running\b/.test(t)) {
          const live = document.getElementById("live-dot");
          const running = live && !live.classList.contains("hidden");
          window.CHITTI.say(
            running ? "A job is live right now — watch the timeline." : "No live job. Upload a document, then say create a video.",
            { speak }
          );
          return true;
        }
        if (/\b(history|library|sessions?)\b/.test(t)) {
          try { switchView("sessions"); } catch (e) {}
          window.CHITTI.say("History is open.", { speak });
          return true;
        }
        const wantsCreate = /\b(create|make|start|run|generate|render|begin)\b.{0,48}\b(video|job|pipeline|slideshow|short|reel|tiktok)\b/.test(t)
          || /\bnew (job|video)\b/.test(t);
        const wantsUpload = /\b(upload|attach)\b/.test(t)
          || /\b(docx?|pptx?)\b/.test(t)
          || /\b(upload|attach|drop|pick|choose)\b.{0,40}\b(doc|docs|document|pdf|pptx?|file|paper)\b/.test(t);
        if (wantsCreate || wantsUpload) {
          try { switchView("studio"); } catch (e) {}
          if (wantsCreate && selectedFile) {
            chittiPendingRun = false;
            window.CHITTI.say("Starting the video pipeline with the document you chose.", { speak, autoClose: false });
            runPipeline();
            return true;
          }
          if (wantsCreate) chittiPendingRun = true;
          window.CHITTI.say(
            wantsCreate
              ? "Pick a document and I’ll start the video."
              : "Pick a PDF, Word, PPT, or notes file.",
            { speak, autoClose: false }
          );
          chittiPickDoc();
          return true;
        }
        if (!meta.fromLive) {
          window.CHITTI.say("Try: create a video, upload a document, status, history, or help.");
        }
        return true;
      },
    });
  }
});

// ------------------------------------------------------------- app theme ----

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  try { localStorage.setItem("cc-theme", mode); } catch (e) { /* ignore */ }
}

function initTheme() {
  let mode;
  try { mode = localStorage.getItem("cc-theme"); } catch (e) { mode = null; }
  if (!mode) {
    // Follow the OS preference on first visit.
    mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }
  applyTheme(mode);
  const btn = $("theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const now = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      applyTheme(now);
    });
  }
}

// --------------------------------------------------------------- UI zoom ----

const UI_ZOOM_STEPS = [80, 90, 100, 110, 125, 140];
let uiZoom = 100;

function clampUiZoom(n) {
  const v = Math.round(Number(n) || 100);
  if (v < 80) return 80;
  if (v > 140) return 140;
  return v;
}

function nearestUiZoom(n) {
  const v = clampUiZoom(n);
  let best = UI_ZOOM_STEPS[0];
  let dist = Math.abs(v - best);
  UI_ZOOM_STEPS.forEach((s) => {
    const d = Math.abs(v - s);
    if (d < dist) { best = s; dist = d; }
  });
  return best;
}

function applyUiZoom(pct, { persist = true, snap = true } = {}) {
  uiZoom = snap ? nearestUiZoom(pct) : clampUiZoom(pct);
  const root = document.documentElement;
  root.style.zoom = uiZoom + "%";
  root.setAttribute("data-ui-zoom", String(uiZoom));
  if (persist) {
    try { localStorage.setItem("mms_ui_zoom", String(uiZoom)); } catch (e) { /* ignore */ }
  }
  const label = $("zoom-value");
  if (label) label.textContent = uiZoom + "%";
  document.querySelectorAll(".ui-zoom-opt").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.zoom) === uiZoom);
  });
  const out = $("zoom-out");
  const inn = $("zoom-in");
  if (out) out.disabled = uiZoom <= UI_ZOOM_STEPS[0];
  if (inn) inn.disabled = uiZoom >= UI_ZOOM_STEPS[UI_ZOOM_STEPS.length - 1];
}

function stepUiZoom(delta) {
  const idx = UI_ZOOM_STEPS.indexOf(nearestUiZoom(uiZoom));
  const i = idx < 0 ? 2 : idx;
  const next = UI_ZOOM_STEPS[Math.max(0, Math.min(UI_ZOOM_STEPS.length - 1, i + delta))];
  applyUiZoom(next);
}

function setZoomMenuOpen(open) {
  const menu = $("zoom-menu");
  const value = $("zoom-value");
  if (!menu || !value) return;
  menu.classList.toggle("hidden", !open);
  value.setAttribute("aria-expanded", open ? "true" : "false");
}

function initUiZoom() {
  let saved = 100;
  try { saved = parseInt(localStorage.getItem("mms_ui_zoom") || "100", 10); } catch (e) { saved = 100; }
  if (!Number.isFinite(saved)) saved = 100;
  applyUiZoom(saved, { persist: true, snap: true });

  const out = $("zoom-out");
  const inn = $("zoom-in");
  const value = $("zoom-value");
  const menu = $("zoom-menu");
  if (out) out.addEventListener("click", (e) => {
    e.stopPropagation();
    setZoomMenuOpen(false);
    stepUiZoom(-1);
  });
  if (inn) inn.addEventListener("click", (e) => {
    e.stopPropagation();
    setZoomMenuOpen(false);
    stepUiZoom(1);
  });
  if (value) {
    value.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !!(menu && menu.classList.contains("hidden"));
      setZoomMenuOpen(open);
    });
  }
  document.querySelectorAll(".ui-zoom-opt").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyUiZoom(btn.dataset.zoom);
      setZoomMenuOpen(false);
    });
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#ui-zoom")) return;
    setZoomMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setZoomMenuOpen(false);
  });
}

// ------------------------------------------------------ session / history ----

let sessions = [];

async function loadSessions() {
  try {
    const data = await (await fetch("/api/sessions")).json();
    sessions = data.sessions || [];
  } catch (e) { sessions = []; }
  renderSessionTabs();
  renderSessionGallery();
  // Restore last Studio job after Switch product / reload
  try {
    const savedId = localStorage.getItem("ms_studio_job_id");
    if (savedId && sessions.some((s) => s.id === savedId) && savedId !== jobId) {
      await openSession(savedId);
    }
  } catch (e) { /* ignore */ }
}

function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function renderSessionGallery() {
  const grid = $("session-grid");
  const empty = $("sessions-empty");
  if (!grid) return;
  grid.innerHTML = "";
  if (!sessions.length) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  sessions.forEach((s) => {
    const card = document.createElement("div");
    card.className = "sess-card" + (s.id === jobId ? " current" : "");
    const statusLabel = { running: "Running", error: "Failed", done: "Completed" }[s.status] || "Ready";
    const statusCls = { running: "run", error: "err", done: "ok" }[s.status] || "";
    const preview = s.preview
      ? `<img src="${escapeHtml(bust(s.preview))}" alt="" loading="lazy" />`
      : `<div class="sess-noprev"><i data-lucide="file-text"></i></div>`;
    const meta = [];
    if (s.slides) meta.push(`${s.slides} slides`);
    if (s.automation_kind) meta.push(escapeHtml(String(s.automation_kind)));
    if (s.video_format) meta.push(escapeHtml(String(s.video_format).replace(/_/g, " ")));
    if (s.duration) meta.push(`${Math.round(s.duration / 60) || 1}m target`);
    const srcLabel = (() => {
      const pdf = String(s.source_pdf || "").trim();
      if (pdf && pdf.toLowerCase() !== "paper.pdf") return pdf;
      const fn = String(s.filename || "").trim();
      if (fn && fn.toLowerCase() !== "paper.pdf") return fn;
      if (s.automation_folder) return String(s.automation_folder);
      if (s.automation_paper_id) return String(s.automation_paper_id);
      return fn || "source";
    })();
    card.innerHTML =
      `<div class="sess-thumb">${preview}` +
        `<span class="sess-badge ${statusCls}">${statusLabel}</span>` +
        (s.video ? `<span class="sess-play"><i data-lucide="play"></i></span>` : "") +
      `</div>` +
      `<div class="sess-info">` +
        `<div class="sess-title" title="${escapeHtml(s.title || s.filename)}">${escapeHtml(s.title || s.filename)}</div>` +
        `<div class="sess-doc" title="${escapeHtml(srcLabel)}"><i data-lucide="paperclip"></i> ${escapeHtml(srcLabel)}</div>` +
        `<div class="sess-meta">${meta.join(" \u00b7 ")}</div>` +
        `<div class="sess-foot"><span class="sess-when">${fmtWhen(s.created_at)}</span>` +
          `<div class="sess-actions">` +
            `<button class="sess-open" data-id="${s.id}"><i data-lucide="folder-open"></i> Open</button>` +
            `<button class="sess-del" data-id="${s.id}" title="Delete session"><i data-lucide="trash-2"></i> Delete</button>` +
          `</div>` +
        `</div>` +
      `</div>`;
    card.querySelector(".sess-open").addEventListener("click", () => {
      switchView("studio");
      openSession(s.id);
    });
    const thumb = card.querySelector(".sess-thumb");
    if (thumb) thumb.addEventListener("click", () => { switchView("studio"); openSession(s.id); });
    card.querySelector(".sess-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.id, s.filename || s.title || "this session");
    });
    grid.appendChild(card);
  });
  icons();
}

function renderSessionTabs() {
  const list = $("stab-list");
  if (!list) return;
  list.innerHTML = "";

  const newBtn = $("tab-new");
  if (newBtn) newBtn.classList.toggle("active", !jobId);

  // No open job: New only. Past work lives under top-nav History.
  if (!jobId) {
    if (!sessions.length) {
    const hint = document.createElement("span");
    hint.className = "stab-empty";
    hint.textContent = "No knowledge uploaded yet — drop a source file to begin.";
    list.appendChild(hint);
    }
    icons();
    return;
  }

  let current = sessions.find((s) => s.id === jobId);
  if (!current) {
    current = {
      id: jobId,
      filename: (lastJob && (lastJob.filename || lastJob.title)) || selectedFile?.name || "Current session",
      status: (lastJob && lastJob.status) || "running",
    };
  }
  appendSessionTab(list, current);
  icons();
}

function appendSessionTab(list, s) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "stab sess-tab" + (s.id === jobId ? " active" : "");
  tab.dataset.id = s.id;
  const name = s.title || s.filename || "Untitled";
  const short = name.length > 22 ? name.slice(0, 21) + "\u2026" : name;
  const dot = { running: "dot-run", error: "dot-err", done: "dot-ok" }[s.status] || "";
  const title = { running: "Running", error: "Failed", done: "Completed" }[s.status] || "Ready";
  tab.innerHTML =
    `<span class="stab-dot ${dot}" title="${title}"></span>` +
    `<span class="stab-name" title="${escapeHtml(name)}">${escapeHtml(short)}</span>` +
    `<span class="stab-close" title="Delete session"><i data-lucide="trash-2"></i></span>`;
  tab.addEventListener("click", (e) => {
    if (e.target.closest(".stab-close")) { e.stopPropagation(); deleteSession(s.id, name); return; }
    if (s.id !== jobId) openSession(s.id);
  });
  list.appendChild(tab);
}

async function deleteSession(id, label) {
  const name = label || "this session";
  if (!confirm(`Delete "${name}"? This removes the session and its files permanently.`)) return;
  try {
    const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const msg = res.status === 409 ? "Cannot delete a session that is still running." : "Failed to delete session.";
      alert(msg);
      return;
    }
  } catch (e) {
    alert("Failed to delete session.");
    return;
  }
  sessions = sessions.filter((s) => s.id !== id);
  if (id === jobId) { newSession(); return; }
  renderSessionTabs();
  renderSessionGallery();
}

async function openSession(id) {
  if (!id || id === jobId) return;
  try {
    const job = await (await fetch(`/api/jobs/${id}`)).json();
    if (job && job.id) {
      jobId = id;
      try { localStorage.setItem("ms_studio_job_id", id); } catch (e) {}
      try { localStorage.setItem("ms_product", "multimodal"); } catch (e) {}
      // A restored session uses its own stored audio, not the current upload's
      // clone selection — clear it so the recorder panel renders correctly.
      selectedVoiceId = null;
      renderVoices();
      socialData = {};
      // Keep the active social tab; don't leave socialActive null (breaks copy/ready).
      socialActive = SOCIAL_PLATFORMS.includes(socialActive) ? socialActive : "youtube";
      // Force the recorder to rebuild for this job's slides.
      const recSlides = $("record-slides");
      if (recSlides) delete recSlides.dataset.count;
      // Restore left-column selections for context (best-effort).
      if (job.options && job.options.video_format) {
        selectedFormat = job.options.video_format;
        if (job.options.target_duration != null) {
          selectedDuration = job.options.target_duration;
        }
        selectFormat(selectedFormat, { preserveDuration: true });
      }
      if (job.options && (job.options.video_theme || job.options.video_style)) {
        applyResolvedVisualFromJob(job);
      }
      if (job.options && job.options.target_duration != null) {
        selectedDuration = job.options.target_duration;
        renderDurationChips();
      }
      applyAudienceFromJob(job);
      $("progress-card").classList.remove("hidden");
      $("empty-state").classList.add("hidden");
      render(job);
      switchSocialTab(socialActive);
      connectStream(id);
      renderSessionTabs();
    }
  } catch (e) { /* ignore */ }
}

function newSession() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  jobId = null;
  try { localStorage.removeItem("ms_studio_job_id"); } catch (e) {}
  lastJob = null;
  selectedFile = null;
  selectedVoiceId = null;
  renderVoices();
  socialData = {};
  socialActive = "youtube";
  const stages = $("stages");
  const previewThumb = $("preview-thumb");
  if (previewThumb) {
    previewThumb.classList.add("hidden");
    previewThumb.removeAttribute("src");
  }
  const previewVid = $("preview-video");
  if (previewVid) {
    previewVid.classList.add("hidden");
    previewVid.removeAttribute("src");
  }
  if (stages) { stages.innerHTML = ""; delete stages.dataset.snap; }
  const pages = $("pages");
  if (pages) { pages.innerHTML = ""; delete pages.dataset.pagesKey; }
  const arts = $("artifacts");
  if (arts) { arts.innerHTML = ""; delete arts.dataset.artKey; }
  $("dropzone").classList.remove("has-file");
  $("dz-main").textContent = "Drop your knowledge source here";
  $("dz-sub").textContent = "PDF, Word, PPT, TXT, Markdown, images \u00b7 or click to browse";
  // Reset the optional voice-clone dropzone.
  const vdz = $("voice-dropzone");
  if (vdz) { vdz.classList.remove("has-file"); const vm = $("voice-dz-main"); if (vm) vm.textContent = "Upload a voice-style JSON"; }
  const vinput = $("voice-input"); if (vinput) vinput.value = "";
  $("run-btn").disabled = true;
  $("progress-card").classList.add("hidden");
  $("pages-card").classList.add("hidden");
  $("artifacts-card").classList.add("hidden");
  $("publish-card").classList.add("hidden");
  const recSlides = $("record-slides");
  if (recSlides) { recSlides.innerHTML = ""; delete recSlides.dataset.count; }
  $("record-note").textContent = "Run the pipeline first to generate a script, then record each slide in your own voice.";
  $("empty-state").classList.remove("hidden");
  hideAlert();
  renderSessionTabs();
}

function initSessionTabs() {
  const nb = $("tab-new");
  if (nb) nb.addEventListener("click", newSession);
}

// -------------------------------------------------------- voice recorder ----
// When the user has NOT uploaded a clone JSON, they can record their own voice
// reading each slide's script. Recorded clips replace TTS for those slides.

let mediaRecorders = {}; // slideIndex -> { rec, chunks }

function jobUsesTtsClone(job) {
  const o = (job && job.options) || {};
  if (o.voice_style_path || o.voice_preset || o.pocket_voice || o.cloud_voice_id) return true;
  if (o.voice_id) {
    const v = voiceLibrary.find((x) => x.id === o.voice_id);
    return voiceHasTtsClone(v);
  }
  return false;
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderRecorder(job) {
  const card = $("record-card");
  const note = $("record-note");
  const wrap = $("record-slides");
  if (!card) return false;

  // Hide when this job uses a TTS clone, or no slides yet.
  if (jobUsesTtsClone(job) || !job || !job.content) {
    card.classList.add("hidden");
    return false;
  }

  const slides = (job.content && job.content.slides) || [];
  if (!slides.length) {
    card.classList.add("hidden");
    return false;
  }
  card.classList.remove("hidden");
  note.textContent = "Read each slide's script aloud and record it. Recorded slides use your voice instead of TTS \u2014 then re-narrate.";

  const recorded = (job.content && job.content.recorded_audio) || {};
  // Only rebuild if slide count changed (avoid clobbering active recorders).
  if (wrap.dataset.count === String(slides.length)) {
    // Just refresh recorded badges.
    slides.forEach((_, i) => {
      const row = wrap.querySelector(`.rec-slide[data-idx="${i}"]`);
      if (row) row.classList.toggle("has-clip", recorded[String(i)] != null);
    });
    return false;
  }
  wrap.dataset.count = String(slides.length);
  wrap.innerHTML = "";

  slides.forEach((sl, i) => {
    const script = (sl.narration || "").trim() || "(no narration)";
    const row = document.createElement("div");
    row.className = "rec-slide" + (recorded[String(i)] != null ? " has-clip" : "");
    row.dataset.idx = String(i);
    row.innerHTML = `
      <div class="rec-head">
        <span class="rec-num">${i + 1}</span>
        <span class="rec-script">${escapeHtml(script)}</span>
      </div>
      <div class="rec-controls">
        <button class="btn-sm rec-btn" data-rec="${i}"><i data-lucide="mic"></i>Record</button>
        <audio class="rec-audio hidden" controls preload="none"></audio>
        <span class="rec-flag"><i data-lucide="check"></i>saved</span>
      </div>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("[data-rec]").forEach((btn) => {
    btn.addEventListener("click", () => toggleRecord(parseInt(btn.dataset.rec, 10), btn));
  });
  return true;
}

async function toggleRecord(idx, btn) {
  const existing = mediaRecorders[idx];
  if (existing && existing.rec.state === "recording") {
    existing.rec.stop();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showAlert("Microphone recording is not supported in this browser.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showAlert("Microphone permission denied.");
    return;
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  mediaRecorders[idx] = { rec, chunks };
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    btn.innerHTML = '<i data-lucide="mic"></i>Record';
    btn.classList.remove("recording");
    icons();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const row = btn.closest(".rec-slide");
    const audioEl = row.querySelector(".rec-audio");
    audioEl.src = URL.createObjectURL(blob);
    audioEl.classList.remove("hidden");
    await uploadRecording(idx, blob, row);
  };
  rec.start();
  btn.innerHTML = '<span class="spinner"></span>Stop';
  btn.classList.add("recording");
  icons();
}

async function uploadRecording(idx, blob, row) {
  if (!jobId) { showAlert("No active session to attach the recording to."); return; }
  const form = new FormData();
  form.append("slide_index", String(idx));
  form.append("audio", blob, `slide_${idx}.webm`);
  try {
    const res = await fetch(`/api/jobs/${jobId}/voice-recording`, { method: "POST", body: form });
    if (!res.ok) throw new Error("upload failed");
    row.classList.add("has-clip");
  } catch (e) {
    showAlert("Failed to save recording.");
  }
}

// =============================================================== auth + nav ===

let currentUser = null;

async function initAuth() {
  try {
    const data = await (await fetch("/api/auth/me")).json();
    currentUser = data.user || null;
  } catch (e) { currentUser = null; }
  renderUserChip();

  const chip = $("user-chip");
  const menu = $("user-menu");
  if (chip && menu) {
    chip.addEventListener("click", (e) => {
      if (e.target.closest("#um-logout")) return;
      menu.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      if (!chip.contains(e.target)) menu.classList.remove("open");
    });
  }
  const logout = $("um-logout");
  if (logout) logout.addEventListener("click", async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) {}
    window.location.href = "/login";
  });
  // Reveal admin nav tabs.
  if (currentUser && currentUser.role === "admin") {
    document.querySelectorAll(".admin-only").forEach((el) => { el.hidden = false; });
    refreshInviteBadge();
  }
  icons();
}

function renderUserChip() {
  const chip = $("user-chip");
  if (!chip || !currentUser) return;
  chip.hidden = false;
  const label = currentUser.username || currentUser.email.split("@")[0];
  const initial = (label[0] || "?").toUpperCase();
  $("user-avatar").textContent = initial;
  $("user-name").textContent = label;
  $("um-name").textContent = label;
  $("um-email").textContent = currentUser.email;
  $("um-role").textContent = currentUser.role;
}

function initNav() {
  document.querySelectorAll("#main-nav .stab").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.querySelectorAll(".admin-sub").forEach((btn) => {
    btn.addEventListener("click", () => switchAdminPanel(btn.dataset.admin));
  });
  const ir = $("invites-refresh");
  if (ir) ir.addEventListener("click", loadInvites);
  const ic = $("invites-clear-old");
  if (ic) ic.addEventListener("click", clearOldInvites);
  const cr = $("cron-refresh");
  if (cr) cr.addEventListener("click", () => { loadCron(); loadAutomation(); });
  document.querySelectorAll(".cron-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cron-filter").forEach((b) => b.classList.toggle("active", b === btn));
      cronFilter = btn.dataset.filter || "queue";
      try { localStorage.setItem("cronFilter", cronFilter); } catch (e) {}
      const grid = $("cron-grid");
      if (grid) delete grid.dataset.cronSnap;
      const empty = $("cron-empty");
      if (empty) delete empty.dataset.filter;
      loadCron();
    });
  });
  const at = $("auto-trigger");
  if (at) at.addEventListener("click", triggerAutomation);
  const ar = $("auto-resume");
  if (ar) ar.addEventListener("click", resumeAutomation);
  const ap = $("auto-pause");
  if (ap) ap.addEventListener("click", pauseAutomation);
  const ae = $("auto-enabled");
  if (ae) ae.addEventListener("change", () => toggleAutomation(ae.checked));
  document.querySelectorAll(".auto-input-tab").forEach((btn) => {
    btn.addEventListener("click", () => setAutoInputTab(btn.dataset.inputTab || "papers"));
  });
  const atr = $("auto-topics-refresh");
  if (atr) atr.addEventListener("click", () => {
    autoTopicSearchMode = false;
    autoTopicSearchQuery = "";
    autoTopicView = "trending";
    setAutoTopicView("trending");
    loadAutomationTopics(true);
  });
  document.querySelectorAll("#auto-topics-subnav [data-topic-view]").forEach((btn) => {
    btn.addEventListener("click", () => setAutoTopicView(btn.dataset.topicView || "trending"));
  });
  const tsForm = $("auto-topics-search-form");
  if (tsForm) tsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    searchAutomationTopics();
  });
  const tsClear = $("auto-topics-clear-search");
  if (tsClear) tsClear.addEventListener("click", () => {
    autoTopicSearchMode = false;
    autoTopicSearchQuery = "";
    const q = $("auto-topics-search-q");
    if (q) q.value = "";
    if (autoTrendingBackup) {
      autoTopics = autoTrendingBackup;
      renderAutomationTopics();
    } else {
      loadAutomationTopics(false);
    }
  });
  const rts = $("rt-save");
  if (rts) rts.addEventListener("click", saveRuntimeSettings);
  const rtp = $("rt-llm-provider");
  if (rtp) rtp.addEventListener("change", syncRuntimeProviderFields);
  const cref = $("costs-refresh");
  if (cref) cref.addEventListener("click", loadCosts);
  const crange = $("cost-range");
  if (crange) crange.addEventListener("change", loadCosts);
  const csort = $("cost-job-sort");
  if (csort) csort.addEventListener("change", () => {
    costJobSort = csort.value || "recent";
    if (lastCostReport) renderCosts(lastCostReport);
    else loadCosts();
  });
  const cdbg = $("cost-debug");
  if (cdbg) cdbg.addEventListener("change", loadCosts);
  document.querySelectorAll(".cost-subtab").forEach((btn) => {
    btn.addEventListener("click", () => setCostTab(btn.dataset.costTab || "model"));
  });
  const sref = $("sessions-refresh");
  if (sref) sref.addEventListener("click", loadSessions);
  const uref = $("users-refresh");
  if (uref) uref.addEventListener("click", loadUsers);
  const uform = $("user-add-form");
  if (uform) uform.addEventListener("submit", createUser);
  const pref = $("palette-refresh");
  if (pref) pref.addEventListener("click", loadAdminPalette);
  const psave = $("palette-save");
  if (psave) psave.addEventListener("click", saveAdminPalette);
  const slidePrev = $("admin-slide-prev");
  if (slidePrev) slidePrev.addEventListener("click", () => adminSlideStep(-1));
  const slideNext = $("admin-slide-next");
  if (slideNext) slideNext.addEventListener("click", () => adminSlideStep(1));
  const slideRange = $("admin-slide-range");
  if (slideRange) slideRange.addEventListener("input", () => {
    adminSlideIdx = Number(slideRange.value) || 0;
    renderAdminSlidePreview();
  });
  const scref = $("social-creds-refresh");
  if (scref) scref.addEventListener("click", loadSocialCredentials);
}

let leftPanel = "setup";

function initLeftTabs() {
  document.querySelectorAll(".left-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchLeftPanel(btn.dataset.left));
  });
  switchLeftPanel("setup");
}

function switchLeftPanel(panel) {
  leftPanel = panel || "setup";
  document.querySelectorAll(".left-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.left === leftPanel)
  );
  swapPanelGroup(".left-panel", (p) =>
    (leftPanel === "setup" && p.id === "left-panel-setup") ||
    (leftPanel === "voices" && p.id === "left-panel-voices")
  );
  if (leftPanel === "voices") loadVoices();
  icons();
}

/** Smooth show for tab panels. Hide is instant so sibling panels never stack. */
const _paneTimers = new WeakMap();
const PANE_MS = 240;
function fadeSwapPanel(el, show) {
  if (!el) return;
  const prev = _paneTimers.get(el);
  if (prev) {
    clearTimeout(prev.t);
    if (prev.raf) cancelAnimationFrame(prev.raf);
    _paneTimers.delete(el);
  }
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clearAnim = () => {
    el.classList.remove("pane-enter", "pane-enter-active", "pane-leave", "pane-leave-active");
    el.style.opacity = "";
    el.style.transform = "";
    el.style.willChange = "";
  };
  if (show) {
    el.hidden = false;
    el.classList.remove("hidden");
    clearAnim();
    if (reduce) return;
    el.style.willChange = "opacity, transform";
    el.classList.add("pane-enter");
    // Double rAF so the browser paints the start state before transitioning.
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        el.classList.add("pane-enter-active");
        el.classList.remove("pane-enter");
        const t = setTimeout(() => {
          clearAnim();
          _paneTimers.delete(el);
        }, PANE_MS);
        _paneTimers.set(el, { t, raf: 0 });
      });
      _paneTimers.set(el, { t: 0, raf: raf2 });
    });
    _paneTimers.set(el, { t: 0, raf: raf1 });
  } else {
    el.classList.add("hidden");
    el.hidden = true;
    clearAnim();
  }
}

/** Hide every panel in a group instantly, then fade-in the active one. */
function swapPanelGroup(selector, isActive) {
  const nodes = [...document.querySelectorAll(selector)];
  nodes.forEach((p) => {
    if (!isActive(p)) fadeSwapPanel(p, false);
  });
  nodes.forEach((p) => {
    if (isActive(p)) fadeSwapPanel(p, true);
  });
}

/** Set button HTML only when it changes — avoids Lucide rebuild flicker on polls. */
function setIconHtml(el, html) {
  if (!el) return false;
  if (el.dataset.iconHtml === html) return false;
  el.dataset.iconHtml = html;
  el.innerHTML = html;
  return true;
}

let adminPanel = "users";

function switchAdminPanel(panel) {
  if (panel === "cron" && (!currentUser || currentUser.role !== "admin")) return;
  if (panel === "palette" && (!currentUser || currentUser.role !== "admin")) return;
  if (panel === "visual" && (!currentUser || currentUser.role !== "admin")) return;
  if (panel === "social" && (!currentUser || currentUser.role !== "admin")) return;
  adminPanel = panel || "users";
  document.querySelectorAll(".admin-sub").forEach((b) =>
    b.classList.toggle("active", b.dataset.admin === adminPanel)
  );
  swapPanelGroup(".admin-panel", (p) => p.id === "admin-panel-" + adminPanel);
  if (adminPanel === "users") loadUsers();
  if (adminPanel === "invites") loadInvites();
  if (adminPanel === "palette") loadAdminPalette();
  if (adminPanel === "visual") renderAdminVisualStyles();
  if (adminPanel === "social") loadSocialCredentials();
  if (adminPanel === "cron") { loadCron(); loadAutomation(); loadRuntimeSettings(); }
  if (adminPanel === "costs") loadCosts();
  icons();
}

function switchView(view) {
  if (view === "admin" && (!currentUser || currentUser.role !== "admin")) return;
  document.querySelectorAll("#main-nav .stab").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  swapPanelGroup(".view", (v) => v.id === "view-" + view);
  if (view === "admin") switchAdminPanel(adminPanel);
  if (view === "sessions") { loadSessions(); renderSessionGallery(); }
  if (view === "video-edit") loadMediaStatus();
  if (view === "studio") renderSessionTabs();
  // Keep scroll calm when jumping between major views.
  try {
    const main = document.querySelector("main") || document.scrollingElement;
    if (main && typeof main.scrollTo === "function") {
      main.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch (e) { /* ignore */ }
}

// ----------------------------------------------------------- admin: users ---

function fmtUserWhen(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

async function loadUsers() {
  const tbody = $("users-tbody");
  const empty = $("users-empty");
  const table = $("users-table");
  if (!tbody) return;
  let users = [];
  let roles = ["user", "admin"];
  try {
    const res = await fetch("/api/admin/users");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Failed to load users");
    users = data.users || [];
    roles = data.roles || roles;
  } catch (e) {
    users = [];
    if (empty && e.message) {
      empty.textContent = e.message;
      empty.classList.remove("hidden");
    }
  }
  tbody.innerHTML = "";
  const hasRows = users.length > 0;
  if (empty) {
    empty.classList.toggle("hidden", hasRows);
    if (hasRows) empty.textContent = "No users yet.";
  }
  if (table) table.classList.toggle("hidden", !hasRows);
  const me = currentUser && currentUser.id;
  users.forEach((u) => {
    const tr = document.createElement("tr");
    const isSelf = u.id === me;
    const isInvited = u.status === "invited";
    const roleOpts = roles.map((r) =>
      `<option value="${escapeHtml(r)}" ${r === u.role ? "selected" : ""}>${escapeHtml(r === "admin" ? "Admin" : "User")}</option>`
    ).join("");
    const accessCell = isInvited
      ? `<span class="pill invited" title="Approved — waiting for them to set a password on the login page">Invited</span>`
      : `<select class="role-select" data-id="${escapeHtml(u.id)}" ${isSelf ? "disabled title='Cannot change your own role'" : ""}>${roleOpts}</select>`;
    tr.innerHTML =
      `<td class="user-cell-main">` +
        `<div class="user-cell-email">${escapeHtml(u.email)}</div>` +
        `<div class="user-cell-name">${escapeHtml(u.username || "—")}</div>` +
      `</td>` +
      `<td>${accessCell}</td>` +
      `<td class="user-cell-when">${fmtUserWhen(u.created_at)}</td>` +
      `<td class="user-cell-actions">` +
        (isSelf
          ? `<span class="user-self-tag">You</span>`
          : `<button type="button" class="btn-sm ghost user-del" data-id="${escapeHtml(u.id)}" data-invited="${isInvited ? "1" : "0"}" title="${isInvited ? "Revoke invite" : "Remove user"}"><i data-lucide="${isInvited ? "user-x" : "trash-2"}"></i></button>`) +
      `</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".role-select").forEach((sel) => {
    sel.dataset.prev = sel.value;
    sel.addEventListener("change", () => updateUserRole(sel.dataset.id, sel.value, sel));
  });
  tbody.querySelectorAll(".user-del").forEach((btn) => {
    btn.addEventListener("click", () => deleteUser(btn.dataset.id, btn.dataset.invited === "1"));
  });
  icons();
}

async function updateUserRole(id, role, sel) {
  const prev = sel.dataset.prev || role;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Update failed");
    sel.dataset.prev = role;
  } catch (e) {
    sel.value = prev;
    alert(e.message || "Failed to update access level");
  }
}

async function deleteUser(id, invited) {
  const msg = invited
    ? "Revoke this invite? They will not be able to register with this approval."
    : "Remove this user? They will lose access immediately.";
  if (!confirm(msg)) return;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Delete failed");
    loadUsers();
  } catch (e) {
    alert(e.message || "Failed to remove user");
  }
}

async function createUser(e) {
  e.preventDefault();
  const msg = $("user-add-msg");
  const email = ($("ua-email") && $("ua-email").value || "").trim();
  const username = ($("ua-name") && $("ua-name").value || "").trim();
  const password = ($("ua-pw") && $("ua-pw").value) || "";
  const role = ($("ua-role") && $("ua-role").value) || "user";
  if (msg) { msg.classList.add("hidden"); msg.textContent = ""; }
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, username, password, role }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Create failed");
    if (msg) {
      msg.textContent = `Created ${data.user && data.user.email ? data.user.email : email}`;
      msg.className = "user-add-msg ok";
      msg.classList.remove("hidden");
    }
    e.target.reset();
    loadUsers();
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || "Failed to create user";
      msg.className = "user-add-msg err";
      msg.classList.remove("hidden");
    }
  }
}

// ----------------------------------------------------------- admin: invites --

async function refreshInviteBadge() {
  try {
    const res = await fetch("/api/admin/invites");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const pending = (data.invites || []).filter((i) => i.status === "pending").length;
    const badge = $("nav-invite-count");
    if (badge) {
      badge.textContent = String(pending);
      badge.hidden = pending === 0;
    }
  } catch (e) { /* ignore */ }
}

async function loadInvites() {
  const grid = $("invites-grid");
  const empty = $("invites-empty");
  if (!grid) return;
  let invites = [];
  try {
    const res = await fetch("/api/admin/invites");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Failed to load invites"));
    invites = data.invites || [];
  } catch (e) {
    invites = [];
    if (empty) {
      empty.textContent = e.message || "Failed to load invites";
      empty.classList.remove("hidden");
    }
  }
  grid.innerHTML = "";
  if (empty && invites.length > 0) empty.classList.add("hidden");
  else if (empty && !empty.textContent) {
    empty.textContent = "No invite requests.";
    empty.classList.remove("hidden");
  } else if (empty && invites.length === 0) {
    if (!/failed/i.test(empty.textContent || "")) empty.textContent = "No invite requests.";
    empty.classList.remove("hidden");
  }
  const oldCount = invites.filter((i) =>
    ["revoked", "denied", "registered"].includes(String(i.status || "").toLowerCase())
  ).length;
  const clearBtn = $("invites-clear-old");
  if (clearBtn) {
    clearBtn.disabled = oldCount === 0;
    clearBtn.title = oldCount
      ? `Delete ${oldCount} settled invite(s) from the database`
      : "No revoked / denied / registered invites to clear";
  }
  invites.forEach((inv) => {
    const card = document.createElement("div");
    card.className = "invite-card";
    const when = inv.created_at ? new Date(inv.created_at * 1000).toLocaleString() : "";
    const status = String(inv.status || "pending").toLowerCase();
    const actions = status === "pending"
      ? `<button class="btn-sm accent" data-approve="${escapeHtml(inv.id)}"><i data-lucide="check"></i>Approve</button>
         <button class="btn-sm ghost" data-deny="${escapeHtml(inv.id)}"><i data-lucide="x"></i>Deny</button>`
      : `<button class="btn-sm ghost" data-delete-invite="${escapeHtml(inv.id)}" title="Remove from list and database"><i data-lucide="trash-2"></i> Clear</button>`;
    card.innerHTML = `
      <div class="invite-row">
        <div>
          <div class="invite-email">${escapeHtml(inv.email)}</div>
          ${inv.name ? `<div class="invite-name">${escapeHtml(inv.name)}</div>` : ""}
        </div>
        <span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      ${inv.message ? `<div class="invite-msg">${escapeHtml(inv.message)}</div>` : ""}
      <div class="invite-name">${when}</div>
      <div class="invite-actions">${actions}</div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-approve]").forEach((b) =>
    b.addEventListener("click", () => decideInvite(b.dataset.approve, true))
  );
  grid.querySelectorAll("[data-deny]").forEach((b) =>
    b.addEventListener("click", () => decideInvite(b.dataset.deny, false))
  );
  grid.querySelectorAll("[data-delete-invite]").forEach((b) =>
    b.addEventListener("click", () => deleteInvite(b.dataset.deleteInvite))
  );
  icons();
}

async function decideInvite(id, approve) {
  try {
    const res = await fetch(`/api/admin/invites/${id}/decide?approve=${approve}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Failed to update invite"));
  } catch (e) {
    alert(e.message || "Failed to update invite");
  }
  loadInvites();
  loadUsers();
  refreshInviteBadge();
}

async function deleteInvite(id) {
  if (!id) return;
  if (!confirm("Remove this invite from the list and database?")) return;
  try {
    const res = await fetch(`/api/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Failed to delete invite"));
  } catch (e) {
    alert(e.message || "Failed to delete invite");
  }
  loadInvites();
  loadUsers();
  refreshInviteBadge();
}

async function clearOldInvites() {
  if (!confirm("Clear all revoked, denied, and registered invite requests from the database? Pending and approved invites stay.")) {
    return;
  }
  const btn = $("invites-clear-old");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Clearing…'; }
  try {
    const res = await fetch("/api/admin/invites/clear-old", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ statuses: ["revoked", "denied", "registered"] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Failed to clear invites"));
    if (data.deleted === 0) alert("Nothing to clear.");
  } catch (e) {
    alert(e.message || "Failed to clear invites");
  } finally {
    if (btn) { btn.innerHTML = orig; icons(); }
  }
  loadInvites();
  loadUsers();
  refreshInviteBadge();
}

// -------------------------------------------------------------- admin: cron --

let cronFilter = "queue";
try {
  const saved = localStorage.getItem("cronFilter");
  // Migrate old filter keys to the Queue / History model.
  if (saved === "all" || saved === "processing") cronFilter = "queue";
  else if (saved === "published") cronFilter = "history";
  else if (saved && ["queue", "ready", "incomplete", "history"].includes(saved)) cronFilter = saved;
} catch (e) {}
let cronRuns = [];
let autoPreview = null;

function fmtHour(h) {
  const hr = Number(h);
  if (Number.isNaN(hr)) return String(h);
  const ampm = hr >= 12 ? "PM" : "AM";
  const h12 = hr % 12 || 12;
  return `${h12}:00 ${ampm}`;
}

function fmtHourList(hours) {
  return (hours || []).map(fmtHour).join(", ") || "—";
}

function fmtTs(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function paperPdfLink(paper, runFolder) {
  if (!paper) return "";
  const label = escapeHtml(
    (paper.pdf_file && paper.pdf_file !== "paper.pdf")
      ? paper.pdf_file
      : (paper.title ? `${String(paper.title).slice(0, 48)}.pdf` : "Source PDF")
  );
  if (paper.pdf_file && runFolder) {
    const p = `/api/admin/cron/${encodeURIComponent(runFolder)}/file/${encodeURIComponent(paper.pdf_file)}`;
    return `<a href="${p}" target="_blank" rel="noopener" download="${label}"><i data-lucide="file-text"></i> ${label}</a>`;
  }
  if (paper.pdf_url) {
    return `<a href="${escapeHtml(paper.pdf_url)}" target="_blank" rel="noopener"><i data-lucide="file-text"></i> ${label}</a>`;
  }
  return "";
}

let autoPaperSelection = new Set();
let autoInputTab = "papers";
try {
  const t = localStorage.getItem("autoInputTab");
  if (t === "papers" || t === "topics") autoInputTab = t;
} catch (e) {}
let autoTopics = null;
let autoTopicSelection = "";
let autoTopicsLoading = false;
let autoTopicsAbort = null;
let autoTopicSearchMode = false;
let autoTopicSearchQuery = "";
let autoTrendingBackup = null;
let autoTopicView = "trending";

function setAutoTopicView(view) {
  autoTopicView = view === "past" ? "past" : "trending";
  document.querySelectorAll("#auto-topics-subnav [data-topic-view]").forEach((b) => {
    const on = (b.dataset.topicView || "") === autoTopicView;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  renderAutomationTopics();
}

function autoTopicsStale(data) {
  if (!data) return true;
  const ttl = Number(data.cache_ttl_s) || 3600;
  const age = Number(data.cache_age_s);
  if (Number.isFinite(age) && age >= ttl) return true;
  if (data.stale) return true;
  const fetched = Number(data.fetched_at) || 0;
  if (fetched > 0 && (Date.now() / 1000 - fetched) >= ttl) return true;
  return false;
}

function topicLists() {
  return [
    autoTopics && autoTopics.topics,
    autoTopics && autoTopics.extras,
    autoTopics && autoTopics.archive,
    autoTrendingBackup && autoTrendingBackup.topics,
    autoTrendingBackup && autoTrendingBackup.extras,
    autoTrendingBackup && autoTrendingBackup.archive,
  ].filter(Boolean);
}

function patchAutomationTopic(topicId, patch) {
  if (!topicId || !patch) return;
  for (const list of topicLists()) {
    const t = list.find((x) => x && x.id === topicId);
    if (t) Object.assign(t, patch);
  }
}

function findTopicButton(attr, topicId) {
  if (!topicId) return null;
  const esc = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    ? CSS.escape(topicId)
    : String(topicId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return document.querySelector(`[${attr}="${esc}"]`);
}

function setAutoInputTab(tab, { load = true } = {}) {
  autoInputTab = tab === "topics" ? "topics" : "papers";
  try { localStorage.setItem("autoInputTab", autoInputTab); } catch (e) {}
  document.querySelectorAll(".auto-input-tab").forEach((b) => {
    const on = (b.dataset.inputTab || "") === autoInputTab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  const papers = $("auto-paper-preview");
  const topics = $("auto-topics-preview");
  if (papers) papers.classList.toggle("hidden", autoInputTab !== "papers");
  if (topics) topics.classList.toggle("hidden", autoInputTab !== "topics");
  if (load && autoInputTab === "topics") loadAutomationTopics(false);
  if (load && autoInputTab === "papers") loadAutomation();
}

function truthPill(level) {
  const lv = String(level || "medium").toLowerCase();
  const label = lv === "high" ? "Truth: high"
    : (lv === "low" ? "Truth: low"
      : (lv === "mixed" ? "Truth: mixed" : "Truth: medium"));
  return `<span class="truth-pill ${escapeHtml(lv)}"><i data-lucide="shield-check"></i> ${label}</span>`;
}

function renderPaperPreview(st, preview) {
  const panel = $("auto-input-panel");
  const el = $("auto-paper-preview");
  if (!el) return false;
  // Preserve checkbox picks across re-renders.
  el.querySelectorAll(".auto-paper-check:checked").forEach((c) => {
    const id = c.value || c.dataset.paperId;
    if (id) autoPaperSelection.add(id);
  });
  const running = st && st.running;
  const current = running && st.current_paper ? st.current_paper : null;
  const queue = running && st.papers_queue && st.papers_queue.length
    ? st.papers_queue
    : (preview && preview.papers) || [];
  const showCurrent = running && current;
  const showQueue = !running && queue.length > 0;
  const showEmpty = !running && queue.length === 0 && !(preview && preview.running);

  // Keep the panel visible when topics tab is active even if paper queue is empty.
  const showPanel = showCurrent || showQueue || showEmpty || autoInputTab === "topics"
    || (autoTopics && (autoTopics.topics || []).length);
  if (panel) panel.classList.toggle("hidden", !showPanel);
  if (!showCurrent && !showQueue && !showEmpty && autoInputTab === "papers") {
    if (el.innerHTML) { el.innerHTML = ""; el.dataset.stableHtml = ""; }
    return false;
  }

  let html = "";
  if (showCurrent) {
    const authors = (current.authors || []).join(", ");
    const pdf = paperPdfLink(current, current.folder);
    const rest = (queue || []).filter((p) => p.id !== current.id).slice(0, 2);
    const restHtml = rest.length
      ? `<div class="auto-paper-label" style="margin-top:12px">Also in this run</div>` +
        rest.map((p) => `
          <div class="auto-paper-card auto-paper-card-muted">
            <div class="auto-paper-title">${escapeHtml(p.title || p.id)}</div>
          </div>`).join("")
      : "";
    html = `
      <div class="auto-paper-label">Processing input PDF</div>
      <div class="auto-paper-card">
        <div class="auto-paper-title">${escapeHtml(current.title || current.id)}</div>
        ${authors ? `<div class="auto-paper-authors">${escapeHtml(authors)}</div>` : ""}
        <div class="auto-paper-links">
          ${pdf}
          ${current.code_url ? `<a href="${escapeHtml(current.code_url)}" target="_blank" rel="noopener"><i data-lucide="github"></i> Code</a>` : ""}
        </div>
      </div>${restHtml}`;
  } else if (showQueue) {
    const cards = queue.slice(0, 3).map((p, i) => {
      const authors = (p.authors || []).slice(0, 3).join(", ");
      const pdf = paperPdfLink(p, p.folder);
      const pid = escapeHtml(p.id || "");
      const folder = escapeHtml(p.folder || "");
      const checked = autoPaperSelection.has(p.id) ? " checked" : "";
      const badge = p.resume
        ? `<span class="auto-paper-badge resume">Resume · ${escapeHtml(p.left_at || "pdf_ready")}</span>`
        : `<span class="auto-paper-badge queue">Queue #${i + 1}</span>`;
      const completeBtn = p.resume
        ? `<button type="button" class="btn-sm accent auto-paper-act" data-act="complete" data-paper-id="${pid}" data-folder="${folder}" title="Finish this incomplete paper"><i data-lucide="play"></i> Complete</button>`
        : "";
      return `
        <div class="auto-paper-card auto-paper-selectable">
          <input type="checkbox" class="auto-paper-check" value="${pid}" data-paper-id="${pid}"${checked} />
          <div class="auto-paper-card-body">
            <div class="auto-paper-title-row">
          <div class="auto-paper-title">${escapeHtml(p.title || p.id)}</div>
              ${badge}
            </div>
          ${authors ? `<div class="auto-paper-authors">${escapeHtml(authors)}</div>` : ""}
          <div class="auto-paper-links">
            ${pdf}
            ${p.has_code && p.code_url ? `<a href="${escapeHtml(p.code_url)}" target="_blank" rel="noopener"><i data-lucide="github"></i> Code</a>` : ""}
            </div>
            <div class="auto-paper-actions">
              ${completeBtn}
              <button type="button" class="btn-sm auto-paper-act" data-act="skip" data-paper-id="${pid}" data-folder="${folder}" title="Already generated / skip — won't reappear in queue"><i data-lucide="ban"></i> Skip</button>
              <button type="button" class="btn-sm ghost auto-paper-act" data-act="delete" data-paper-id="${pid}" data-folder="${folder}" title="Delete downloaded folder"><i data-lucide="trash-2"></i> Delete</button>
            </div>
          </div>
        </div>`;
    }).join("");
    html = `
      <div class="auto-paper-label">Pending / next papers — select up to 3, then Run now. Incomplete items need Resume or Complete (nothing auto-starts on login).</div>
      ${cards}`;
  } else if (preview && preview.error) {
    html = `<div class="auto-paper-empty">Could not preview next paper: ${escapeHtml(preview.error)}</div>`;
  } else {
    html = `<div class="auto-paper-empty">No new papers available — all recent candidates have already been processed.</div>`;
  }
  const changed = setStableHtml(el, html);
  if (changed || showQueue) {
    // Re-apply selection + wire link clicks so they don't fight the checkbox.
    el.querySelectorAll(".auto-paper-check").forEach((c) => {
      const id = c.value || c.dataset.paperId;
      c.checked = !!(id && autoPaperSelection.has(id));
      c.onchange = () => {
        const pid = c.value || c.dataset.paperId;
        if (!pid) return;
        if (c.checked) {
          if (autoPaperSelection.size >= 3 && !autoPaperSelection.has(pid)) {
            c.checked = false;
    return;
          }
          autoPaperSelection.add(pid);
        } else {
          autoPaperSelection.delete(pid);
        }
      };
    });
    el.querySelectorAll(".auto-paper-links a").forEach((a) => {
      a.onclick = (e) => e.stopPropagation();
    });
    el.querySelectorAll(".auto-paper-selectable").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest("a, input, button")) return;
        const cb = card.querySelector(".auto-paper-check");
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
      };
    });
    el.querySelectorAll(".auto-paper-act").forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        paperJobAction(btn.dataset.act, btn.dataset.paperId, btn.dataset.folder, btn);
      };
    });
  }
  setAutoInputTab(autoInputTab, { load: false });
  return changed;
}

async function loadAutomationTopics(refresh = false) {
  const list = $("auto-topics-list");
  const empty = $("auto-topics-empty");
  const btn = $("auto-topics-refresh");
  const modeEl = $("auto-topics-mode");
  if (!list) return;
  if (autoTopicsLoading) {
    // A refresh is already in flight — don't stack freezes; render what we have.
    if (!refresh && autoTopics) renderAutomationTopics();
    return;
  }
  if (!refresh && autoTopics && (autoTopics.topics || []).length && !autoTopicsStale(autoTopics)) {
    autoTopicSearchMode = false;
    renderAutomationTopics();
    return;
  }
  autoTopicsLoading = true;
  autoTopicSearchMode = false;
  const hadCards = list.children.length > 0;
  list.classList.add("is-refreshing");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-spinning");
  }
  // Keep existing cards visible while refreshing — only show empty on first load.
  if (!hadCards && empty) {
    empty.classList.remove("hidden");
    empty.textContent = refresh || autoTopicsStale(autoTopics)
      ? "Refreshing AI news pulse…"
      : "Loading trending topics…";
  } else if (empty && hadCards) {
    empty.classList.add("hidden");
  }
  if (modeEl && hadCards) {
    modeEl.dataset.prevText = modeEl.textContent || "";
    modeEl.textContent = "Refreshing pulse…";
  }
  if (autoTopicsAbort) {
    try { autoTopicsAbort.abort(); } catch (e) { /* ignore */ }
  }
  autoTopicsAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortTimer = autoTopicsAbort
    ? setTimeout(() => { try { autoTopicsAbort.abort(); } catch (e) { /* ignore */ } }, 45000)
    : null;
  try {
    const res = await fetch(
      `/api/admin/automation/topics${refresh ? "?refresh=1" : ""}`,
      autoTopicsAbort ? { signal: autoTopicsAbort.signal } : undefined,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Failed to load topics"));
    autoTopics = data;
    autoTrendingBackup = data;
    invalidateStable(list);
    renderAutomationTopics();
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    if (empty && !hadCards) {
      empty.classList.remove("hidden");
      empty.textContent = aborted
        ? "Topic refresh timed out — try Refresh again."
        : (e.message || "Failed to load topics");
    } else if (modeEl) {
      modeEl.textContent = aborted
        ? "Refresh timed out — showing previous list"
        : (e.message || "Refresh failed — showing previous list");
    }
    if (autoTopics) renderAutomationTopics();
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    autoTopicsLoading = false;
    list.classList.remove("is-refreshing");
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-spinning");
    }
  }
}

async function searchAutomationTopics() {
  const qEl = $("auto-topics-search-q");
  const q = ((qEl && qEl.value) || "").trim();
  if (q.length < 2) {
    alert("Enter at least 2 characters to search.");
    return;
  }
  const empty = $("auto-topics-empty");
  const btn = $("auto-topics-search-btn");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`; }
  if (empty) {
    empty.classList.remove("hidden");
    empty.textContent = `Searching “${q}”…`;
  }
  try {
    const res = await fetch("/api/admin/automation/topics/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Search failed"));
    if (!autoTrendingBackup && autoTopics && !autoTopicSearchMode) {
      autoTrendingBackup = autoTopics;
    }
    autoTopicSearchMode = true;
    autoTopicSearchQuery = data.query || q;
    autoTopics = {
      ...(autoTrendingBackup || {}),
      topics: data.topics || [],
      extras: (autoTrendingBackup && autoTrendingBackup.extras) || [],
      model: data.model || (autoTopics && autoTopics.model),
      search_query: autoTopicSearchQuery,
    };
    renderAutomationTopics();
  } catch (e) {
    if (empty) {
      empty.classList.remove("hidden");
      empty.textContent = e.message || "Search failed";
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; icons(); }
  }
}

function trendMeter(score) {
  const s = Math.max(1, Math.min(10, Number(score) || 5));
  const pct = Math.round((s / 10) * 100);
  return `<span class="auto-topic-trend" title="Trend score ${s}/10">` +
    `<span class="auto-topic-trend-bar"><span class="auto-topic-trend-fill" style="width:${pct}%"></span></span>` +
    ` ${s}/10</span>`;
}

function topicCardHtml(t) {
  const id = escapeHtml(t.id || "");
  const selected = autoTopicSelection === t.id || t.selected ? " selected" : "";
  const score = t.trend_score || t.heat || 5;
  const badges = [];
  if (t.prepared) badges.push(`${truthPill(t.truthfulness)} <span class="auto-paper-badge queue">Prepared</span>`);
  else badges.push(trendMeter(score));
  if (t.selected || autoTopicSelection === t.id) badges.push(`<span class="auto-paper-badge resume">Selected</span>`);
  if (t.job_id) badges.push(`<span class="auto-paper-badge queue">Queued</span>`);
  const sources = (t.sources || []).slice(0, 3).map((s) =>
    `<span class="auto-topic-src">${escapeHtml(s)}</span>`
  ).join("");
  return `
    <div class="auto-topic-card${selected}" data-topic-id="${id}">
      <div class="auto-topic-card-head">
        <div class="auto-paper-title">${escapeHtml(t.prep_title || t.title || t.id)}</div>
        <div class="auto-topic-meta">${badges.join(" ")}</div>
      </div>
      ${t.blurb ? `<p class="auto-topic-blurb">${escapeHtml(t.blurb)}</p>` : ""}
      ${sources ? `<div class="auto-topic-meta">${sources}</div>` : ""}
      <div class="auto-topic-actions">
        <button type="button" class="btn-sm accent" data-topic-prep="${id}">
          <i data-lucide="sparkles"></i> ${t.prepared ? "Re-prepare" : "Prepare content"}
        </button>
        <button type="button" class="btn-sm" data-topic-queue="${id}">
          <i data-lucide="clapperboard"></i> Queue video
        </button>
      </div>
    </div>`;
}

function bindTopicCardHandlers(root) {
  if (!root) return;
  root.querySelectorAll(".auto-topic-card").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest("button, a")) return;
      const tid = card.dataset.topicId || "";
      autoTopicSelection = tid;
      selectAutomationTopic(tid);
      renderAutomationTopics();
    };
  });
  root.querySelectorAll("[data-topic-prep]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      prepareAutomationTopic(btn.dataset.topicPrep, btn);
    };
  });
  root.querySelectorAll("[data-topic-queue]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      queueAutomationTopic(btn.dataset.topicQueue, btn);
    };
  });
}

function renderAutomationTopics() {
  const list = $("auto-topics-list");
  const empty = $("auto-topics-empty");
  const detail = $("auto-topic-detail");
  const sourcesEl = $("auto-topics-sources");
  const modeEl = $("auto-topics-mode");
  const extrasEl = $("auto-topics-extras");
  const clearBtn = $("auto-topics-clear-search");
  const subnav = $("auto-topics-subnav");
  if (!list) return;

  const showPast = autoTopicView === "past" && !autoTopicSearchMode;
  const trending = (autoTopics && autoTopics.topics) || [];
  const archive = (autoTopics && (autoTopics.archive || autoTopics.extras)) || [];
  const topics = showPast ? archive : trending;
  if (subnav) subnav.classList.toggle("hidden", autoTopicSearchMode);
  if (empty) empty.classList.toggle("hidden", topics.length > 0);
  if (clearBtn) clearBtn.classList.toggle("hidden", !autoTopicSearchMode);

  if (sourcesEl && !showPast) {
    const srcs = (autoTopics && autoTopics.sources) || [];
    sourcesEl.innerHTML = srcs.length
      ? srcs.map((s) => `<span class="auto-topics-source-chip">${escapeHtml(s.label || s.id || s)}</span>`).join("")
      : `<span class="auto-topics-source-chip">Hacker News</span>` +
        `<span class="auto-topics-source-chip">AIM</span>` +
        `<span class="auto-topics-source-chip">The Batch</span>` +
        `<span class="auto-topics-source-chip">TLDR AI</span>` +
        `<span class="auto-topics-source-chip">Ben's Bites</span>`;
    sourcesEl.classList.remove("hidden");
  } else if (sourcesEl) {
    sourcesEl.classList.add("hidden");
  }
  if (modeEl) {
    if (autoTopicSearchMode) {
      modeEl.textContent = `Search results for “${autoTopicSearchQuery}” (up to 4)`;
    } else if (showPast) {
      modeEl.textContent = archive.length
        ? `${archive.length} past topic${archive.length === 1 ? "" : "s"} — prepared, queued, or previous trending`
        : "No past topics yet";
    } else {
      const fetched = autoTopics && autoTopics.fetched_at
        ? new Date(Number(autoTopics.fetched_at) * 1000).toLocaleString()
        : "";
      const staleNote = autoTopicsStale(autoTopics) ? " · refresh pending" : "";
      modeEl.textContent = `Top ${(autoTopics && autoTopics.limit) || 4} trending now${fetched ? ` · updated ${fetched}` : ""}${staleNote}`;
    }
  }

  if (!topics.length) {
    list.innerHTML = "";
    list.dataset.stableHtml = "";
    if (extrasEl) { extrasEl.classList.add("hidden"); extrasEl.innerHTML = ""; }
    if (detail) { detail.classList.add("hidden"); detail.innerHTML = ""; }
    if (empty && !autoTopicsLoading) {
      empty.classList.remove("hidden");
      empty.textContent = showPast
        ? "Past topics appear here after you refresh trending or prepare a topic."
        : "No trending topics yet — click Refresh.";
    }
    return;
  }

  if (!autoTopicSelection) {
    const dbSel = trending.find((t) => t.selected) || archive.find((t) => t.selected);
    if (dbSel) autoTopicSelection = dbSel.id;
  }

  const listHtml = topics.map(topicCardHtml).join("");
  const listChanged = setStableHtml(list, listHtml);
  if (extrasEl) {
    extrasEl.classList.add("hidden");
    extrasEl.innerHTML = "";
  }

  const all = trending.concat(archive);
  const selected = all.find((t) => t.id === autoTopicSelection && t.prepared);
  if (detail) {
    if (selected) {
      detail.classList.remove("hidden");
      const claims = (selected.claims || []).slice(0, 6).map((c) =>
        `<li><strong>[${escapeHtml((c.confidence || "medium").toUpperCase())}]</strong> ${escapeHtml(c.text || "")}</li>`
      ).join("");
      const cites = (selected.citations || []).slice(0, 6).map((c) =>
        `<li><a href="${escapeHtml(c.url || "#")}" target="_blank" rel="noopener">${escapeHtml(c.title || c.url || "source")}</a></li>`
      ).join("");
      detail.innerHTML = `
        <h4>Prepared brief · ${truthPill(selected.truthfulness)}</h4>
        <p class="auto-topic-blurb">${escapeHtml(selected.truthfulness_notes || "Review claims before publishing.")}</p>
        ${claims ? `<div class="auto-paper-label">Claims</div><ul class="claims-list">${claims}</ul>` : ""}
        ${cites ? `<div class="auto-paper-label" style="margin-top:10px">Citations</div><ul class="cites-list">${cites}</ul>` : ""}`;
    } else {
      detail.classList.add("hidden");
      detail.innerHTML = "";
    }
  }

  if (listChanged) {
    bindTopicCardHandlers(list);
    bindTopicCardHandlers(extrasEl);
    icons();
  } else {
    bindTopicCardHandlers(list);
  }
}

async function selectAutomationTopic(topicId) {
  if (!topicId) return;
  const all = [
    ...((autoTopics && autoTopics.topics) || []),
    ...((autoTopics && autoTopics.extras) || []),
  ];
  const topic = all.find((t) => t.id === topicId);
  try {
    await fetch("/api/admin/automation/topics/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic_id: topicId,
        selected: true,
        title: (topic && topic.title) || "",
        blurb: (topic && topic.blurb) || "",
      }),
    });
    if (topic) topic.selected = true;
  } catch (e) { /* best-effort */ }
}

async function prepareAutomationTopic(topicId, btn) {
  if (!topicId) return;
  const endBusy = beginBusy(
    btn,
    `<span class="spinner"></span> Preparing…`,
    { find: () => findTopicButton("data-topic-prep", topicId) },
  );
  try {
    const all = [
      ...((autoTopics && autoTopics.topics) || []),
      ...((autoTopics && autoTopics.extras) || []),
      ...((autoTopics && autoTopics.archive) || []),
    ];
    const topic = all.find((t) => t.id === topicId);
    const res = await fetch("/api/admin/automation/topics/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic_id: topicId, topic: (topic && topic.title) || "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Prepare failed"));
    autoTopicSelection = topicId;
    autoTopicSearchMode = false;
    patchAutomationTopic(topicId, {
      prepared: true,
      selected: true,
      prep_title: data.title || data.topic || (topic && topic.title) || "",
      blurb: String(data.summary || (topic && topic.blurb) || "").slice(0, 240),
      truthfulness: data.truthfulness || (topic && topic.truthfulness) || "medium",
      truthfulness_notes: data.truthfulness_notes || "",
      claims: data.claims || (topic && topic.claims) || [],
      citations: data.citations || (topic && topic.citations) || [],
      folder: data.folder || (topic && topic.folder) || "",
    });
    invalidateStable($("auto-topics-list"));
    renderAutomationTopics();
    // Fresh cards already replaced the busy button — do not restore the old label.
  } catch (e) {
    endBusy();
    alert(e.message || "Prepare failed");
  }
}

async function queueAutomationTopic(topicId, btn) {
  if (!topicId) return;
  const endBusy = beginBusy(
    btn,
    `<span class="spinner"></span> Queuing…`,
    { find: () => findTopicButton("data-topic-queue", topicId) },
  );
  try {
    const style = (selectedStyle && selectedStyle !== "auto") ? selectedStyle : "whiteboard";
    const theme = (selectedTheme && selectedTheme !== "auto") ? selectedTheme : "snow";
    const res = await fetch("/api/admin/automation/topics/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic_id: topicId,
        video_format: selectedFormat || "youtube_video",
        target_duration: Number.isFinite(selectedDuration) ? selectedDuration : DEFAULT_STUDIO_DURATION,
        video_theme: theme,
        video_style: style,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Queue failed"));
    patchAutomationTopic(topicId, {
      prepared: true,
      selected: true,
      job_id: data.job_id || "",
    });
    invalidateStable($("auto-topics-list"));
    renderAutomationTopics();
    // Topic videos are Studio jobs — cron Queue/Ready tabs only list paper runs.
    if (data.job_id) {
      switchView("studio");
      await openSession(data.job_id);
      try { await loadSessions(); } catch (e) { /* ignore */ }
    } else {
      alert(data.reused
        ? `Already queued (${data.status || "saved"}).`
        : "Queued — open Studio sessions to watch progress.");
    }
  } catch (e) {
    endBusy();
    alert(e.message || "Queue failed");
  }
}

async function paperJobAction(act, paperId, folder, btn) {
  if (!act) return;
  const endBusy = beginBusy(btn, '<span class="spinner"></span>');
  try {
    if (act === "delete") {
      const msg = folder
        ? "Delete this paper folder and remove it from future queues?"
        : "Delete / remove this paper from the queue?";
      if (!confirm(msg)) {
        endBusy();
        return;
      }
      const res = await fetch("/api/admin/automation/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: folder || "", paper_id: paperId || "", mark_seen: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiDetail(data, "Delete failed"));
      if (paperId) autoPaperSelection.delete(paperId);
      if (folder) autoPaperSelection.delete(`folder:${folder}`);
    } else if (act === "skip") {
      if (!confirm("Skip this paper? It won't appear in the queue.")) {
        endBusy();
        return;
      }
      const res = await fetch("/api/admin/automation/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_id: paperId || "", folder: folder || "", delete_folder: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiDetail(data, "Skip failed"));
      if (paperId) autoPaperSelection.delete(paperId);
      if (folder) autoPaperSelection.delete(`folder:${folder}`);
    } else if (act === "complete") {
      const res = await fetch("/api/admin/automation/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_id: paperId || "", folder: folder || "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiDetail(data, "Complete failed"));
    }
    invalidateStable($("auto-paper-preview"));
    const grid = $("cron-grid");
    if (grid) delete grid.dataset.cronSnap;
    await loadAutomationPreview();
    await loadAutomation();
    await loadCron();
    // Preview/cron re-render replaces action buttons; skip restoring a detached node.
  } catch (e) {
    endBusy();
    alert(e.message || "Action failed");
  }
}

function selectedAutomationPaperIds() {
  // Prefer live checkbox state; fall back to remembered set.
  const live = [...document.querySelectorAll("#auto-paper-preview .auto-paper-check:checked")]
    .map((el) => el.value || el.dataset.paperId)
    .filter(Boolean);
  if (live.length) return live.slice(0, 3);
  return [...autoPaperSelection].slice(0, 3);
}

function renderAutoSchedule(st) {
  const el = $("auto-schedule");
  if (!el || !st) return false;
  el.classList.remove("hidden");
  const last = st.last_run || {};
  const triggerLabel = last.trigger === "schedule" ? "Scheduled" : (last.trigger === "manual" ? "Manual" : "");
  const blocked = st.blocked_run_hours && st.blocked_run_hours.length
    ? `<span class="auto-schedule-note">Blocked during working hours: ${fmtHourList(st.blocked_run_hours)}</span>`
    : "";
  const html = `
    <div class="auto-schedule-grid">
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Configured hours</span>
        <span class="auto-schedule-val">${fmtHourList(st.run_hours)}</span>
      </div>
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Working hours (no auto-run)</span>
        <span class="auto-schedule-val">${fmtHour(st.work_hours && st.work_hours.start)} – ${fmtHour(st.work_hours && st.work_hours.end)}</span>
      </div>
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Active schedule</span>
        <span class="auto-schedule-val">${fmtHourList(st.effective_run_hours)} ${st.enabled ? "" : "(disabled)"}</span>
      </div>
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Next scheduled run</span>
        <span class="auto-schedule-val">${st.next_run ? new Date(st.next_run).toLocaleString() : "—"}</span>
      </div>
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Last run</span>
        <span class="auto-schedule-val">${last.started_at ? `${fmtTs(last.started_at)}${triggerLabel ? ` (${triggerLabel})` : ""}` : "—"}</span>
      </div>
      <div class="auto-schedule-item">
        <span class="auto-schedule-key">Source / max papers</span>
        <span class="auto-schedule-val">${escapeHtml(st.source || "—")} · ${st.max_papers || 1} paper(s)${st.require_code ? " · code required" : ""}</span>
      </div>
    </div>
    ${blocked}`;
  return setStableHtml(el, html);
}

function cronStatus(run) {
  if (run.status && ["published", "ready", "incomplete", "processing"].includes(run.status)) {
    return run.status;
  }
  if (run.published) return "published";
  const video = (run.artifacts && run.artifacts.videos && run.artifacts.videos[0]) || null;
  if (video) return "ready";
  if (run.incomplete) return "incomplete";
  return "processing";
}

function cronMatchesFilter(run, filter) {
  const status = cronStatus(run);
  const archived = !!run.archived;
  if (filter === "queue") {
    // Active work only — Ready/Published/Archived live elsewhere.
    return !archived && (status === "processing" || status === "incomplete");
  }
  if (filter === "ready") {
    return !archived && status === "ready";
  }
  if (filter === "incomplete") {
    return !archived && status === "incomplete";
  }
  if (filter === "history") {
    // Published + manually archived. Ready stays under Ready until Archive.
    return archived || status === "published";
  }
  return true;
}

function cronDisplayTitle(run) {
  const paper = run.paper || {};
  const raw = String(paper.title || "").trim();
  const id = String(run.id || "").trim();
  const weak = new Set(["", "topics", "paper", "untitled", "overview", id.toLowerCase()]);
  if (raw && !weak.has(raw.toLowerCase())) return raw;
  if (paper.arxiv_id) return `arXiv:${paper.arxiv_id}`;
  if (id && !weak.has(id.toLowerCase())) return id.replace(/[-_]+/g, " ");
  return "Untitled run";
}

function cronEmptyMessage(filter, total) {
  if (total === 0) {
    return "No automation runs yet. Trigger a run above, or wait for the scheduled off-hours run.";
  }
  const hints = {
    queue: "Queue is clear — nothing processing or incomplete. Topic videos open in Studio. Ready paper videos are under Ready.",
    ready: "No ready videos waiting. Finish a run, then Review & publish — or Archive when done reviewing.",
    incomplete: "No incomplete runs. Stopped mid-PDF or mid-render jobs appear here.",
    history: "History is empty. Publish a video or click Archive on a Ready item to move it here.",
  };
  return hints[filter] || hints.queue;
}

function fmtCronDate(id) {
  const m = String(id).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}`).toLocaleDateString();
  return id;
}

async function loadCron() {
  if (!currentUser || currentUser.role !== "admin") return;
  const grid = $("cron-grid");
  const empty = $("cron-empty");
  const countEl = $("cron-count");
  if (!grid) return;
  // Keep filter pills in sync with persisted selection.
  document.querySelectorAll(".cron-filter").forEach((b) => {
    b.classList.toggle("active", (b.dataset.filter || "queue") === cronFilter);
  });
  try {
    const data = await (await fetch("/api/admin/cron")).json();
    cronRuns = data.runs || [];
  } catch (e) { cronRuns = []; }
  const filtered = cronRuns.filter((run) => cronMatchesFilter(run, cronFilter));
  // Avoid full rebuild flicker when the filtered set is unchanged.
  const snap = JSON.stringify(filtered.map((r) => [
    r.id, cronStatus(r), r.published, r.incomplete, r.deleted, r.archived,
    (r.artifacts && r.artifacts.videos && r.artifacts.videos[0]) || "",
    (r.artifacts && r.artifacts.thumbnail) || "",
  ]));
  if (grid.dataset.cronSnap === snap && empty && empty.dataset.filter === cronFilter) {
    if (countEl) {
      const activeN = cronRuns.filter((r) => cronMatchesFilter(r, "queue")).length;
      countEl.textContent = cronFilter === "queue"
        ? `${filtered.length} in queue`
        : `${filtered.length} · ${activeN} active`;
    }
    return;
  }
  grid.dataset.cronSnap = snap;
  grid.innerHTML = "";
  if (empty) {
  empty.classList.toggle("hidden", filtered.length > 0);
    empty.textContent = cronEmptyMessage(cronFilter, cronRuns.length);
    empty.dataset.filter = cronFilter;
  }
  if (countEl) {
    const activeN = cronRuns.filter((r) => cronMatchesFilter(r, "queue")).length;
    countEl.textContent = cronFilter === "queue"
      ? `${filtered.length} in queue`
      : `${filtered.length} · ${activeN} active`;
  }
  filtered.forEach((run) => {
    const paper = run.paper || {};
    const title = cronDisplayTitle(run);
    const arts = run.artifacts || {};
    const video = (arts.videos && arts.videos[0]) || null;
    const thumb = arts.thumbnail || null;
    const pdf = arts.pdf || null;
    const slides = (arts.slides && arts.slides[0]) || null;
    const post = (arts.posts && arts.posts[0]) || null;
    const status = cronStatus(run);
    const archived = !!run.archived;
    const historyOnly = !!run.history_only || !!run.deleted;
    const inHistoryView = cronFilter === "history" || archived || status === "published";
    const fileUrl = (p) =>
      bust(
      `/api/admin/cron/${encodeURIComponent(run.id)}/file/` +
        p.split("/").map(encodeURIComponent).join("/")
      );
    const leftAt = (run.checkpoint && run.checkpoint.phase) || (run.incomplete ? "pdf_ready" : "");
    const ytUrl = (run.youtube && run.youtube.url) || "";
    let media;
    if (video && !historyOnly) {
      media = `<video controls preload="metadata" src="${fileUrl(video)}"></video>`;
    } else if (thumb && !historyOnly) {
      media = `<img src="${fileUrl(thumb)}" alt="thumbnail"/>`;
    } else if ((historyOnly || archived) && status === "published") {
      media = `<div class="cron-no-media"><i data-lucide="check-circle"></i><span>Published${ytUrl ? " (files removed)" : ""}</span></div>`;
    } else if (archived) {
      media = `<div class="cron-no-media"><i data-lucide="archive"></i><span>Archived</span></div>`;
    } else {
      media = `<div class="cron-no-media"><i data-lucide="${run.incomplete ? "pause-circle" : "clock"}"></i><span>${run.incomplete ? "Stopped — resume" : "Processing…"}</span></div>`;
    }
    const statusPill = archived
      ? `<span class="pill pending">Archived</span>`
      : (status === "published"
      ? `<span class="pill published">Published</span>`
        : (status === "ready" ? `<span class="pill approved">Ready</span>`
          : (status === "incomplete" ? `<span class="pill pending">Incomplete</span>`
            : `<span class="pill pending">Processing</span>`)));
    const pubBtn = run.published || historyOnly
      ? `<button class="btn-sm ghost" disabled><i data-lucide="check-circle"></i> Published</button>`
      : `<button class="btn-sm accent" data-publish="${escapeHtml(run.id)}" ${video ? "" : "disabled"}><i data-lucide="upload"></i> Review &amp; publish</button>`;
    const resumeBtn = run.incomplete && !historyOnly && !archived
      ? `<button class="btn-sm accent" data-resume-one="${escapeHtml(run.id)}" data-paper-id="${escapeHtml(paper.id || "")}"><i data-lucide="rotate-cw"></i> Complete</button>`
      : "";
    const delBtn = historyOnly
      ? ""
      : `<button class="btn-sm ghost" data-delete-cron="${escapeHtml(run.id)}" title="Delete this job folder"><i data-lucide="trash-2"></i> Delete</button>`;
    const archiveBtn = historyOnly && !archived
      ? ""
      : (archived
        ? `<button class="btn-sm" data-unarchive-cron="${escapeHtml(run.id)}" title="Restore to Ready / Queue"><i data-lucide="undo-2"></i> Restore</button>`
        : (status === "ready" || status === "published"
          ? `<button class="btn-sm" data-archive-cron="${escapeHtml(run.id)}" title="Move to History"><i data-lucide="archive"></i> Archive</button>`
          : ""));
    const skipBtn = run.incomplete && !historyOnly && !archived
      ? `<button class="btn-sm" data-skip-cron="${escapeHtml(run.id)}" data-paper-id="${escapeHtml(paper.id || "")}" title="Skip — already generated / don't re-queue"><i data-lucide="ban"></i> Skip</button>`
      : "";
    const authors = (paper.authors || []).slice(0, 3).join(", ");
    const abs = (paper.abstract || "").replace(/\s+/g, " ").trim();
    const metaParts = [];
    if (paper.arxiv_id || (paper.id && String(paper.id).startsWith("arxiv:"))) {
      const ax = paper.arxiv_id || String(paper.id).replace(/^arxiv:/, "");
      metaParts.push(`<span><i data-lucide="file-text"></i> arXiv:${escapeHtml(ax)}</span>`);
    }
    if (paper.source) metaParts.push(`<span><i data-lucide="rss"></i> ${escapeHtml(paper.source)}</span>`);
    // Don't clutter with folder id when it equals a weak title like "topics".
    if (run.id && String(run.id).toLowerCase() !== "topics") {
      metaParts.push(`<span><i data-lucide="folder"></i> ${escapeHtml(run.id)}</span>`);
    }
    if (leftAt) metaParts.push(`<span><i data-lucide="map-pin"></i> left at ${escapeHtml(leftAt)}</span>`);
    if (authors) metaParts.push(`<span><i data-lucide="users"></i> ${escapeHtml(authors)}</span>`);
    if (paper.code_url) metaParts.push(`<span><a href="${escapeHtml(paper.code_url)}" target="_blank" rel="noopener"><i data-lucide="github"></i> Code</a></span>`);
    if (ytUrl) metaParts.push(`<span><a href="${escapeHtml(ytUrl)}" target="_blank" rel="noopener"><i data-lucide="youtube"></i> YouTube</a></span>`);
    const item = document.createElement("div");
    item.className = "cron-item"
      + (run.incomplete ? " cron-incomplete" : "")
      + (inHistoryView || historyOnly || archived ? " cron-history" : "");
    item.innerHTML = `
      <div class="cron-item-media">${media}</div>
      <div class="cron-item-body">
        <div class="cron-item-head">
          <h3 class="cron-item-title">${escapeHtml(title)}</h3>
          ${statusPill}
        </div>
        <div class="cron-item-meta">${metaParts.join("")}</div>
        ${abs && !archived ? `<p class="cron-item-abs">${escapeHtml(abs.slice(0, 220))}${abs.length > 220 ? "…" : ""}</p>` : ""}
      </div>
      <div class="cron-item-actions">
        ${pdf && !historyOnly ? `<a class="btn-sm" href="${fileUrl(pdf)}" target="_blank" rel="noopener"><i data-lucide="file-text"></i> PDF</a>` : ""}
        ${slides && !historyOnly ? `<a class="btn-sm" href="${fileUrl(slides)}" target="_blank" rel="noopener"><i data-lucide="layout"></i> Slides</a>` : ""}
        ${post && !historyOnly ? `<a class="btn-sm" href="${fileUrl(post)}" target="_blank" rel="noopener"><i data-lucide="type"></i> Post</a>` : ""}
        ${thumb && !historyOnly ? `<a class="btn-sm" href="${fileUrl(thumb)}" target="_blank" rel="noopener"><i data-lucide="image"></i> Thumb</a>` : ""}
        ${video && !historyOnly ? `<a class="btn-sm" href="${fileUrl(video)}" target="_blank" rel="noopener"><i data-lucide="download"></i> Video</a>` : ""}
        ${ytUrl ? `<a class="btn-sm accent" href="${escapeHtml(ytUrl)}" target="_blank" rel="noopener"><i data-lucide="external-link"></i> Watch</a>` : ""}
        ${resumeBtn}
        ${skipBtn}
        ${archiveBtn}
        ${delBtn}
        ${!archived ? pubBtn : ""}
      </div>`;
    grid.appendChild(item);
  });
  grid.querySelectorAll("[data-publish]").forEach((b) =>
    b.addEventListener("click", () => publishCron(b.dataset.publish, b))
  );
  grid.querySelectorAll("[data-resume-one]").forEach((b) =>
    b.addEventListener("click", () => paperJobAction("complete", b.dataset.paperId, b.dataset.resumeOne, b))
  );
  grid.querySelectorAll("[data-skip-cron]").forEach((b) =>
    b.addEventListener("click", () => paperJobAction("skip", b.dataset.paperId, b.dataset.skipCron, b))
  );
  grid.querySelectorAll("[data-delete-cron]").forEach((b) =>
    b.addEventListener("click", () => paperJobAction("delete", "", b.dataset.deleteCron, b))
  );
  grid.querySelectorAll("[data-archive-cron]").forEach((b) =>
    b.addEventListener("click", () => archiveCron(b.dataset.archiveCron, true, b))
  );
  grid.querySelectorAll("[data-unarchive-cron]").forEach((b) =>
    b.addEventListener("click", () => archiveCron(b.dataset.unarchiveCron, false, b))
  );
  icons();
}

async function archiveCron(id, archived, btn) {
  const endBusy = beginBusy(btn, `<span class="spinner"></span>`);
  try {
    const res = await fetch(
      `/api/admin/cron/${encodeURIComponent(id)}/archive?archived=${archived ? "true" : "false"}`,
      { method: "POST" }
    );
    if (!res.ok) throw new Error("failed");
    if (archived) cronFilter = "history";
    else cronFilter = "ready";
    try { localStorage.setItem("cronFilter", cronFilter); } catch (e) {}
    const grid = $("cron-grid");
    if (grid) delete grid.dataset.cronSnap;
    await loadCron();
    endBusy();
  } catch (e) {
    endBusy();
  }
}

async function publishCron(id, btn) {
  const endBusy = beginBusy(btn, `<span class="spinner"></span> Publishing…`);
  try {
    const res = await fetch(`/api/admin/cron/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error("failed");
    cronFilter = "history";
    try { localStorage.setItem("cronFilter", cronFilter); } catch (e) {}
    const grid = $("cron-grid");
    if (grid) delete grid.dataset.cronSnap;
    await loadCron();
    endBusy();
  } catch (e) {
    endBusy();
  }
}

// -------------------------------------------------- admin: automation ctrl --

let autoPoll = null;

async function loadAutomationPreview() {
  if (!currentUser || currentUser.role !== "admin") return;
  try {
    autoPreview = await (await fetch("/api/admin/automation/preview")).json();
  } catch (e) {
    autoPreview = null;
  }
}

async function loadAutomation() {
  if (!currentUser || currentUser.role !== "admin") return;
  const paperEl = $("auto-paper-preview");
  const cronBtn = $("cron-refresh");
  if (paperEl) paperEl.classList.add("is-refreshing");
  if (cronBtn) cronBtn.classList.add("is-spinning");
  let st = null;
  try {
    st = await (await fetch("/api/admin/automation")).json();
  if (!st.running) await loadAutomationPreview();
    let dirty = false;
    dirty = renderAutomation(st) || dirty;
    dirty = renderAutoSchedule(st) || dirty;
    dirty = renderPaperPreview(st, autoPreview) || dirty;
    if (dirty) icons();
    // Poll while a run is active so the admin sees live progress + filtered list.
  if (st.running && !autoPoll) {
    autoPoll = setInterval(async () => {
      try {
        const s = await (await fetch("/api/admin/automation")).json();
          let d = false;
          d = renderAutomation(s) || d;
          d = renderAutoSchedule(s) || d;
          d = renderPaperPreview(s, autoPreview) || d;
          if (d) icons();
          // Keep the run list live for the active filter (Ready / Incomplete / …).
          if (adminPanel === "cron") loadCron();
          if (!s.running) {
            clearInterval(autoPoll);
            autoPoll = null;
            loadAutomationPreview().then(() => { loadAutomation(); loadCron(); });
          }
      } catch (e) { clearInterval(autoPoll); autoPoll = null; }
    }, 4000);
    }
  } catch (e) {
    /* soft-fail — still clear busy chrome below */
  } finally {
    if (paperEl) paperEl.classList.remove("is-refreshing");
    if (cronBtn) cronBtn.classList.remove("is-spinning");
  }
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderAutomation(st) {
  const dot = $("auto-dot");
  const phase = $("auto-phase");
  const meta = $("auto-meta");
  const toggle = $("auto-enabled");
  const trigger = $("auto-trigger");
  const resumeBtn = $("auto-resume");
  const pauseBtn = $("auto-pause");
  const banner = $("auto-resume-banner");
  if (!phase) return false;
  if (dot) dot.className = "auto-dot" + (st.running ? " run" : (st.enabled ? " ok" : " off"));
  const triggerTag = st.trigger === "manual" ? "Manual run"
    : (st.trigger === "schedule" ? "Scheduled run"
      : (st.trigger === "resume" ? "Resume run" : ""));
  phase.textContent = st.running
    ? `${triggerTag ? triggerTag + " · " : ""}${st.phase || "working"}`
    : (st.phase && st.phase !== "idle" ? st.phase : "Idle");
  const parts = [];
  if (st.total) parts.push(`${st.processed}/${st.total} paper(s)`);
  if (st.source) parts.push(st.source);
  if (st.incomplete_count) parts.push(`${st.incomplete_count} incomplete`);
  if (st.last_error) parts.push(`error: ${st.last_error}`);
  if (meta) meta.textContent = parts.join(" · ");
  if (toggle) toggle.checked = !!st.enabled;
  let iconsDirty = false;
  if (trigger) {
    trigger.disabled = !!st.running;
    iconsDirty = setIconHtml(
      trigger,
      st.running
      ? `<span class="spinner"></span> Running…`
        : `<i data-lucide="play"></i> Run now`
    ) || iconsDirty;
  }
  if (pauseBtn) {
    pauseBtn.hidden = !st.running;
    pauseBtn.disabled = !st.running || /paus/i.test(st.phase || "");
    iconsDirty = setIconHtml(
      pauseBtn,
      /paus/i.test(st.phase || "")
        ? `<span class="spinner"></span> Pausing…`
        : `<i data-lucide="pause"></i> Pause`
    ) || iconsDirty;
  }
  const canResume = !!st.can_resume && !st.running;
  if (resumeBtn) {
    resumeBtn.hidden = !canResume && !(st.incomplete_count > 0 && st.running);
    resumeBtn.disabled = !!st.running || !st.can_resume;
    iconsDirty = setIconHtml(
      resumeBtn,
      st.running && st.trigger === "resume"
        ? `<span class="spinner"></span> Resuming…`
        : `<i data-lucide="rotate-cw"></i> Resume${st.incomplete_count ? ` (${st.incomplete_count})` : ""}`
    ) || iconsDirty;
  }
  if (banner) {
    const items = st.incomplete || [];
    if (items.length && !st.running) {
      const first = items[0];
      const html =
        `<i data-lucide="pause-circle"></i> ` +
        `<span><strong>${items.length} pending incomplete:</strong> ${escapeHtml(first.title || first.folder)}` +
        ` — left at <code>${escapeHtml(first.left_at || "pdf_ready")}</code>.` +
        ` Shown for admin only — click <strong>Resume</strong> or per-item <strong>Complete</strong> (never auto-starts on login).</span>`;
      if (banner.dataset.bannerHtml !== html) {
        banner.dataset.bannerHtml = html;
        banner.classList.remove("hidden");
        banner.innerHTML = html;
        iconsDirty = true;
      }
    } else if (!banner.classList.contains("hidden") || banner.innerHTML) {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      banner.dataset.bannerHtml = "";
    }
  }
  const logWrap = $("auto-log-wrap");
  const logEl = $("auto-log");
  if (logWrap && logEl) {
    const lines = st.log || [];
    const text = lines.join("\n");
    logWrap.classList.toggle("hidden", lines.length === 0);
    if (lines.length && st.running) logWrap.open = true;
    if (logEl.textContent !== text) {
      logEl.textContent = text;
      // Keep the live tail visible.
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
  return iconsDirty;
}

function syncRuntimeProviderFields() {
  const p = ($("rt-llm-provider") && $("rt-llm-provider").value) || "auto";
  const showO = p === "ollama" || p === "auto";
  const showG = p === "gemini" || p === "auto";
  const showA = p === "openai" || p === "auto";
  const ow = $("rt-ollama-wrap");
  const gw = $("rt-gemini-wrap");
  const aw = $("rt-openai-wrap");
  if (ow) ow.hidden = !showO;
  if (gw) gw.hidden = !showG;
  if (aw) aw.hidden = !showA;
}

function fillDatalist(id, values) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = (values || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
}

async function loadRuntimeSettings() {
  try {
    const data = await (await fetch("/api/admin/runtime-settings")).json();
    const set = (id, v) => { const el = $(id); if (el && v != null) el.value = v; };
    set("rt-llm-provider", data.llm_provider || "auto");
    set("rt-ollama-model", data.ollama_model || "");
    set("rt-gemini-model", data.gemini_model || "");
    set("rt-openai-model", data.openai_model || "");
    set("rt-thumb-backend", data.thumbnail_backend || "auto");
    const ch = data.choices || {};
    fillDatalist("rt-ollama-models", ch.ollama_models);
    fillDatalist("rt-gemini-models", ch.gemini_models);
    fillDatalist("rt-openai-models", ch.openai_models);
    const eff = $("rt-effective");
    if (eff) {
      eff.textContent = `Active: ${data.active_provider || "?"} / ${data.text_model || "?"} · thumbs ${data.thumbnail_backend || "auto"}`;
    }
    syncRuntimeProviderFields();
  } catch (e) { /* ignore */ }
}

async function saveRuntimeSettings() {
  const msg = $("rt-msg");
  const btn = $("rt-save");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Saving…`; }
  if (msg) { msg.classList.add("hidden"); msg.classList.remove("ok", "err"); }
  const body = {
    llm_provider: ($("rt-llm-provider") && $("rt-llm-provider").value) || "auto",
    ollama_model: ($("rt-ollama-model") && $("rt-ollama-model").value) || "",
    ollama_vision_model: ($("rt-ollama-model") && $("rt-ollama-model").value) || "",
    gemini_model: ($("rt-gemini-model") && $("rt-gemini-model").value) || "",
    gemini_vision_model: ($("rt-gemini-model") && $("rt-gemini-model").value) || "",
    openai_model: ($("rt-openai-model") && $("rt-openai-model").value) || "",
    openai_vision_model: ($("rt-openai-model") && $("rt-openai-model").value) || "",
    thumbnail_backend: ($("rt-thumb-backend") && $("rt-thumb-backend").value) || "auto",
    auto_video_style: ($("rt-video-style") && $("rt-video-style").value) || "",
    auto_video_theme: ($("rt-video-theme") && $("rt-video-theme").value) || "",
  };
  try {
    const res = await fetch("/api/admin/runtime-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "save failed");
    if (msg) {
      msg.textContent = `Saved — using ${data.settings?.active_provider || body.llm_provider} / ${data.settings?.text_model || ""}`;
      msg.classList.remove("hidden", "err");
      msg.classList.add("ok");
    }
    await loadRuntimeSettings();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || "Save failed";
      msg.classList.remove("hidden", "ok");
      msg.classList.add("err");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="save"></i> Save settings`;
  icons();
    }
  }
}

async function pauseAutomation() {
  const btn = $("auto-pause");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/admin/automation/pause", { method: "POST" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.detail || d.message || "pause failed");
  } catch (e) {
    alert(e.message || "Pause failed");
  }
  loadAutomation();
}

async function resumeAutomation() {
  const btn = $("auto-resume");
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Resuming…`; }
  try {
    const res = await fetch("/api/admin/automation/resume", { method: "POST" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.detail || "resume failed");
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="rotate-cw"></i> Resume`;
      icons();
    }
    return;
  }
  loadAutomation();
}

async function triggerAutomation() {
  const btn = $("auto-trigger");
  const paperIds = selectedAutomationPaperIds();
  if (!paperIds.length) {
    alert("Select one or more pending papers first. Old incomplete folders use Resume / Complete — they do not auto-run.");
    return;
  }
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Starting…`; }
  try {
    const res = await fetch("/api/admin/automation/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_ids: paperIds }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.detail || "failed");
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i data-lucide="play"></i> Run now`; icons(); }
    return;
  }
  loadAutomation();
}

async function toggleAutomation(enabled) {
  try {
    await fetch("/api/admin/automation/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (e) { /* ignore */ }
  loadAutomation();
}

// ------------------------------------------------------------ admin: costs ----

let costActiveTab = "model";
let costJobSort = "recent";
let costDebug = false;
let lastCostReport = null;

function fmtModelName(model) {
  const s = String(model || "—");
  // Main Flash workhorse is 3.7; Flash-Lite stays gemini-3.5-flash-lite.
  if (s === "gemini-3.5-flash" || s === "gemini-3.6-flash") return "gemini-3.7-flash";
  return s;
}
function fmtTs(ts) {
  const n = Number(ts) || 0;
  if (!n) return "—";
  return new Date(n * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtUsd(n) {
  const v = Number(n || 0);
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  if (v < 1) return "$" + v.toFixed(3);
  return "$" + v.toFixed(2);
}
function fmtNum(n) { return Number(n || 0).toLocaleString(); }

function setCostTab(tab) {
  costActiveTab = tab === "job" ? "job" : "model";
  document.querySelectorAll(".cost-subtab").forEach((btn) => {
    const on = btn.dataset.costTab === costActiveTab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-cost-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.costPanel !== costActiveTab);
  });
}

async function loadCosts() {
  const days = ($("cost-range") && $("cost-range").value) || "30";
  costJobSort = ($("cost-job-sort") && $("cost-job-sort").value) || "recent";
  costDebug = Boolean($("cost-debug") && $("cost-debug").checked);
  const empty = $("costs-empty");
  const cards = $("cost-cards");
  try {
    const q = `days=${encodeURIComponent(days)}${costDebug ? "&debug=1" : ""}`;
    const res = await fetch(`/api/admin/costs?${q}`);
    const rep = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(rep, "Failed to load costs"));
    lastCostReport = rep;
  renderCosts(rep);
  } catch (e) {
    if (cards) cards.innerHTML = "";
    ["cost-breakdown", "cost-section-day"].forEach((id) => {
      const s = $(id);
      if (s) s.classList.add("hidden");
    });
    if (empty) {
      empty.textContent = e.message || "Failed to load costs";
      empty.classList.remove("hidden");
    }
  }
}

function renderCosts(rep) {
  const cards = $("cost-cards");
  const empty = $("costs-empty");
  const breakdown = $("cost-breakdown");
  const secDay = $("cost-section-day");
  if (!cards) return;
  if (!rep || typeof rep !== "object") {
    if (empty) {
      empty.textContent = "Failed to load costs";
      empty.classList.remove("hidden");
    }
    return;
  }
  const has = (rep.calls || 0) > 0 || (rep.by_model || []).length > 0 || (rep.by_job || []).length > 0;
  const windowDays = rep.days ?? (($("cost-range") && $("cost-range").value) || "30");
  const snap = JSON.stringify({
    d: windowDays,
    c: rep.cost_usd, n: rep.calls, it: rep.in_tokens, ot: rep.out_tokens,
    m: rep.by_model, j: rep.by_job, day: rep.by_day,
    sort: costJobSort, dbg: costDebug, ev: (rep.debug_events || []).length,
  });
  if (cards.dataset.costSnap === snap) {
    setCostTab(costActiveTab);
    return;
  }
  cards.dataset.costSnap = snap;

  if (empty) {
    empty.textContent = "No usage recorded yet in this window.";
    empty.classList.toggle("hidden", has);
  }
  if (breakdown) breakdown.classList.toggle("hidden", !has);
  if (secDay) secDay.classList.toggle("hidden", !has);
  setCostTab(costActiveTab);

  cards.innerHTML = has ? `
    <div class="cost-card"><div class="cost-k">Est. spend</div><div class="cost-v">${fmtUsd(rep.cost_usd)}</div><div class="cost-sub">last ${escapeHtml(String(windowDays))} days</div></div>
    <div class="cost-card"><div class="cost-k">LLM / VLM calls</div><div class="cost-v">${fmtNum(rep.calls)}</div></div>
    <div class="cost-card"><div class="cost-k">Input tokens</div><div class="cost-v">${fmtNum(rep.in_tokens)}</div></div>
    <div class="cost-card"><div class="cost-k">Output tokens</div><div class="cost-v">${fmtNum(rep.out_tokens)}</div></div>` : "";

  const tbl = $("cost-by-model");
  if (tbl && has) {
    const provCls = (p) => {
      const k = String(p || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      return ["gemini", "openai", "ollama"].includes(k) ? k : "other";
    };
    const rows = (rep.by_model || []).map((m) => `
      <tr>
        <td><span class="cost-prov ${provCls(m.provider)}">${escapeHtml(m.provider || "—")}</span> ${escapeHtml(fmtModelName(m.model))}</td>
        <td class="num">${fmtNum(m.c)}</td>
        <td class="num">${fmtNum(m.it)}</td>
        <td class="num">${fmtNum(m.ot)}</td>
        <td class="num">${fmtUsd(m.cost)}</td>
      </tr>`).join("");
    tbl.innerHTML = `
      <thead><tr><th>Provider / model</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="cost-none">No usage.</td></tr>`}</tbody>`;
  }

  const jobTbl = $("cost-by-job");
  if (jobTbl && has) {
    let jobs = (rep.by_job || []).slice();
    if (costJobSort === "cost") {
      jobs.sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0));
    } else {
      jobs.sort((a, b) => Number(b.last_ts || 0) - Number(a.last_ts || 0));
    }
    const rows = jobs.map((j) => {
      const id = j.job_id ? `<span class="cost-job-id">${escapeHtml(j.job_id)}</span>` : "";
      const status = j.status && j.status !== "—"
        ? `<span class="cost-job-status">${escapeHtml(j.status)}</span>`
        : "";
      const when = j.last_ts
        ? `<span class="cost-job-ts" title="Last call">${escapeHtml(fmtTs(j.last_ts))}</span>`
        : "";
      const models = (j.models || []).map((m) => `
        <div class="cost-job-model-row">
          <strong>${escapeHtml(m.provider || "—")} / ${escapeHtml(fmtModelName(m.model))}</strong>
          <span>${fmtNum(m.c)} calls</span>
          <span>in ${fmtNum(m.it)}</span>
          <span>out ${fmtNum(m.ot)}</span>
          <span>${fmtUsd(m.cost)}</span>
        </div>`).join("");
      return `
      <tr>
        <td>
          <span class="cost-job-title">${escapeHtml(j.title || j.filename || j.job_id || "—")}</span>
          <div class="cost-job-meta">${when}${id}${status}</div>
          ${models ? `<div class="cost-job-models">${models}</div>` : ""}
        </td>
        <td class="num">${fmtNum(j.c)}</td>
        <td class="num">${fmtNum(j.it)}</td>
        <td class="num">${fmtNum(j.ot)}</td>
        <td class="num">${fmtUsd(j.cost)}</td>
      </tr>`;
    }).join("");
    jobTbl.innerHTML = `
      <thead><tr><th>Job / session + call breakdown</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="cost-none">No attributed job usage in this window.</td></tr>`}</tbody>`;
  }

  const dbgWrap = $("cost-debug-wrap");
  const dbgTbl = $("cost-debug-table");
  if (dbgWrap && dbgTbl) {
    const events = rep.debug_events || [];
    dbgWrap.classList.toggle("hidden", !costDebug || !events.length);
    if (costDebug && events.length) {
      dbgTbl.innerHTML = `
        <thead><tr><th>When</th><th>Job</th><th>Provider / model</th><th>Kind</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead>
        <tbody>${events.map((e) => `
          <tr>
            <td>${escapeHtml(fmtTs(e.ts))}</td>
            <td><code>${escapeHtml(e.job_id || "—")}</code></td>
            <td>${escapeHtml(e.provider || "—")} / ${escapeHtml(fmtModelName(e.model))}</td>
            <td>${escapeHtml(e.kind || "text")}</td>
            <td class="num">${fmtNum(e.in_tokens)}</td>
            <td class="num">${fmtNum(e.out_tokens)}</td>
            <td class="num">${fmtUsd(e.cost_usd)}</td>
          </tr>`).join("")}</tbody>`;
    }
  }

  const bars = $("cost-by-day");
  if (bars && has) {
    const dayRows = rep.by_day || [];
    const max = Math.max(0.0001, ...dayRows.map((d) => d.cost_usd || 0));
    bars.innerHTML = dayRows.slice().reverse().map((d) => {
      const h = Math.round(((d.cost_usd || 0) / max) * 100);
      const label = new Date(d.day * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return `<div class="cost-bar" title="${label}: ${fmtUsd(d.cost_usd)} (${d.calls} calls)">
        <span class="cost-bar-fill" style="height:${Math.max(3, h)}%"></span>
        <span class="cost-bar-label">${label}</span></div>`;
    }).join("") || `<div class="cost-none">No usage.</div>`;
  }
  // Cost cards have no Lucide icons — skip createIcons to avoid header flicker.
  // Sub-tabs do; refresh icons when breakdown is shown.
  if (has && typeof icons === "function") icons();
}

// -------------------------------------------------------- publish: social ----
// Platform sub-tabs: YouTube / IG / X / LinkedIn / TikTok / Substack / Medium.
// Each social tab generates ONLY that platform when the user clicks Generate.
// Copy is stored on the job (social_metadata) so any tab can be finished later.

const SOCIAL_META = {
  youtube: { label: "YouTube", icon: "youtube", kind: "video" },
  instagram: { label: "Instagram", icon: "instagram", kind: "social" },
  x: { label: "Twitter", icon: "twitter", kind: "social" },
  linkedin: { label: "LinkedIn", icon: "linkedin", kind: "social" },
  tiktok: { label: "TikTok", icon: "video", kind: "social" },
  substack: { label: "Substack", icon: "mail", kind: "blog" },
  medium: { label: "Medium", icon: "book-open", kind: "blog" },
};
const SOCIAL_PLATFORMS = ["youtube", "instagram", "x", "linkedin", "tiktok", "substack", "medium"];
const SOCIAL_POSTABLE = new Set(["youtube", "instagram", "x", "linkedin"]);
let socialData = {};
let socialActive = "youtube";
let socialWired = false;
let socialReady = {};

function wireSocial() {
  if (socialWired) return;
  socialWired = true;
  document.querySelectorAll("#social-tabs .social-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchSocialTab(tab.dataset.platform));
  });
  document.querySelectorAll(".social-gen-btn").forEach((btn) => {
    btn.addEventListener("click", () => generateSocial(btn.dataset.platform, btn));
  });
  document.querySelectorAll(".social-copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => copySocial(btn.dataset.platform, btn));
  });
  document.querySelectorAll(".social-download-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadSocial(btn.dataset.platform, btn));
  });
  document.querySelectorAll(".social-post-btn").forEach((btn) => {
    btn.addEventListener("click", () => postSocial(btn.dataset.platform, btn));
  });
  $("pub-copy")?.addEventListener("click", () => copyYouTube($("pub-copy")));
  $("pub-download")?.addEventListener("click", () => downloadYouTube($("pub-download")));
  ["pub-title", "pub-desc", "pub-tags"].forEach((id) => {
    $(id)?.addEventListener("input", () => updateYtChecklist());
  });
  const igPrep = $("ig-prep-carousel");
  if (igPrep) igPrep.addEventListener("click", prepareIgCarousel);
  // Persist edits on blur for non-YouTube fields
  document.querySelectorAll(".social-field-title, .social-field-desc").forEach((el) => {
    el.addEventListener("change", () => {
      persistSocialField(el.dataset.platform).catch(() => { /* soft-fail on blur */ });
    });
  });
  switchSocialTab(socialActive || "youtube");
  loadSocialReady();
}

function switchSocialTab(platform) {
  socialActive = SOCIAL_PLATFORMS.includes(platform) ? platform : "youtube";
  document.querySelectorAll("#social-tabs .social-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.platform === socialActive);
  });
  document.querySelectorAll(".social-pane").forEach((pane) => {
    pane.classList.toggle("is-active", pane.dataset.platform === socialActive);
  });
  swapPanelGroup(".social-pane", (pane) => pane.dataset.platform === socialActive);
  fillSocialPane(socialActive);
  icons();
}

async function loadSocialReady() {
  try {
    const data = await (await fetch("/api/social/status")).json();
    socialReady = {};
    (data.platforms || []).forEach((p) => { socialReady[p.id] = p; });
    renderSocialReadyBar();
  } catch (e) { /* ignore */ }
}

function renderSocialReadyBar() {
  const bar = $("social-ready-bar");
  if (!bar) return;
  const bits = SOCIAL_PLATFORMS.map((id) => {
    const meta = SOCIAL_META[id] || { label: id };
    const p = socialReady[id];
    const stored = id === "youtube"
      ? !!(lastJob?.content?.publish_title || ($("pub-title") && $("pub-title").value))
      : !!(socialData[id] && (socialData[id].title || socialData[id].description));
    if (SOCIAL_POSTABLE.has(id) && p) {
      const cls = p.ready ? "ok" : (p.enabled ? "warn" : "off");
      const tip = p.ready ? "ready to post" : (p.enabled ? "credentials incomplete" : "disabled / copy-only");
      return `<span class="social-ready-chip ${cls}" title="${tip}">${escapeHtml(p.label || meta.label)}${stored ? " · ready" : ""}</span>`;
    }
    return `<span class="social-ready-chip ${stored ? "ok" : "off"}" title="${stored ? "copy generated" : "generate when needed"}">${escapeHtml(meta.label)}${stored ? " · ready" : ""}</span>`;
  }).filter(Boolean);
  if (!bits.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span class="social-ready-label">Channels:</span> ${bits.join("")}`;
}

function updateYtChecklist() {
  const map = {
    title: !!(($("pub-title") && $("pub-title").value.trim())),
    desc: !!(($("pub-desc") && $("pub-desc").value.trim())),
    tags: !!(($("pub-tags") && $("pub-tags").value.trim())),
    thumb: !!(lastJob && (lastJob.content?.thumbnail || lastJob.artifacts?.thumbnail)),
    video: !!(lastJob && lastJob.artifacts?.video_final),
  };
  document.querySelectorAll("#yt-checklist [data-yt]").forEach((li) => {
    const ok = !!map[li.dataset.yt];
    li.classList.toggle("ok", ok);
  });
}

async function persistSocialField(platform) {
  if (!jobId || !platform || platform === "youtube") return true;
  const title = document.querySelector(`.social-field-title[data-platform="${platform}"]`);
  const desc = document.querySelector(`.social-field-desc[data-platform="${platform}"]`);
  socialData[platform] = {
    ...(socialData[platform] || {}),
    title: title ? title.value : "",
    description: desc ? desc.value : "",
    hashtags: (socialData[platform] && socialData[platform].hashtags) || [],
  };
  try {
    const res = await fetch(`/api/jobs/${jobId}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ social_metadata: { ...socialData } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(apiDetail(data, "Could not save social copy"));
    }
    if (lastJob && lastJob.content) {
      lastJob.content.social_metadata = { ...socialData };
    }
    renderSocialReadyBar();
    return true;
  } catch (e) {
    renderSocialReadyBar();
    throw e;
  }
}

function socialPackText(platform) {
  if (platform === "youtube") {
    const title = ($("pub-title") && $("pub-title").value) || "";
    const desc = ($("pub-desc") && $("pub-desc").value) || "";
    const tags = (($("pub-tags") && $("pub-tags").value) || "")
      .split(",").map((t) => t.trim()).filter(Boolean)
      .map((t) => (t.startsWith("#") ? t : "#" + t.replace(/^#+/, ""))).join(" ");
    return [title, desc, tags].filter(Boolean).join("\n\n");
  }
  const titleEl = document.querySelector(`.social-field-title[data-platform="${platform}"]`);
  const descEl = document.querySelector(`.social-field-desc[data-platform="${platform}"]`);
  const d = socialData[platform] || {};
  const title = (titleEl && titleEl.value) || d.title || "";
  const desc = (descEl && descEl.value) || d.description || "";
  const tags = (d.hashtags || []).map((h) => "#" + h).join(" ");
  return [title, desc, tags].filter(Boolean).join("\n\n");
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function copyYouTube(btn) {
  const text = socialPackText("youtube");
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const o = btn.innerHTML;
      btn.innerHTML = '<i data-lucide="check"></i> Copied';
      icons();
      setTimeout(() => { btn.innerHTML = o; icons(); }, 1400);
    }
  } catch (e) { /* ignore */ }
}

function downloadYouTube(btn) {
  const text = socialPackText("youtube");
  const slug = (($("pub-title") && $("pub-title").value) || "youtube").slice(0, 40).replace(/\s+/g, "-");
  downloadTextFile(`${slug || "youtube"}-publish.md`, text);
  if (btn) {
    const o = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="check"></i> Saved';
    icons();
    setTimeout(() => { btn.innerHTML = o; icons(); }, 1400);
  }
}

function socialPostMode(platform) {
  const el = document.querySelector(`input[name="mode-${platform}"]:checked`);
  return (el && el.value) || "auto";
}

function setSocialPostStatus(platform, text, kind) {
  const el = document.querySelector(`.social-post-status[data-platform="${platform}"]`);
  if (!el) return;
  el.textContent = text || "";
  el.className = "social-post-status" + (kind ? " " + kind : "");
}

async function postSocial(platform, btn) {
  if (!jobId || !platform) return;
  const el = btn || document.querySelector(`.social-post-btn[data-platform="${platform}"]`);
  const orig = el ? el.innerHTML : "";
  const mode = socialPostMode(platform);
  if (el) { el.disabled = true; el.innerHTML = '<span class="spinner"></span> Posting…'; }
  setSocialPostStatus(platform, "Saving edits…", "info");
  try {
    // Persist edited caption fields before post — abort if save fails.
    if (platform !== "youtube") {
      await persistSocialField(platform);
    } else {
      const res = await fetch(`/api/jobs/${jobId}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publish_title: ($("pub-title") && $("pub-title").value) || "",
          publish_description: ($("pub-desc") && $("pub-desc").value) || "",
          publish_tags: (($("pub-tags") && $("pub-tags").value) || "")
            .split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiDetail(data, "Could not save YouTube details before posting"));
    }
    setSocialPostStatus(platform, "Posting…", "info");
    const res = await fetch(`/api/jobs/${jobId}/social-post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, data.detail || "Post failed"));
    let msg = data.message || "Posted.";
    if (data.result && data.result.url) msg = `Posted: ${data.result.url}`;
    if (data.staged && data.media) {
      msg = data.message || `Prepared ${data.media.length} media file(s).`;
      renderIgCarousel(data.media);
    }
    if (data.images) msg = `Posted carousel (${data.images} images).`;
    setSocialPostStatus(platform, msg, data.ok === false ? "err" : "ok");
  } catch (e) {
    setSocialPostStatus(platform, e.message || "Post failed", "err");
  } finally {
    if (el) { el.disabled = false; el.innerHTML = orig; icons(); }
  }
}

async function prepareIgCarousel() {
  if (!jobId) return;
  const btn = $("ig-prep-carousel");
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Preparing…'; }
  try {
    const res = await fetch(`/api/jobs/${jobId}/social-prepare-carousel`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Prepare failed"));
    renderIgCarousel(data.media || []);
    setSocialPostStatus("instagram", `Prepared ${data.images || 0} square images (1080×1080).`, "ok");
  } catch (e) {
    setSocialPostStatus("instagram", e.message || "Prepare failed", "err");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; icons(); }
  }
}

function renderIgCarousel(media) {
  const el = $("ig-carousel-preview");
  if (!el) return;
  if (!media || !media.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = media.map((src) =>
    `<a href="${bust(src)}" target="_blank" rel="noopener"><img src="${bust(src)}" alt="ig slide" /></a>`
  ).join("");
}

async function generateSocial(platform, btn) {
  if (!jobId || !platform || platform === "youtube") return;
  const el = btn || document.querySelector(`.social-gen-btn[data-platform="${platform}"]`);
  const empty = document.querySelector(`.social-field-empty[data-platform="${platform}"]`);
  const orig = el ? el.innerHTML : "";
  if (el) { el.disabled = true; el.innerHTML = '<span class="spinner"></span> Generating…'; }
  try {
    const res = await fetch(`/api/jobs/${jobId}/social-metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms: [platform] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, data.message || "Generation failed"));
    socialData = { ...socialData, ...(data.social || {}) };
    if (lastJob && lastJob.content) {
      lastJob.content.social_metadata = { ...socialData };
    }
    fillSocialPane(platform);
    renderSocialReadyBar();
  } catch (e) {
    if (empty) {
      empty.classList.remove("hidden");
      empty.textContent = e.message || "Generation failed. Try again.";
    }
  } finally {
    if (el) { el.disabled = false; el.innerHTML = orig; icons(); }
  }
}

/** @returns {boolean} whether Lucide icons need a rebuild */
function renderSocial(job) {
  wireSocial();
  if (job && job.content && job.content.social_metadata) {
    socialData = { ...socialData, ...(job.content.social_metadata || {}) };
  }
  if (job && job.content && job.content.ig_carousel) {
    renderIgCarousel(job.content.ig_carousel);
  }
  SOCIAL_PLATFORMS.filter((p) => p !== "youtube").forEach(fillSocialPane);
  updateYtChecklist();
  renderSocialReadyBar();
  return false;
}

function fillSocialPane(platform) {
  if (!platform || platform === "youtube") return;
  const d = socialData[platform] || {};
  const has = !!(d.title || d.description || (d.hashtags && d.hashtags.length));
  const title = document.querySelector(`.social-field-title[data-platform="${platform}"]`);
  const desc = document.querySelector(`.social-field-desc[data-platform="${platform}"]`);
  const tags = document.querySelector(`.social-field-tags[data-platform="${platform}"]`);
  const hint = document.querySelector(`.social-field-hint[data-platform="${platform}"]`);
  const empty = document.querySelector(`.social-field-empty[data-platform="${platform}"]`);
  const panel = document.querySelector(`.social-panel[data-platform="${platform}"]`);
  if (document.activeElement !== title && title) title.value = d.title || "";
  if (document.activeElement !== desc && desc) desc.value = d.description || "";
  if (hint) hint.textContent = (d.hashtags || []).length ? `(${d.hashtags.length})` : "";
  if (tags) {
    tags.innerHTML = (d.hashtags || [])
      .map((h) => `<span class="social-tag">#${escapeHtml(h)}</span>`).join("") ||
      (has ? `<span class="social-copy-hint">No hashtags.</span>` : "");
  }
  if (empty) empty.classList.toggle("hidden", has);
  if (panel) panel.classList.toggle("is-filled", has);
}

async function copySocial(platform, btn) {
  try {
    await persistSocialField(platform);
  } catch (e) { /* copy still works from local fields */ }
  const text = socialPackText(platform || socialActive);
  try {
    await navigator.clipboard.writeText(text);
    const el = btn || document.querySelector(`.social-copy-btn[data-platform="${platform}"]`);
    if (el) {
      const o = el.innerHTML;
      el.innerHTML = '<i data-lucide="check"></i> Copied';
      icons();
      setTimeout(() => { el.innerHTML = o; icons(); }, 1400);
    }
  } catch (e) { /* clipboard may be blocked */ }
}

async function downloadSocial(platform, btn) {
  try {
    await persistSocialField(platform);
  } catch (e) { /* download still works from local fields */ }
  const text = socialPackText(platform);
  const d = socialData[platform] || {};
  const slug = (d.title || platform || "post").slice(0, 40).replace(/[^\w\-]+/g, "-").replace(/-+/g, "-");
  const ext = (SOCIAL_META[platform]?.kind === "blog") ? "md" : "txt";
  downloadTextFile(`${slug || platform}.${ext}`, text);
  const el = btn || document.querySelector(`.social-download-btn[data-platform="${platform}"]`);
  if (el) {
    const o = el.innerHTML;
    el.innerHTML = '<i data-lucide="check"></i> Saved';
    icons();
    setTimeout(() => { el.innerHTML = o; icons(); }, 1400);
  }
}

// ---------------------------------------------------- admin: social creds ----

async function loadSocialCredentials() {
  const list = $("social-creds-list");
  if (!list) return;
  let data = { platforms: [] };
  try {
    data = await (await fetch("/api/admin/social-credentials")).json();
  } catch (e) {
    list.innerHTML = `<p class="admin-empty">Failed to load credentials.</p>`;
    return;
  }
  list.innerHTML = "";
  (data.platforms || []).forEach((p) => {
    const card = document.createElement("div");
    card.className = "social-cred-card";
    card.dataset.platform = p.id;
    const fieldsHtml = (p.fields || []).map((f) => {
      const inputType = f.secret ? "password" : "text";
      const ph = f.has_value ? (f.masked || "***") : "";
      return `
        <label class="social-cred-field">
          <span class="social-cred-label">${escapeHtml(f.label)}
            ${f.has_value ? '<em class="social-cred-set">set</em>' : ""}
          </span>
          <div class="social-cred-input-row">
            <input class="text-input social-cred-input" type="${inputType}"
              data-platform="${p.id}" data-key="${f.key}" data-secret="${f.secret ? "1" : "0"}"
              placeholder="${escapeHtml(ph || "—")}" autocomplete="off" />
            ${f.secret ? `<button type="button" class="btn-sm ghost social-cred-reveal" data-platform="${p.id}" data-key="${f.key}" title="Show / hide"><i data-lucide="eye"></i></button>` : ""}
            ${f.has_value ? `<button type="button" class="btn-sm ghost social-cred-clear" data-platform="${p.id}" data-key="${f.key}" title="Clear"><i data-lucide="trash-2"></i></button>` : ""}
          </div>
        </label>`;
    }).join("");
    const ready = p.ready ? "ready" : (p.enabled ? "incomplete" : "off");
    card.innerHTML = `
      <div class="social-cred-head">
        <div class="social-cred-title">${escapeHtml(p.label)}
          <span class="social-cred-badge ${ready}">${ready}</span>
        </div>
        <div class="social-cred-toggles">
          <label class="auto-toggle"><input type="checkbox" class="social-cred-enabled" data-platform="${p.id}" ${p.enabled ? "checked" : ""}/> <span>Enabled</span></label>
          <label class="auto-toggle"><input type="checkbox" class="social-cred-auto" data-platform="${p.id}" ${p.auto_post ? "checked" : ""}/> <span>Auto-post</span></label>
        </div>
      </div>
      <div class="social-cred-fields">${fieldsHtml}</div>
      <button type="button" class="btn-sm accent social-cred-save" data-platform="${p.id}"><i data-lucide="save"></i> Save ${escapeHtml(p.label)}</button>`;
    list.appendChild(card);
  });
  list.querySelectorAll(".social-cred-save").forEach((b) =>
    b.addEventListener("click", () => saveSocialCredentials(b.dataset.platform))
  );
  list.querySelectorAll(".social-cred-reveal").forEach((b) =>
    b.addEventListener("click", () => {
      const inp = list.querySelector(`.social-cred-input[data-platform="${b.dataset.platform}"][data-key="${b.dataset.key}"]`);
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.innerHTML = show ? '<i data-lucide="eye-off"></i>' : '<i data-lucide="eye"></i>';
      icons();
    })
  );
  list.querySelectorAll(".social-cred-clear").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await fetch("/api/admin/social-credentials/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: b.dataset.platform, key: b.dataset.key }),
        });
        loadSocialCredentials();
      } catch (e) { /* ignore */ }
    })
  );
  icons();
}

async function saveSocialCredentials(platform) {
  const msg = $("social-creds-msg");
  const card = document.querySelector(`.social-cred-card[data-platform="${platform}"]`);
  if (!card) return;
  const enabled = !!card.querySelector(`.social-cred-enabled[data-platform="${platform}"]`)?.checked;
  const auto_post = !!card.querySelector(`.social-cred-auto[data-platform="${platform}"]`)?.checked;
  const fields = {};
  card.querySelectorAll(`.social-cred-input[data-platform="${platform}"]`).forEach((inp) => {
    const v = (inp.value || "").trim();
    if (v && !v.startsWith("***")) fields[inp.dataset.key] = v;
  });
  try {
    const res = await fetch("/api/admin/social-credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, enabled, auto_post, fields }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiDetail(data, "Save failed"));
    if (msg) {
      msg.textContent = `${platform} credentials saved.`;
      msg.classList.remove("hidden", "err");
      msg.classList.add("ok");
    }
    loadSocialCredentials();
    loadSocialReady();
  } catch (e) {
    if (msg) {
      msg.textContent = e.message || "Save failed";
      msg.classList.remove("hidden", "ok");
      msg.classList.add("err");
    }
  }
}
