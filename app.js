(() => {
  "use strict";

  const STORAGE_KEY = "cornerstore.list.v1";
  const LOCALE = "ca-ES";

  // ---------- Supabase (sincronització al núvol per usuari; localStorage com a alternativa) ----------
  const SUPABASE_URL = "https://cvwrkfpbhbexahfvqtfr.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2d3JrZnBiaGJleGFoZnZxdGZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4ODg1NDMsImV4cCI6MjEwNDQ2NDU0M30.agQThRg6tFOH-uZX5uVAodW-zpo7kpus4hHO3YAOBxQ";
  const TABLE = "shopping_items"; // Taula nova dedicada.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ALL_CATS = "Tot";
  const DEFAULT_CAT = "Altres";

  let sb = null;          // Client de Supabase (null si la llibreria no carrega / sense connexió)
  let sbUser = null;      // usuari amb sessió iniciada
  let cloudReady = false; // true després de la primera baixada correcta
  let realtimeChannel = null;

  function sbClient() {
    if (sb) return sb;
    try {
      if (typeof window.supabase === "undefined") return null;
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return sb;
    } catch {
      return null;
    }
  }

  const rowToItem = (r) => ({
    id: r.id,
    name: r.name,
    qty: r.qty,
    cat: r.cat,
    done: !!r.done,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  });

  const itemToRow = (it, userId) => {
    const row = {
      user_id: userId,
      name: it.name.slice(0, 80),
      qty: Math.min(99, Math.max(1, Number(it.qty) || 1)),
      cat: (it.cat || DEFAULT_CAT).slice(0, 24),
      done: !!it.done,
    };
    // Només enviem l'id si és un uuid vàlid; si no, la BD en genera un.
    // (Enviar null explícit violaria la clau primària.)
    if (UUID_RE.test(it.id)) row.id = it.id;
    return row;
  };

  function setSyncStatus(text) {
    const el = $("#syncStatus");
    if (el) el.textContent = text;
  }

  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#list");
  const emptyEl = $("#empty");
  const noResultsEl = $("#noResults");
  const form = $("#addForm");
  const nameInput = $("#itemName");
  const qtyInput = $("#itemQty");
  const catInput = $("#itemCat");
  const searchInput = $("#search");
  const chipsEl = $("#catChips");
  const progressLabel = $("#progressLabel");
  const progressPct = $("#progressPct");
  const progressBar = $("#progressBar");
  const footCount = $("#footCount");
  const saveStatus = $("#saveStatus");
  const storageNote = $("#storageNote");

  let items = [];
  let filter = "all"; // all | todo | done
  let activeCat = ALL_CATS;
  let saveTimer = null;

  const uid = () =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));

  // ---------- persistència ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // Llista inicial d'exemple la primera vegada, perquè la persistència es vegi clara.
        items = [
          { id: uid(), name: "Pa de pagès", qty: 1, cat: "Forn", done: false, createdAt: Date.now() - 3000 },
          { id: uid(), name: "Llet d'avena", qty: 2, cat: "Làctics", done: false, createdAt: Date.now() - 2000 },
          { id: uid(), name: "Tomàquets cirerols", qty: 1, cat: "Fruita i verdura", done: true, createdAt: Date.now() - 1000 },
        ];
        save(true);
        return;
      }
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.name === "string") : [];
    } catch {
      items = [];
    }
  }

  function save(immediate = false) {
    const write = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        saveStatus.textContent = "Tots els canvis desats · " + new Date().toLocaleTimeString(LOCALE);
        renderStorageNote();
      } catch (err) {
        saveStatus.textContent = "No s'ha pogut desar — l'emmagatzematge no està disponible o és ple.";
      }
    };
    if (immediate) return write();
    saveStatus.textContent = "Desant…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 250);
  }

  function renderStorageNote() {
    try {
      const bytes = (localStorage.getItem(STORAGE_KEY) || "").length;
      storageNote.textContent = (bytes / 1024).toFixed(1) + " KB al navegador · sobreviu les recàrregues";
    } catch {
      storageNote.textContent = "";
    }
  }

  // ---------- mutacions ----------
  function addItem(name, qty, cat) {
    const it = { id: uid(), name, qty, cat, done: false, createdAt: Date.now() };
    items.unshift(it);
    save();
    render();
    cloudInsert(it);
  }

  function toggle(id) {
    const it = items.find((x) => x.id === id);
    if (it) { it.done = !it.done; save(); render(); cloudUpdate(it); }
  }

  function changeQty(id, delta) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.qty = Math.min(99, Math.max(1, (Number(it.qty) || 1) + delta));
    save(); render(); cloudUpdate(it);
  }

  function removeItem(id) {
    items = items.filter((x) => x.id !== id);
    save(); render(); cloudDelete([id]);
  }

  function rename(id, name) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const clean = name.trim();
    if (!clean) return render(); // reverteix si és buit
    it.name = clean.slice(0, 80);
    save(); render(); cloudUpdate(it);
  }

  // ---------- escriptura al núvol (sense bloqueig; en local és la font de veritat fora de línia) ----------
  async function cloudInsert(it) {
    const client = sbClient();
    if (!client || !sbUser || !cloudReady) return;
    setSyncStatus("Sincronitzant…");
    const row = itemToRow(it, sbUser.id);
    const { data, error } = await client.from(TABLE).insert(row).select("id").single();
    if (error) { setSyncStatus("Fora de línia — es reintentarà amb el pròxim canvi"); return; }
    if (data && data.id && data.id !== it.id) {
      it.id = data.id; // La BD ha generat l'uuid (id local antic) — l'adoptem.
      save(true);
    }
    setSyncStatus("Sincronitzat ✓");
  }

  async function cloudUpdate(it) {
    const client = sbClient();
    if (!client || !sbUser || !cloudReady || !UUID_RE.test(it.id)) return;
    setSyncStatus("Sincronitzant…");
    const { name, qty, cat, done } = itemToRow(it, sbUser.id);
    const { error } = await client.from(TABLE).update({ name, qty, cat, done }).eq("id", it.id);
    setSyncStatus(error ? "Fora de línia — es reintentarà amb el pròxim canvi" : "Sincronitzat ✓");
  }

  async function cloudDelete(ids) {
    const client = sbClient();
    if (!client || !sbUser || !cloudReady) return;
    const uuids = ids.filter((id) => UUID_RE.test(id));
    if (!uuids.length) return;
    setSyncStatus("Sincronitzant…");
    const { error } = await client.from(TABLE).delete().in("id", uuids);
    setSyncStatus(error ? "Fora de línia — es reintentarà amb el pròxim canvi" : "Sincronitzat ✓");
  }

  async function cloudPullAndMerge() {
    const client = sbClient();
    if (!client || !sbUser) return;
    setSyncStatus("Sincronitzant…");
    const { data, error } = await client.from(TABLE).select("id,name,qty,cat,done,created_at").order("created_at", { ascending: false });
    if (error) { setSyncStatus("Sincronització no disponible — només local"); return; }
    const cloudItems = (data || []).map(rowToItem);
    const cloudIds = new Set(cloudItems.map((i) => i.id));
    // Unió: el núvol guanya en cas de conflicte; les files només locals es pugen.
    const localOnly = items.filter((it) => !cloudIds.has(it.id));
    items = [...cloudItems, ...localOnly];
    cloudReady = true;
    save(true);
    render();
    if (localOnly.length) {
      const rows = localOnly.map((it) => itemToRow(it, sbUser.id));
      const { data: ins, error: insErr } = await client.from(TABLE).insert(rows).select("id");
      if (!insErr && ins) {
        ins.forEach((r, i) => { if (localOnly[i]) localOnly[i].id = r.id; });
        save(true);
      }
    }
    setSyncStatus("Sincronitzat ✓");
    subscribeRealtime();
  }

  function subscribeRealtime() {
    const client = sbClient();
    if (!client || !sbUser || realtimeChannel) return;
    // Llista COMPARTIDA: escoltem totes les files, sense filtrar per usuari.
    realtimeChannel = client
      .channel("shopping_items_shared")
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLE },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const id = payload.old && payload.old.id;
            if (id && items.some((i) => i.id === id)) {
              items = items.filter((i) => i.id !== id);
              save(true); render();
            }
          } else if (payload.new) {
            const incoming = rowToItem(payload.new);
            const idx = items.findIndex((i) => i.id === incoming.id);
            if (idx >= 0) items[idx] = incoming;
            else items.unshift(incoming);
            save(true); render();
          }
        })
      .subscribe();
  }

  function teardownRealtime() {
    if (realtimeChannel && sbClient()) sbClient().removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  // ---------- autenticació ----------
  function renderAuth() {
    const out = $("#authOut"), inn = $("#authIn");
    if (!out || !inn) return;
    const signedIn = !!sbUser;
    out.hidden = signedIn;
    inn.hidden = !signedIn;
    if (signedIn) $("#authUserEmail").textContent = sbUser.email || "sessió iniciada";
    const link = $("#authLink");
    if (link) link.textContent = signedIn ? "Sincronitzat ✓" : "Inicia sessió";
  }

  async function initAuth() {
    const client = sbClient();
    renderAuth();
    if (!client) return; // CDN de Supabase inabastable — mode només local.
    const { data } = await client.auth.getSession();
    sbUser = (data && data.session && data.session.user) || null;
    renderAuth();
    if (sbUser) await cloudPullAndMerge();

    client.auth.onAuthStateChange(async (event, session) => {
      const next = (session && session.user) || null;
      const changed = (next && next.id) !== (sbUser && sbUser.id);
      sbUser = next;
      renderAuth();
      if (sbUser && changed) {
        cloudReady = false;
        teardownRealtime();
        const dlg = $("#authDialog");
        if (dlg && dlg.open) dlg.close();
        await cloudPullAndMerge();
      } else if (!sbUser) {
        cloudReady = false;
        teardownRealtime();
        setSyncStatus("Només local");
      }
    });
  }

  function visibleItems() {
    const q = searchInput.value.trim().toLowerCase();
    return items.filter((it) => {
      if (filter === "todo" && it.done) return false;
      if (filter === "done" && !it.done) return false;
      if (activeCat !== ALL_CATS && it.cat !== activeCat) return false;
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ---------- render ----------
  function render() {
    const vis = visibleItems();
    const cats = [ALL_CATS, ...new Set(items.map((i) => i.cat).filter(Boolean))];

    chipsEl.innerHTML = cats.map((c) =>
      `<button class="chip${c === activeCat ? " is-active" : ""}" data-cat="${esc(c)}" type="button">${esc(c)}</button>`
    ).join("");

    listEl.innerHTML = vis.map((it) => `
      <li class="item${it.done ? " done" : ""}" data-id="${esc(it.id)}">
        <button class="check" data-act="toggle" aria-label="${it.done ? "Marca com a per comprar" : "Marca com a al cistell"}" title="Commuta">${it.done ? "✓" : ""}</button>
        <div class="item-body">
          <button class="item-name" data-act="rename" title="Fes clic per reanomenar">${esc(it.name)}${it.done ? '<span class="stamp">AL CISTELL</span>' : ""}</button>
          <div class="item-meta">${esc(it.cat || DEFAULT_CAT)} · afegit el ${new Date(it.createdAt).toLocaleDateString(LOCALE)}</div>
        </div>
        <div class="item-tools">
          <span class="stepper">
            <button data-act="dec" aria-label="Redueix la quantitat">−</button>
            <span aria-label="Quantitat">×${Number(it.qty) || 1}</span>
            <button data-act="inc" aria-label="Augmenta la quantitat">+</button>
          </span>
          <button class="icon-btn" data-act="del" aria-label="Elimina ${esc(it.name)}" title="Elimina">🗑</button>
        </div>
      </li>
    `).join("");

    emptyEl.hidden = items.length !== 0;
    noResultsEl.hidden = !(items.length !== 0 && vis.length === 0);

    const done = items.filter((i) => i.done).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    progressLabel.textContent = `${done} de ${items.length} al cistell`;
    progressPct.textContent = pct + "%";
    progressBar.style.width = pct + "%";
    footCount.textContent = `${items.length} ${items.length === 1 ? "article" : "articles"} · ${done} marcat${done === 1 ? "" : "s"}`;

    $("#receiptDate").textContent = new Date().toLocaleDateString(LOCALE, {
      year: "numeric", month: "short", day: "numeric",
    });
  }

  // ---------- esdeveniments ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    addItem(name.slice(0, 80), Math.min(99, Math.max(1, Number(qtyInput.value) || 1)), catInput.value);
    nameInput.value = "";
    qtyInput.value = "1";
    nameInput.focus();
  });

  $("#qtyMinus").addEventListener("click", () => {
    qtyInput.value = Math.max(1, (Number(qtyInput.value) || 1) - 1);
  });
  $("#qtyPlus").addEventListener("click", () => {
    qtyInput.value = Math.min(99, (Number(qtyInput.value) || 1) + 1);
  });

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const li = e.target.closest(".item");
    if (!li) return;
    const id = li.dataset.id;
    const act = btn.dataset.act;
    if (act === "toggle") toggle(id);
    else if (act === "inc") changeQty(id, 1);
    else if (act === "dec") changeQty(id, -1);
    else if (act === "del") removeItem(id);
    else if (act === "rename") {
      const it = items.find((x) => x.id === id);
      const next = prompt("Reanomena l'article:", it ? it.name : "");
      if (next !== null) rename(id, next);
    }
  });

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("is-active"));
      t.classList.add("is-active");
      filter = t.dataset.filter;
      render();
    })
  );

  chipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cat]");
    if (!chip) return;
    activeCat = chip.dataset.cat;
    render();
  });

  searchInput.addEventListener("input", render);

  $("#clearDone").addEventListener("click", () => {
    if (!items.some((i) => i.done)) return;
    if (!confirm("Vols eliminar tot el que està marcat? S'esborrarà per a tothom.")) return;
    const ids = items.filter((i) => i.done).map((i) => i.id);
    items = items.filter((i) => !i.done);
    save(); render(); cloudDelete(ids);
  });

  $("#clearAll").addEventListener("click", () => {
    if (!items.length) return;
    if (!confirm("Vols buidar la llista compartida? S'esborrarà per a tothom.")) return;
    const ids = items.map((i) => i.id);
    items = [];
    save(); render(); cloudDelete(ids);
  });

  $("#exportBtn").addEventListener("click", () => {
    const text = items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.name} x${i.qty} (${i.cat})`).join("\n") || "La llista és buida.";
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "llista-compra.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $("#printBtn").addEventListener("click", () => window.print());

  // Manté les pestanyes sincronitzades si el lloc és obert en un altre lloc.
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) { load(); render(); }
  });

  const authDialog = $("#authDialog");
  const authLink = $("#authLink");
  if (authLink) authLink.addEventListener("click", () => {
    if (!authDialog) return;
    if (typeof authDialog.showModal === "function") authDialog.showModal();
  });

  async function sendLoginLink() {
    const client = sbClient();
    if (!client) { $("#authNote").textContent = "No s'ha pogut contactar amb el servei d'accés — comprova la connexió."; return; }
    const email = $("#authEmail").value.trim();
    if (!email) { $("#authEmail").focus(); return; }
    $("#authNote").textContent = "Enviant l'enllaç d'accés…";
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.href.split("#")[0] },
    });
    $("#authNote").textContent = error
      ? "L'accés ha fallat: " + error.message
      : "Revisa el correu: t'hem enviat un enllaç d'accés. Obre'l en aquest dispositiu.";
  }

  const authSend = $("#authSend");
  if (authSend) authSend.addEventListener("click", sendLoginLink);
  const authEmail = $("#authEmail");
  if (authEmail) authEmail.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendLoginLink(); }
  });

  const signOutBtn = $("#signOut");
  if (signOutBtn) signOutBtn.addEventListener("click", async () => {
    const client = sbClient();
    if (client) await client.auth.signOut();
    sbUser = null;
    cloudReady = false;
    teardownRealtime();
    renderAuth();
  });

  load();
  render();
  renderStorageNote();
  renderAuth();
  initAuth();
})();
