// Login / register screen for Multimodal Studio.
const $ = (id) => document.getElementById(id);
const icons = () => { try { lucide.createIcons(); } catch (e) {} };

function showMsg(text, kind) {
  const el = $("auth-msg");
  el.textContent = text;
  el.className = "auth-msg " + (kind || "info");
  el.classList.remove("hidden");
}
function clearMsg() { $("auth-msg").classList.add("hidden"); }

function switchTab(tab) {
  document.querySelectorAll(".auth-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.querySelectorAll(".auth-form").forEach((f) =>
    f.classList.toggle("hidden", f.dataset.pane !== tab)
  );
  clearMsg();
  icons();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.detail || "Request failed");
  return data;
}

document.addEventListener("DOMContentLoaded", () => {
  icons();
  // Match studio theme (Indigo / admin palette) on the login screen.
  fetch("/api/ui-palette")
    .then((r) => r.json())
    .then((data) => {
      const p = data && data.palette;
      if (!p) return;
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
        if (p[k]) root.style.setProperty(cssVar, p[k]);
      });
      if (p.primary) {
        root.style.setProperty("--accent", p.primary);
        root.style.setProperty("--ring", p.primary);
      }
    })
    .catch(() => {});

  document.querySelectorAll(".auth-tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab))
  );

  $("pane-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMsg();
    const identifier = $("si-id").value.trim();
    const password = $("si-pw").value;
    if (!identifier || !password) return showMsg("Enter your email/username and password.", "error");
    try {
      await postJSON("/api/auth/login", { identifier, password });
      const me = await (await fetch("/api/auth/me")).json();
      window.location.href = "/";
    } catch (err) {
      showMsg(err.message, "error");
    }
  });

  $("pane-register").addEventListener("submit", async (e) => {
    e.preventDefault();
    clearMsg();
    const email = $("rg-email").value.trim();
    const username = $("rg-name").value.trim();
    const password = $("rg-pw").value;

    if (!email) return showMsg("Email is required.", "error");

    // After admin approval: user returns with password to activate the account.
    if (password && password.length >= 6) {
      try {
        await postJSON("/api/auth/register", { email, username, password });
        const me = await (await fetch("/api/auth/me")).json();
        window.location.href = "/";
        return;
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("already registered")) {
          showMsg("This email is already registered — use Login.", "error");
          return;
        }
        // Not approved yet — fall through and submit for review instead.
        if (!msg.toLowerCase().includes("approved")) {
          showMsg(msg, "error");
          return;
        }
      }
    }

    // Default: submit for admin review (no account created yet).
    try {
      const data = await postJSON("/api/auth/request-invite", { email, name: username, message: "" });
      showMsg(
        data.message ||
          "Submitted for review. An admin will approve your account — then return here with your password.",
        "success"
      );
      $("rg-pw").value = "";
    } catch (err) {
      showMsg(err.message, "error");
    }
  });
});
