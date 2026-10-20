"use strict";
const summary = document.getElementById("summary");
const checks = document.getElementById("checks");
const refresh = document.getElementById("refresh");
async function update() {
  refresh.disabled = true;
  summary.textContent = "Checking public endpoints and dependencies...";
  checks.replaceChildren();
  try {
    const response = await fetch("/dashboard/status", { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error("Status unavailable");
    const report = await response.json();
    if (!Array.isArray(report.checks) || report.checks.length === 0) throw new Error("Invalid status response");
    for (const check of report.checks) {
      const item = document.createElement("li");
      item.className = check.ok ? "pass" : "fail";
      const title = document.createElement("strong");
      title.textContent = `${check.ok ? "\u2611 PASS" : "\u2717 FAIL"}  ${check.label}`;
      const detail = document.createElement("span");
      detail.textContent = check.detail;
      item.append(title, detail);
      checks.append(item);
    }
    const passed = report.checks.filter(check => check.ok).length;
    summary.textContent = `${passed}/${report.checks.length} checks passed. Last checked: ${new Date(report.checkedAt).toLocaleString()}.`;
  } catch {
    summary.textContent = "Health checks unavailable or timed out. No healthy status can be confirmed. Try again or contact the operator.";
  } finally {
    refresh.disabled = false;
  }
}
refresh.addEventListener("click", update);
void update();
