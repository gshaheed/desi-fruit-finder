const STATUS_LABELS = {
  in_stock: "✅ Looks in stock",
  pre_order: "🟠 Pre-order open",
  sold_out: "❌ Sold out",
  season_ended: "⏳ Season ended",
  manual: "📞 Check directly",
  unknown: "❔ Not yet checked",
  error: "❔ Couldn't check"
};

const REGION_LABELS = {
  norcal: "NorCal",
  socal: "SoCal",
  "ships-statewide": "Ships to You"
};

let DATA = null;
let state = { region: "all", fruit: "all", query: "" };

async function init() {
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    DATA = await res.json();
  } catch (e) {
    document.getElementById("vendor-grid").innerHTML =
      '<p class="empty-state">Could not load data.json.</p>';
    return;
  }

  populateFruitFilter();
  renderCalendar();
  renderLastGenerated();
  wireControls();
  render();
}

function populateFruitFilter() {
  const select = document.getElementById("fruit-filter");
  DATA.fruits.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.name;
    opt.textContent = f.name;
    select.appendChild(opt);
  });
}

function renderLastGenerated() {
  const el = document.getElementById("last-generated");
  const d = new Date(DATA.generated_at);
  el.textContent = `Vendor list last curated: ${d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}

function wireControls() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.region = chip.dataset.region;
      render();
    });
  });

  document.getElementById("fruit-filter").addEventListener("change", (e) => {
    state.fruit = e.target.value;
    render();
  });

  document.getElementById("search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    render();
  });
}

function render() {
  const grid = document.getElementById("vendor-grid");
  const filtered = DATA.vendors.filter((v) => {
    if (state.region !== "all" && v.region !== state.region) return false;
    if (state.fruit !== "all" && !v.fruits.includes(state.fruit)) return false;
    if (state.query) {
      const hay = (v.name + " " + v.location + " " + v.fruits.join(" ")).toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<p class="empty-state">No vendors match those filters yet.</p>';
    return;
  }

  grid.innerHTML = filtered.map(renderCard).join("");
}

function renderCard(v) {
  const statusKey = STATUS_LABELS[v.status] ? v.status : "unknown";
  const lastChecked = v.last_checked
    ? `Last checked ${new Date(v.last_checked).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "Not yet auto-checked";

  return `
    <article class="card">
      <span class="badge ${statusKey}">${STATUS_LABELS[statusKey]}</span>
      <h3>${escapeHtml(v.name)}</h3>
      <p class="location">${escapeHtml(REGION_LABELS[v.region] || v.region)} · ${escapeHtml(v.location)}</p>
      <div class="fruits">${v.fruits.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</div>
      ${v.status_text ? `<p class="muted" style="margin:0;font-size:0.82rem;">${escapeHtml(v.status_text)}</p>` : ""}
      <p class="last-checked">${v.auto_checked ? lastChecked : "Manually curated — no live check"}</p>
      <a class="visit" href="${v.url}" target="_blank" rel="noopener">Visit site →</a>
    </article>
  `;
}

function renderCalendar() {
  const container = document.getElementById("fruit-calendar");
  container.innerHTML = DATA.fruits.map((f) => {
    return `
      <div class="fruit-row">
        <div>${escapeHtml(f.name)}</div>
        <div>
          <div class="season-text">${escapeHtml(f.typical_season)} · ${escapeHtml(f.source_regions)}</div>
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

init();
