/* Overlay loaded AFTER app.js: data-fit layout previews and cron style sync.
 * app.js calls uniquePreviewKit / __layoutCardHtml when this file has loaded.
 */
(function () {
  const FAMILIES = ["treemap", "orbit", "cascade", "masonry", "path", "golden", "bands", "scatter", "slices", "skyline"];
  const FAMILY_LABEL = {
    treemap: "Treemap", orbit: "Orbit", cascade: "Cascade", masonry: "Masonry",
    path: "Path", golden: "Golden split", bands: "Bands", scatter: "Scatter",
    slices: "Slices", skyline: "Skyline",
  };
  const THEME_ALIASES = {
    paper: "snow", ivory: "snow", mint: "snow",
    nebula: "aurora", slate: "midnight", mono: "midnight",
  };
  const catalog = { styles: [], presets: [], themes: [] };

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
  function familyOrder(styleKey) {
    const lead = fnv(styleKey) % FAMILIES.length;
    return FAMILIES.slice(lead).concat(FAMILIES.slice(0, lead));
  }

  function cellsFor(family, n, seed) {
    const count = Math.max(3, Math.min(5, n || 4));
    const flip = seed % 2 === 1;
    const bias = 42 + (seed % 5) * 4;
    let cells = [];
    if (family === "treemap" || family === "golden") {
      cells.push({ x: 0, y: 0, w: bias, h: 100 });
      const rest = count - 1;
      const gap = 2;
      const rw = 100 - bias - gap;
      const h = (100 - gap * (rest - 1)) / rest;
      for (let i = 0; i < rest; i++) cells.push({ x: bias + gap, y: i * (h + gap), w: rw, h });
    } else if (family === "orbit") {
      cells.push({ x: 36, y: 30, w: 28, h: 40 });
      const ring = count - 1;
      const dir = seed % 2 ? -1 : 1;
      for (let i = 0; i < ring; i++) {
        const ang = -Math.PI / 2 + dir * i * (2 * Math.PI / ring);
        cells.push({ x: 50 + Math.cos(ang) * 34 - 10, y: 50 + Math.sin(ang) * 32 - 12, w: 20, h: 24 });
      }
    } else if (family === "cascade") {
      const step = 7 + (seed % 3) * 3;
      const h = (100 - 2 * (count - 1)) / count;
      for (let i = 0; i < count; i++) {
        const x = (seed % 3 === 2) ? (i % 2) * step : step * i;
        cells.push({ x, y: i * (h + 2), w: 100 - step * (count - 1), h });
      }
    } else if (family === "masonry") {
      const cols = count >= 5 ? 3 : 2;
      const gap = 3;
      const cw = (100 - gap * (cols - 1)) / cols;
      const rows = Math.ceil(count / cols);
      const rh = (100 - gap * (rows - 1)) / rows;
      for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        cells.push({ x: col * (cw + gap), y: row * (rh + gap), w: cw, h: rh });
      }
    } else if (family === "bands") {
      const weights = [1.45, 1, 0.75, 1.15, 0.9].slice(0, count);
      const sum = weights.reduce((a, b) => a + b, 0);
      let y = 0;
      weights.forEach((w, i) => {
        const h = (100 - 2 * (count - 1)) * w / sum;
        const inset = (seed % 3 === 1) ? (i % 2) * 16 : 0;
        cells.push({ x: i % 2 ? inset : 0, y, w: 100 - inset, h });
        y += h + 2;
      });
    } else if (family === "skyline" || family === "slices") {
      const gap = 2.5;
      const cw = (100 - gap * (count - 1)) / count;
      for (let i = 0; i < count; i++) {
        const h = 38 + ((seed + i * 19) % 54);
        cells.push({ x: i * (cw + gap), y: 100 - h, w: cw, h });
      }
    } else if (family === "scatter") {
      const cols = 3;
      for (let i = 0; i < count; i++) {
        const col = (seed + i * 2) % cols;
        const row = Math.floor(i / 2) % 2;
        const rot = ((seed + i) % 5) - 2;
        cells.push({ x: 3 + col * 32, y: 8 + row * 46, w: 26, h: 36, rot });
      }
    } else {
      const cw = Math.min(26, 78 / count);
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const x = cw / 2 + t * (100 - cw);
        const up = i % 2 === (seed % 2);
        cells.push({ x: x - cw / 2, y: up ? 8 : 54, w: cw, h: 34 });
      }
    }
    if (flip && family !== "orbit" && family !== "path") {
      cells = cells.map((c) => ({ ...c, x: +(100 - c.x - c.w).toFixed(2) }));
    }
    return cells;
  }

  function stageHtml(family, labels, seed, mini) {
    const cells = cellsFor(family, labels.length, seed);
    const bits = cells.map((c, i) => {
      const rot = c.rot ? `;transform:rotate(${c.rot}deg)` : "";
      const box = `left:${c.x.toFixed(2)}%;top:${c.y.toFixed(2)}%;width:${c.w.toFixed(2)}%;height:${Math.max(8, c.h).toFixed(2)}%${rot}`;
      if (mini) return `<i style="${box}"></i>`;
      return `<div class="fit-c" style="${box}"><b>${String(i + 1).padStart(2, "0")}</b><span>${esc(labels[i] || "")}</span></div>`;
    }).join("");
    return `<span class="${mini ? "lx-mini" : "fit-stage"}" data-fam="${family}">${bits}</span>`;
  }

  function visualPreviewInner(compose, styleKey) {
    const key = String(styleKey || compose || "stack");
    return stageHtml(familyOrder(key)[0], ["", "", "", ""], fnv(key), true);
  }

  function uniquePreviewKit(styleKey) {
    const meta = catalog.styles.find((s) => s.key === styleKey) || {};
    const preset = catalog.presets.find((p) => p.style === styleKey) || {};
    const label = meta.label || preset.style_label || String(styleKey || "style").replace(/_/g, " ");
    const beats = String(meta.template || preset.template || "Open → Teach → Prove → Close")
      .split(/\s*→\s*|\s*->\s*|\s*,\s*/).map((x) => x.trim()).filter(Boolean);
    while (beats.length < 6) beats.push(beats[beats.length - 1] || "Beat");
    const n = fnv(styleKey);
    return familyOrder(styleKey).map((fam, i) => {
      const count = 3 + ((n + i) % 3);
      const labels = [];
      for (let k = 0; k < count; k++) labels.push(beats[(i + k) % beats.length]);
      return {
        key: fam,
        label: `${label} · ${FAMILY_LABEL[fam] || fam}`,
        html: () => `<div class="vs-kicker">${esc(FAMILY_LABEL[fam] || fam)}</div>${stageHtml(fam, labels, n + i * 13, false)}`,
      };
    });
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
    const sw = (p.swatch || []).slice(0, 3).map((c) => `<i class="vp-dot" style="background:${esc(c)}"></i>`).join("");
    const themeName = p.key === "auto" ? "Smart match" : (p.theme_label || "");
    return (
      `<span class="${previewCls}" aria-hidden="true"${fontStyle}>${visualPreviewInner(compose, sk)}</span>` +
      (sw ? `<span class="vp-swatch">${sw}</span>` : "") +
      `<span class="vp-label"${fontStyle}>${icon}${esc(styleName)}</span>` +
      (themeName ? `<span class="vp-theme">${esc(themeName)}</span>` : "") +
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
  window.__layoutCardHtml = visualLayoutCardHtml;
  window.visualLayoutCardHtml = visualLayoutCardHtml;
  window.visualPreviewInner = visualPreviewInner;
  window.uniquePreviewKit = uniquePreviewKit;
  window.fillCronVisualSelects = fillCronVisualSelects;
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
