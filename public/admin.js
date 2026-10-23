"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = "";

  function say(text, isError) {
    const el = $("message");
    el.textContent = text;
    el.className = isError ? "error" : "";
  }

  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
    const res = await fetch(`/admin/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/login") showLogin();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function showLogin() {
    csrf = "";
    $("app").hidden = true;
    $("login").hidden = false;
  }

  function el(tag, props, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  async function loadSettings() {
    const { settings } = await api("GET", "/settings");
    const root = $("settings");
    root.replaceChildren();
    let group = "";
    for (const s of settings) {
      if (s.group !== group) {
        group = s.group;
        root.append(el("h3", { className: "group" }, group));
      }
      const input = el("input", {
        name: s.key,
        type: s.secret ? "password" : "text",
        value: s.value,
        autocomplete: "off",
        placeholder: s.secret ? (s.isSet ? "(set - leave blank to keep)" : "(not set)") : "",
      });
      input.dataset.original = s.value;
      root.append(el("label", { className: "setting" }, el("code", {}, s.key), input, el("small", {}, s.description)));
    }
  }

  async function loadCimd() {
    const { documents } = await api("GET", "/cimd");
    const root = $("cimd-list");
    root.replaceChildren();
    for (const d of documents) {
      const area = el("textarea", { rows: 10, spellcheck: false, value: JSON.stringify(d.document, null, 2) });
      const save = el("button", { type: "button" }, "Save");
      save.addEventListener("click", () => run(async () => {
        await api("PUT", `/cimd/${d.name}`, { document: JSON.parse(area.value) });
        say(`Saved ${d.url}`);
        await loadCimd();
      }));
      const del = el("button", { type: "button", className: "danger" }, d.builtin ? "Reset to default" : "Delete");
      del.disabled = d.builtin && !d.modified;
      del.addEventListener("click", () => run(async () => {
        if (!confirm(`${d.builtin ? "Reset" : "Delete"} ${d.name}?`)) return;
        await api("DELETE", `/cimd/${d.name}`);
        say(`${d.builtin ? "Reset" : "Deleted"} ${d.name}`);
        await loadCimd();
      }));
      const link = el("a", { href: `/cimd/${d.name}.json`, target: "_blank", rel: "noopener" }, d.url);
      const title = el("strong", {}, d.name);
      if (d.modified && d.builtin) title.append(el("span", { className: "badge" }, "edited"));
      if (!d.builtin) title.append(el("span", { className: "badge" }, "custom"));
      root.append(el("div", { className: "doc" }, title, " ", link, area, el("div", { className: "actions" }, save, del)));
    }
  }

  async function run(fn) {
    try {
      await fn();
    } catch (error) {
      say(error.message, true);
    }
  }

  function afterRestart(result) {
    if (!result.restarting) return say("No settings changed.");
    say("Saved. The server is restarting; this page reloads when it is back.");
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (res.ok) {
          clearInterval(timer);
          location.reload();
        }
      } catch { /* still restarting */ }
    }, 2000);
  }

  async function enter() {
    $("login").hidden = true;
    $("app").hidden = false;
    await loadSettings();
    await loadCimd();
  }

  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      ({ csrf } = await api("POST", "/login", { username: $("username").value, password: $("password").value }));
      $("password").value = "";
      say("");
      await enter();
    });
  });

  $("logout").addEventListener("click", () => run(async () => {
    await api("POST", "/logout", {});
    showLogin();
  }));

  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const values = {};
      for (const input of $("settings").querySelectorAll("input")) {
        if (input.value !== input.dataset.original) values[input.name] = input.value;
      }
      if (Object.keys(values).length === 0) return say("No settings changed.");
      afterRestart(await api("PUT", "/settings", { values }));
    });
  });

  $("export").addEventListener("click", () => run(async () => {
    const data = await api("GET", "/export");
    const link = el("a", {
      href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })),
      download: "bxhealth-fhir-mcp-settings.json",
    });
    link.click();
    URL.revokeObjectURL(link.href);
  }));

  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => run(async () => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (!confirm("Import these settings and CIMD documents? Changed settings restart the server.")) return;
    const result = await api("POST", "/import", data);
    await loadCimd();
    afterRestart(result);
  }));

  $("cimd-new").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const result = await api("PUT", `/cimd/${$("new-name").value}`, { document: JSON.parse($("new-doc").value) });
      say(`Added ${result.url}`);
      $("new-name").value = "";
      await loadCimd();
    });
  });

  run(async () => {
    try {
      ({ csrf } = await api("GET", "/session"));
      await enter();
    } catch {
      showLogin();
    }
  });
})();
