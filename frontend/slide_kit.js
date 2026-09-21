/* Overlay loaded AFTER app.js: unique layouts, 108 frames, group fonts, cron sync.
 * Survives app.js reverting to the old 3-slide STYLE_PREVIEW_KITS path.
 */
(function () {
  const MAX_SLIDES = 108;
  const THEME_ALIASES = {
    paper: "snow", ivory: "snow", mint: "snow",
    nebula: "aurora", slate: "midnight", mono: "midnight",
  };
  const catalog = { styles: [], presets: [], themes: [] };
  let overlayIdx = 0;

  function $(id) { return document.getElementById(id); }
  function esc(x) {
    return String(x == null ? "" : x)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function aliasTheme(key) {
    const k = String(key || "").toLowerCase();
    return THEME_ALIASES[k] || k;
  }
  function fnv(s) {
    let h = 2166136261;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function styleKeyFromFrame() {
    const frame = $("admin-slide-frame");
    return (frame && frame.dataset.style) || "whiteboard";
  }

  function visualPreviewInner(compose, styleKey) {
    const c = compose || "stack";
    const n = fnv(String(styleKey || c));
    const mono = `<span class="sp-mono">${esc(String(styleKey || c).replace(/_/g, "").slice(0, 2))}</span>`;
    const thumbs = [
      `<span class="sp-term"><i></i><i></i><i></i></span>`,
      `<span class="sp-split" aria-hidden="true"><i></i><i></i></span>`,
      `<span class="sp-kpi" aria-hidden="true">42</span>`,
      `<span class="sp-bento" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`,
      `<span class="sp-line sp-body"></span><span class="sp-lower"></span>`,
      `<span class="sp-line sp-title sp-center"></span><span class="sp-line sp-body short sp-center"></span>`,
      `<span class="sp-rail" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`,
      `<span class="sp-quote">“ ”</span>`,
      `<span class="sp-poster"><span class="sp-line sp-title"></span></span>`,
      `<span class="sp-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`,
      `<span class="sp-ring" aria-hidden="true"></span>`,
      `<span class="sp-map" aria-hidden="true"></span>`,
      `<span class="sp-letterbox" aria-hidden="true"><i></i><i></i></span>`,
      `<span class="sp-funnel" aria-hidden="true"><i></i><i></i><i></i></span>`,
      `<span class="sp-pills" aria-hidden="true"><i></i><i></i><i></i></span>`,
      `<span class="sp-stack" aria-hidden="true"><i></i><i></i></span>`,
      `<span class="sp-line sp-title"></span><span class="sp-line sp-body short"></span>`,
      `<span class="sp-kpi" aria-hidden="true">★</span>`,
    ];
    const named = {
      chalkboard: 0, terminal: 0, blueprint: 0, code_hike: 0, scramble: 0,
      split: 1, dual: 1, pip: 1, device: 1,
      kpi: 2, counter_ring: 10, donut_stat: 10, zoom_punch: 2,
      bento: 3, mosaic: 3, quad: 3, kanban: 3, cards_stack: 15, spring_cards: 15,
      lower_third: 4, news_lower: 4, broadcast: 4, ticker: 14, news_stack: 4,
      kinetic_center: 5, caption: 5, mega_type: 5, karaoke: 14,
      rail: 6, chapters: 6, progress_track: 6, filmstrip: 6, subway: 6,
      quote: 7, magazine: 7, poster: 8, glitch_type: 8, neon_sign: 8,
      audiogram: 9, podcast_tile: 9, travel_map: 11, particle_field: 11,
      letterbox: 12, light_leak: 12, funnel: 13, cycle: 14, word_cloud: 14,
      stack: 16, swiss: 16, glass: 15, polaroid: 15,
      stargazer: 17, repo_stars: 17, mask_reveal: 5, safe_overlay: 8,
    };
    const idx = Object.prototype.hasOwnProperty.call(named, c) ? named[c] : (n % thumbs.length);
    return thumbs[idx] + mono;
  }

  function uniquePreviewKit(styleKey) {
    const meta = catalog.styles.find((s) => s.key === styleKey) || {};
    const preset = catalog.presets.find((p) => p.style === styleKey) || {};
    const label = meta.label || preset.style_label || String(styleKey).replace(/_/g, " ");
    const compose = meta.layout_mode || preset.layout_mode || "stack";
    const uses = meta.uses || preset.uses || meta.example || label;
    const desc = String(meta.description || preset.description || uses).split(".")[0];
    const beats = String(meta.template || preset.template || "Open → Teach → Prove → Close")
      .split(/\s*→\s*|\s*->\s*|\s*,\s*/).map((x) => x.trim()).filter(Boolean);
    while (beats.length < 8) beats.push(beats[beats.length - 1] || "Beat");
    const n = fnv(styleKey);
    const punch = label.split(/\s+/).slice(-1)[0] || label;
    const L = esc(label);
    const U = esc(uses);
    const D = esc(desc);
    const P = esc(punch);
    const C = esc(String(compose).replace(/_/g, " "));
    const b = (i) => esc(beats[i % beats.length]);
    const widgets = [
      () => `<div class="vs-kicker vs-a-in">${L}</div><div class="vs-title vs-a-clip">${P}</div><p class="vs-body">${D}</p>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-title vs-a-clip" style="text-align:center">${P}</div><p class="vs-body" style="text-align:center">${U}</p>`,
      () => `<div class="vs-kicker vs-a-in">${C}</div><div class="vs-title vs-a-clip">${b(0)}</div><p class="vs-body">${L} · clip-path wipe</p>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-title sm vs-a-up"><span style="color:var(--palette-accent,#a855f7)">${b(0)}</span> ${b(1)} ${b(2)}</div><p class="vs-body">Karaoke captions</p>`,
      () => `<div class="vs-kicker">${L}</div><blockquote class="vs-quote vs-a-up">“${D}”</blockquote>`,
      () => `<div class="vs-split"><div class="vs-split-a vs-a-left"><div class="vs-kicker">${L}</div><div class="vs-title sm">${b(0)}</div></div><div class="vs-split-b vs-a-right"><div class="vs-kicker">${C}</div><div class="vs-title sm">${b(1)}</div></div></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-title sm vs-a-up">${b(0)}</div><div class="vs-min-list vs-a-up"><p>${b(1)}</p><p>${b(2)}</p><p>${b(3)}</p></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-cards-3"><div class="vs-mini-card vs-a-stagger"><b>01</b><strong>${b(0)}</strong></div><div class="vs-mini-card vs-a-stagger"><b>02</b><strong>${b(1)}</strong></div><div class="vs-mini-card vs-a-stagger"><b>03</b><strong>${b(2)}</strong></div></div>`,
      () => `<div class="vs-cards-3"><div class="vs-mini-card vs-a-stagger" style="grid-column:span 2"><strong>${L}</strong><span>${b(0)}</span></div><div class="vs-mini-card vs-a-stagger"><strong>${b(1)}</strong></div><div class="vs-mini-card vs-a-stagger"><strong>${b(2)}</strong></div></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-scorecard"><div class="vs-a-pop"><b>${(n % 89) + 11}</b><span>${b(0)}</span></div><div class="vs-a-pop"><b>${(n % 7) + 2}×</b><span>${b(1)}</span></div><div class="vs-a-pop"><b>${(n % 40) + 60}%</b><span>${b(2)}</span></div></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-a-pop" style="width:120px;height:120px;border-radius:50%;border:10px solid color-mix(in srgb, currentColor 20%, transparent);border-top-color:var(--palette-accent,#a855f7);margin:12px auto"></div><div class="vs-title sm" style="text-align:center">${(n % 40) + 60}%</div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-cin-bars"><i style="--w:${40 + (n % 40)}%"></i><i style="--w:${55 + (n % 30)}%"></i><i style="--w:${30 + (n % 50)}%"></i></div><p class="vs-body">${b(0)} · chart race</p>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-timeline vs-a-fade"><div class="vs-tl-item on"><b>1</b><span>${b(0)}</span></div><div class="vs-tl-item on"><b>2</b><span>${b(1)}</span></div><div class="vs-tl-item"><b>3</b><span>${b(2)}</span></div><div class="vs-tl-item"><b>4</b><span>${b(3)}</span></div></div>`,
      () => `<div class="vs-term vs-a-up"><div class="vs-term-bar"><i></i><i></i><i></i><span>${esc(styleKey)}</span></div><div class="vs-term-body"><p><span class="vs-term-p">$</span> ${C}</p><p class="vs-term-ok">✓ ${b(0)}</p></div></div>`,
      () => `<div class="vs-kicker">code hike</div><div class="vs-min-list vs-a-up"><p>  ${b(0)}</p><p style="border-left:3px solid var(--palette-accent,#a855f7);padding-left:8px">${b(1)}</p><p>  ${b(2)}</p></div>`,
      () => `<div class="vs-kicker">LIVE</div><div class="vs-title sm">${b(0)}</div><div class="vs-chip-row"><span class="vs-chip">${P}</span><span class="vs-chip">${C}</span><span class="vs-chip">${b(1)}</span></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-min-list vs-a-up" style="align-items:center"><p style="width:100%">${b(0)}</p><p style="width:78%">${b(1)}</p><p style="width:52%">${b(2)}</p></div>`,
      () => `<div class="vs-kicker">${L}</div><div class="vs-title sm vs-a-up">${b(0)} → ${b(1)}</div><p class="vs-body">${U}</p>`,
    ];
    const widgetIds = ["cover","type","wipe","karaoke","quote","split","list","cards","bento","kpi","ring","bars","rail","term","hike","ticker","funnel","map"];
    const chromeIds = ["plain","term","letterbox","board","poster","lower"];
    const chromes = [
      (inner) => inner,
      (inner) => `<div class="vs-term vs-a-up"><div class="vs-term-bar"><i></i><i></i><i></i><span>${esc(styleKey)}</span></div><div class="vs-term-body">${inner}</div></div>`,
      (inner) => `<div class="vs-letterbox-frame"><i></i><div class="vs-letterbox-mid">${inner}</div><i></i></div>`,
      (inner) => `<div class="vs-board-frame">${inner}</div>`,
      (inner) => `<div class="vs-poster-frame">${inner}</div>`,
      (inner) => `${inner}<div class="vs-cta-pill vs-a-pulse">${b(0)} · ${L}</div>`,
    ];
    const leadChrome = {
      chalkboard: 3, terminal: 1, blueprint: 3, code_hike: 1, scramble: 1,
      letterbox: 2, cinematic: 2, documentary: 2,
      poster: 4, mega_type: 4, neon_sign: 4,
      lower_third: 5, broadcast: 5, ticker: 5, news_lower: 5,
      kinetic_center: 0, caption: 0, karaoke: 0,
    }[compose] || 0;
    const frames = [];
    for (let w = 0; w < widgets.length; w++) {
      for (let ch = 0; ch < chromes.length; ch++) {
        frames.push({ w, ch, id: `${chromeIds[ch]}-${widgetIds[w]}` });
      }
    }
    const lead = frames.filter((f) => f.ch === leadChrome);
    const rest = frames.filter((f) => f.ch !== leadChrome);
    const rot = n % Math.max(rest.length, 1);
    const seq = lead.concat(rest.slice(rot), rest.slice(0, rot)).slice(0, MAX_SLIDES);
    return seq.map((f) => ({
      key: f.id,
      label: `${label} · ${f.id}`,
      html: () => chromes[f.ch](widgets[f.w]()),
    }));
  }

  function visualLayoutCardHtml(p, opts) {
    const admin = opts && opts.admin;
    const sk = p.key === "auto" ? "auto" : (p.style || "explainer");
    const compose = p.layout_mode || "stack";
    const previewCls = "style-preview compose-" + compose + " style-preview-" + (sk === "auto" ? "modern" : sk);
    const styleName = p.style_label || p.label || sk;
    const fontName = p.font_label || "";
    const fontStack = p.font_stack || "";
    const variety = p.template || p.variety || "";
    const uses = p.uses || p.example || "";
    const cat = p.category_label || "";
    const fontStyle = fontStack ? ` style="font-family:${esc(fontStack)}"` : "";
    const icon = admin ? `<i data-lucide="layout-template"></i>` : "";
    return (
      `<span class="${previewCls}" aria-hidden="true"${fontStyle}>${visualPreviewInner(compose, sk)}</span>` +
      `<span class="vp-label"${fontStyle}>${icon}${esc(styleName)}</span>` +
      (fontName ? `<span class="vp-font">Aa · ${esc(fontName)}</span>` : "") +
      (cat && p.key !== "auto" ? `<span class="vp-cat">${esc(cat)}</span>` : "") +
      (variety ? `<span class="vp-variety">${esc(variety)}</span>` : "") +
      (uses ? `<span class="vp-example">${esc(uses)}</span>` : "")
    );
  }

  function fillCronVisualSelects(styleVal, themeVal) {
    const ss = $("rt-video-style");
    const ts = $("rt-video-theme");
    if (ss) {
      const cats = {};
      catalog.styles.forEach((s) => {
        if (!s.key || s.key === "auto") return;
        const g = s.category_label || s.category || "Other";
        (cats[g] || (cats[g] = [])).push(s);
      });
      const groups = Object.keys(cats).sort().map((g) => {
        const opts = cats[g].map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join("");
        return `<optgroup label="${esc(g)}">${opts}</optgroup>`;
      }).join("");
      ss.innerHTML = `<option value="auto">Auto</option>${groups}`;
      const want = styleVal || ss.value;
      if (want && [...ss.options].some((o) => o.value === want)) ss.value = want;
    }
    if (ts) {
      ts.innerHTML = catalog.themes.map((th) =>
        `<option value="${esc(th.key)}">${esc(th.label)}</option>`
      ).join("");
      const wantT = themeVal || ts.value;
      if (wantT && [...ts.options].some((o) => o.value === wantT)) ts.value = wantT;
    }
  }

  function paintSlide(idx) {
    const styleKey = styleKeyFromFrame();
    const kit = uniquePreviewKit(styleKey);
    if (!kit.length) return;
    overlayIdx = ((idx % kit.length) + kit.length) % kit.length;
    const mock = kit[overlayIdx];
    const canvas = $("admin-slide-canvas");
    const meta = catalog.styles.find((s) => s.key === styleKey) || {};
    if (canvas) {
      const stack = meta.font_stack || "";
      if (stack) {
        canvas.style.fontFamily = stack;
        canvas.style.setProperty("--slide-font", stack);
      }
      canvas.innerHTML = mock.html();
      canvas.classList.remove("vs-play");
      void canvas.offsetWidth;
      canvas.classList.add("vs-play");
    }
    const counter = $("admin-slide-counter");
    if (counter) counter.textContent = `${overlayIdx + 1} / ${kit.length} · ${mock.label}`;
    const range = $("admin-slide-range");
    if (range) {
      range.min = "0";
      range.max = String(kit.length - 1);
      range.value = String(overlayIdx);
    }
    const dots = $("admin-slide-dots");
    if (dots) { dots.innerHTML = ""; dots.hidden = true; }
  }

  async function refreshCatalog() {
    try {
      const data = await (await fetch("/api/video-formats")).json();
      catalog.styles = data.styles || [];
      catalog.presets = data.visual_presets || [];
      catalog.themes = data.themes || [];
    } catch (e) { /* keep last */ }
  }

  window.adminSlideKit = function adminSlideKit(styleKey) {
    return uniquePreviewKit(styleKey);
  };
  window.visualLayoutCardHtml = visualLayoutCardHtml;
  window.visualPreviewInner = visualPreviewInner;
  window.uniquePreviewKit = uniquePreviewKit;
  window.fillCronVisualSelects = fillCronVisualSelects;
  window.MAX_STYLE_PREVIEW_SLIDES = MAX_SLIDES;

  const origPreview = typeof renderAdminSlidePreview === "function" ? renderAdminSlidePreview : null;
  window.renderAdminSlidePreview = function renderAdminSlidePreview() {
    if (origPreview) origPreview();
    overlayIdx = 0;
    paintSlide(0);
  };

  document.addEventListener("click", (e) => {
    const prev = e.target.closest && e.target.closest("#admin-slide-prev");
    const next = e.target.closest && e.target.closest("#admin-slide-next");
    if (!prev && !next) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    paintSlide(overlayIdx + (next ? 1 : -1));
  }, true);

  document.addEventListener("input", (e) => {
    if (!e.target || e.target.id !== "admin-slide-range") return;
    paintSlide(Number(e.target.value) || 0);
  }, true);

  const origFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const u = String(url || "");
    const method = (opts && opts.method) || "GET";
    if (u.includes("/api/video-formats") && method === "GET") {
      return origFetch(url, opts).then((res) => {
        res.clone().json().then((data) => {
          catalog.styles = data.styles || catalog.styles;
          catalog.presets = data.visual_presets || catalog.presets;
          catalog.themes = data.themes || catalog.themes;
          fillCronVisualSelects();
        }).catch(() => {});
        return res;
      });
    }
    if (u.includes("/api/admin/runtime-settings") && method === "PUT" && opts && opts.body) {
      try {
        const body = JSON.parse(opts.body);
        const ss = $("rt-video-style");
        const ts = $("rt-video-theme");
        if (ss) body.auto_video_style = ss.value || body.auto_video_style || "whiteboard";
        if (ts) body.auto_video_theme = ts.value || body.auto_video_theme || "snow";
        opts = Object.assign({}, opts, { body: JSON.stringify(body) });
      } catch (e) { /* keep original body */ }
    }
    return origFetch(url, opts).then((res) => {
      if (u.includes("/api/admin/runtime-settings") && method === "GET") {
        res.clone().json().then((data) => {
          fillCronVisualSelects(data.auto_video_style || "whiteboard", aliasTheme(data.auto_video_theme || "snow"));
        }).catch(() => {});
      }
      return res;
    });
  };

  refreshCatalog().then(() => {
    fillCronVisualSelects();
    if (typeof renderVisualPresets === "function") renderVisualPresets();
    if (typeof renderAdminVisualStyles === "function") renderAdminVisualStyles();
  });
})();
