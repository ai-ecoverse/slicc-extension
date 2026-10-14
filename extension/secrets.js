(() => {
 
    "ghp_",
   
    "gho_",
   
    "ghu_",
   
    "ghs_",
   
    "ghr_",
   
    "github_pat_",
   
    "sk-",
   
    "pk-",
   
    "xoxb-",
   
    "xoxp-",
   
    "xoxa-",
   
    "xoxs-",
   
    "AKIA",
   
    "ABIA",
   
    "ACCA",
   
    "ASIA",
   
    "sk-ant-",
   
    "Bearer "
   
  var OAUTH_EXTRA_DOMAINS_KEY = "slicc_oauth_extra_domains";
  function readOAuthExtras(storage2) {
    try {
      const raw = storage2.getItem(OAUTH_EXTRA_DOMAINS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k !== "string" || !Array.isArray(v)) continue;
        const cleaned = v.filter((d) => typeof d === "string" && d.length > 0);
        if (cleaned.length > 0) out[k] = cleaned;
      }
      return out;
    } catch {
      return {};
    }
  }
  function writeOAuthExtras(storage2, store) {
    try {
      storage2.setItem(OAUTH_EXTRA_DOMAINS_KEY, JSON.stringify(store));
    } catch (err) {
      throw new Error(
        `Failed to persist OAuth extras (localStorage quota exceeded?): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  function addOAuthExtraDomain(storage2, providerId, domain) {
    if (!providerId || !domain) return { added: false, reason: "provider and domain required" };
    const store = readOAuthExtras(storage2);
    const current = store[providerId] ?? [];
    const lower = domain.toLowerCase();
    if (current.some((d) => d.toLowerCase() === lower)) {
      return { added: false, reason: "duplicate" };
    }
    store[providerId] = [...current, domain];
    try {
      writeOAuthExtras(storage2, store);
    } catch (err) {
      return { added: false, reason: err instanceof Error ? err.message : String(err) };
    }
    return { added: true };
  }
  function removeOAuthExtraDomain(storage2, providerId, domain) {
    const store = readOAuthExtras(storage2);
    const current = store[providerId] ?? [];
    const lower = domain.toLowerCase();
    const next = current.filter((d) => d.toLowerCase() !== lower);
    if (next.length === current.length) return { removed: false };
    if (next.length === 0) delete store[providerId];
    else store[providerId] = next;
    writeOAuthExtras(storage2, store);
    return { removed: true };
  }
  function clearOAuthExtras(storage2, providerId) {
    const store = readOAuthExtras(storage2);
    delete store[providerId];
    writeOAuthExtras(storage2, store);
  }

 
  var DOMAINS_SUFFIX = "_DOMAINS";
  function parseDomainsCsv(raw) {
    return raw.split(",").map((domain) => domain.trim()).filter((domain) => domain.length > 0);
  }
  function pairEnvEntriesToSecrets(entries) {
    const values = new Map();
    const domains = new Map();
    const order = [];
    for (const entry of entries) {
      if (entry.key.endsWith(DOMAINS_SUFFIX)) {
        const name = entry.key.slice(0, -DOMAINS_SUFFIX.length);
        if (name) domains.set(name, parseDomainsCsv(entry.value));
      } else {
        if (!values.has(entry.key)) order.push(entry.key);
        values.set(entry.key, entry.value);
      }
    }
    return order.flatMap((name) => {
      const value = values.get(name);
      const allowedDomains = domains.get(name);
      return value !== void 0 && allowedDomains?.length ? [{ name, value, domains: allowedDomains }] : [];
    });
  }
  var PROFILE_RE = /^[a-zA-Z0-9._-]+$/;
  function deriveS3Domains(endpoint) {
    if (!endpoint) return ["*.amazonaws.com"];
    try {
      const url = new URL(endpoint);
      const parts = url.host.split(".");
      return parts.length >= 3 ? [`*.${parts.slice(1).join(".")}`] : [url.host];
    } catch {
      return ["*.amazonaws.com"];
    }
  }
  function validateS3ProfileInput(input) {
    if (!input.profile || !PROFILE_RE.test(input.profile)) {
      return { ok: false, error: "Profile name must be alphanumeric / dot / underscore / hyphen" };
    }
    if (!input.accessKey) return { ok: false, error: "Access Key ID is required" };
    if (!input.secretKey) return { ok: false, error: "Secret Access Key is required" };
    const resolvedDomains = input.domains && input.domains.length > 0 ? input.domains : deriveS3Domains(input.endpoint);
    return { ok: true, resolvedDomains };
  }

 
      [name + DOMAINS_SUFFIX]: domains.join(",")
    });
  }
  async function deleteSecret(storage2, name) {
    await storage2.remove([name, name + DOMAINS_SUFFIX]);
  }
  async function saveS3Profile(storage2, input) {
    const v = validateS3ProfileInput(input);
    if (!v.ok) return v;
    const domains = v.resolvedDomains;
    const prefix = `s3.${input.profile}`;
    await setSecret(storage2, `${prefix}.access_key_id`, input.accessKey, domains);
    await setSecret(storage2, `${prefix}.secret_access_key`, input.secretKey, domains);
    if (input.region) await setSecret(storage2, `${prefix}.region`, input.region, domains);
    if (input.endpoint) await setSecret(storage2, `${prefix}.endpoint`, input.endpoint, domains);
    if (input.pathStyle === true) {
      await setSecret(storage2, `${prefix}.path_style`, "true", domains);
    } else {
      await deleteSecret(storage2, `${prefix}.path_style`);
    }
    return v;
  }
  function validateCustomSecretInput(input) {
    if (!input.name) return { ok: false, error: "Name is required" };
    if (!input.value) return { ok: false, error: "Value is required" };
    if (input.domains.length === 0) {
      return { ok: false, error: "At least one domain pattern is required" };
    }
    return { ok: true };
  }
  async function saveCustomSecret(storage2, input) {
    const v = validateCustomSecretInput(input);
    if (!v.ok) return v;
    await setSecret(storage2, input.name, input.value, input.domains);
    return v;
  }
  function pairStorageEntries(all) {
    return pairEnvEntriesToSecrets(
      Object.entries(all).flatMap(
        ([key, value]) => typeof value === "string" ? [{ key, value }] : []
      )
    );
  }

 
        if (k === "class") node.className = v;
        else if (k === "dataset") Object.assign(node.dataset, v);
        else if (k === "text") node.textContent = v;
        else if (k === "on") {
          for (const [evt, fn] of Object.entries(v)) {
            node.addEventListener(evt, fn);
          }
        } else if (k.startsWith("style:")) {
          node.style.setProperty(k.slice(6), v);
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    for (const child of children) {
      if (child == null) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  function showToast(msg, isError = false) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", isError);
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }
  var storage = chrome.storage.local;
  async function renderList() {
    const container = $("list");
    container.replaceChildren();
    let entries;
    try {
      entries = await listSecrets(storage);
    } catch (err) {
      container.appendChild(el("div", { class: "empty", text: `Failed to read storage: ${err}` }));
      return;
    }
    if (entries.length === 0) {
      container.appendChild(el("div", { class: "empty", text: "No secrets stored. Add one below." }));
      return;
    }
    for (const entry of entries) {
      const row = el(
        "div",
        { class: "secret-row", dataset: { name: entry.name } },
        el(
          "div",
          { class: "secret-meta" },
          el("div", { class: "secret-name", text: entry.name }),
          el("div", { class: "secret-domains", text: entry.domains.join(", ") })
        ),
        el("button", {
          class: "btn-secondary btn",
          text: "Copy name",
          "style:font-size": "11px",
          "style:padding": "4px 8px",
          on: {
            click: async () => {
              try {
                await navigator.clipboard.writeText(entry.name);
                showToast(`Copied "${entry.name}"`);
              } catch {
                showToast("Clipboard failed", true);
              }
            }
          }
        }),
        el("button", {
          class: "btn-danger",
          text: "Delete",
          on: {
            click: async () => {
              if (!confirm(`Delete secret "${entry.name}"?`)) return;
              try {
                await deleteSecret(storage, entry.name);
                showToast(`Deleted ${entry.name}`);
                renderList();
              } catch (err) {
                showToast(`Failed: ${err}`, true);
              }
            }
          }
        })
      );
      container.appendChild(row);
    }
  }
  function setupTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.pane;
        document.querySelectorAll(".tab").forEach((t) => {
          t.classList.toggle("active", t === tab);
        });
        document.querySelectorAll(".pane").forEach((p) => {
          p.classList.toggle("active", p.id === `pane-${target}`);
        });
      });
    });
  }
  async function onSaveS3() {
    const result = await saveS3Profile(storage, {
      profile: $("s3-profile").value.trim(),
      accessKey: $("s3-key").value.trim(),
      secretKey: $("s3-secret").value,
      region: $("s3-region").value.trim() || void 0,
      endpoint: $("s3-endpoint").value.trim() || void 0,
      pathStyle: $("s3-pathstyle").value === "true",
      domains: $("s3-domains").value.trim().split(",").map((d) => d.trim()).filter(Boolean) || void 0
    });
    if (!result.ok) {
      showToast(result.error ?? "Failed", true);
      return;
    }
    const profileName = $("s3-profile").value.trim();
    showToast(`Saved profile "${profileName}"`);
    clearS3Form();
    renderList();
  }
  function clearS3Form() {
    ["s3-profile", "s3-key", "s3-secret", "s3-region", "s3-endpoint", "s3-domains"].forEach((id) => {
      $(id).value = "";
    });
    $("s3-pathstyle").value = "";
  }
  async function onSaveCustom() {
    const result = await saveCustomSecret(storage, {
      name: $("c-name").value.trim(),
      value: $("c-value").value,
      domains: $("c-domains").value.trim().split(",").map((d) => d.trim()).filter(Boolean)
    });
    if (!result.ok) {
      showToast(result.error ?? "Failed", true);
      return;
    }
    const name = $("c-name").value.trim();
    showToast(`Saved "${name}"`);
    clearCustomForm();
    renderList();
  }
  function clearCustomForm() {
    ["c-name", "c-value", "c-domains"].forEach((id) => {
      $(id).value = "";
    });
  }
  function renderOAuthExtras() {
    const container = $("od-list");
    container.replaceChildren();
    const store = readOAuthExtras(localStorage);
    const providers = Object.keys(store).sort();
    if (providers.length === 0) {
      container.appendChild(el("div", { class: "empty", text: "No extras configured." }));
      return;
    }
    for (const providerId of providers) {
      const domains = store[providerId] ?? [];
      if (domains.length === 0) continue;
      const row = el(
        "div",
        { class: "secret-row", dataset: { provider: providerId } },
        el(
          "div",
          { class: "secret-meta" },
          el("div", { class: "secret-name", text: providerId }),
          el("div", { class: "secret-domains", text: domains.join(", ") })
        ),
        el("button", {
          class: "btn-danger",
          text: "Clear",
          on: {
            click: () => {
              if (!confirm(`Clear all extras for "${providerId}"?`)) return;
              clearOAuthExtras(localStorage, providerId);
              showToast(`Cleared extras for ${providerId}`);
              renderOAuthExtras();
            }
          }
        })
      );
      container.appendChild(row);
      for (const d of domains) {
        const domainRow = el(
          "div",
          { class: "secret-row", "style:padding-left": "24px" },
          el("div", { class: "secret-meta" }, el("div", { class: "secret-domains", text: d })),
          el("button", {
            class: "btn-secondary btn",
            text: "Remove",
            "style:font-size": "11px",
            "style:padding": "4px 8px",
            on: {
              click: () => {
                const r = removeOAuthExtraDomain(localStorage, providerId, d);
                if (r.removed) showToast(`Removed ${d} from ${providerId}`);
                renderOAuthExtras();
              }
            }
          })
        );
        container.appendChild(domainRow);
      }
    }
  }
  function onAddOAuthExtra() {
    const provider = $("od-provider").value.trim();
    const domain = $("od-domain").value.trim();
    if (!provider) {
      showToast("Provider is required", true);
      return;
    }
    if (!domain) {
      showToast("Domain is required", true);
      return;
    }
    const r = addOAuthExtraDomain(localStorage, provider, domain);
    if (!r.added) {
      showToast(
        r.reason === "duplicate" ? `Already in ${provider} extras` : r.reason ?? "Failed",
        true
      );
      return;
    }
    showToast(`Added ${domain} to ${provider}`);
    $("od-domain").value = "";
    renderOAuthExtras();
  }
  document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    renderList();
    renderOAuthExtras();
    $("refreshBtn").addEventListener("click", () => {
      renderList();
      renderOAuthExtras();
    });
    $("s3-save").addEventListener("click", onSaveS3);
    $("s3-clear").addEventListener("click", clearS3Form);
    $("c-save").addEventListener("click", onSaveCustom);
    $("c-clear").addEventListener("click", clearCustomForm);
    $("od-add").addEventListener("click", onAddOAuthExtra);
  });
})();
