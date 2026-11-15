/* Portfolio editor.
   On your own computer it talks to server.js, which saves into the "site" folder.
   On the published site it saves straight into the live site's files (see github.js). */
(function () {
  "use strict";

  var E = window.PortfolioEmbeds;
  var API = "../api/";
  var TOKEN_KEY = "portfolio-editor-token";
  var CHUNK = 4 * 1024 * 1024;

  /* Set when this editor is running on the published site. */
  var HOST = window.PORTFOLIO_HOST && window.PORTFOLIO_HOST.type === "github" ? window.PORTFOLIO_HOST : null;
  var GitHub = window.PortfolioGitHub;
  var KEY_NAME = "portfolio-editor-key";
  var HOSTED_MAX = 50 * 1024 * 1024; /* biggest file kept on the published site */
  var HOSTED_TYPES = "png jpg jpeg gif webp avif mp4 m4v mov webm mp3 m4a aac wav ogg flac pdf".split(" ");
  var gh = null;
  var liveFiles = {}; /* files that are part of the published site */
  var waitingFiles = {}; /* uploaded, and added to the site with the next save */
  var waitingRemovals = {}; /* no longer needed, removed with the next save */
  var localPreviews = {}; /* so new uploads show here before the live site has them */
  var indexHtml = "";
  var liveState = ""; /* "", "updating", "live", "slow" */

  var gate = document.getElementById("gate");
  var app = document.getElementById("app");
  var sidebar = document.getElementById("sidebar");
  var panel = document.getElementById("panel");
  var saveState = document.getElementById("save-state");
  var toasts = document.getElementById("toasts");
  var picker = document.getElementById("file-picker");
  var veil = document.getElementById("drop-veil");

  var token = "";
  try {
    token = localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    token = "";
  }

  var content = null;
  var current = "site"; /* "section:<id>", "site" or "publish" */
  var uploads = []; /* files being uploaded right now */
  var uploading = false;
  var justAdded = null;

  /* ---------- helpers ---------- */

  function el(tag, attrs) {
    var node = document.createElement(tag);
    var key, i, child;
    for (key in attrs || {}) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "value") node.value = value;
      else if (key.slice(0, 2) === "on" && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (i = 2; i < arguments.length; i++) {
      child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function icon(path) {
    var holder = document.createElement("span");
    holder.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<path d="' + path + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return holder.firstChild;
  }

  var PATHS = {
    up: "M12 19V5M5 12l7-7 7 7",
    down: "M12 5v14M5 12l7 7 7-7",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    close: "M6 6l12 12M18 6L6 18"
  };

  function slug(value, fallback) {
    var text = String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return text || fallback;
  }

  function uniqueId(list, title, fallback) {
    var base = slug(title, fallback);
    var id = base;
    var n = 2;
    var taken = function (candidate) {
      return list.some(function (entry) {
        return entry.id === candidate;
      });
    };
    while (taken(id) || ["home", "contact", "admin", "api", "media"].indexOf(id) !== -1) {
      id = base + "-" + n;
      n += 1;
    }
    return id;
  }

  function randomId() {
    var out = "";
    var letters = "abcdefghijklmnopqrstuvwxyz0123456789";
    var bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) out += letters[bytes[i] % letters.length];
    return out;
  }

  function titleFromFile(name) {
    var base = String(name).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Untitled";
  }

  function shortUrl(url) {
    return String(url).replace(/^https?:\/\/(www\.)?/, "").replace(/\?.*$/, "").replace(/\/$/, "");
  }

  function previewPath(path) {
    if (!path) return "";
    if (localPreviews[path]) return localPreviews[path];
    return /^https?:\/\//.test(path) ? path : "../" + path;
  }

  function sectionById(id) {
    for (var i = 0; i < content.sections.length; i++) if (content.sections[i].id === id) return content.sections[i];
    return null;
  }

  function currentSection() {
    return current.indexOf("section:") === 0 ? sectionById(current.slice(8)) : null;
  }

  /* ---------- talking to the server ---------- */

  function api(path, options) {
    options = options || {};
    var headers = { Authorization: "Bearer " + token };
    var body = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    return fetch(API + path, { method: options.method || "GET", headers: headers, body: body }).then(
      function (reply) {
        return reply
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (reply.ok) return data;
            var error = new Error(data.error || "Something went wrong. Please try again.");
            error.status = reply.status;
            if (reply.status === 401 && !options.gate) showGate("signin", "Your session ended. Sign in to keep editing.");
            throw error;
          });
      },
      function () {
        throw new Error("Couldn't reach the editor. Check your connection and try again.");
      }
    );
  }

  /* ---------- saving ---------- */

  var dirty = false;
  var saveTimer = null;
  var savingNow = null;
  var saveQueued = false;

  function showSaveState(kind) {
    saveState.className = "save-state" + (kind === "error" ? " is-error" : "");
    saveState.textContent = "";
    if (kind === "saving") saveState.textContent = "Saving…";
    if (kind === "saved") {
      saveState.textContent = "All changes saved";
      if (HOST && liveState === "updating") saveState.textContent = "Saved. Updating your live site…";
      if (HOST && liveState === "live") saveState.textContent = "Saved. Your live site is up to date.";
      if (HOST && liveState === "slow") saveState.textContent = "Saved. Your live site will update in a few minutes.";
    }
    if (kind === "error") {
      saveState.appendChild(document.createTextNode("Not saved."));
      saveState.appendChild(el("button", { type: "button", text: "Try again", onclick: save }));
    }
  }

  function changed() {
    dirty = true;
    showSaveState("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, HOST ? 2500 : 700);
  }

  function save() {
    clearTimeout(saveTimer);
    if (savingNow) {
      saveQueued = true;
      return savingNow;
    }
    showSaveState("saving");
    savingNow = (HOST ? hostedSave() : api("content", { method: "PUT", json: content }))
      .then(function () {
        if (!saveQueued) {
          dirty = false;
          showSaveState("saved");
        }
      })
      .catch(function (error) {
        showSaveState("error");
        if (HOST && error && error.code === "auth") showGate("key", "Your editing key has stopped working. Paste a new one to keep going. Nothing you did is lost while this page stays open.");
        else if (HOST && error && error.message) toast(error.message, { error: true });
      })
      .then(function () {
        savingNow = null;
        if (saveQueued) {
          saveQueued = false;
          return save();
        }
      });
    return savingNow;
  }

  window.addEventListener("beforeunload", function (event) {
    if (dirty || uploads.some(function (u) { return !u.error; })) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  /* Remove uploaded files that are no longer used anywhere (the server double-checks). */
  function cleanUp(paths) {
    var mine = paths.filter(function (p) {
      return p && p.indexOf("media/") === 0;
    });
    if (!mine.length) return;
    if (HOST) {
      /* Decided for real at the next save, against what the site uses by then. */
      mine.forEach(function (p) {
        waitingRemovals[p] = true;
      });
      changed();
      return;
    }
    Promise.resolve(dirty ? save() : null).then(function () {
      api("delete-files", { method: "POST", json: { paths: mine } }).catch(function () {});
    });
  }

  /* ---------- toasts ---------- */

  function toast(message, options) {
    options = options || {};
    var done = false;
    var node = el("div", { class: "toast" + (options.error ? " is-error" : "") }, el("span", { text: message }));
    function finish(viaAction) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      node.remove();
      if (!viaAction && options.onExpire) options.onExpire();
    }
    if (options.action) {
      node.appendChild(
        el("button", {
          type: "button",
          text: options.action,
          onclick: function () {
            finish(true);
            options.onAction();
          }
        })
      );
    } else {
      node.appendChild(
        el("button", { type: "button", "aria-label": "Dismiss", onclick: function () { finish(false); } }, icon(PATHS.close))
      );
    }
    toasts.appendChild(node);
    var timer = setTimeout(function () {
      finish(false);
    }, options.duration || (options.error ? 9000 : 6000));
  }

  /* ---------- images, video frames, uploads ---------- */

  function uploadBlob(blob, name, onProgress) {
    var id = randomId();
    var offset = 0;

    function sendPiece(attempt) {
      var end = Math.min(offset + CHUNK, blob.size);
      var last = end >= blob.size;
      var query =
        "upload?id=" + id + "&offset=" + offset + "&last=" + (last ? 1 : 0) + "&name=" + encodeURIComponent(name);
      return api(query, { method: "POST", body: blob.slice(offset, end) }).then(
        function (data) {
          offset = end;
          if (onProgress) onProgress(blob.size ? offset / blob.size : 1);
          return last ? data.path : sendPiece(0);
        },
        function (error) {
          /* A dropped connection is worth another go; a clear "no" from the server is not. */
          if (error.status || attempt >= 3) throw error;
          return new Promise(function (resolve) {
            setTimeout(resolve, 1000 * (attempt + 1));
          }).then(function () {
            return sendPiece(attempt + 1);
          });
        }
      );
    }
    if (!blob.size) return Promise.reject(new Error("That file is empty."));
    if (HOST) return hostedUpload(blob, name, onProgress);
    return sendPiece(0);
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, url: url, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("This browser couldn't open that image."));
      };
      img.src = url;
    });
  }

  function drawSmaller(source, width, height, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(width, height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(
        function (blob) {
          if (blob) resolve(blob);
          else reject(new Error("Couldn't make a preview picture."));
        },
        "image/jpeg",
        0.84
      );
    });
  }

  /* Grab a frame from a video file to use as its thumbnail. Gives null if the
     browser can't read the video (some .mov files). */
  function videoFrame(file) {
    return new Promise(function (resolve) {
      var video = document.createElement("video");
      var url = URL.createObjectURL(file);
      var finished = false;
      function finish(result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        resolve(result);
      }
      var timer = setTimeout(function () {
        finish(null);
      }, 15000);
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onerror = function () {
        finish(null);
      };
      video.onloadedmetadata = function () {
        if (!video.videoWidth) return finish(null);
        var at = isFinite(video.duration) ? Math.min(video.duration * 0.2, 4) : 0.5;
        video.currentTime = Math.max(at, 0.05);
      };
      video.onseeked = function () {
        var width = video.videoWidth;
        var height = video.videoHeight;
        drawSmaller(video, width, height, 1280).then(
          function (blob) {
            finish({ blob: blob, ratio: width / height });
          },
          function () {
            finish(null);
          }
        );
      };
      video.src = url;
    });
  }

  var KINDS = {
    image: ["jpg", "jpeg", "png", "gif", "webp", "avif"],
    video: ["mp4", "m4v", "mov", "webm"],
    audio: ["mp3", "m4a", "aac", "wav", "ogg", "flac"],
    pdf: ["pdf"]
  };

  function kindOf(file) {
    var ext = (file.name.match(/\.([a-z0-9]+)$/i) || ["", ""])[1].toLowerCase();
    for (var kind in KINDS) if (KINDS[kind].indexOf(ext) !== -1) return kind;
    return ext === "heic" || ext === "heif" ? "heic" : "";
  }

  /* Upload one picture (shrunk if huge) and hand back its saved path. */
  function uploadPicture(file, maxEdge) {
    return loadImage(file).then(function (info) {
      var keepOriginal =
        Math.max(info.width, info.height) <= maxEdge && file.size < 900 * 1024 && /\.(jpe?g|png|webp)$/i.test(file.name);
      var work = keepOriginal
        ? uploadBlob(file, file.name)
        : drawSmaller(info.img, info.width, info.height, maxEdge).then(function (blob) {
            return uploadBlob(blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
          });
      return work.then(
        function (path) {
          URL.revokeObjectURL(info.url);
          return { path: path, ratio: info.width / info.height };
        },
        function (error) {
          URL.revokeObjectURL(info.url);
          throw error;
        }
      );
    });
  }

  function pickFiles(accept, multiple, onPicked) {
    picker.value = "";
    picker.accept = accept;
    picker.multiple = multiple;
    picker.onchange = function () {
      var files = Array.prototype.slice.call(picker.files || []);
      if (files.length) onPicked(files);
    };
    picker.click();
  }

  var ACCEPT_MEDIA =
    "image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/quicktime,video/webm,audio/*,application/pdf," +
    ".jpg,.jpeg,.png,.gif,.webp,.avif,.mp4,.m4v,.mov,.webm,.mp3,.m4a,.aac,.wav,.ogg,.flac,.pdf";
  var ACCEPT_IMAGE = "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif";

  /* ---------- adding media ---------- */

  function addFiles(section, files) {
    files.forEach(function (file) {
      var kind = kindOf(file);
      var entry = { key: randomId(), file: file, name: file.name, kind: kind, sectionId: section.id, progress: 0, state: "Waiting", error: "" };
      if (kind === "heic") entry.error = "iPhone HEIC photos don't show on websites. Save it as a JPG first, then add it.";
      else if (!kind) entry.error = "This type of file can't be added. Use an image, video, audio file or PDF.";
      uploads.push(entry);
    });
    drawUploads();
    runUploads();
  }

  function runUploads() {
    if (uploading) return;
    var entry = uploads.filter(function (u) {
      return !u.error;
    })[0];
    if (!entry) return;
    uploading = true;
    entry.state = "Uploading";
    drawUploads();

    var item = {
      id: "",
      type: entry.kind,
      title: titleFromFile(entry.name),
      description: "",
      group: "",
      src: "",
      thumb: "",
      ratio: 0
    };
    var warning = "";

    uploadBlob(entry.file, entry.name, function (fraction) {
      entry.progress = fraction;
      drawUploads(true);
    })
      .then(function (path) {
        item.src = path;
        entry.state = "Finishing";
        drawUploads();
        if (entry.kind === "image") {
          return loadImage(entry.file).then(
            function (info) {
              item.ratio = info.width / info.height;
              var small = Math.max(info.width, info.height) <= 1400 && entry.file.size < 500 * 1024;
              if (small || /\.gif$/i.test(entry.name)) {
                item.thumb = path;
                URL.revokeObjectURL(info.url);
                return;
              }
              return drawSmaller(info.img, info.width, info.height, 1400)
                .then(function (blob) {
                  return uploadBlob(blob, entry.name.replace(/\.[^.]+$/, "") + "-thumb.jpg");
                })
                .then(
                  function (thumbPath) {
                    item.thumb = thumbPath;
                    URL.revokeObjectURL(info.url);
                  },
                  function () {
                    item.thumb = path;
                    URL.revokeObjectURL(info.url);
                  }
                );
            },
            function () {
              item.thumb = path;
            }
          );
        }
        if (entry.kind === "video") {
          return videoFrame(entry.file).then(function (frame) {
            if (!frame) {
              item.ratio = 1.7778;
              warning =
                "“" + item.title + "” was added, but this browser couldn't preview it. If it won't play on the site, export it as an MP4 (H.264) and add it again.";
              return;
            }
            item.ratio = frame.ratio;
            return uploadBlob(frame.blob, entry.name.replace(/\.[^.]+$/, "") + "-thumb.jpg").then(
              function (thumbPath) {
                item.thumb = thumbPath;
              },
              function () {}
            );
          });
        }
      })
      .then(function () {
        var section = sectionById(entry.sectionId);
        if (!section) {
          cleanUp([item.src, item.thumb]);
          return;
        }
        item.id = uniqueId(section.items, item.title, "item");
        section.items.unshift(item);
        justAdded = item.id;
        changed();
        if (warning) toast(warning, { duration: 14000 });
      })
      .catch(function (error) {
        entry.error = error.message || "Upload failed. Please try again.";
        if (item.src) cleanUp([item.src, item.thumb]);
      })
      .then(function () {
        if (!entry.error) uploads.splice(uploads.indexOf(entry), 1);
        uploading = false;
        drawSidebar();
        if (current === "section:" + entry.sectionId) drawItems();
        drawUploads();
        runUploads();
      });
  }

  function drawUploads(progressOnly) {
    var box = document.getElementById("uploads");
    var section = currentSection();
    if (!box || !section) return;
    var mine = uploads.filter(function (u) {
      return u.sectionId === section.id;
    });
    if (progressOnly) {
      mine.forEach(function (u) {
        var row = box.querySelector('[data-key="' + u.key + '"]');
        if (!row) return;
        var bar = row.querySelector("progress");
        var state = row.querySelector(".upload-state");
        if (bar) bar.value = u.progress;
        if (state && !u.error) state.textContent = Math.round(u.progress * 100) + "%";
      });
      return;
    }
    box.textContent = "";
    mine.forEach(function (u) {
      var state = u.error || (u.state === "Uploading" ? Math.round(u.progress * 100) + "%" : u.state + "…");
      var row = el(
        "div",
        { class: "upload" + (u.error ? " is-error" : ""), "data-key": u.key },
        el("span", { class: "upload-name", text: u.name }),
        u.error
          ? el("button", {
              class: "text-button",
              type: "button",
              text: "Dismiss",
              onclick: function () {
                uploads.splice(uploads.indexOf(u), 1);
                drawUploads();
              }
            })
          : el("span", { class: "upload-state", text: state }),
        u.error ? el("span", { class: "upload-state", role: "alert", text: u.error }) : null,
        el("progress", { max: 1, value: u.progress, "aria-label": "Upload progress for " + u.name })
      );
      box.appendChild(row);
    });
  }

  function addLink(section, text, form) {
    var found = E.detect(text);
    var error = form.querySelector(".form-error");
    var button = form.querySelector("button");
    var input = form.querySelector("input");
    error.hidden = true;
    if (!found) {
      error.textContent = "That doesn't look like a link. Paste the full address, starting with https://";
      error.hidden = false;
      input.focus();
      return;
    }
    button.disabled = true;
    button.textContent = "Adding…";
    (HOST ? hostedLinkInfo(found.src, found.type) : api("link-info?url=" + encodeURIComponent(found.src)))
      .catch(function () {
        return {};
      })
      .then(function (info) {
        var fallbackTitle = found.type === "link" ? shortUrl(found.src).split("/")[0] : E.label(found.type);
        var item = {
          id: "",
          type: found.type,
          title: info.title || fallbackTitle,
          description: "",
          group: "",
          src: found.src,
          thumb: info.thumb || found.thumb || "",
          ratio: found.type === "vimeo" && info.ratio ? info.ratio : found.ratio
        };
        if (!sectionById(section.id)) return;
        item.id = uniqueId(section.items, item.title, "item");
        section.items.unshift(item);
        justAdded = item.id;
        changed();
        input.value = "";
        drawSidebar();
        if (current === "section:" + section.id) drawItems();
      })
      .catch(function () {
        error.textContent = "That link couldn't be added. Please try again.";
        error.hidden = false;
      })
      .then(function () {
        button.disabled = false;
        button.textContent = "Add link";
      });
  }

  /* ---------- sidebar ---------- */

  function go(target) {
    current = target;
    drawSidebar();
    drawPanel();
    window.scrollTo(0, 0);
    panel.focus({ preventScroll: true });
  }

  function drawSidebar() {
    sidebar.textContent = "";
    sidebar.appendChild(el("p", { class: "sidebar-heading", text: "Sections" }));
    content.sections.forEach(function (section) {
      var key = "section:" + section.id;
      sidebar.appendChild(
        el(
          "button",
          {
            type: "button",
            "aria-current": current === key ? "page" : null,
            onclick: function () {
              go(key);
            }
          },
          el("span", { text: section.title + (section.hidden ? " (hidden)" : "") }),
          el("span", { class: "count", text: String(section.items.length) })
        )
      );
    });
    sidebar.appendChild(el("span", { class: "divider" }));
    [["site", "Site details"], ["publish", HOST ? "Your live site" : "Publish"]].forEach(function (pair) {
      sidebar.appendChild(
        el("button", {
          type: "button",
          text: pair[1],
          "aria-current": current === pair[0] ? "page" : null,
          onclick: function () {
            go(pair[0]);
          }
        })
      );
    });
  }

  /* ---------- building blocks ---------- */

  function field(label, control, hint) {
    return el("label", { class: "field" }, el("span", { text: label }), control, hint ? el("small", { text: hint }) : null);
  }

  function textInput(object, key, options) {
    options = options || {};
    var node = el(options.rows ? "textarea" : "input", {
      type: options.rows ? null : options.type || "text",
      rows: options.rows || null,
      placeholder: options.placeholder || null,
      maxlength: options.max || null,
      list: options.list || null,
      "data-focus": options.focusKey || null,
      autocomplete: "off"
    });
    node.value = object[key] || "";
    node.addEventListener("input", function () {
      object[key] = node.value;
      changed();
      if (options.onInput) options.onInput(node.value);
    });
    if (options.onChange) node.addEventListener("change", function () { options.onChange(node.value); });
    return node;
  }

  /* A picture slot (banner, section cover): preview + choose + remove. */
  function imagePicker(object, key, maxEdge, emptyText) {
    var wrap = el("div", { class: "image-pick" });
    function draw() {
      wrap.textContent = "";
      wrap.appendChild(
        el("div", { class: "preview" }, object[key] ? el("img", { src: previewPath(object[key]), alt: "" }) : emptyText)
      );
      var choose = el("button", {
        class: "button small",
        type: "button",
        text: object[key] ? "Replace image" : "Choose image",
        onclick: function () {
          pickFiles(ACCEPT_IMAGE, false, function (files) {
            choose.disabled = true;
            choose.textContent = "Uploading…";
            uploadPicture(files[0], maxEdge).then(
              function (result) {
                var old = object[key];
                object[key] = result.path;
                changed();
                cleanUp([old]);
                draw();
              },
              function (error) {
                toast(error.message, { error: true });
                draw();
              }
            );
          });
        }
      });
      wrap.appendChild(choose);
      if (object[key]) {
        wrap.appendChild(
          el("button", {
            class: "button small quiet",
            type: "button",
            text: "Remove",
            onclick: function () {
              var old = object[key];
              object[key] = "";
              changed();
              cleanUp([old]);
              draw();
            }
          })
        );
      }
    }
    draw();
    return wrap;
  }

  /* ---------- section panel ---------- */

  function groupNames(section) {
    var seen = {};
    return section.items
      .map(function (item) {
        return (item.group || "").trim();
      })
      .filter(function (name) {
        if (!name || seen[name]) return false;
        seen[name] = true;
        return true;
      });
  }

  function sourceLine(item) {
    if (/^media\//.test(item.src)) return "File: " + item.src.replace(/^media\//, "");
    return shortUrl(item.src);
  }

  function itemRow(section, item, index) {
    var total = section.items.length;
    var isAudio = E.isAudio(item.type);
    var thumb = el("div", { class: "thumb" });
    if (item.thumb || item.type === "image") {
      thumb.appendChild(el("img", { src: previewPath(item.thumb || item.src), alt: "", loading: "lazy" }));
    } else {
      thumb.appendChild(el("span", { class: "thumb-empty", text: isAudio ? "Audio player" : "No thumbnail yet" }));
    }

    var media = el("div", { class: "item-media" }, thumb, el("span", { class: "kind", text: E.label(item.type) }));
    if (!isAudio) {
      var change = el("button", {
        class: "text-button",
        type: "button",
        text: item.thumb ? "Change thumbnail" : "Add thumbnail",
        onclick: function () {
          pickFiles(ACCEPT_IMAGE, false, function (files) {
            change.textContent = "Uploading…";
            change.disabled = true;
            uploadPicture(files[0], 1400).then(
              function (result) {
                var old = item.thumb;
                item.thumb = result.path;
                if (!E.opensInViewer(item.type) || item.type === "instagram") item.ratio = result.ratio;
                changed();
                if (old !== item.src) cleanUp([old]);
                drawItems();
              },
              function (error) {
                toast(error.message, { error: true });
                drawItems();
              }
            );
          });
        }
      });
      media.appendChild(change);
    }

    var moveSelect = el("select", { "aria-label": "Section for " + (item.title || "this item") });
    content.sections.forEach(function (other) {
      var option = el("option", { value: other.id, text: other.title });
      if (other.id === section.id) option.selected = true;
      moveSelect.appendChild(option);
    });
    moveSelect.addEventListener("change", function () {
      var target = sectionById(moveSelect.value);
      if (!target || target === section) return;
      section.items.splice(section.items.indexOf(item), 1);
      item.id = uniqueId(target.items, item.id, "item");
      item.group = "";
      target.items.unshift(item);
      changed();
      drawSidebar();
      drawItems();
      toast("Moved “" + (item.title || "Untitled") + "” to " + target.title + ".");
    });

    var fields = el(
      "div",
      { class: "item-fields" },
      field("Title", textInput(item, "title", { max: 200, focusKey: item.id + ":title" })),
      field(
        "Description (optional)",
        textInput(item, "description", { rows: 2, max: 2000, focusKey: item.id + ":description", placeholder: "Credits, your role, a line of context…" })
      ),
      el(
        "div",
        { class: "two" },
        field(
          "Subheading (optional)",
          textInput(item, "group", {
            max: 80,
            list: "group-names",
            focusKey: item.id + ":group",
            placeholder: "e.g. Podcast",
            onChange: drawGroupList
          })
        ),
        field("Section", moveSelect)
      ),
      el("p", { class: "item-source", text: sourceLine(item) })
    );

    if (/adobe\.io|myportfolio\.com/.test(item.src)) {
      fields.appendChild(
        el("p", {
          class: "notice",
          text:
            "This video still plays from your old Adobe Portfolio. If you close that account it will stop working, so replace it with the video file or a YouTube link before then."
        })
      );
    }

    function move(by) {
      var at = section.items.indexOf(item);
      var to = at + by;
      if (to < 0 || to >= section.items.length) return;
      section.items.splice(at, 1);
      section.items.splice(to, 0, item);
      changed();
      drawItems();
      var again = panel.querySelector('[data-item="' + item.id + '"] [data-move="' + by + '"]');
      if (again && !again.disabled) again.focus();
      else {
        var other = panel.querySelector('[data-item="' + item.id + '"] [data-move="' + -by + '"]');
        if (other) other.focus();
      }
    }

    var name = item.title || "this item";
    var actions = el(
      "div",
      { class: "item-actions" },
      el("button", { class: "icon-btn", type: "button", "data-move": "-1", "aria-label": "Move " + name + " up", title: "Move up", disabled: index === 0, onclick: function () { move(-1); } }, icon(PATHS.up)),
      el("button", { class: "icon-btn", type: "button", "data-move": "1", "aria-label": "Move " + name + " down", title: "Move down", disabled: index === total - 1, onclick: function () { move(1); } }, icon(PATHS.down)),
      el("button", { class: "icon-btn", type: "button", "aria-label": "Delete " + name, title: "Delete", onclick: function () { deleteItem(section, item); } }, icon(PATHS.trash))
    );

    return el("li", { class: "item" + (justAdded === item.id ? " is-new" : ""), "data-item": item.id }, media, fields, actions);
  }

  function deleteItem(section, item) {
    var at = section.items.indexOf(item);
    if (at === -1) return;
    section.items.splice(at, 1);
    changed();
    drawSidebar();
    drawItems();
    toast("Deleted “" + (item.title || "Untitled") + "”.", {
      action: "Undo",
      duration: 8000,
      onAction: function () {
        var home = sectionById(section.id);
        if (!home) return;
        item.id = uniqueId(home.items, item.id, "item");
        home.items.splice(Math.min(at, home.items.length), 0, item);
        changed();
        drawSidebar();
        if (current === "section:" + home.id) drawItems();
      },
      onExpire: function () {
        cleanUp([item.src, item.thumb]);
      }
    });
  }

  function drawGroupList() {
    var list = document.getElementById("group-names");
    var section = currentSection();
    if (!list || !section) return;
    list.textContent = "";
    groupNames(section).forEach(function (name) {
      list.appendChild(el("option", { value: name }));
    });
  }

  /* Rebuild the item list, keeping the cursor where it was if someone is typing. */
  function drawItems() {
    var section = currentSection();
    var holder = document.getElementById("items-holder");
    if (!section || !holder) return;
    var active = document.activeElement;
    var focusKey = active && active.getAttribute ? active.getAttribute("data-focus") : null;
    var caret = focusKey && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

    holder.textContent = "";
    var count = section.items.length;
    holder.appendChild(
      el(
        "div",
        { class: "list-head" },
        el("h2", { text: "In this section" }),
        el("p", { text: count ? (count === 1 ? "1 item" : count + " items") + " · shown on the site in this order" : "" })
      )
    );
    if (!count) {
      holder.appendChild(el("p", { class: "empty", text: "Nothing here yet. Add your first file or link above." }));
    } else {
      var list = el("ul", { class: "items" });
      section.items.forEach(function (item, index) {
        list.appendChild(itemRow(section, item, index));
      });
      holder.appendChild(list);
    }
    drawGroupList();
    justAdded = null;

    if (focusKey) {
      var again = holder.querySelector('[data-focus="' + focusKey + '"]');
      if (again) {
        again.focus({ preventScroll: true });
        if (caret) {
          try {
            again.setSelectionRange(caret[0], caret[1]);
          } catch (e) {
            /* not a text box */
          }
        }
      }
    }
  }

  function sectionPanel(section) {
    var linkForm = el(
      "form",
      {
        novalidate: true,
        onsubmit: function (event) {
          event.preventDefault();
          addLink(section, linkForm.querySelector("input").value, linkForm);
        }
      },
      el(
        "div",
        { class: "link-form" },
        el("input", { type: "url", inputmode: "url", "aria-label": "Link to add", placeholder: "https://www.youtube.com/watch?v=…", autocomplete: "off" }),
        el("button", { class: "button", type: "submit", text: "Add link" })
      ),
      el("p", { class: "form-error", role: "alert", hidden: true, style: "margin-top:8px" }),
      el("p", { class: "hint", text: "YouTube, Vimeo, SoundCloud, Instagram, TikTok, or any web page." })
    );

    var nameInput = textInput(section, "title", {
      max: 60,
      onChange: function () {
        if (!section.title.trim()) section.title = "Untitled";
        drawSidebar();
        var heading = panel.querySelector(".panel-head h1");
        if (heading) heading.textContent = section.title;
      }
    });

    var hideBox = el("input", { type: "checkbox" });
    hideBox.checked = Boolean(section.hidden);
    hideBox.addEventListener("change", function () {
      section.hidden = hideBox.checked;
      changed();
      drawSidebar();
    });

    return el(
      "div",
      null,
      el(
        "div",
        { class: "panel-head" },
        el("h1", { text: section.title }),
        el("a", { href: "../#/" + section.id, target: "_blank", rel: "noopener", text: "View this page" })
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Add to this section" }),
        el(
          "div",
          { class: "dropzone" },
          el("button", {
            class: "button primary",
            type: "button",
            text: "Choose files",
            onclick: function () {
              pickFiles(ACCEPT_MEDIA, true, function (files) {
                addFiles(section, files);
              });
            }
          }),
          el("p", { text: "or drag files anywhere onto this page. Images, video (MP4 works best), audio and PDFs." })
        ),
        el("div", { class: "uploads", id: "uploads" }),
        el("p", { class: "or", text: "or paste a link" }),
        linkForm
      ),
      el("div", { id: "items-holder" }),
      el("datalist", { id: "group-names" }),
      el(
        "details",
        { class: "box", style: "margin-top:28px" },
        el("summary", { text: "Section settings" }),
        el(
          "div",
          { class: "stack" },
          field("Name", nameInput),
          field("Short description (optional)", textInput(section, "description", { rows: 2, max: 600 }), "Shown under the section name on its page."),
          el(
            "div",
            null,
            el("span", { class: "field-label", text: "Cover image" }),
            imagePicker(section, "cover", 1400, "Using first item"),
            el("small", { class: "hint", text: "Shown on the home page. Without one, the first item's picture is used." })
          ),
          el("label", { class: "check" }, hideBox, el("span", { text: "Hide this section from the site for now" })),
          el(
            "div",
            null,
            el("button", {
              class: "button small danger",
              type: "button",
              text: "Delete this section",
              onclick: function () {
                deleteSection(section);
              }
            })
          )
        )
      )
    );
  }

  function deleteSection(section) {
    var at = content.sections.indexOf(section);
    if (at === -1) return;
    content.sections.splice(at, 1);
    changed();
    go(content.sections.length ? "section:" + content.sections[Math.max(0, at - 1)].id : "site");
    toast("Deleted the “" + section.title + "” section.", {
      action: "Undo",
      duration: 10000,
      onAction: function () {
        section.id = uniqueId(content.sections, section.id, "section");
        content.sections.splice(Math.min(at, content.sections.length), 0, section);
        changed();
        go("section:" + section.id);
      },
      onExpire: function () {
        var paths = [section.cover];
        section.items.forEach(function (item) {
          paths.push(item.src, item.thumb);
        });
        cleanUp(paths);
      }
    });
  }

  /* ---------- site details ---------- */

  function sitePanel() {
    var site = content.site;

    var links = el("div", { class: "stack", style: "gap:8px" });
    function drawLinks() {
      links.textContent = "";
      site.links.forEach(function (link, index) {
        links.appendChild(
          el(
            "div",
            { class: "link-row" },
            (function () {
              var input = textInput(link, "label", { max: 60, placeholder: "Name, e.g. Instagram" });
              input.setAttribute("aria-label", "Link name");
              return input;
            })(),
            (function () {
              var input = textInput(link, "url", { max: 500, type: "url", placeholder: "https://…" });
              input.setAttribute("aria-label", "Link address");
              return input;
            })(),
            el(
              "button",
              {
                class: "icon-btn",
                type: "button",
                "aria-label": "Remove " + (link.label || "link"),
                title: "Remove",
                onclick: function () {
                  site.links.splice(index, 1);
                  changed();
                  drawLinks();
                }
              },
              icon(PATHS.trash)
            )
          )
        );
      });
    }
    drawLinks();

    function themeChoice(value, label) {
      var input = el("input", { type: "radio", name: "theme", value: value });
      input.checked = (site.theme || "light") === value;
      input.addEventListener("change", function () {
        site.theme = value;
        changed();
      });
      return el("label", null, input, label);
    }

    var colour = el("input", { type: "color", "aria-label": "Accent color" });
    colour.value = site.accent || "#0e627f";
    colour.addEventListener("input", function () {
      site.accent = colour.value;
      changed();
    });

    var passwordError = el("p", { class: "form-error", role: "alert", hidden: true });
    var currentPassword = el("input", { type: "password", autocomplete: "current-password" });
    var nextPassword = el("input", { type: "password", autocomplete: "new-password" });
    var passwordForm = el(
      "form",
      {
        class: "stack",
        novalidate: true,
        onsubmit: function (event) {
          event.preventDefault();
          passwordError.hidden = true;
          api("password", { method: "POST", json: { current: currentPassword.value, next: nextPassword.value }, gate: true }).then(
            function (data) {
              setToken(data.token);
              currentPassword.value = "";
              nextPassword.value = "";
              toast("Password changed.");
            },
            function (error) {
              passwordError.textContent = error.message;
              passwordError.hidden = false;
            }
          );
        }
      },
      el("div", { class: "two" }, field("Current password", currentPassword), field("New password", nextPassword, "At least 8 characters.")),
      passwordError,
      el("div", null, el("button", { class: "button small", type: "submit", text: "Change password" }))
    );

    return el(
      "div",
      null,
      el("div", { class: "panel-head" }, el("h1", { text: "Site details" })),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Home page" }),
        el(
          "div",
          { class: "stack" },
          field("Your name", textInput(site, "name", { max: 120 }), "Shown at the top of every page."),
          field("Headline", textInput(site, "headline", { max: 200 }), "The big line on the home page."),
          field("Intro (optional)", textInput(site, "intro", { rows: 2, max: 600 }), "A sentence or two under the headline."),
          el(
            "div",
            null,
            el("span", { class: "field-label", text: "Banner photo" }),
            imagePicker(site, "banner", 2400, "No banner"),
            el("small", { class: "hint", text: "A wide photo behind the headline. Remove it for a plain text heading." })
          )
        )
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Contact page" }),
        el(
          "div",
          { class: "stack" },
          field("About you (optional)", textInput(site, "about", { rows: 4, max: 4000 })),
          field("Email (optional)", textInput(site, "email", { type: "email", max: 200, placeholder: "you@example.com" })),
          el(
            "div",
            null,
            el("span", { class: "field-label", text: "Links" }),
            links,
            el("button", {
              class: "button small",
              type: "button",
              text: "Add a link",
              style: "margin-top:10px",
              onclick: function () {
                site.links.push({ label: "", url: "" });
                drawLinks();
                var inputs = links.querySelectorAll("input");
                if (inputs.length) inputs[inputs.length - 2].focus();
              }
            })
          )
        )
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Look" }),
        el(
          "div",
          { class: "stack" },
          el(
            "div",
            { role: "radiogroup", "aria-label": "Theme" },
            el("span", { class: "field-label", text: "Theme" }),
            el("div", { class: "choices" }, themeChoice("light", "Light"), themeChoice("dark", "Dark"))
          ),
          el(
            "div",
            null,
            el("span", { class: "field-label", text: "Accent color" }),
            el(
              "div",
              { class: "row" },
              colour,
              el("button", {
                class: "button small quiet",
                type: "button",
                text: "Reset",
                onclick: function () {
                  site.accent = "#0e627f";
                  colour.value = site.accent;
                  changed();
                }
              })
            ),
            el("small", { class: "hint", text: "Used for small highlights: underlines, arrows and buttons." })
          )
        )
      ),
      HOST
        ? el(
            "details",
            { class: "box", style: "margin-top:20px" },
            el("summary", { text: "Your editing key" }),
            el("p", { text: "This browser remembers your editing key, so you won't be asked again here. On another computer or phone, open this editor and paste the same key." }),
            el(
              "p",
              { style: "margin-top:10px" },
              "Lost it, or it stopped working? ",
              el("a", { href: GitHub.KEY_URL, target: "_blank", rel: "noopener", text: "Make a new key on GitHub" }),
              ", then sign out here and paste the new one."
            )
          )
        : el("details", { class: "box", style: "margin-top:20px" }, el("summary", { text: "Change editor password" }), passwordForm),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Sections" }),
        el(
          "form",
          {
            class: "inline-form",
            onsubmit: function (event) {
              event.preventDefault();
              var input = event.target.querySelector("input");
              var title = input.value.trim();
              if (!title) return input.focus();
              var section = { id: uniqueId(content.sections, title, "section"), title: title, description: "", cover: "", hidden: false, items: [] };
              content.sections.push(section);
              changed();
              go("section:" + section.id);
            }
          },
          el("input", { type: "text", maxlength: 60, "aria-label": "New section name", placeholder: "New section name, e.g. Photography" }),
          el("button", { class: "button", type: "submit", text: "Add section" })
        ),
        el("p", { class: "hint", text: "To rename, hide or delete a section, open it and use Section settings at the bottom." })
      )
    );
  }

  /* ---------- publish ---------- */

  function publishPanel() {
    if (HOST) return livePanel();
    var download = el("button", {
      class: "button primary",
      type: "button",
      text: "Download website (.zip)",
      onclick: function () {
        download.disabled = true;
        Promise.resolve(dirty ? save() : null)
          .then(function () {
            return api("export-ticket", { method: "POST" });
          })
          .then(
            function (data) {
              var link = el("a", { href: API + "export?ticket=" + encodeURIComponent(data.ticket), download: "portfolio-site.zip" });
              document.body.appendChild(link);
              link.click();
              link.remove();
            },
            function (error) {
              toast(error.message, { error: true });
            }
          )
          .then(function () {
            download.disabled = false;
          });
      }
    });

    return el(
      "div",
      null,
      el(
        "div",
        { class: "panel-head" },
        el("h1", { text: "Publish" }),
        el("p", { text: "Your finished website is a folder of ordinary files, so it can live on any web host." })
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Put it online" }),
        el(
          "ol",
          { class: "steps" },
          el("li", null, "Download the website.", el("div", { style: "margin-top:8px" }, download)),
          el(
            "li",
            null,
            "Unzip it, then drag the folder onto ",
            el("a", { href: "https://app.netlify.com/drop", target: "_blank", rel: "noopener", text: "app.netlify.com/drop" }),
            " (free), or upload it to any other web host."
          ),
          el("li", null, "After you change anything here, download and upload again to update the live site.")
        )
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Keep it fast" }),
        el("p", {
          text:
            "For videos longer than a minute or two, upload them to YouTube or Vimeo and paste the link here instead of uploading the file. They start faster for visitors and keep your website small."
        })
      )
    );
  }

  function drawPanel() {
    panel.textContent = "";
    var section = currentSection();
    if (section) {
      panel.appendChild(sectionPanel(section));
      drawItems();
      drawUploads();
    } else if (current === "publish") {
      panel.appendChild(publishPanel());
    } else {
      current = "site";
      panel.appendChild(sitePanel());
    }
  }

  /* ---------- drag files onto the page ---------- */

  var dragDepth = 0;

  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return Boolean(types) && Array.prototype.indexOf.call(types, "Files") !== -1;
  }

  window.addEventListener("dragenter", function (event) {
    if (!hasFiles(event) || app.hidden) return;
    event.preventDefault();
    dragDepth += 1;
    var section = currentSection();
    document.getElementById("drop-veil-text").textContent = section
      ? "Drop to add to " + section.title
      : "Open a section first, then drop files there";
    veil.hidden = false;
  });
  window.addEventListener("dragover", function (event) {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", function (event) {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) veil.hidden = true;
  });
  window.addEventListener("drop", function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    veil.hidden = true;
    var section = currentSection();
    var files = Array.prototype.slice.call(event.dataTransfer.files || []);
    if (section && files.length && !app.hidden) addFiles(section, files);
  });


  /* ---------- the published site: saving straight to its files ---------- */

  function makeHost(key) {
    return new GitHub({
      api: HOST.api,
      token: key,
      owner: HOST.owner,
      repo: HOST.repo,
      branch: HOST.branch,
      onWait: function (seconds) {
        toast("GitHub asked us to slow down. Carrying on in " + seconds + " seconds…", { duration: 8000 });
      }
    });
  }

  function setKey(value) {
    try {
      if (value) localStorage.setItem(KEY_NAME, value);
      else localStorage.removeItem(KEY_NAME);
    } catch (e) {
      /* private mode: the key lasts until the tab closes */
    }
  }

  /* Check a pasted key really can change this site. */
  function connect(key) {
    var candidate = makeHost(key);
    return candidate.repoInfo().then(
      function (repo) {
        if (!repo.permissions || !repo.permissions.push) {
          var error = new Error("That key can't change this site. Make the key while signed in to the GitHub account that owns the site, with the “repo” box ticked.");
          throw error;
        }
        gh = candidate;
      },
      function (error) {
        if (error.code === "missing") {
          throw new Error("That key can't see this site. Make the key while signed in to the GitHub account that owns the site, with the “repo” box ticked.");
        }
        throw error;
      }
    );
  }

  function hostedLoad() {
    return Promise.all([gh.readText("content.js"), gh.readText("index.html"), gh.listFiles()]).then(function (parts) {
      var text = parts[0];
      indexHtml = parts[1];
      liveFiles = {};
      parts[2].forEach(function (entry) {
        liveFiles[entry.path] = true;
      });
      waitingFiles = {};
      waitingRemovals = {};
      liveState = "";
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    });
  }

  function usedFiles() {
    var used = {};
    function add(value) {
      if (typeof value === "string" && value.indexOf("media/") === 0) used[value] = true;
    }
    add(content.site.banner);
    content.sections.forEach(function (section) {
      add(section.cover);
      section.items.forEach(function (item) {
        add(item.src);
        add(item.thumb);
      });
    });
    return used;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* Keep the page title (browser tab, Google, link previews) in step with the content. */
  function withMeta(html) {
    var title = escapeHtml(content.site.name || "Portfolio");
    var description = escapeHtml(content.site.headline || content.site.intro || "Portfolio");
    var block =
      "<!--meta:start-->\n" +
      "<title>" + title + "</title>\n" +
      '<meta name="description" content="' + description + '">\n' +
      '<meta property="og:title" content="' + title + '">\n' +
      '<meta property="og:description" content="' + description + '">\n' +
      '<meta property="og:type" content="website">\n' +
      "<!--meta:end-->";
    return html.replace(/<!--meta:start-->[\s\S]*?<!--meta:end-->/, function () {
      return block;
    });
  }

  function hostedSave() {
    var used = usedFiles();
    var changes = [{ path: "content.js", text: "window.PORTFOLIO = " + JSON.stringify(content, null, 2) + ";\n" }];
    var added = [];
    var removed = [];

    Object.keys(waitingRemovals).forEach(function (path) {
      delete waitingRemovals[path];
      if (used[path]) return; /* back in use (for example after Undo) */
      if (waitingFiles[path]) {
        delete waitingFiles[path];
        return;
      }
      if (liveFiles[path]) {
        removed.push(path);
        changes.push({ path: path, remove: true });
      }
    });
    Object.keys(waitingFiles).forEach(function (path) {
      added.push(path);
      changes.push({ path: path, sha: waitingFiles[path] });
    });

    var nextIndex = indexHtml ? withMeta(indexHtml) : "";
    if (nextIndex && nextIndex !== indexHtml) changes.push({ path: "index.html", text: nextIndex });

    return gh.commit("Update portfolio from the editor", changes).then(
      function (commit) {
        added.forEach(function (path) {
          liveFiles[path] = true;
          delete waitingFiles[path];
        });
        removed.forEach(function (path) {
          delete liveFiles[path];
        });
        if (nextIndex) indexHtml = nextIndex;
        if (commit) watchLiveSite(commit);
      },
      function (error) {
        /* Nothing was changed on the site: try the removals again next time. */
        removed.forEach(function (path) {
          waitingRemovals[path] = true;
        });
        throw error;
      }
    );
  }

  /* After a save, GitHub takes a minute or so to put the change on the live site. Watch for it. */
  var liveTarget = "";
  var liveSince = 0;
  var liveTimer = null;

  function watchLiveSite(commit) {
    liveTarget = commit;
    liveSince = Date.now();
    liveState = "updating";
    if (!liveTimer) liveTimer = setTimeout(checkLiveSite, 8000);
  }

  function checkLiveSite() {
    liveTimer = null;
    if (!gh) return;
    gh.latestBuild()
      .then(
        function (build) {
          if (build && build.commit === liveTarget && build.status === "built") return "live";
          if (build && build.commit === liveTarget && build.status === "errored") return "slow";
          return Date.now() - liveSince > 4 * 60 * 1000 ? "slow" : "updating";
        },
        function () {
          return "slow";
        }
      )
      .then(function (state) {
        liveState = state;
        if (state === "updating") liveTimer = setTimeout(checkLiveSite, 6000);
        if (!dirty && !savingNow) showSaveState("saved");
      });
  }

  function hostedUpload(blob, name, onProgress) {
    var ext = (String(name).match(/\.([a-z0-9]+)$/i) || ["", ""])[1].toLowerCase();
    if (HOSTED_TYPES.indexOf(ext) === -1) {
      return Promise.reject(new Error("This type of file can't be added. Use an image, video, audio file or PDF."));
    }
    if (blob.size > HOSTED_MAX) {
      return Promise.reject(
        new Error(
          "This file is " + Math.round(blob.size / 1024 / 1024) + " MB. Files over 50 MB can't be stored on the site. Upload it to YouTube or Vimeo, then paste its link here instead."
        )
      );
    }
    return gh.uploadFile(blob, onProgress).then(function (sha) {
      var path = "media/" + slug(String(name).replace(/\.[^.]+$/, ""), "file") + "-" + randomId().slice(0, 6) + "." + ext;
      waitingFiles[path] = sha;
      if (/^(png|jpe?g|gif|webp|avif)$/.test(ext)) localPreviews[path] = URL.createObjectURL(blob);
      return path;
    });
  }

  var OEMBED = [
    { test: /(^|\.)youtube\.com$|^youtu\.be$/, endpoint: "https://www.youtube.com/oembed?format=json&url=" },
    { test: /(^|\.)vimeo\.com$/, endpoint: "https://vimeo.com/api/oembed.json?url=" },
    { test: /(^|\.)soundcloud\.com$/, endpoint: "https://soundcloud.com/oembed?format=json&url=" },
    { test: /(^|\.)tiktok\.com$/, endpoint: "https://www.tiktok.com/oembed?url=" }
  ];

  function fetchQuickly(url, seconds) {
    var stop = new AbortController();
    var timer = setTimeout(function () {
      stop.abort();
    }, seconds * 1000);
    return fetch(url, { signal: stop.signal, credentials: "omit" }).then(
      function (reply) {
        clearTimeout(timer);
        return reply;
      },
      function (error) {
        clearTimeout(timer);
        throw error;
      }
    );
  }

  /* Title and thumbnail for a pasted YouTube / Vimeo / SoundCloud / TikTok link. */
  function hostedLinkInfo(address, type) {
    var target;
    try {
      target = new URL(address);
    } catch (e) {
      return Promise.resolve({});
    }
    var provider = OEMBED.filter(function (p) {
      return p.test.test(target.hostname.toLowerCase());
    })[0];
    if (!provider) return Promise.resolve({});
    return fetchQuickly(provider.endpoint + encodeURIComponent(target.href), 7)
      .then(function (reply) {
        return reply.ok ? reply.json() : {};
      })
      .then(function (info) {
        var width = Number(info.width);
        var height = Number(info.height);
        var result = {
          title: typeof info.title === "string" ? info.title.slice(0, 200) : "",
          thumb: "",
          ratio: width > 0 && height > 0 ? width / height : 0
        };
        var remote = typeof info.thumbnail_url === "string" && /^https:\/\//.test(info.thumbnail_url) ? info.thumbnail_url : "";
        if (!remote) return result;
        /* Keep our own copy of the thumbnail when the provider allows it, so it can't disappear later. */
        return fetchQuickly(remote, 7)
          .then(function (reply) {
            if (!reply.ok) throw new Error("no thumbnail");
            return reply.blob();
          })
          .then(function (blob) {
            var ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type];
            if (!ext || !blob.size || blob.size > 8 * 1024 * 1024) throw new Error("no thumbnail");
            return hostedUpload(blob, slug(result.title, "link") + "-thumb." + ext);
          })
          .then(
            function (path) {
              result.thumb = path;
              return result;
            },
            function () {
              /* TikTok's thumbnail addresses expire, so leave those blank rather than break later. */
              result.thumb = type === "tiktok" ? "" : remote;
              return result;
            }
          );
      })
      .catch(function () {
        return {};
      });
  }

  /* Pictures added a moment ago aren't on the live site yet: fetch them from the saved files instead. */
  if (HOST) {
    document.addEventListener(
      "error",
      function (event) {
        var img = event.target;
        if (!img || img.tagName !== "IMG" || img.getAttribute("data-second-try")) return;
        var match = String(img.getAttribute("src") || "").match(/^\.\.\/(media\/.+)$/);
        if (!match || HOST.api) return;
        img.setAttribute("data-second-try", "1");
        img.src =
          "https://raw.githubusercontent.com/" + HOST.owner + "/" + HOST.repo + "/" + encodeURIComponent(HOST.branch || "main") + "/" + match[1];
      },
      true
    );
  }

  function livePanel() {
    var address = new URL("../", location.href).href;
    var copied = el("span", { class: "hint", role: "status", style: "margin-left:10px" });
    return el(
      "div",
      null,
      el("div", { class: "panel-head" }, el("h1", { text: "Your live site" }), el("p", { text: "Your portfolio is online. This is the address to share." })),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Address" }),
        el("p", null, el("a", { href: address, target: "_blank", rel: "noopener", text: address.replace(/^https?:\/\//, "") })),
        el(
          "div",
          { style: "margin-top:12px" },
          el("button", {
            class: "button small",
            type: "button",
            text: "Copy address",
            onclick: function () {
              var done = function () {
                copied.textContent = "Copied";
              };
              var failed = function () {
                copied.textContent = "Couldn't copy. Select the address above and copy it instead.";
              };
              if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(address).then(done, failed);
              else failed();
            }
          }),
          copied
        )
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "How changes go live" }),
        el("p", { text: "Everything you change here is saved to your live site automatically. It takes about a minute to show up. Watch the note at the top of this page: it says when your live site is up to date." }),
        el("p", { style: "margin-top:10px", text: "To come back and edit later, open your site address with /admin/ on the end. On the computer you're using now, an “Edit site” link also appears at the bottom of your site. Visitors never see it." })
      ),
      el(
        "section",
        { class: "box" },
        el("h2", { text: "Videos" }),
        el("p", {
          text:
            "Files up to 50 MB can be added straight to the site. For anything bigger, and for most videos longer than a minute, upload the video to YouTube or Vimeo and paste its link here. It starts faster for visitors too."
        })
      )
    );
  }

  /* ---------- sign in ---------- */

  function setToken(value) {
    token = value || "";
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* private mode: stay signed in until the tab closes */
    }
  }

  var gateMode = "signin";

  function showGate(mode, message) {
    gateMode = mode;
    var creating = mode === "create";
    app.hidden = true;
    gate.hidden = false;
    document.getElementById("gate-help").hidden = mode !== "key";
    if (mode === "key") {
      document.getElementById("gate-title").textContent = "Portfolio editor";
      document.getElementById("gate-text").textContent = message || "Paste your editing key to change your site.";
      document.getElementById("gate-label").textContent = "Editing key";
      document.getElementById("gate-password").autocomplete = "off";
      document.getElementById("gate-confirm-field").hidden = true;
      document.getElementById("gate-submit").textContent = "Open editor";
      document.getElementById("gate-error").hidden = true;
      document.getElementById("gate-password").value = "";
      document.getElementById("gate-new-key").href = GitHub.KEY_URL;
      document.getElementById("gate-password").focus();
      return;
    }
    document.getElementById("gate-title").textContent = creating ? "Set a password" : "Portfolio editor";
    document.getElementById("gate-text").textContent =
      message || (creating ? "Choose a password for this editor. Only someone with it can change your site." : "Sign in to edit your site.");
    document.getElementById("gate-label").textContent = creating ? "New password (8 or more characters)" : "Password";
    document.getElementById("gate-password").autocomplete = creating ? "new-password" : "current-password";
    document.getElementById("gate-confirm-field").hidden = !creating;
    document.getElementById("gate-submit").textContent = creating ? "Save password and open editor" : "Sign in";
    document.getElementById("gate-error").hidden = true;
    document.getElementById("gate-password").value = "";
    document.getElementById("gate-confirm").value = "";
    document.getElementById("gate-password").focus();
  }

  document.getElementById("gate-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var password = document.getElementById("gate-password").value;
    var error = document.getElementById("gate-error");
    var button = document.getElementById("gate-submit");
    function show(message) {
      error.textContent = message;
      error.hidden = false;
    }
    error.hidden = true;
    if (gateMode === "key") {
      var key = password.replace(/\s+/g, "");
      if (!key) return show("Paste your editing key.");
      button.disabled = true;
      button.textContent = "Checking…";
      connect(key)
        .then(function () {
          setKey(key);
          if (content && dirty) {
            /* Signed back in after a key stopped working: keep the unsaved work and save it now. */
            gate.hidden = true;
            app.hidden = false;
            return save();
          }
          return openEditor();
        })
        .catch(function (problem) {
          gh = null;
          show(problem.message || "That didn't work. Please try again.");
        })
        .then(function () {
          button.disabled = false;
          button.textContent = "Open editor";
        });
      return;
    }
    if (gateMode === "create") {
      if (password.length < 8) return show("Use at least 8 characters.");
      if (password !== document.getElementById("gate-confirm").value) return show("Those two passwords don't match.");
    } else if (!password) {
      return show("Type your password.");
    }
    button.disabled = true;
    api(gateMode === "create" ? "setup" : "login", { method: "POST", json: { password: password }, gate: true })
      .then(
        function (data) {
          setToken(data.token);
          return openEditor();
        },
        function (problem) {
          show(problem.message);
        }
      )
      .then(function () {
        button.disabled = false;
      });
  });

  document.getElementById("sign-out").addEventListener("click", function () {
    Promise.resolve(dirty ? save() : null).then(function () {
      if (HOST) {
        setKey("");
        gh = null;
        return showGate("key");
      }
      setToken("");
      showGate("signin");
    });
  });

  function openEditor() {
    return (HOST ? hostedLoad() : api("content")).then(function (data) {
      content = data && typeof data === "object" ? data : {};
      content.site = content.site || {};
      content.site.links = Array.isArray(content.site.links) ? content.site.links : [];
      content.sections = Array.isArray(content.sections) ? content.sections : [];
      content.sections.forEach(function (section) {
        section.items = Array.isArray(section.items) ? section.items : [];
      });
      if (!currentSection() && current !== "publish") {
        current = content.sections.length ? "section:" + content.sections[0].id : "site";
      }
      gate.hidden = true;
      app.hidden = false;
      dirty = false;
      showSaveState("saved");
      drawSidebar();
      drawPanel();
    });
  }

  if (HOST) {
    var savedKey = "";
    try {
      savedKey = localStorage.getItem(KEY_NAME) || "";
    } catch (e) {
      savedKey = "";
    }
    if (!savedKey) return showGate("key");
    gh = makeHost(savedKey);
    return openEditor().catch(function (error) {
      gh = null;
      showGate("key", error && error.code === "auth" ? "Your editing key has stopped working. Paste a new one." : (error && error.message) || "");
    });
  }

  fetch(API + "status", { headers: { Authorization: "Bearer " + token } })
    .then(function (reply) {
      return reply.json();
    })
    .then(function (status) {
      if (status.needsPassword) return showGate("create");
      if (!status.signedIn) return showGate("signin");
      return openEditor();
    })
    .catch(function () {
      showGate("signin", "Couldn't reach the editor. Make sure it is running, then reload this page.");
    });
})();
