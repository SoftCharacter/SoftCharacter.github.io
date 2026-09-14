/* GitHub 作品集的数据层：只处理真实 API 数据，不写死项目内容。 */
const CONFIG = Object.freeze({
  user: "SoftCharacter",
  startDate: "2025-01-01T00:00:00Z",
  api: "https://api.github.com",
  excludedRepositories: ["personmanage", "claude-code-src"],
});

const state = { profile: null, repositories: [], filtered: [], sort: "recent", language: "all", query: "", readmeLoading: false };
const elements = {
  avatar: document.querySelector("#profile-avatar"), fallback: document.querySelector("#avatar-fallback"),
  login: document.querySelector("#profile-login"), bio: document.querySelector("#profile-bio"),
  repos: document.querySelector("#profile-repos"), followers: document.querySelector("#profile-followers"),
  count: document.querySelector("#project-count"), languages: document.querySelector("#language-count"),
  stars: document.querySelector("#star-count"), sync: document.querySelector("#last-sync"),
  status: document.querySelector("#project-status"), grid: document.querySelector("#project-grid"),
  search: document.querySelector("#project-search"), filter: document.querySelector("#language-filter"), sort: document.querySelector("#sort-select"),
};

/* 日期和数字格式化集中处理，保证卡片口径一致。 */
const formatNumber = (value) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
const formatDate = (value) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));

async function getJson(path) {
  const response = await fetch(`${CONFIG.api}${path}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return response.json();
}

/* README 使用 raw 响应，避免再做 base64 解码，也让摘要提取更直接。 */
async function getReadmeText(repo) {
  const path = `/repos/${CONFIG.user}/${encodeURIComponent(repo.name)}/readme`;
  const response = await fetch(`${CONFIG.api}${path}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!response.ok) return "";
  return response.text();
}

/* 只提取 README 的首段有效文字，过滤徽章、图片和安装命令。 */
function extractReadmeSummary(markdown = "") {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const parts = [];
  let sawHeading = false;
  for (const line of lines) {
    const text = line.trim();
    if (!text || text.startsWith("<!--")) {
      if (parts.length) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(text)) {
      sawHeading = true;
      if (parts.length) break;
      continue;
    }
    if (/^(!?\[.*\]\(.*\)|<img\b|https?:\/\/)/i.test(text)) continue;
    const cleaned = text
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/^[-*+]\s+/, "")
      .trim();
    if (cleaned && (sawHeading || !parts.length)) parts.push(cleaned);
    if (parts.join(" ").length >= 220) break;
  }
  const summary = parts.join(" ").replace(/\s+/g, " ").trim();
  return summary.length > 220 ? `${summary.slice(0, 217)}…` : summary;
}

/* 以 4 个并发 worker 读取 README，兼顾速度和 GitHub 未登录限流。 */
async function hydrateReadmes() {
  const targets = state.repositories.filter((repo) => !repo.description && !repo.readmeDescription);
  if (!targets.length) return;
  state.readmeLoading = true;
  renderProjects();
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const repo = targets[cursor];
      cursor += 1;
      try {
        const summary = extractReadmeSummary(await getReadmeText(repo));
        if (summary) repo.readmeDescription = summary;
      } catch (error) {
        // 单个 README 失败不应阻断其他项目的摘要同步。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  state.readmeLoading = false;
  applyFilters();
}

/* profile 和仓库并发请求，减少首屏等待。 */
async function loadGithub() {
  elements.status.innerHTML = '<span class="status-spinner" aria-hidden="true"></span> 正在加载 GitHub 项目…';
  try {
    const [profile, repositories] = await Promise.all([
      getJson(`/users/${CONFIG.user}`),
      getJson(`/users/${CONFIG.user}/repos?per_page=100&sort=updated&type=owner`),
    ]);
    state.profile = profile;
    state.repositories = repositories.filter((repo) => {
      const repositoryName = String(repo.name || "").toLowerCase();
      const isExcluded = CONFIG.excludedRepositories.includes(repositoryName);
      const isInDateRange = new Date(repo.pushed_at || repo.updated_at) >= new Date(CONFIG.startDate);
      return isInDateRange && !isExcluded;
    });
    renderProfile();
    populateLanguages();
    applyFilters();
    hydrateReadmes();
    elements.sync.textContent = `最后同步 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    elements.status.innerHTML = `<div class="error-state"><strong>暂时无法连接 GitHub</strong><span>页面需要访问 api.github.com 才能读取真实项目。请确认网络后重试，或直接打开 GitHub 账号。</span><button id="retry-load" type="button">重新连接</button></div>`;
    document.querySelector("#retry-load").addEventListener("click", loadGithub, { once: true });
  }
}

function renderProfile() {
  const profile = state.profile;
  elements.login.textContent = profile.login || CONFIG.user;
  elements.bio.textContent = profile.bio || "开源项目与实验记录";
  elements.repos.textContent = formatNumber(profile.public_repos);
  elements.followers.textContent = formatNumber(profile.followers);
  elements.count.textContent = formatNumber(state.repositories.length);
  elements.avatar.src = profile.avatar_url || elements.avatar.src;
  elements.avatar.alt = `${profile.login || CONFIG.user} 的 GitHub 头像`;
}

function populateLanguages() {
  const languages = [...new Set(state.repositories.map((repo) => repo.language).filter(Boolean))].sort();
  elements.languages.textContent = formatNumber(languages.length);
  elements.filter.innerHTML = '<option value="all">全部语言</option>' + languages.map((language) => `<option value="${escapeHtml(language)}">${escapeHtml(language)}</option>`).join("");
}

function applyFilters() {
  const query = state.query.toLowerCase();
  state.filtered = state.repositories.filter((repo) => {
    const searchable = `${repo.name} ${repo.description || ""} ${repo.readmeDescription || ""}`.toLowerCase();
    return (state.language === "all" || repo.language === state.language) && searchable.includes(query);
  });
  state.filtered.sort((a, b) => state.sort === "stars" ? b.stargazers_count - a.stargazers_count : state.sort === "name" ? a.name.localeCompare(b.name) : new Date(b.pushed_at || b.updated_at) - new Date(a.pushed_at || a.updated_at));
  elements.stars.textContent = formatNumber(state.repositories.reduce((total, repo) => total + repo.stargazers_count, 0));
  renderProjects();
}

function renderProjects() {
  elements.status.textContent = state.readmeLoading ? `正在读取 ${state.repositories.filter((repo) => !repo.description && !repo.readmeDescription).length} 个 README 摘要…` : state.filtered.length ? `${state.filtered.length} 个项目匹配当前视图` : "没有匹配的项目";
  if (!state.filtered.length) {
    elements.grid.innerHTML = '<div class="empty-state">没有找到符合条件的项目。试试清空搜索词，或切换到“全部语言”。</div>';
    return;
  }
  elements.grid.innerHTML = state.filtered.map((repo, index) => {
    const description = repo.description || repo.readmeDescription || "README 暂无可提取摘要，打开仓库查看详情。";
    const archive = repo.archived ? '<span class="archived-label">已归档</span>' : "";
    return `<article class="project-card"><div class="card-topline"><span class="card-index">${String(index + 1).padStart(2, "0")}</span><span class="card-repo-type">${repo.fork ? "FORK" : "PUBLIC REPO"}</span></div><h3 class="card-title">${escapeHtml(repo.name)}</h3><p class="card-description">${escapeHtml(description)}</p><div class="card-footer"><div class="card-meta"><span class="language-chip" style="--chip-color:${languageColor(repo.language)}">${escapeHtml(repo.language || "未标注语言")}</span><span>${formatNumber(repo.stargazers_count)} stars</span><span>${formatDate(repo.pushed_at || repo.updated_at)}</span></div><a class="card-link" href="${escapeHtml(repo.html_url)}" target="_blank" rel="noreferrer">打开 ↗</a></div>${archive}</article>`;
  }).join("");
}

function languageColor(language) {
  const colors = { JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", HTML: "#e34c26", CSS: "#563d7c", Rust: "#dea584", Go: "#00ADD8", Java: "#b07219" };
  return colors[language] || "#d95d39";
}

/* 主题偏好保存在本地，下一次打开仍维持用户选择。 */
function setupTheme() {
  const button = document.querySelector("#theme-toggle");
  const stored = localStorage.getItem("softcharacter-theme");
  const apply = (theme) => { document.documentElement.dataset.theme = theme; button.textContent = theme === "dark" ? "深色" : "浅色"; button.setAttribute("aria-pressed", theme === "dark"); };
  apply(stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  button.addEventListener("click", () => { const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; localStorage.setItem("softcharacter-theme", next); apply(next); });
}

elements.avatar.addEventListener("error", () => { elements.avatar.style.display = "none"; elements.fallback.classList.add("is-visible"); });
elements.search.addEventListener("input", (event) => { state.query = event.target.value.trim(); applyFilters(); });
elements.filter.addEventListener("change", (event) => { state.language = event.target.value; applyFilters(); });
elements.sort.addEventListener("change", (event) => { state.sort = event.target.value; applyFilters(); });
setupTheme();
loadGithub();
