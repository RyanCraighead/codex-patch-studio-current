#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "assets", "readme");
const outPath = path.join(outDir, "repo-activity.svg");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lastDays(count) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (count - 1 - index));
    return shortDate(date);
  });
}

function listLines(text) {
  return text.length ? text.split(/\r?\n/u).filter(Boolean) : [];
}

const days = lastDays(30);
const since = days[0];
const logLines = listLines(git(["log", `--since=${since}`, "--date=short", "--format=%ad%x09%an%x09%s"]));
const commitsByDay = new Map(days.map((day) => [day, 0]));
const contributors = new Map();

for (const line of logLines) {
  const [date, author] = line.split("\t");
  if (commitsByDay.has(date)) {
    commitsByDay.set(date, commitsByDay.get(date) + 1);
  }
  if (author) {
    contributors.set(author, (contributors.get(author) || 0) + 1);
  }
}

const commitCounts = days.map((day) => commitsByDay.get(day) || 0);
const maxCommits = Math.max(1, ...commitCounts);
const totalCommits = commitCounts.reduce((sum, count) => sum + count, 0);
const branch = git(["branch", "--show-current"]) || "unknown";
const trackedFiles = listLines(git(["ls-files"]));
const agentTemplates = trackedFiles.filter((file) => /^native-patches\/agents\/.+\.toml$/u.test(file)).length;
const patchScripts = trackedFiles.filter((file) => /^scripts\/.+/u.test(file)).length;
const latestCommit = git(["log", "-1", "--format=%h %s"]) || "No commits yet";
const topContributors = [...contributors.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 4);

function card(x, y, width, title, value, accent) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${width}" height="82" rx="8" fill="#ffffff" stroke="#d8dee8"/>
      <text x="16" y="26" font-size="14" font-weight="700" fill="${accent}">${escapeXml(title)}</text>
      <text x="16" y="56" font-size="22" font-weight="800" fill="#121820">${escapeXml(value)}</text>
    </g>`;
}

const bars = commitCounts
  .map((count, index) => {
    const x = 26 + index * 20;
    const height = Math.max(5, Math.round((count / maxCommits) * 86));
    const y = 260 - height;
    const color = count > 0 ? "#ff7a33" : "#e8edf4";
    return `<rect x="${x}" y="${y}" width="12" height="${height}" rx="3" fill="${color}"><title>${days[index]}: ${count} commits</title></rect>`;
  })
  .join("\n");

const contributorText = topContributors.length
  ? topContributors.map(([name, count]) => `${name} ${count}`).join("   ")
  : "No commits in the last 30 days";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="390" viewBox="0 0 1000 390" role="img" aria-label="Repository activity dashboard">
  <defs>
    <linearGradient id="header" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#00b8ff"/>
      <stop offset="0.55" stop-color="#9a5cff"/>
      <stop offset="1" stop-color="#ff4fad"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#0b1020" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="1000" height="390" rx="14" fill="#f8fafc"/>
  <rect x="20" y="20" width="960" height="68" rx="10" fill="#ffffff" stroke="#d8dee8" filter="url(#shadow)"/>
  <rect x="40" y="43" width="16" height="16" rx="3" fill="url(#header)"/>
  <text x="70" y="48" font-family="Segoe UI, Arial, sans-serif" font-size="19" font-weight="800" fill="#111827">${totalCommits} Contributions in the Last 30 Days</text>
  <text x="70" y="70" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#64748b">Latest: ${escapeXml(latestCommit)}</text>
  <g transform="translate(620 47)">
    ${commitCounts
      .map((count, index) => `<rect x="${index * 10}" y="0" width="7" height="7" rx="2" fill="${count > 0 ? "#ec4899" : "#f3d7e8"}"><title>${days[index]}: ${count}</title></rect>`)
      .join("")}
  </g>
  ${card(20, 106, 300, "Current Branch", branch, "#2563eb")}
  ${card(350, 106, 300, "Tracked Files", String(trackedFiles.length), "#7c3aed")}
  ${card(680, 106, 300, "Patch Scripts", String(patchScripts), "#ef4444")}
  <g transform="translate(20 206)">
    <rect width="630" height="142" rx="8" fill="#ffffff" stroke="#d8dee8"/>
    <text x="18" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="800" fill="#ff6a2a">Commit Activity</text>
    ${bars}
  </g>
  <g transform="translate(680 206)">
    <rect width="300" height="142" rx="8" fill="#ffffff" stroke="#d8dee8"/>
    <text x="18" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="800" fill="#16a34a">Top Contributors</text>
    <text x="18" y="64" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#334155">${escapeXml(contributorText)}</text>
    <text x="18" y="104" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#64748b">Agent templates: ${agentTemplates}</text>
  </g>
  <text x="20" y="374" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="#94a3b8">Generated locally by scripts/generate-readme-activity.cjs</text>
</svg>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, svg, "utf8");
console.log(outPath);
