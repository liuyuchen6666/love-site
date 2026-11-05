(function () {
  const C = window.LOVE_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const colors = ["#6b2232", "#b39158", "#8c5a5f", "#4a5560", "#a07a6a", "#7a6a58"];
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => new Date().toLocaleDateString("sv-SE");
  const parseDate = (s) => new Date(String(s).replace("T", " ").replace(/-/g, "/"));

  function toast(text, ms = 2200) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), ms);
  }
  const fail = (e) => {
    console.error(e);
    toast("出错了：" + (e && e.message ? e.message : e), 4000);
  };

  // ---------- 图片压缩 ----------
  function compress(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv);
      };
      img.onerror = () => reject(new Error("图片读取失败"));
      img.src = url;
    });
  }

  // ---------- 本地存储（不配置云端时使用） ----------
  const idb = {
    conn: null,
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("love_site", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("items", { keyPath: "id" });
        req.onsuccess = () => resolve((this.conn = req.result));
        req.onerror = () => reject(req.error);
      });
    },
    tx(mode, fn) {
      return new Promise((resolve, reject) => {
        const t = this.conn.transaction("items", mode);
        const r = fn(t.objectStore("items"));
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
      });
    },
  };
  const LS_MSG = "love_site_messages";
  const LS_SET = "love_site_settings";
  const LS_NOTE = "love_site_notes";
  const lsGet = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
  const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const localStore = {
    mode: "local",
    init: () => idb.open(),
    canEdit: () => true,
    listItems: () => idb.tx("readonly", (s) => s.getAll()),
    saveItem: (item) => idb.tx("readwrite", (s) => s.put(item)),
    deleteItem: (item) => idb.tx("readwrite", (s) => s.delete(item.id)),
    async uploadImage(file, max, quality = 0.82) {
      return { src: (await compress(file, max)).toDataURL("image/jpeg", quality) };
    },
    async uploadFile() {
      throw new Error("本地模式不支持上传音乐，需要先配置云端");
    },
    async listMessages() {
      const list = lsGet(LS_MSG, []).map((m) => (m.id ? m : { ...m, id: newId() }));
      lsSet(LS_MSG, list);
      return list;
    },
    async addMessage(m) {
      lsSet(LS_MSG, [{ ...m, id: newId(), time: new Date().toLocaleString("zh-CN") }, ...lsGet(LS_MSG, [])]);
    },
    async deleteMessage(id) {
      lsSet(LS_MSG, lsGet(LS_MSG, []).filter((m) => m.id !== id));
    },
    getSettings: async () => lsGet(LS_SET, {}),
    saveSettings: async (s) => lsSet(LS_SET, s),
    listNotes: async () => lsGet(LS_NOTE, []),
    async addNote(n) {
      lsSet(LS_NOTE, [{ ...n, id: newId(), created_at: new Date().toISOString() }, ...lsGet(LS_NOTE, [])]);
    },
    async deleteNote(id) {
      lsSet(LS_NOTE, lsGet(LS_NOTE, []).filter((n) => n.id !== id));
    },
  };

  // ---------- 云端存储（Supabase） ----------
  function cloudStore(sb) {
    let session = null;
    const check = ({ data, error }) => {
      if (error) throw error;
      return data;
    };
    return {
      mode: "cloud",
      async init() {
        session = check(await sb.auth.getSession()).session;
        sb.auth.onAuthStateChange((_e, s) => (session = s));
      },
      canEdit: () => !!session,
      async login(email, password) {
        session = check(await sb.auth.signInWithPassword({ email, password })).session;
      },
      async logout() {
        await sb.auth.signOut();
        session = null;
      },
      async listItems() {
        const rows = check(await sb.from("items").select("*").order("created_at"));
        return rows.map((r) => ({ ...r.payload, id: r.id, type: r.type }));
      },
      async saveItem(item) {
        const { id, type, ...payload } = item;
        check(await sb.from("items").upsert({ id, type, payload }));
      },
      async deleteItem(item) {
        check(await sb.from("items").delete().eq("id", item.id));
        const files = [item, ...(item.photos || [])].flatMap((f) => [f.path, f.thumbPath]).filter(Boolean);
        if (files.length) await sb.storage.from("photos").remove(files);
      },
      async uploadFile(file) {
        const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
        const path = `${today()}/${newId()}.${ext}`;
        check(await sb.storage.from("photos").upload(path, file, { contentType: file.type || "application/octet-stream", cacheControl: "31536000" }));
        return { src: sb.storage.from("photos").getPublicUrl(path).data.publicUrl, path };
      },
      async uploadImage(file, max, quality = 0.82) {
        const cv = await compress(file, max);
        const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", quality));
        const path = `${today()}/${newId()}.jpg`;
        check(await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" }));
        return { src: sb.storage.from("photos").getPublicUrl(path).data.publicUrl, path };
      },
      async listMessages() {
        const rows = check(await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(300));
        return rows.map((m) => ({ id: m.id, name: m.name, text: m.text, time: new Date(m.created_at).toLocaleString("zh-CN") }));
      },
      async addMessage(m) {
        check(await sb.from("messages").insert({ name: m.name, text: m.text }));
      },
      async deleteMessage(id) {
        check(await sb.from("messages").delete().eq("id", id));
      },
      async getSettings() {
        const rows = check(await sb.from("settings").select("value").eq("key", "site"));
        return (rows[0] && rows[0].value) || {};
      },
      async saveSettings(s) {
        check(await sb.from("settings").upsert({ key: "site", value: s }));
      },
      async listNotes() {
        return check(await sb.from("notes").select("*").order("created_at", { ascending: false }).limit(500));
      },
      async addNote(n) {
        check(await sb.from("notes").insert({ who: n.who, text: n.text }));
      },
      async deleteNote(id) {
        check(await sb.from("notes").delete().eq("id", id));
      },
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function createStore() {
    const cfg = C.supabase || {};
    if (!cfg.url || !cfg.anonKey) return localStore;
    for (const src of [
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
      "https://unpkg.com/@supabase/supabase-js@2",
    ]) {
      try {
        await loadScript(src);
        if (window.supabase) return cloudStore(window.supabase.createClient(cfg.url, cfg.anonKey));
      } catch (e) {}
    }
    toast("云服务加载失败，暂时使用本地模式", 4000);
    return localStore;
  }

  // ---------- 状态 ----------
  let store = localStore;
  let settings = {};
  let items = [];
  let messages = [];
  let dataLoaded = false;
  const byType = (type) => items.filter((i) => i.type === type);
  const site = () => ({
    startDate: settings.startDate || C.startDate,
    metDate: settings.metDate || C.metDate,
    boyName: settings.boyName || C.boy.name,
    girlName: settings.girlName || C.girl.name,
    boyAvatar: settings.boyAvatar || C.boy.avatar,
    girlAvatar: settings.girlAvatar || C.girl.avatar,
    background: settings.background || C.background,
    bgBlur: settings.bgBlur ?? C.bgBlur ?? 6,
    slogan: settings.slogan ?? C.slogan,
    boyBirthday: settings.boyBirthday || "",
    girlBirthday: settings.girlBirthday || "",
    chibiShow: settings.chibiShow ?? true,
    boyChibi: { hair: "short", hairColor: "#2b2422", cloth: "#4a5560", ...settings.boyChibi },
    girlChibi: { hair: "long", hairColor: "#4a2f27", cloth: "#6b2232", ...settings.girlChibi },
  });
  const delBtn = (id, attr = "data-del") => (id ? `<button class="del" ${attr}="${esc(id)}" title="删除">✕</button>` : "");
  const tools = (id) => (id ? `<button class="del edit-btn" data-edit="${esc(id)}" title="修改">✎</button>${delBtn(id)}` : "");
  const EDIT_FIELDS = {
    moment: [["date", "日期（例如 2024-05-20）"], ["text", "内容"]],
    photo: [["caption", "照片描述"], ["place", "地点（可留空，填了会出现在足迹地图上）"], ["date", "拍摄日期（例如 2026-05-17，可留空）"], ["note", "写在照片背面的话（可留空）"]],
    todo: [["title", "清单内容"]],
    plan: [["title", "计划"], ["date", "目标日期（例如 2027-12-01，可留空）"], ["note", "备注（可留空）"]],
    place: [["name", "地点"], ["date", "日期（例如 2026-10-01，可留空）"], ["note", "故事（可留空）"]],
  };

  // ---------- 顶部 & 计时 ----------
  let startTime = Date.now();
  let metTime = null;
  const applyBlur = (px) => ($("heroBg").style.filter = px > 0 ? `blur(${px}px)` : "none");
  function renderHeader() {
    const s = site();
    document.title = C.siteTitle;
    $("siteName").textContent = C.siteTitle;
    $("heroBg").style.backgroundImage = `url("${s.background}")`;
    applyBlur(s.bgBlur);
    $("boyAvatar").src = s.boyAvatar;
    $("boyName").textContent = s.boyName;
    $("girlAvatar").src = s.girlAvatar;
    $("girlName").textContent = s.girlName;
    $("slogan").textContent = s.slogan;
    $("footer").textContent = `${s.boyName} & ${s.girlName} · ${C.footer}`;
    startTime = parseDate(s.startDate).getTime();
    $("since").textContent = `始于 ${String(s.startDate).replace("T", " ").slice(0, 16)}`;
    metTime = s.metDate ? parseDate(s.metDate).getTime() : null;
    $("met").hidden = !s.metDate;
    $("metSince").textContent = s.metDate ? `初见于 ${String(s.metDate).slice(0, 10)}` : "";
    tick();
  }
  function fillCounter(prefix, from) {
    const diff = Math.max(0, Math.floor((Date.now() - from) / 1000));
    $(prefix + "d").textContent = Math.floor(diff / 86400);
    $(prefix + "h").textContent = Math.floor((diff % 86400) / 3600);
    $(prefix + "m").textContent = Math.floor((diff % 3600) / 60);
    $(prefix + "s").textContent = diff % 60;
  }
  function tick() {
    fillCounter("", startTime);
    if (metTime !== null) fillCounter("met", metTime);
  }
  setInterval(tick, 1000);

  // ---------- 点点滴滴 ----------
  function renderMoments() {
    const list = [...C.moments, ...byType("moment")].sort((a, b) => b.date.localeCompare(a.date));
    $("timeline").innerHTML = list
      .map((m) => `<article class="card moment">${tools(m.id)}
          <time>${esc(m.date)}</time>
          <p>${esc(m.text)}</p>
          ${m.image ? `<img src="${esc(m.image)}" data-caption="${esc(m.text)}" loading="lazy" alt="">` : ""}
        </article>`)
      .join("") || `<p class="empty">还没有记录</p>`;
  }

  // ---------- 恋爱清单 ----------
  function renderList() {
    const list = [...C.loveList, ...byType("todo")];
    const done = list.filter((i) => i.done).length;
    $("listProgress").textContent = `${done} / ${list.length}`;
    $("loveList").innerHTML = list
      .map((i) => `<li class="${i.done ? "done" : ""}" ${i.id ? `data-todo="${esc(i.id)}"` : ""}>${esc(i.title)}${tools(i.id)}</li>`)
      .join("");
    requestAnimationFrame(() => ($("listBar").style.width = `${(done / (list.length || 1)) * 100}%`));
  }

  // ---------- 相册 ----------
  // 按拍摄日期排，新的在前；没填日期的用上传那天，同一天再按上传先后
  const photoList = () =>
    byType("photo").slice().sort((a, b) => photoDate(b).localeCompare(photoDate(a)) || (b.created || 0) - (a.created || 0));
  const LS_VIEW = "love_site_album_view";
  let albumView = localStorage.getItem(LS_VIEW) || "polaroid";
  const photoDate = (p) => p.date || (p.created ? ymd(new Date(p.created)) : "");
  // 按 id 算出固定的小角度，拍立得每次打开歪的方向都一样
  const tilt = (id) => {
    let h = 0;
    for (const ch of String(id || "x")) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 7) - 3) * 0.8;
  };
  function renderAlbum() {
    const list = [...photoList(), ...C.album];
    const pol = albumView === "polaroid";
    document.querySelectorAll("#albumViews [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === albumView));
    $("gallery").classList.toggle("polaroid", pol);
    $("gallery").hidden = albumView === "book";
    $("bookWrap").hidden = albumView !== "book";
    if (albumView === "book") return renderBook(list);
    $("gallery").innerHTML = list
      .map((p) => {
        const img = `<img src="${esc(p.thumb || p.src)}" data-full="${esc(p.src)}" data-caption="${esc(p.caption)}" loading="lazy" decoding="async" alt="">`;
        const id = p.id ? `data-id="${esc(p.id)}"` : "";
        if (!pol) return `<figure ${id}>${tools(p.id)}${img}<figcaption>${esc(p.caption)}</figcaption></figure>`;
        return `<figure ${id} class="pol" style="--tilt:${tilt(p.id || p.src)}deg">${tools(p.id)}<div class="pol-inner">
            <div class="pol-front">${img}<figcaption>${esc(p.caption)}</figcaption></div>
            <div class="pol-back"><time>${esc(photoDate(p))}${p.place ? ` · ${esc(p.place)}` : ""}</time><p>${esc(p.note || p.caption || "这一天，我们很好。")}</p><button type="button" class="pol-zoom">看大图</button></div>
          </div></figure>`;
      })
      .join("") || `<p class="empty">还没有照片</p>`;
  }
  $("albumViews").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    albumView = b.dataset.view;
    localStorage.setItem(LS_VIEW, albumView);
    renderAlbum();
  });
  $("gallery").addEventListener("click", (e) => {
    const fig = e.target.closest(".pol");
    if (!fig || e.target.closest(".del") || document.body.classList.contains("editing")) return;
    if (e.target.closest(".pol-zoom")) return openLightbox(fig.querySelector("img"));
    fig.classList.toggle("flipped");
  });

  // ---------- 翻页纪念册 ----------
  let book = null;
  let bookKey = "";
  let bookLib = null;
  function renderBook(list) {
    const s = site();
    const key = JSON.stringify([list.map((p) => [p.id, p.thumb || p.src, p.caption, p.note, p.date, p.place]), s.boyName, s.girlName, s.startDate]);
    if (book && key === bookKey) return;
    bookKey = key;
    if (!list.length) {
      if (book) book.destroy();
      book = null;
      $("bookStage").innerHTML = `<p class="empty">还没有照片，先上传几张吧</p>`;
      $("bookPage").textContent = "";
      return;
    }
    const pages = [
      `<div class="bpage bcover" data-density="hard"><div class="bcover-in"><small>Our Story</small><h3>${esc(s.boyName)} &amp; ${esc(s.girlName)}</h3><span>since ${esc(String(s.startDate).slice(0, 4))}</span></div></div>`,
      ...list.map((p, i) => `<div class="bpage"><div class="bpage-in">
          <img src="${esc(p.thumb || p.src)}" alt="">
          ${p.caption ? `<h4>${esc(p.caption)}</h4>` : ""}
          ${p.note ? `<p>${esc(p.note)}</p>` : ""}
          <time>${esc(photoDate(p))}${p.place ? ` · ${esc(p.place)}` : ""}</time><span class="pno">${i + 1}</span></div></div>`),
    ];
    if (list.length % 2) pages.push(`<div class="bpage"><div class="bpage-in bpage-end"><p>未完待续……</p><small>剩下的故事，我们慢慢写</small></div></div>`);
    pages.push(`<div class="bpage bcover" data-density="hard"><div class="bcover-in"><small>To be continued</small><h3>${esc(C.footer)}</h3></div></div>`);
    const lib = () => loadScript("page-flip.js").catch(() => Promise.reject(new Error("纪念册组件加载失败，刷新再试试")));
    (bookLib || (bookLib = window.St ? Promise.resolve() : lib()))
      .then(() => {
        if (bookKey !== key) return;
        if (book) book.destroy();
        const el = document.createElement("div");
        el.className = "book";
        el.innerHTML = pages.join("");
        $("bookStage").innerHTML = "";
        $("bookStage").appendChild(el);
        book = new St.PageFlip(el, {
          width: 400, height: 540, size: "stretch",
          minWidth: 240, maxWidth: 480, minHeight: 320, maxHeight: 650,
          showCover: true, usePortrait: true, mobileScrollSupport: true,
          maxShadowOpacity: 0.45, flippingTime: 900,
        });
        book.loadFromHTML(el.querySelectorAll(".bpage"));
        const total = pages.length;
        const sync = () => ($("bookPage").textContent = `${book.getCurrentPageIndex() + 1} / ${total}`);
        book.on("flip", sync);
        sync();
      })
      .catch((err) => {
        bookLib = null;
        fail(err);
      });
  }
  $("bookPrev").addEventListener("click", () => book && book.flipPrev());
  $("bookNext").addEventListener("click", () => book && book.flipNext());

  // ---------- 未来计划 ----------
  function planWhen(date) {
    const days = Math.ceil((parseDate(date) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    if (days > 0) return `${date} · 还有 ${days} 天`;
    if (days === 0) return "就是今天";
    return `${date} · 已过去 ${-days} 天`;
  }
  function renderPlans() {
    const list = [...C.plans, ...byType("plan")].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    $("planList").innerHTML = list
      .map((p) => `<div class="card plan ${p.done ? "done" : ""}">${tools(p.id)}
          <h3>${esc(p.title)}</h3>
          ${p.date ? `<div class="when">${planWhen(p.date)}</div>` : ""}
          ${p.note ? `<div class="note">${esc(p.note)}</div>` : ""}
          ${p.id ? `<button class="check edit-only" data-plan="${esc(p.id)}">${p.done ? "取消完成" : "标记完成"}</button>` : ""}
        </div>`)
      .join("") || `<p class="empty">写下你们的第一个约定吧</p>`;
  }

  // ---------- 留言 ----------
  function renderMsgs() {
    $("msgList").innerHTML = messages.length
      ? messages.map((m) => `<div class="card msg">${delBtn(m.id, "data-del-msg")}
          <div class="avatar" style="background:${colors[String(m.name).length % colors.length]}">${esc(String(m.name).slice(0, 1))}</div>
          <div class="body">
            <div class="meta"><b>${esc(m.name)}</b>${esc(m.time)}</div>
            <div class="text">${esc(m.text)}</div>
          </div></div>`).join("")
      : `<p class="empty">还没有人留言，来做第一个送上祝福的人吧</p>`;
  }

  // ---------- 见字如面（私密，只有登录后能读写） ----------
  const LS_NOTE_WHO = "love_site_note_who";
  let notes = null;
  let notesError = "";
  async function loadNotes() {
    notesError = "";
    if (!store.canEdit()) notes = null;
    else {
      try {
        notes = await store.listNotes();
      } catch (err) {
        console.error(err);
        notes = null;
        notesError = /notes|PGRST205|42P01/.test(`${err.code} ${err.message}`) ? "setup" : err.message || "加载失败";
      }
    }
    renderNotes();
  }
  const noteTime = (t) => new Date(t).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  function renderNotes() {
    const s = site();
    const names = { boy: s.boyName, girl: s.girlName };
    const box = $("noteBox");
    $("noteCount").textContent = notes && notes.length ? `${notes.length} 封` : "";
    if (!store.canEdit()) {
      box.innerHTML = `<div class="card note-locked"><svg><use href="#i-letter" /></svg>
        <p>这里的信，只写给彼此看</p><button type="button" data-note-login>登录后拆开</button></div>`;
      return;
    }
    if (notesError === "setup") {
      box.innerHTML = `<p class="empty">这个板块还差一步：需要在 Supabase 的 SQL Editor 里运行一段 SQL 开通</p>`;
      return;
    }
    if (notesError) {
      box.innerHTML = `<p class="empty">加载失败：${esc(notesError)}</p>`;
      return;
    }
    if (!notes) {
      box.innerHTML = `<p class="empty">正在拆信...</p>`;
      return;
    }
    const who = localStorage.getItem(LS_NOTE_WHO) || "boy";
    box.innerHTML = `<form class="card note-form" id="noteForm">
        <textarea id="noteText" maxlength="2000" placeholder="有些话，想慢慢写给你..." required></textarea>
        <div class="note-form-row">
          <label>落款 <select id="noteWho">${["boy", "girl"].map((w) => `<option value="${w}" ${w === who ? "selected" : ""}>${esc(names[w])}</option>`).join("")}</select></label>
          <button type="submit">寄出</button>
        </div>
      </form>
      ${notes.length
        ? notes.map((n) => `<article class="card note ${n.who === "girl" ? "from-girl" : "from-boy"}">${delBtn(String(n.id), "data-del-note")}
            <p class="note-to">致 ${esc(names[n.who === "girl" ? "boy" : "girl"])}：</p>
            <p class="note-text">${esc(n.text)}</p>
            <p class="note-sign">—— ${esc(names[n.who] || "")}<time>${noteTime(n.created_at)}</time></p>
          </article>`).join("")
        : `<p class="empty">第一封信，由谁来写呢</p>`}`;
  }
  $("notes").addEventListener("click", async (e) => {
    if (e.target.closest("[data-note-login]")) return openModal("loginModal");
    const del = e.target.closest("[data-del-note]");
    if (!del) return;
    e.stopPropagation();
    if (!confirm("确定删除这封信吗？")) return;
    try {
      const id = del.dataset.delNote;
      await store.deleteNote(store.mode === "cloud" ? Number(id) : id);
      await loadNotes();
    } catch (err) {
      fail(err);
    }
  });
  $("notes").addEventListener("submit", (e) => {
    if (e.target.id !== "noteForm") return;
    busy(e, async () => {
      const text = $("noteText").value.trim();
      const who = $("noteWho").value;
      if (!text) return toast("写点什么吧");
      localStorage.setItem(LS_NOTE_WHO, who);
      await store.addNote({ who, text });
      await loadNotes();
      toast("信已寄出");
    });
  });

  // ---------- Q 版情侣小人 ----------
  const SKIN = "#ffe4d4";
  const BANGS = "M26 62 Q24 22 60 22 Q96 22 94 62 Q88 44 72 40 Q62 50 44 46 Q34 50 26 62Z";
  const HAIR = {
    short: { front: BANGS },
    long: { back: "M24 60 Q22 22 60 22 Q98 22 96 60 L98 118 Q90 124 82 116 L80 84 L40 84 L38 116 Q30 124 22 118Z", front: BANGS },
    bun: { front: BANGS, extra: '<circle cx="60" cy="20" r="13"/>' },
  };
  function chibiSVG(c, flip, role) {
    const h = HAIR[c.hair] || HAIR.short;
    const body = `
      ${h.back ? `<path d="${h.back}" fill="${c.hairColor}"/>` : ""}
      <rect x="47" y="128" width="10" height="22" rx="5" fill="#3a3135"/>
      <rect x="63" y="128" width="10" height="22" rx="5" fill="#3a3135"/>
      <path d="M40 104 Q60 94 80 104 L86 136 Q60 142 34 136Z" fill="${c.cloth}"/>
      <path d="M42 108 Q30 120 32 130" stroke="${c.cloth}" stroke-width="9" stroke-linecap="round" fill="none"/>
      <circle cx="32" cy="131" r="5" fill="${SKIN}"/>
      <g class="arm-in"><path d="M78 108 Q96 118 114 116" stroke="${c.cloth}" stroke-width="9" stroke-linecap="round" fill="none"/>
      <circle cx="115" cy="116" r="5" fill="${SKIN}"/></g>
      <circle cx="60" cy="64" r="34" fill="${SKIN}"/>
      <g fill="${c.hairColor}"><path d="${h.front}"/>${h.extra || ""}</g>
      <g class="eyes">
        <circle cx="48" cy="68" r="3.8" fill="#2b2422"/><circle cx="72" cy="68" r="3.8" fill="#2b2422"/>
        <circle cx="49.3" cy="66.6" r="1.2" fill="#fff"/><circle cx="73.3" cy="66.6" r="1.2" fill="#fff"/>
      </g>
      <g class="eyes-happy" stroke="#2b2422" stroke-width="2.6" stroke-linecap="round" fill="none">
        <path d="M44 69 Q48 64 52 69"/><path d="M68 69 Q72 64 76 69"/>
      </g>
      <g class="blush" fill="#f3a3a3">
        <ellipse cx="41" cy="78" rx="6" ry="3.5"/><ellipse cx="79" cy="78" rx="6" ry="3.5"/>
      </g>
      <path class="mouth" d="M55 80 Q60 85 65 80" stroke="#8c4a4a" stroke-width="2" stroke-linecap="round" fill="none"/>
      <path class="mouth-kiss" d="M59 78.5 Q64 78 62.5 81 Q61.5 82.2 60 82 Q64 82.6 62.6 85 Q61.6 86.4 59 85.8" stroke="#8c4a4a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    return `<svg viewBox="0 0 120 152" class="chibi-person ${role}" data-role="${role}">${flip ? `<g transform="translate(120 0) scale(-1 1)">${body}</g>` : body}</svg>`;
  }
  function renderChibi() {
    const s = site();
    $("chibi").hidden = !s.chibiShow;
    $("chibiStage").innerHTML = `${chibiSVG(s.boyChibi, false, "boy")}${chibiSVG(s.girlChibi, true, "girl")}
      <svg class="chibi-heart"><use href="#i-heart" /></svg><div class="chibi-fx" id="chibiFx"></div>`;
  }

  // 点人物时说的话；不重复，直到全部说完再重新洗牌
  const POEMS = [
    ["愿我如星君如月，夜夜流光相皎洁。", "范成大《车遥遥篇》"],
    ["玲珑骰子安红豆，入骨相思知不知。", "温庭筠"],
    ["山有木兮木有枝，心悦君兮君不知。", "《越人歌》"],
    ["执子之手，与子偕老。", "《诗经·邶风·击鼓》"],
    ["既见君子，云胡不喜。", "《诗经·郑风·风雨》"],
    ["我见青山多妩媚，料青山见我应如是。", "辛弃疾《贺新郎》"],
    ["两情若是久长时，又岂在朝朝暮暮。", "秦观《鹊桥仙》"],
    ["海上生明月，天涯共此时。", "张九龄《望月怀远》"],
    ["曾经沧海难为水，除却巫山不是云。", "元稹《离思》"],
    ["从前的日色变得慢，车，马，邮件都慢，一生只够爱一个人。", "木心《从前慢》"],
    ["我行过许多地方的桥，看过许多次数的云，喝过许多种类的酒，却只爱过一个正当最好年龄的人。", "沈从文"],
    ["月色与雪色之间，你是第三种绝色。", "余光中《绝色》"],
    ["草在结它的种子，风在摇它的叶子，我们站着，不说话，就十分美好。", "顾城《门前》"],
    ["你是一树一树的花开，是燕在梁间呢喃。", "林徽因《你是人间的四月天》"],
    ["我想和你一起生活，在某个小镇，共享无尽的黄昏和绵绵不绝的钟声。", "茨维塔耶娃"],
    ["斯人若彩虹，遇上方知有。", "《怦然心动》"],
    ["风在吹，月亮在走，我在想你。", ""],
    ["遇见你之后，所有的风都有了方向。", ""],
    ["我把今天的晚霞折好，悄悄放进你的口袋。", ""],
    ["人间烟火，山河远阔，无一是你，无一不是你。", ""],
    ["想和你把日子过成诗，也过成一碗温热的粥。", ""],
    ["晚风很温柔，像你。", ""],
    ["你是我平淡日子里，藏不住的星光。", ""],
    ["愿有岁月可回首，且以深情共白头。", ""],
    ["我携满天星辰以赠你，仍觉星辰不及你。", ""],
    ["余生很长，慢慢走，反正身边都是你。", ""],
  ];
  let poemDeck = [];
  const nextPoem = () => {
    if (!poemDeck.length) poemDeck = POEMS.slice().sort(() => Math.random() - 0.5);
    return poemDeck.pop();
  };
  let bubbleTimer;
  function say(text, from = "", side = "center") {
    const b = $("chibiBubble");
    b.querySelector("p").textContent = text;
    b.querySelector("small").textContent = from ? `—— ${from}` : "";
    b.dataset.side = side;
    b.classList.remove("show");
    void b.offsetWidth;
    b.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => b.classList.remove("show"), Math.max(3500, text.length * 220));
  }
  function spawnHearts(n, xPct, yPx) {
    const fx = $("chibiFx");
    if (!fx) return;
    for (let i = 0; i < n; i++) {
      const h = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      h.setAttribute("class", "fx-heart");
      h.innerHTML = '<use href="#i-heart" />';
      h.style.left = `calc(${xPct}% + ${(Math.random() - 0.5) * 40}px)`;
      h.style.top = `${yPx}px`;
      h.style.animationDelay = `${i * 0.12}s`;
      h.style.setProperty("--dx", `${(Math.random() - 0.5) * 50}px`);
      fx.appendChild(h);
      setTimeout(() => h.remove(), 2200 + i * 120);
    }
  }
  // 从一点向四周炸开一圈小爱心
  function spawnBurst(n, xPct, yPx, dist = 46) {
    const fx = $("chibiFx");
    if (!fx) return;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.3;
      const h = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      h.setAttribute("class", "fx-burst");
      h.innerHTML = '<use href="#i-heart" />';
      h.style.left = `${xPct}%`;
      h.style.top = `${yPx}px`;
      h.style.setProperty("--dx", `${Math.cos(a) * dist * (0.8 + Math.random() * 0.4)}px`);
      h.style.setProperty("--dy", `${Math.sin(a) * dist * 0.75}px`);
      h.style.setProperty("--s", (0.6 + Math.random() * 0.6).toFixed(2));
      fx.appendChild(h);
      setTimeout(() => h.remove(), 1300);
    }
  }
  function spawnPop(text, xPct, yPx) {
    const fx = $("chibiFx");
    if (!fx) return;
    const p = document.createElement("span");
    p.className = "fx-pop";
    p.textContent = text;
    p.style.left = `${xPct}%`;
    p.style.top = `${yPx}px`;
    fx.appendChild(p);
    setTimeout(() => p.remove(), 1500);
  }
  const ACTS = {
    hug: { ms: 2400, line: "抱紧一点，整个冬天就都暖了。", fx: () => spawnHearts(5, 50, 20) },
    kiss: {
      ms: 3200,
      line: "偷偷亲一下，月亮替我们保密。",
      fx: () => {
        setTimeout(() => {
          spawnPop("啵~", 50, 4);
          spawnBurst(7, 50, 48, 38);
        }, 1050);
        setTimeout(() => spawnHearts(3, 50, 20), 1700);
      },
    },
    lift: { ms: 3000, line: "把你举高一点，离星星近一点。", fx: () => setTimeout(() => spawnHearts(4, 42, -40), 700) },
    spin: { ms: 2400, line: "转个圈，晚风都为我们让路。", fx: () => setTimeout(() => spawnHearts(4, 50, 10), 1200) },
    heart: {
      ms: 3400,
      line: "这颗心，只交给你保管。",
      fx: () => {
        setTimeout(() => spawnBurst(10, 50, -6, 58), 900);
        setTimeout(() => spawnBurst(8, 50, -6, 44), 2250);
        setTimeout(() => spawnHearts(4, 50, 0), 2600);
      },
    },
  };
  let actTimer;
  $("chibi").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) {
      const act = ACTS[btn.dataset.act];
      const c = $("chibi");
      delete c.dataset.act;
      void c.offsetWidth;
      c.dataset.act = btn.dataset.act;
      act.fx();
      say(act.line);
      clearTimeout(actTimer);
      actTimer = setTimeout(() => delete c.dataset.act, act.ms);
      return;
    }
    const person = e.target.closest(".chibi-person");
    if (person) {
      const [text, from] = nextPoem();
      say(text, from, person.dataset.role === "boy" ? "left" : "right");
    }
  });

  // ---------- 纪念日 ----------
  const DAY = 86400000;
  // 七夕是农历，按年份写死
  const QIXI = { 2026: "08-19", 2027: "08-08", 2028: "08-26", 2029: "08-16", 2030: "08-05" };
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const ymd = (d) => d.toLocaleDateString("sv-SE");
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  function nextYearly(mmdd, from) {
    const [m, d] = mmdd.split("-").map(Number);
    const dt = new Date(from.getFullYear(), m - 1, d);
    return dt < from ? new Date(from.getFullYear() + 1, m - 1, d) : dt;
  }
  function anniversaries() {
    const s = site();
    const t0 = midnight(new Date());
    const list = [];
    const add = (date, title) => list.push({ date, title, days: Math.round((date - t0) / DAY) });
    const milestones = (from, label) => {
      const passed = Math.round((t0 - from) / DAY);
      if (passed < 0) {
        add(from, `${label}第一天`);
        return -1;
      }
      const hundred = Math.max(100, Math.ceil(passed / 100) * 100);
      add(addDays(from, hundred), `${label} ${hundred} 天`);
      const ann = nextYearly(ymd(from).slice(5), t0);
      const years = ann.getFullYear() - from.getFullYear();
      if (years > 0) add(ann, `${label} ${years} 周年`);
      return passed;
    };
    const together = milestones(midnight(parseDate(s.startDate)), "在一起");
    for (const n of [520, 1314]) if (together <= n) add(addDays(midnight(parseDate(s.startDate)), n), `在一起 ${n} 天`);
    if (s.metDate) milestones(midnight(parseDate(s.metDate)), "相识");
    if (s.boyBirthday) add(nextYearly(s.boyBirthday.slice(5), t0), `${s.boyName} 的生日`);
    if (s.girlBirthday) add(nextYearly(s.girlBirthday.slice(5), t0), `${s.girlName} 的生日`);
    add(nextYearly("02-14", t0), "情人节");
    add(nextYearly("05-20", t0), "520");
    add(nextYearly("12-25", t0), "圣诞节");
    for (const y of [t0.getFullYear(), t0.getFullYear() + 1]) {
      const d = QIXI[y] && parseDate(`${y}-${QIXI[y]}`);
      if (d && d >= t0) { add(d, "七夕"); break; }
    }
    const seen = new Set();
    return list
      .filter((e) => e.days >= 0)
      .sort((a, b) => a.days - b.days)
      .filter((e) => !seen.has(e.title) && seen.add(e.title));
  }
  let celebrated = false;
  function renderAnniv() {
    const list = anniversaries();
    const todays = list.filter((e) => e.days === 0);
    $("annivToday").hidden = !todays.length;
    $("annivToday").textContent = todays.length ? `今天是「${todays.map((e) => e.title).join("」「")}」，纪念日快乐` : "";
    const upcoming = list.filter((e) => e.days > 0);
    $("annivNext").textContent = upcoming[0] ? `下一个：${upcoming[0].title} · 还有 ${upcoming[0].days} 天` : "";
    $("annivList").innerHTML = upcoming
      .slice(0, 6)
      .map((e) => `<li><span class="a-title">${esc(e.title)}</span><span class="a-date">${ymd(e.date)}</span><span class="a-days">还有 <b>${e.days}</b> 天</span></li>`)
      .join("");
    if (todays.length && !celebrated && dataLoaded) {
      celebrated = true;
      setTimeout(() => fireworks(6000), 600);
    }
  }

  $("annivToggle").addEventListener("click", () => {
    const open = $("anniv").classList.toggle("open");
    $("annivToggle").setAttribute("aria-expanded", open);
    $("annivToggle").querySelector(".chev").textContent = open ? "收起" : "展开全部";
  });

  // ---------- 足迹地图 ----------
  let map = null;
  let markers = null;
  let spotLayer = null;
  let pickMarker = null;
  let picked = null;
  let mapFitted = false;
  const pin = (temp) => L.divIcon({ className: temp ? "pin temp" : "pin", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -8] });
  function setPicked(latlng, label) {
    picked = latlng;
    if (pickMarker) pickMarker.setLatLng(latlng);
    else pickMarker = L.marker(latlng, { icon: pin(true) }).addTo(map);
    $("placeHint").textContent = `${label}，位置对的话点“添加足迹”；不对就在地图上点一下正确位置`;
    $("placeSubmit").textContent = "添加足迹";
  }
  function clearPicked() {
    picked = null;
    if (pickMarker) pickMarker.remove();
    pickMarker = null;
    $("placeHint").textContent = "输入地点后点“搜索”，从候选里选一个；也可以直接在地图上点一下";
    $("placeSubmit").textContent = "定位";
  }
  function initMap() {
    if (!window.L) return;
    map = L.map("mapBox", { attributionControl: false, scrollWheelZoom: false, zoomSnap: 0.5 }).setView([34, 108], 4);
    L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
      subdomains: "1234",
      maxZoom: 18,
    }).addTo(map);
    markers = L.layerGroup().addTo(map);
    spotLayer = L.layerGroup().addTo(map);
    map.zoomControl.setPosition("topright");
    const FitAll = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create("button", "map-fit");
        b.type = "button";
        b.title = "看全部";
        b.innerHTML = '<svg><use href="#i-map" /></svg>';
        L.DomEvent.disableClickPropagation(b);
        b.addEventListener("click", fitAll);
        return b;
      },
    });
    new FitAll({ position: "topright" }).addTo(map);
    map.on("zoomend", drawSpots);
    map.on("click", (e) => {
      if (document.body.classList.contains("editing")) setPicked(e.latlng, "已选择位置");
    });
    map.on("popupopen", (e) => {
      e.popup.getElement().querySelectorAll(".place-photo").forEach((img) => img.addEventListener("click", () => openLightbox(img)));
    });
  }
  const placeList = () => byType("place").slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  function placePopup(p) {
    const photos = p.photos || [];
    return `<div class="popup"><b>${esc(p.name)}</b>${p.date ? `<time>${esc(p.date)}</time>` : ""}
      ${p.note ? `<p>${esc(p.note)}</p>` : ""}
      ${photos.length ? `<div class="popup-photos">${photos.map((ph) => `<img class="place-photo" src="${esc(ph.thumb || ph.src)}" data-full="${esc(ph.src)}" data-caption="${esc(p.name)}" alt="">`).join("")}</div>` : ""}</div>`;
  }
  // 国内地图用的是加密坐标（GCJ-02），地点搜索返回的是 GPS 坐标（WGS-84），不换算会偏几百米
  function wgs2gcj(lat, lng) {
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
    const tl = (x, y) => -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
      + ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
      + ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
      + ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
    const tg = (x, y) => 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
      + ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
      + ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
      + ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    const rad = (lat / 180) * Math.PI;
    let magic = Math.sin(rad);
    magic = 1 - ee * magic * magic;
    const sq = Math.sqrt(magic);
    const dLat = (tl(lng - 105, lat - 35) * 180) / (((a * (1 - ee)) / (magic * sq)) * Math.PI);
    const dLng = (tg(lng - 105, lat - 35) * 180) / ((a / sq) * Math.cos(rad) * Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }
  // 新保存的带 cs:"gcj" 标记，已经是换算后的；没标记的老照片按 GPS 坐标处理，显示时换算
  const coord = (p) => (p.type === "photo" && !p.cs ? wgs2gcj(p.lat, p.lng) : { lat: p.lat, lng: p.lng });
  // 把相册照片和足迹里的照片按坐标归到一起，同一个地点一个“点”
  function photoSpots() {
    const spots = new Map();
    const put = (lat, lng, title, photo, extra = {}) => {
      const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
      if (!spots.has(k)) spots.set(k, { lat, lng, title, photos: [], placeIds: [], notes: [] });
      const s = spots.get(k);
      if (photo) s.photos.push(photo);
      if (extra.placeId) s.placeIds.push(extra.placeId);
      if (extra.note) s.notes.push(extra.note);
    };
    for (const p of photoList()) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) put(coord(p).lat, coord(p).lng, p.place, { thumb: p.thumb || p.src, src: p.src, caption: p.caption, date: photoDate(p) });
    }
    for (const pl of placeList()) {
      const photos = pl.photos || [];
      if (!photos.length) continue;
      photos.forEach((ph, i) => put(pl.lat, pl.lng, pl.name, { thumb: ph.thumb || ph.src, src: ph.src, caption: "", date: pl.date || "" }, i ? {} : { placeId: pl.id, note: pl.note }));
    }
    return [...spots.values()];
  }
  function spotPopup(s) {
    return `<div class="popup spot-popup"><b>${esc(s.title)}</b>
      ${s.notes.filter(Boolean).map((n) => `<p>${esc(n)}</p>`).join("")}
      <div class="spot-list">${s.photos.map((p) => `<figure>
        <img class="place-photo" src="${esc(p.thumb)}" data-full="${esc(p.src)}" data-caption="${esc(p.caption || s.title)}" alt="">
        <figcaption>${p.caption ? `<span>${esc(p.caption)}</span>` : "<span></span>"}<time>${esc(p.date)}</time></figcaption>
      </figure>`).join("")}</div></div>`;
  }
  // 照片缩略图标记：白边圆角 + 小尖角，左下角是张数；多个地点合并时后面叠一层
  const photoPin = (thumb, n, stacked) => L.divIcon({
    className: "photo-pin",
    html: `<div class="pp ${stacked ? "stack" : ""}"><img src="${esc(thumb)}" alt="">${n > 1 ? `<b>${n}</b>` : ""}<svg class="pp-heart"><use href="#i-heart" /></svg></div>`,
    iconSize: [56, 64], iconAnchor: [28, 64], popupAnchor: [0, -62],
  });
  let spotCache = [];
  // 按当前缩放级别，把屏幕上挨得太近的点合成一个
  function drawSpots() {
    if (!map) return;
    spotLayer.clearLayers();
    const z = map.getZoom();
    const groups = [];
    for (const s of spotCache) {
      const pt = map.project([s.lat, s.lng], z);
      const g = groups.find((c) => c.pt.distanceTo(pt) < 60);
      if (g) g.spots.push(s);
      else groups.push({ pt, spots: [s] });
    }
    for (const g of groups) {
      const first = g.spots[0];
      const total = g.spots.reduce((n, s) => n + s.photos.length, 0);
      const stacked = g.spots.length > 1;
      const m = L.marker([first.lat, first.lng], { icon: photoPin(first.photos[0].thumb, total, stacked), riseOnHover: true });
      m.placeIds = g.spots.flatMap((s) => s.placeIds);
      if (stacked) {
        m.on("click", () => map.flyToBounds(L.latLngBounds(g.spots.map((s) => [s.lat, s.lng])).pad(0.6), { maxZoom: Math.min(18, z + 4), duration: 0.7 }));
      } else {
        m.bindPopup(spotPopup(first), { maxWidth: 240, minWidth: 200, className: "spot" });
        m.on("mouseover", () => m.openPopup());
      }
      spotLayer.addLayer(m);
    }
  }
  // ---------- 地点搜索：输入后点“搜索”，从候选里选 ----------
  // Nominatim 不允许边打字边查，所以打字时只提示去过的地方，点搜索才联网
  function knownPlaces() {
    const seen = new Set();
    const out = [];
    for (const [name, lat, lng] of [
      ...byType("place").map((p) => [p.name, p.lat, p.lng]),
      ...byType("photo").map((p) => [p.place, coord(p).lat, coord(p).lng]),
    ]) {
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, addr: "去过的地方", lat, lng });
    }
    return out;
  }
  const AMAP_KEY = (C.amapKey || "").trim();
  async function fetchJSON(url, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  // 高德：中文地名最准，返回的就是 GCJ-02，不用转换（需要在 config.js 填 amapKey）
  async function searchAmap(q) {
    const d = await fetchJSON(`https://restapi.amap.com/v3/place/text?key=${encodeURIComponent(AMAP_KEY)}&keywords=${encodeURIComponent(q)}&offset=8&page=1&extensions=base`);
    if (d.status !== "1") throw new Error(d.info || "amap error");
    const str = (v) => (typeof v === "string" ? v : "");
    return (d.pois || [])
      .map((x) => {
        const [lng, lat] = str(x.location).split(",").map(Number);
        const addr = [...new Set([x.pname, x.cityname, x.adname, x.address].map(str).filter(Boolean))].join(" ");
        return { name: x.name, addr, lat, lng };
      })
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  }
  // OpenStreetMap：免费无需注册，但国内网络时好时坏，中文小地点也不全
  async function searchNominatim(q) {
    const d = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=zh-CN&q=${encodeURIComponent(q)}`);
    return d.map((x) => {
      const parts = x.display_name.split(",").map((s) => s.trim());
      return {
        name: x.name || parts[0],
        addr: parts.slice(1).filter((s) => !/^\d+$/.test(s)).reverse().join(" "),
        ...wgs2gcj(Number(x.lat), Number(x.lon)),
      };
    });
  }
  // 返回 { list, failed }：failed = 所有搜索服务都没连上（和“连上了但没有结果”区分开）
  async function searchPlaces(q) {
    const jobs = [searchNominatim(q)];
    if (AMAP_KEY) jobs.unshift(searchAmap(q));
    const res = await Promise.allSettled(jobs);
    const list = [];
    for (const c of res.flatMap((r) => (r.status === "fulfilled" ? r.value : []))) {
      if (!list.some((o) => Math.abs(o.lat - c.lat) < 0.004 && Math.abs(o.lng - c.lng) < 0.004)) list.push(c);
    }
    return { list, failed: res.every((r) => r.status === "rejected") };
  }
  const NOT_FOUND = "没搜到这个地点。试试加上城市名（如“杭州 西湖”），或者直接在地图上选";
  const OFFLINE = "搜索服务暂时连不上（网络问题）。可以直接在地图上选位置";
  const PIN_ROW = `<li class="pick-pin" data-pin><b>📍 在地图上手动选点</b><small>搜不到时，自己点一下地图</small></li>`;

  // ---------- 手动选点：弹出一张小地图，点一下就行 ----------
  let pinMap = null;
  let pinMarker = null;
  function pinOnMap(name) {
    return new Promise((resolve) => {
      if (!window.L) {
        toast("地图没加载出来，刷新页面再试试");
        return resolve(null);
      }
      const modal = $("pinModal");
      const ok = $("pinOk");
      let at = null;
      const done = (v) => {
        ok.onclick = modal.onclick = null;
        closeModal("pinModal");
        resolve(v);
      };
      $("pinTitle").textContent = name ? `“${name}”在哪里？` : "在地图上选位置";
      $("pinTip").textContent = "点一下地图，放下标记（可以拖动、缩放找位置）";
      ok.disabled = true;
      openModal("pinModal");
      setTimeout(() => {
        if (!pinMap) {
          pinMap = L.map("pinMap", { attributionControl: false, zoomSnap: 0.5 });
          L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", { subdomains: "1234", maxZoom: 18 }).addTo(pinMap);
          pinMap.on("click", (e) => {
            at = e.latlng;
            if (pinMarker) pinMarker.setLatLng(at);
            else pinMarker = L.marker(at, { icon: pin(true) }).addTo(pinMap);
            ok.disabled = false;
            $("pinTip").textContent = "位置对吗？不对再点一下别处";
          });
        }
        pinMap.invalidateSize();
        if (pinMarker) {
          pinMap.removeLayer(pinMarker);
          pinMarker = null;
        }
        const k = knownPlaces()[0];
        const c = map ? map.getCenter() : null;
        pinMap.setView(k ? [k.lat, k.lng] : c ? [c.lat, c.lng] : [34, 108], k ? 10 : map ? map.getZoom() : 4);
      }, 60);
      ok.onclick = () => at && done({ name: name || "我们去过的地方", addr: "手动选点", lat: at.lat, lng: at.lng });
      modal.onclick = (e) => (e.target === modal || e.target.hasAttribute("data-close")) && done(null);
    });
  }
  const optionHTML = (list) => list.map((c, i) => `<li data-i="${i}"><b>${esc(c.name)}</b><small>${esc(c.addr)}</small></li>`).join("");
  function attachPicker(box, onPick) {
    const input = box.querySelector("input");
    const ul = box.querySelector(".pick-list");
    let options = [];
    const show = (list, note = "", withPin = false) => {
      options = list;
      ul.innerHTML = (list.length ? optionHTML(list) : note ? `<li class="pick-empty">${note}</li>` : "") + (withPin ? PIN_ROW : "");
      ul.hidden = !list.length && !note && !withPin;
    };
    const search = async () => {
      const q = input.value.trim();
      if (!q) return toast("先输入地点");
      show([], "正在搜索...");
      const { list, failed } = await searchPlaces(q);
      const known = knownPlaces().filter((k) => k.name.includes(q));
      const all = [...known, ...list];
      show(all, all.length ? "" : failed ? OFFLINE : NOT_FOUND, true);
      if (failed && all.length) toast("搜索服务没连上，只显示去过的地方", 3000);
    };
    input.addEventListener("input", () => {
      onPick(null);
      const q = input.value.trim();
      show(q ? knownPlaces().filter((k) => k.name.includes(q)).slice(0, 5) : []);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      search();
    });
    box.querySelector(".pick-search").addEventListener("click", search);
    ul.addEventListener("click", async (e) => {
      if (e.target.closest("[data-pin]")) {
        const c = await pinOnMap(input.value.trim());
        if (c) {
          input.value = c.name;
          show([]);
          onPick(c);
        }
        return;
      }
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      const c = options[li.dataset.i];
      input.value = c.name;
      show([]);
      onPick(c);
    });
    document.addEventListener("click", (e) => !box.contains(e.target) && show([]));
    return { reset: () => (show([]), onPick(null)) };
  }
  // 没从下拉框里选时，弹窗让人确认是哪一个
  function chooseLocation(name) {
    return new Promise((resolve) => {
      const list = $("placeOptions");
      const modal = $("placeModal");
      let options = [];
      const done = (v) => {
        list.onclick = modal.onclick = null;
        closeModal("placeModal");
        resolve(v);
      };
      list.onclick = async (e) => {
        if (e.target.closest("[data-pin]")) {
          const c = await pinOnMap(name);
          if (c) done(c);
          return;
        }
        const li = e.target.closest("li[data-i]");
        if (li) done(options[li.dataset.i]);
      };
      modal.onclick = (e) => (e.target === modal || e.target.hasAttribute("data-close")) && done(null);
      $("placeModalTitle").textContent = `“${name}”是哪里？`;
      list.innerHTML = `<li class="pick-empty">正在搜索...</li>`;
      openModal("placeModal");
      searchPlaces(name).then(({ list: found, failed }) => {
        options = [...knownPlaces().filter((k) => k.name.includes(name)), ...found];
        list.innerHTML = (options.length ? optionHTML(options) : `<li class="pick-empty">${failed ? OFFLINE : NOT_FOUND}</li>`) + PIN_ROW;
      });
    });
  }
  // 填过的同名地点直接用原来的坐标，保证同一个地方落在同一处
  const locate = async (name) => knownPlaces().find((k) => k.name === name) || chooseLocation(name);
  function renderPlaces() {
    const list = placeList();
    const spots = photoSpots();
    $("placeCount").textContent = list.length ? `一起去过 ${list.length} 个地方` : "";
    $("placeList").innerHTML = list
      .map((p) => `<li class="card place" data-place="${esc(p.id)}">${tools(p.id)}<b>${esc(p.name)}</b><span>${esc(p.date || "")}</span></li>`)
      .join("") || `<p class="empty">${spots.length ? "照片都已经落在地图上啦" : "还没有足迹，一起出发吧"}</p>`;
    if (!map) return;
    markers.clearLayers();
    list.forEach((p) => {
      if ((p.photos || []).length) return;
      const m = L.marker([p.lat, p.lng], { icon: pin() }).bindPopup(placePopup(p), { maxWidth: 260 });
      m.placeIds = [p.id];
      markers.addLayer(m);
    });
    spotCache = spots;
    drawSpots();
    const pts = [...list, ...spots].map((p) => [p.lat, p.lng]);
    if (pts.length && !mapFitted && dataLoaded) {
      mapFitted = true;
      map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 12 });
    }
  }
  function fitAll() {
    const pts = [...placeList(), ...spotCache].map((p) => [p.lat, p.lng]);
    if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 12, duration: 0.8 });
  }
  function focusPlace(id) {
    const p = byType("place").find((x) => x.id === id);
    if (!p || !map) return;
    $("mapBox").scrollIntoView({ behavior: "smooth", block: "center" });
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
    map.once("moveend", () => {
      const m = [...markers.getLayers(), ...spotLayer.getLayers()].find((l) => (l.placeIds || []).includes(id));
      if (m && m.getPopup()) m.openPopup();
    });
  }
  // ---------- 背景音乐 ----------
  const bgm = $("bgm");
  // 浏览器禁止有声音的自动播放，所以在访客第一次点页面时开始播放
  let autoStart = true;
  function renderMusic() {
    const m = settings.music;
    $("musicBtn").hidden = !m;
    if (m && bgm.dataset.src !== m.src) {
      bgm.src = m.src;
      bgm.dataset.src = m.src;
    }
    if (!m && bgm.dataset.src) {
      bgm.pause();
      bgm.removeAttribute("src");
      delete bgm.dataset.src;
    }
  }
  const syncMusicBtn = () => $("musicBtn").classList.toggle("playing", !bgm.paused);
  bgm.addEventListener("play", syncMusicBtn);
  bgm.addEventListener("pause", syncMusicBtn);
  $("musicBtn").addEventListener("click", () => {
    autoStart = false;
    if (bgm.paused) bgm.play().catch(fail);
    else bgm.pause();
  });
  addEventListener("pointerdown", (e) => {
    if (!autoStart || !settings.music || e.target.closest("#musicBtn, .modal, .edit-bar")) return;
    autoStart = false;
    bgm.play().catch(() => {});
  });

  // ---------- 我们的故事：文字、照片、足迹合成一条时间线 ----------
  let storyDesc = true;
  let storyInit = false;
  const storyOpen = new Set();
  function storyGroups() {
    const s = site();
    const m = new Map();
    const g = (d) => {
      if (!m.has(d)) m.set(d, { marks: [], moments: [], photos: [], places: [] });
      return m.get(d);
    };
    if (s.metDate) g(String(s.metDate).slice(0, 10)).marks.push("我们第一次见面");
    if (s.startDate) g(String(s.startDate).slice(0, 10)).marks.push("我们在一起了");
    [...C.moments, ...byType("moment")].forEach((x) => x.date && g(x.date).moments.push(x));
    photoList().forEach((p) => photoDate(p) && g(photoDate(p)).photos.push(p));
    placeList().forEach((p) => p.date && g(p.date).places.push(p));
    return m;
  }
  function storyNode(date, d) {
    const photos = d.photos.slice(0, 6);
    const names = [...new Set(d.photos.map((p) => p.place).filter(Boolean))];
    const chips = [
      ...d.places.map((p) => `<span class="chip" data-place="${esc(p.id)}"><svg><use href="#i-map" /></svg>${esc(p.name)}</span>`),
      ...names.filter((n) => !d.places.some((p) => p.name === n)).map((n) => `<span class="chip"><svg><use href="#i-map" /></svg>${esc(n)}</span>`),
    ];
    const placeNotes = d.places.filter((p) => p.note).map((p) => `<div class="story-text"><p>${esc(p.note)}</p></div>`);
    const placePhotos = d.places.flatMap((p) => (p.photos || []).map((ph) => ({ thumb: ph.thumb || ph.src, src: ph.src, caption: p.name })));
    const pics = [...photos.map((p) => ({ thumb: p.thumb || p.src, src: p.src, caption: p.caption || p.place || "" })), ...placePhotos].slice(0, 6);
    const total = d.photos.length + placePhotos.length;
    return `<article class="story-node ${d.marks.length ? "mark" : ""}">
      <time>${date.replace(/-/g, ".")}</time>
      ${d.marks.map((t) => `<p class="story-mark">${esc(t)}</p>`).join("")}
      ${d.moments.map((x) => `<div class="story-text"><p>${esc(x.text)}</p>${x.image ? `<img src="${esc(x.image)}" data-caption="${esc(x.text)}" loading="lazy" alt="">` : ""}</div>`).join("")}
      ${placeNotes.join("")}
      ${pics.length ? `<div class="story-photos n${Math.min(pics.length, 3)}">${pics.map((p) => `<img src="${esc(p.thumb)}" data-full="${esc(p.src)}" data-caption="${esc(p.caption)}" loading="lazy" decoding="async" alt="">`).join("")}</div>` : ""}
      ${total > pics.length ? `<p class="story-more">一共 ${total} 张，更多在相册里</p>` : ""}
      ${chips.length ? `<div class="story-chips">${chips.join("")}</div>` : ""}
    </article>`;
  }
  function renderStory() {
    const box = $("storyBox");
    if (!dataLoaded) {
      box.innerHTML = `<p class="empty">正在翻开我们的故事...</p>`;
      return;
    }
    const groups = storyGroups();
    let count = 0;
    groups.forEach((d) => (count += d.moments.length + d.photos.length + d.places.length));
    $("storyCount").textContent = count ? `${count} 段回忆` : "";
    const dates = [...groups.keys()].sort();
    if (storyDesc) dates.reverse();
    const years = new Map();
    dates.forEach((d) => {
      const y = d.slice(0, 4);
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(d);
    });
    if (!storyInit && years.size) {
      storyInit = true;
      storyOpen.add([...years.keys()].sort().pop());
    }
    $("storyOrder").textContent = storyDesc ? "最新在前" : "最早在前";
    box.innerHTML = years.size
      ? [...years].map(([y, ds]) => {
          const n = ds.reduce((a, d) => a + groups.get(d).moments.length + groups.get(d).photos.length + groups.get(d).places.length, 0);
          return `<details class="story-year" data-year="${y}" ${storyOpen.has(y) ? "open" : ""}>
            <summary><b>${y}</b><span>${n ? `${n} 段回忆` : "重要的日子"}</span></summary>
            <div class="story-line">${ds.map((d) => storyNode(d, groups.get(d))).join("")}</div></details>`;
        }).join("")
      : `<p class="empty">还没有回忆，传一张照片或者记一笔试试</p>`;
  }
  $("storyBox").addEventListener("toggle", (e) => {
    const y = e.target.dataset && e.target.dataset.year;
    if (!y) return;
    if (e.target.open) storyOpen.add(y);
    else storyOpen.delete(y);
  }, true);
  $("storyOrder").addEventListener("click", () => {
    storyDesc = !storyDesc;
    renderStory();
  });

  // ---------- 放映：全屏、按时间从最早放到现在 ----------
  const showEl = $("show");
  let showSlides = [];
  let showIdx = 0;
  let showTimer = null;
  let showPaused = false;
  let showMusic = false;
  const showOpen = () => showEl.classList.contains("on");
  const preload = (src) => {
    const i = new Image();
    i.src = src;
  };
  function buildSlides() {
    const s = site();
    const photos = photoList().slice().reverse();
    const first = photoDate(photos[0]).replace(/-/g, ".");
    const last = photoDate(photos[photos.length - 1]).replace(/-/g, ".");
    const days = Math.max(0, Math.floor((Date.now() - startTime) / DAY));
    return [
      { type: "title", html: `<small>Our Story</small><h2>${esc(s.boyName)} &amp; ${esc(s.girlName)}</h2><p>${first}${first !== last ? ` — ${last}` : ""}</p>` },
      ...photos.map((p) => ({ type: "photo", p })),
      { type: "end", html: `<small>And still counting</small><h2>我们已经在一起 <b>${days}</b> 天</h2><p>${esc(C.footer)}</p><button type="button" data-replay>再看一遍</button>` },
    ];
  }
  function showSchedule(ms) {
    clearTimeout(showTimer);
    if (showPaused || showIdx >= showSlides.length - 1) return;
    showTimer = setTimeout(() => showGo(showIdx + 1), ms);
  }
  function showGo(i) {
    showIdx = Math.max(0, Math.min(showSlides.length - 1, i));
    const sl = showSlides[showIdx];
    const el = document.createElement("div");
    el.className = `show-slide ${sl.type}`;
    if (sl.type === "photo") {
      const p = sl.p;
      const place = p.place ? ` · ${esc(p.place)}` : "";
      el.innerHTML = `<div class="show-bg" style="background-image:url('${esc(p.thumb || p.src)}')"></div>
        <img src="${esc(p.src)}" alt="">
        <div class="show-cap"><time>${esc(photoDate(p).replace(/-/g, "."))}${place}</time>${p.caption ? `<p>${esc(p.caption)}</p>` : ""}</div>`;
    } else el.innerHTML = `<div class="show-text">${sl.html}</div>`;
    const stage = $("showStage");
    const old = stage.querySelector(".show-slide.on");
    stage.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("on")));
    if (old) {
      old.classList.remove("on");
      setTimeout(() => old.remove(), 1300);
    }
    $("showBar").style.width = `${(showIdx / Math.max(1, showSlides.length - 1)) * 100}%`;
    const next = showSlides[showIdx + 1];
    if (next && next.type === "photo") preload(next.p.src);
    showSchedule(sl.type === "photo" ? 5200 : 3800);
  }
  function openShow() {
    if (!photoList().length) return toast("还没有照片，先传几张再来放映吧");
    showSlides = buildSlides();
    showPaused = false;
    $("showPause").textContent = "❚❚";
    $("showStage").innerHTML = "";
    showEl.classList.add("on");
    showEl.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    if (settings.music && bgm.paused) bgm.play().then(() => (showMusic = true)).catch(() => {});
    if (showEl.requestFullscreen && !standalone) showEl.requestFullscreen().catch(() => {});
    showGo(0);
  }
  function closeShow() {
    clearTimeout(showTimer);
    showEl.classList.remove("on");
    showEl.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (showMusic) bgm.pause();
    showMusic = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  const showToggle = () => {
    showPaused = !showPaused;
    $("showPause").textContent = showPaused ? "▶" : "❚❚";
    showSchedule(1800);
  };
  $("albumShow").addEventListener("click", openShow);
  $("storyShow").addEventListener("click", openShow);
  $("showClose").addEventListener("click", closeShow);
  $("showPrev").addEventListener("click", () => showGo(showIdx - 1));
  $("showNext").addEventListener("click", () => showGo(showIdx + 1));
  $("showPause").addEventListener("click", showToggle);
  showEl.addEventListener("click", (e) => e.target.closest("[data-replay]") && showGo(0));
  addEventListener("keydown", (e) => {
    if (!showOpen()) return;
    if (e.key === "Escape") closeShow();
    else if (e.key === "ArrowRight") showGo(showIdx + 1);
    else if (e.key === "ArrowLeft") showGo(showIdx - 1);
    else if (e.key === " ") {
      e.preventDefault();
      showToggle();
    }
  });
  let showX = null;
  showEl.addEventListener("touchstart", (e) => (showX = e.touches[0].clientX), { passive: true });
  showEl.addEventListener("touchend", (e) => {
    if (showX === null) return;
    const dx = e.changedTouches[0].clientX - showX;
    showX = null;
    if (Math.abs(dx) > 50) showGo(showIdx + (dx < 0 ? 1 : -1));
  });

  // ---------- 旅程回放：按时间把去过的地方连成路线 ----------
  let tripLayer = null;
  let tripRun = 0;
  let tripState = "idle";
  function tripStops() {
    const ev = [];
    for (const p of photoList()) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !photoDate(p)) continue;
      const c = coord(p);
      ev.push({ date: photoDate(p), created: p.created || 0, lat: c.lat, lng: c.lng, title: p.place, photos: [p.thumb || p.src] });
    }
    for (const pl of placeList()) {
      if (!pl.date || !Number.isFinite(pl.lat) || !Number.isFinite(pl.lng)) continue;
      ev.push({ date: pl.date, created: pl.created || 0, lat: pl.lat, lng: pl.lng, title: pl.name, note: pl.note, photos: (pl.photos || []).map((ph) => ph.thumb || ph.src) });
    }
    ev.sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);
    const stops = [];
    for (const e of ev) {
      const last = stops[stops.length - 1];
      if (last && last.lat.toFixed(3) === e.lat.toFixed(3) && last.lng.toFixed(3) === e.lng.toFixed(3)) {
        last.photos.push(...e.photos);
        last.dateEnd = e.date;
        last.title = last.title || e.title;
        last.note = last.note || e.note;
      } else stops.push({ ...e, dateEnd: e.date });
    }
    return stops;
  }
  // 两站之间画一条弧线，并且一点一点画出来
  function drawArc(a, b, ms) {
    const mid = [(a[0] + b[0]) / 2 - (b[1] - a[1]) * 0.25, (a[1] + b[1]) / 2 + (b[0] - a[0]) * 0.25];
    const pts = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * mid[0] + t * t * b[0], u * u * a[1] + 2 * u * t * mid[1] + t * t * b[1]]);
    }
    const line = L.polyline([], { color: "#6b2232", weight: 3, opacity: 0.85, dashArray: "2 7", lineCap: "round" }).addTo(tripLayer);
    const t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / ms);
      line.setLatLngs(pts.slice(0, Math.max(2, Math.round(k * pts.length))));
      if (k < 1 && tripLayer && tripLayer.hasLayer(line)) requestAnimationFrame(step);
    })(t0);
  }
  const tripBtn = $("tripBtn");
  function tripStop() {
    tripRun++;
    tripState = "idle";
    tripBtn.textContent = "▶ 旅程回放";
    if (!map) return;
    map.closePopup();
    if (tripLayer) map.removeLayer(tripLayer);
    tripLayer = null;
    if (!map.hasLayer(spotLayer)) spotLayer.addTo(map);
  }
  async function tripPlay() {
    if (!map) return toast("地图加载失败，刷新页面再试试");
    const stops = tripStops();
    if (!stops.length) return toast("先上传几张带地点和日期的照片，就能回放旅程啦", 4000);
    tripStop();
    const run = tripRun;
    tripState = "playing";
    tripBtn.textContent = "■ 停止";
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    $("mapBox").scrollIntoView({ behavior: "smooth", block: "center" });
    map.removeLayer(spotLayer);
    tripLayer = L.layerGroup().addTo(map);
    await wait(700);
    let prev = null;
    for (let i = 0; i < stops.length; i++) {
      if (run !== tripRun) return;
      const s = stops[i];
      const cur = [s.lat, s.lng];
      map.flyTo(cur, 12, { duration: i ? 1.6 : 1.2 });
      if (prev) drawArc(prev, cur, 1500);
      await wait(i ? 1800 : 1400);
      if (run !== tripRun) return;
      L.marker(cur, { icon: L.divIcon({ className: "trip-dot", html: `<span>${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 }).addTo(tripLayer);
      const range = s.dateEnd !== s.date ? `${s.date.replace(/-/g, ".")} — ${s.dateEnd.replace(/-/g, ".")}` : s.date.replace(/-/g, ".");
      const shown = s.photos.slice(0, 3);
      L.popup({ className: "spot", autoClose: false, closeOnClick: false, offset: [0, -10] })
        .setLatLng(cur)
        .setContent(`<div class="popup trip-popup"><small>第 ${i + 1} 站 · 共 ${stops.length} 站</small><b>${esc(s.title || "这里")}</b><time>${range}</time>
          ${s.note ? `<p>${esc(s.note)}</p>` : ""}
          ${shown.length ? `<div class="trip-thumbs">${shown.map((src) => `<img src="${esc(src)}" alt="">`).join("")}${s.photos.length > 3 ? `<span>+${s.photos.length - 3}</span>` : ""}</div>` : ""}</div>`)
        .openOn(map);
      prev = cur;
      await wait(3400);
    }
    if (run !== tripRun) return;
    map.closePopup();
    map.flyToBounds(L.latLngBounds(stops.map((s) => [s.lat, s.lng])).pad(0.3), { maxZoom: 12, duration: 1.2 });
    tripState = "done";
    tripBtn.textContent = "清除路线";
    toast(`这一路，我们去过 ${stops.length} 个地方`, 4000);
  }
  tripBtn.addEventListener("click", () => (tripState === "idle" ? tripPlay() : tripStop()));

  function renderAll() {
    renderHeader();
    renderChibi();
    renderAnniv();
    renderPlaces();
    renderMusic();
    renderMoments();
    renderNotes();
    renderStory();
    renderList();
    renderAlbum();
    renderPlans();
    renderMsgs();
  }
  initMap();
  renderAll();

  // ---------- 编辑模式 ----------
  const setEditing = (on) => {
    document.body.classList.toggle("editing", on);
    $("editToggle").textContent = on ? "完成编辑" : "编辑";
    document.querySelectorAll(".pol.flipped").forEach((f) => f.classList.remove("flipped"));
    if (on) backfillThumbs();
  };

  // 给早期上传、还没有缩略图的照片补生成缩略图（需要登录后才能上传）
  const THUMB_SIZE = 600;
  let backfilling = false;
  async function backfillThumbs() {
    const todo = byType("photo").filter((p) => !p.thumb);
    if (backfilling || !todo.length) return;
    backfilling = true;
    try {
      for (let i = 0; i < todo.length; i++) {
        toast(`正在优化相册加载速度 ${i + 1} / ${todo.length}...`, 60000);
        const blob = await (await fetch(todo[i].src)).blob();
        const thumb = await store.uploadImage(blob, THUMB_SIZE, 0.72);
        todo[i].thumb = thumb.src;
        todo[i].thumbPath = thumb.path;
        await store.saveItem(todo[i]);
      }
      renderAlbum();
      toast("相册优化完成");
    } catch (err) {
      fail(err);
    } finally {
      backfilling = false;
    }
  }
  const openModal = (id) => $(id).classList.add("show");
  const closeModal = (id) => $(id).classList.remove("show");
  document.querySelectorAll(".modal").forEach((m) =>
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.hasAttribute("data-close")) m.classList.remove("show");
    })
  );

  if (!C.editable) $("editBar").remove();
  $("editToggle")?.addEventListener("click", () => {
    if (document.body.classList.contains("editing")) return setEditing(false);
    if (!store.canEdit()) return openModal("loginModal");
    setEditing(true);
  });

  $("loginForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      await store.login($("loginEmail").value.trim(), $("loginPassword").value);
      closeModal("loginModal");
      $("loginPassword").value = "";
      setEditing(true);
      loadNotes();
      toast("登录成功");
    })
  );
  $("logoutBtn")?.addEventListener("click", async () => {
    await store.logout();
    setEditing(false);
    loadNotes();
    toast("已退出登录");
  });

  // 提交时禁用按钮，防止重复提交
  async function busy(e, fn) {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      btn.disabled = false;
    }
  }
  async function addItem(item) {
    item.created = Date.now();
    await store.saveItem(item);
    items.push(item);
    renderAll();
  }

  $("momentDate").value = today();
  $("momentForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      const text = $("momentText").value.trim();
      if (!text) return toast("写点什么吧");
      const file = $("momentImage").files[0];
      const item = { id: newId(), type: "moment", date: $("momentDate").value, text };
      if (file) {
        toast("正在上传图片...");
        const img = await store.uploadImage(file, 1280);
        item.image = img.src;
        item.path = img.path;
      }
      await addItem(item);
      e.target.reset();
      $("momentDate").value = today();
      toast("已记录");
    })
  );

  $("todoForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      await addItem({ id: newId(), type: "todo", title: $("todoTitle").value.trim(), done: false });
      e.target.reset();
    })
  );

  let photoLoc = null;
  const photoPicker = attachPicker($("photoPlacePicker"), (c) => (photoLoc = c));
  attachPicker($("placeNamePicker"), (c) => {
    if (!c || !map) return;
    map.flyTo([c.lat, c.lng], 13, { duration: 0.8 });
    setPicked(L.latLng(c.lat, c.lng), `已选择：${c.name}`);
  });
  $("photoForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      const files = [...$("photoFiles").files];
      const caption = $("photoCaption").value.trim();
      const note = $("photoNote").value.trim();
      const place = $("photoPlace").value.trim();
      const date = $("photoDate").value;
      const loc = place ? photoLoc || (await locate(place)) : null;
      for (let i = 0; i < files.length; i++) {
        toast(`正在上传 ${i + 1} / ${files.length}...`, 60000);
        const img = await store.uploadImage(files[i], 1440);
        const thumb = await store.uploadImage(files[i], THUMB_SIZE, 0.72);
        await addItem({
          id: newId(), type: "photo", src: img.src, path: img.path, thumb: thumb.src, thumbPath: thumb.path,
          caption, note, place, date, lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, cs: "gcj",
        });
      }
      e.target.reset();
      photoPicker.reset();
      if (place && !loc) toast("照片已上传，但没有放到地图上。之后可以点 ✎ 重新选地点", 5000);
      else toast(loc ? "上传完成，足迹地图上多了一颗小爱心" : "上传完成");
    })
  );

  $("planForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      await addItem({
        id: newId(), type: "plan", title: $("planTitle").value.trim(),
        date: $("planDate").value, note: $("planNote").value.trim(), done: false,
      });
      e.target.reset();
      toast("计划已添加");
    })
  );

  $("placeForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      if (!map) return toast("地图加载失败，刷新页面再试试");
      const name = $("placeName").value.trim();
      if (!picked) {
        const found = await chooseLocation(name);
        if (!found) return toast("可以直接在地图上点一下选择位置", 4000);
        map.flyTo([found.lat, found.lng], 13, { duration: 0.8 });
        setPicked(L.latLng(found.lat, found.lng), `已选择：${found.name}`);
        return toast("已在地图上标出，请确认位置");
      }
      const files = [...$("placePhotos").files];
      const photos = [];
      for (let i = 0; i < files.length; i++) {
        toast(`正在上传照片 ${i + 1} / ${files.length}...`, 60000);
        const img = await store.uploadImage(files[i], 1440);
        const thumb = await store.uploadImage(files[i], THUMB_SIZE, 0.72);
        photos.push({ src: img.src, path: img.path, thumb: thumb.src, thumbPath: thumb.path });
      }
      const ll = picked;
      await addItem({
        id: newId(), type: "place", name, date: $("placeDate").value,
        note: $("placeNote").value.trim(), lat: ll.lat, lng: ll.lng, photos,
      });
      e.target.reset();
      clearPicked();
      map.flyTo(ll, Math.max(map.getZoom(), 6), { duration: 0.8 });
      toast("足迹已添加");
    })
  );

  // ---------- 站点设置 ----------
  $("settingsBtn")?.addEventListener("click", () => {
    const s = site();
    $("setStart").value = String(s.startDate).replace(" ", "T").replace(/\//g, "-").slice(0, 16);
    $("setMet").value = s.metDate ? String(s.metDate).slice(0, 10) : "";
    $("setBoy").value = s.boyName;
    $("setGirl").value = s.girlName;
    $("setSlogan").value = s.slogan;
    $("setBlur").value = s.bgBlur;
    $("setBlurValue").textContent = s.bgBlur;
    for (const [who, c] of [["Boy", s.boyChibi], ["Girl", s.girlChibi]]) {
      $(`set${who}Hair`).value = c.hair;
      $(`set${who}HairColor`).value = c.hairColor;
      $(`set${who}Cloth`).value = c.cloth;
    }
    $("setChibiShow").checked = s.chibiShow;
    $("setBoyBirthday").value = s.boyBirthday;
    $("setGirlBirthday").value = s.girlBirthday;
    $("musicName").textContent = settings.music ? `当前：${settings.music.name}` : "还没有背景音乐";
    $("setMusicRemove").checked = false;
    openModal("settingsModal");
  });
  $("setBlur").addEventListener("input", (e) => {
    $("setBlurValue").textContent = e.target.value;
    applyBlur(Number(e.target.value));
  });
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget || e.target.hasAttribute("data-close")) renderHeader();
  });
  $("settingsForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      const next = {
        ...settings,
        startDate: $("setStart").value,
        metDate: $("setMet").value,
        boyName: $("setBoy").value.trim(),
        girlName: $("setGirl").value.trim(),
        slogan: $("setSlogan").value.trim(),
        bgBlur: Number($("setBlur").value),
        chibiShow: $("setChibiShow").checked,
        boyChibi: { hair: $("setBoyHair").value, hairColor: $("setBoyHairColor").value, cloth: $("setBoyCloth").value },
        girlChibi: { hair: $("setGirlHair").value, hairColor: $("setGirlHairColor").value, cloth: $("setGirlCloth").value },
        boyBirthday: $("setBoyBirthday").value,
        girlBirthday: $("setGirlBirthday").value,
      };
      const music = $("setMusic").files[0];
      if ($("setMusicRemove").checked) next.music = null;
      else if (music) {
        if (music.size > 20 * 1024 * 1024) return toast("音乐文件太大了，请换一个 20MB 以内的");
        toast("正在上传音乐...", 120000);
        next.music = { ...(await store.uploadFile(music)), name: music.name };
      }
      const uploads = [["setBoyAvatar", "boyAvatar", 400], ["setGirlAvatar", "girlAvatar", 400], ["setBg", "background", 1920]];
      for (const [input, key, max] of uploads) {
        const file = $(input).files[0];
        if (!file) continue;
        toast("正在上传图片...", 60000);
        next[key] = (await store.uploadImage(file, max)).src;
      }
      await store.saveSettings(next);
      settings = next;
      renderAll();
      e.target.reset();
      closeModal("settingsModal");
      toast("设置已保存");
    })
  );

  // ---------- 删除 / 切换完成 ----------
  document.addEventListener("click", async (e) => {
    try {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        if (!confirm("确定删除吗？")) return;
        const item = items.find((i) => i.id === del.dataset.del);
        await store.deleteItem(item);
        items = items.filter((i) => i !== item);
        return renderAll();
      }
      const edit = e.target.closest("[data-edit]");
      if (edit) {
        e.stopPropagation();
        const item = items.find((i) => i.id === edit.dataset.edit);
        const next = { ...item };
        for (const [key, label] of EDIT_FIELDS[item.type] || []) {
          const v = prompt(label, item[key] || "");
          if (v === null) return;
          next[key] = v.trim();
        }
        if (next.type === "moment" && !next.text) return toast("内容不能为空");
        if ((next.type === "todo" || next.type === "plan") && !next.title) return toast("内容不能为空");
        if (next.type === "place" && !next.name) return toast("地点不能为空");
        if (next.type === "place" && next.date && !/^\d{4}-\d{2}-\d{2}$/.test(next.date)) return toast("日期格式应为 2026-10-01");
        const dateOk = /^\d{4}-\d{2}-\d{2}$/;
        if (next.type === "moment" && !dateOk.test(next.date)) return toast("日期格式应为 2024-05-20");
        if (next.type === "plan" && next.date && !dateOk.test(next.date)) return toast("日期格式应为 2027-12-01");
        if (next.type === "photo" && next.date && !dateOk.test(next.date)) return toast("日期格式应为 2026-05-17");
        if (next.type === "photo" && next.place !== (item.place || "")) {
          const loc = next.place ? await locate(next.place) : null;
          next.lat = loc ? loc.lat : null;
          next.lng = loc ? loc.lng : null;
          next.cs = "gcj";
        }
        await store.saveItem(next);
        Object.assign(item, next);
        renderAll();
        if (next.type === "photo" && next.place && !Number.isFinite(next.lat)) return toast("已修改，但没找到这个地点，地图上暂时不显示", 4000);
        return toast("已修改");
      }
      const place = e.target.closest("[data-place]");
      if (place) return focusPlace(place.dataset.place);
      const delMsg = e.target.closest("[data-del-msg]");
      if (delMsg) {
        if (!confirm("确定删除这条留言吗？")) return;
        await store.deleteMessage(isNaN(delMsg.dataset.delMsg) ? delMsg.dataset.delMsg : Number(delMsg.dataset.delMsg));
        messages = await store.listMessages();
        return renderMsgs();
      }
      if (!document.body.classList.contains("editing")) return;
      const toggle = e.target.closest("[data-plan], [data-todo]");
      if (toggle) {
        const item = items.find((i) => i.id === (toggle.dataset.plan || toggle.dataset.todo));
        item.done = !item.done;
        await store.saveItem(item);
        renderAll();
      }
    } catch (err) {
      fail(err);
    }
  });

  // ---------- 留言提交 ----------
  $("msgForm").addEventListener("submit", (e) =>
    busy(e, async () => {
      const name = $("msgName").value.trim();
      const text = $("msgText").value.trim();
      if (!name) return toast("请填写昵称");
      if (text.length < 5) return toast("留言至少需要5个字哦");
      await store.addMessage({ name, text });
      messages = await store.listMessages();
      $("msgText").value = "";
      renderMsgs();
      toast("祝福已送达");
    })
  );

  // ---------- 本地模式：备份 / 恢复 ----------
  $("exportBtn")?.addEventListener("click", () => {
    const data = { version: 2, items, messages: lsGet(LS_MSG, []), settings };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = `恋爱小站备份-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("importFile")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      for (const item of data.items || []) {
        await localStore.saveItem(item);
        if (!items.some((i) => i.id === item.id)) items.push(item);
      }
      if (data.messages) {
        const merged = [...lsGet(LS_MSG, []), ...data.messages].filter(
          (m, i, arr) => arr.findIndex((x) => x.time === m.time && x.text === m.text) === i
        );
        lsSet(LS_MSG, merged);
        messages = await localStore.listMessages();
      }
      if (data.settings) {
        settings = { ...settings, ...data.settings };
        await localStore.saveSettings(settings);
      }
      renderAll();
      toast("备份已导入");
    } catch (err) {
      toast("导入失败，文件格式不对");
    }
    e.target.value = "";
  });

  // ---------- 启动：加载数据 ----------
  (async () => {
    try {
      store = await createStore();
      document.body.classList.add("mode-" + store.mode);
      await store.init();
      [settings, items, messages] = await Promise.all([store.getSettings(), store.listItems(), store.listMessages()]);
      items.sort((a, b) => (a.created || 0) - (b.created || 0));
      dataLoaded = true;
      renderAll();
      loadNotes();
    } catch (err) {
      fail(err);
    }
  })();

  // ---------- 大图预览 ----------
  const lb = $("lightbox");
  document.addEventListener("click", (e) => {
    const img = e.target.closest(".gallery:not(.polaroid) img, .moment img, .story img");
    if (img) openLightbox(img);
  });
  function openLightbox(img) {
    // 先显示已加载的缩略图，原图下载完再替换，避免大图慢时一片空白
    const big = lb.querySelector("img");
    big.src = img.src;
    const full = img.dataset.full;
    if (full && full !== img.src) {
      const pre = new Image();
      pre.onload = () => big.src === img.src && lb.classList.contains("show") && (big.src = full);
      pre.src = full;
    }
    lb.querySelector("p").textContent = img.dataset.caption;
    lb.classList.add("show");
  }
  lb.addEventListener("click", () => lb.classList.remove("show"));

  // ---------- 滚动淡入 ----------
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => en.isIntersecting && (en.target.classList.add("in"), io.unobserve(en.target)));
  }, { threshold: 0.1 });
  document.querySelectorAll(".fade").forEach((el) => io.observe(el));

  // ---------- 添加到手机桌面 ----------
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  const LS_INSTALL = "love_site_install_hidden";
  const installBtn = $("installBtn");
  const ua = navigator.userAgent;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const inWeChat = /micromessenger|qq\//i.test(ua);
  let installPrompt = null;
  const showInstall = () => installBtn && !standalone && !localStorage.getItem(LS_INSTALL) && (installBtn.hidden = false);
  if (inWeChat || isIOS) showInstall();
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    showInstall();
  });
  addEventListener("appinstalled", () => {
    localStorage.setItem(LS_INSTALL, "1");
    if (installBtn) installBtn.hidden = true;
    toast("已添加到桌面");
  });
  installBtn?.addEventListener("click", async () => {
    if (inWeChat) return toast("微信里不能添加，请点右上角「···」选择「在浏览器打开」", 5000);
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null;
      if (outcome === "accepted") installBtn.hidden = true;
      return;
    }
    if (isIOS) {
      localStorage.setItem(LS_INSTALL, "1");
      installBtn.hidden = true;
      return toast("用 Safari 打开，点底部「分享」按钮，再选「添加到主屏幕」", 7000);
    }
    toast("在浏览器菜单里选择「添加到主屏幕」或「安装应用」", 5000);
  });

  // ---------- 点击飘爱心 ----------
  const cv = $("hearts");
  const ctx = cv.getContext("2d");
  const hearts = [];
  const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
  resize();
  addEventListener("resize", resize);
  addEventListener("click", (e) => {
    if (e.target.closest("button, input, textarea, select, label, a, .modal, .map, .place-picker")) return;
    for (let i = 0; i < 4; i++) {
      hearts.push({ x: e.clientX, y: e.clientY, vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 2 - 0.8, life: 1, size: 10 + Math.random() * 8, c: i % 2 ? "#b39158" : "#6b2232" });
    }
  });
  // 纪念日当天的烟花
  const sparks = [];
  const SPARK_COLORS = ["#d9bd88", "#b39158", "#c46a78", "#6b2232", "#f6efe6"];
  function fireworks(duration) {
    const end = Date.now() + duration;
    (function burst() {
      const x = innerWidth * (0.15 + Math.random() * 0.7);
      const y = innerHeight * (0.12 + Math.random() * 0.35);
      const c = SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)];
      for (let i = 0; i < 46; i++) {
        const a = (Math.PI * 2 * i) / 46;
        const v = 1.5 + Math.random() * 2.5;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, c });
      }
      if (Date.now() < end) setTimeout(burst, 350 + Math.random() * 300);
    })();
  }
  (function loop() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.x += p.vx; p.y += p.vy; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.035; p.life -= 0.012;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = hearts.length - 1; i >= 0; i--) {
      const h = hearts[i];
      h.x += h.vx; h.y += h.vy; h.vy += 0.04; h.life -= 0.015;
      if (h.life <= 0) { hearts.splice(i, 1); continue; }
      ctx.globalAlpha = h.life;
      ctx.fillStyle = h.c;
      ctx.font = `${h.size}px sans-serif`;
      ctx.fillText("\u2665\uFE0E", h.x, h.y);
    }
    requestAnimationFrame(loop);
  })();
})();
