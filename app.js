/* Draws the portfolio from the data in content.js.
   You normally never need to edit this file: use the editor to change content. */
(function () {
  "use strict";

  var data = window.PORTFOLIO || { site: {}, sections: [] };
  var site = data.site || {};
  var sections = (data.sections || []).filter(function (s) {
    return s && s.id && !s.hidden;
  });
  var E = window.PortfolioEmbeds;

  var main = document.getElementById("main");
  var nav = document.getElementById("site-nav");
  var viewer = document.getElementById("viewer");
  var stage = document.getElementById("viewer-stage");

  /* ---------- small helpers ---------- */

  function el(tag, attrs) {
    var node = document.createElement(tag);
    var key, i, child;
    for (key in attrs || {}) {
      if (attrs[key] === null || attrs[key] === undefined || attrs[key] === false) continue;
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else if (key === "style") node.setAttribute("style", attrs[key]);
      else node.setAttribute(key, attrs[key] === true ? "" : attrs[key]);
    }
    for (i = 2; i < arguments.length; i++) {
      child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function svg(markup, size) {
    var holder = document.createElement("span");
    holder.innerHTML =
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" aria-hidden="true" focusable="false">' + markup + "</svg>";
    return holder.firstChild;
  }

  var ICON = {
    arrow: '<path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    out: '<path d="M7 17L17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>'
  };

  function safeLink(url) {
    var value = String(url || "").trim();
    if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value)) return "mailto:" + value;
    if (/^(media|uploads)\//.test(value)) return value;
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(value)) return "https://" + value;
    return "";
  }

  function mediaPath(path) {
    var value = String(path || "").trim();
    if (!value) return "";
    if (/^(https?:)?\/\//i.test(value)) return value;
    if (/^data:image\//i.test(value)) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
    return value.split("/").map(encodeURIComponent).join("/").replace(/%25([0-9A-F]{2})/gi, "%$1");
  }

  function findSection(id) {
    for (var i = 0; i < sections.length; i++) if (sections[i].id === id) return sections[i];
    return null;
  }

  function itemsOf(section) {
    return (section.items || []).filter(function (item) {
      return item && item.id && !item.hidden;
    });
  }

  function countLabel(n) {
    if (!n) return "Coming soon";
    return n === 1 ? "1 piece" : n + " pieces";
  }

  /* ---------- site chrome ---------- */

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", site.theme === "dark" ? "dark" : "light");
    if (/^#[0-9a-f]{6}$/i.test(site.accent || "")) {
      document.documentElement.style.setProperty("--accent", site.accent);
    }
    var letter = (site.name || "P").trim().charAt(0).toUpperCase() || "P";
    var icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="' +
      (site.accent || "#0e627f") +
      '"/><text x="32" y="45" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="700" text-anchor="middle" fill="#fff">' +
      letter.replace(/[<&]/g, "") + "</text></svg>";
    var link = document.createElement("link");
    link.rel = "icon";
    link.href = "data:image/svg+xml," + encodeURIComponent(icon);
    document.head.appendChild(link);
  }

  function hasContact() {
    return Boolean(site.email || site.about || (site.links || []).length);
  }

  function drawChrome() {
    document.getElementById("wordmark").textContent = site.name || "Portfolio";
    nav.textContent = "";
    sections.forEach(function (section) {
      nav.appendChild(el("a", { href: "#/" + section.id, "data-route": section.id, text: section.title }));
    });
    if (hasContact()) nav.appendChild(el("a", { href: "#/contact", "data-route": "contact", text: "Contact" }));

    var footer = document.getElementById("site-footer");
    footer.textContent = "";
    footer.appendChild(el("p", { text: "© " + new Date().getFullYear() + " " + (site.name || "") }));
    var list = el("ul", { class: "footer-links" });
    (site.links || []).forEach(function (link) {
      var href = safeLink(link.url);
      if (!href || !link.label) return;
      list.appendChild(el("li", null, el("a", { href: href, target: "_blank", rel: "noopener", text: link.label })));
    });
    if (site.email) {
      list.appendChild(el("li", null, el("a", { href: safeLink(site.email), text: "Email" })));
    }
    var editor = window.PORTFOLIO_EDITOR || "";
    try {
      /* On the published site, only a browser that has signed in to the editor sees this link. */
      if (!editor && window.localStorage.getItem("portfolio-editor-key")) editor = "admin/";
    } catch (e) {
      /* no storage here (private mode, previews): no link */
    }
    if (editor) {
      list.appendChild(el("li", null, el("a", { href: editor, text: "Edit site" })));
    }
    footer.appendChild(list);
  }

  function markNav(route) {
    Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) {
      if (a.getAttribute("data-route") === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  /* ---------- pages ---------- */

  function coverFor(section) {
    if (section.cover) return section.cover;
    var items = itemsOf(section);
    for (var i = 0; i < items.length; i++) if (items[i].thumb) return items[i].thumb;
    return "";
  }

  function homePage() {
    var page = el("div", { class: "page wrap" });
    var banner = mediaPath(site.banner);
    var hero = el("section", { class: "hero " + (banner ? "has-banner" : "no-banner") });
    if (banner) hero.appendChild(el("img", { class: "hero-image", src: banner, alt: "" }));
    hero.appendChild(
      el(
        "div",
        { class: "hero-text" },
        el("h1", { text: site.headline || site.name || "Portfolio" }),
        site.intro ? el("p", { text: site.intro }) : null
      )
    );
    page.appendChild(hero);

    var tiles = el("ul", {
      class: "tiles",
      "aria-label": "Sections",
      style: "--tile-columns:" + Math.min(Math.max(sections.length, 2), 4)
    });
    sections.forEach(function (section) {
      var cover = mediaPath(coverFor(section));
      var count = itemsOf(section).length;
      tiles.appendChild(
        el(
          "li",
          null,
          el(
            "a",
            { class: "tile", href: "#/" + section.id },
            el(
              "div",
              { class: "tile-cover" },
              cover
                ? el("img", { src: cover, alt: "", loading: "lazy", decoding: "async" })
                : el("span", { class: "tile-letter", "aria-hidden": "true", text: (section.title || "").charAt(0) })
            ),
            el(
              "div",
              { class: "tile-label" },
              el("h2", { text: section.title }),
              el("span", { class: "tile-arrow" }, svg(ICON.arrow, 20))
            ),
            el("p", { class: "tile-count", text: countLabel(count) })
          )
        )
      );
    });
    page.appendChild(tiles);
    return page;
  }

  function badgeFor(item) {
    if (E.isMoving(item.type)) {
      return el("span", { class: "badge" }, svg(ICON.play, 14), "Play");
    }
    if (item.type === "link" || item.type === "pdf") {
      return el("span", { class: "badge" }, item.type === "pdf" ? "PDF" : "Visit", svg(ICON.out, 14));
    }
    if (item.type === "instagram") return el("span", { class: "badge" }, "Instagram");
    return null;
  }

  function card(section, item) {
    var ratio = Number(item.ratio) > 0 ? Number(item.ratio) : item.type === "image" ? 1.3333 : 1.7778;
    ratio = Math.min(Math.max(ratio, 0.5), 3);
    var inViewer = E.opensInViewer(item.type);
    var href = inViewer ? "#/" + section.id + "/" + item.id : safeLink(item.src) || mediaPath(item.src);
    var attrs = { class: "card", href: href, style: "--r:" + ratio };
    if (!inViewer) {
      attrs.target = "_blank";
      attrs.rel = "noopener";
    }
    var thumbSource = mediaPath(item.thumb || (item.type === "image" ? item.src : ""));
    var thumb = el("div", { class: "card-thumb" });
    if (thumbSource) {
      var img = el("img", { src: thumbSource, alt: "", loading: "lazy", decoding: "async" });
      if (!(Number(item.ratio) > 0) && item.type === "image") {
        img.addEventListener("load", function () {
          if (img.naturalWidth && img.naturalHeight) {
            node.style.setProperty("--r", Math.min(Math.max(img.naturalWidth / img.naturalHeight, 0.5), 3));
            layoutGalleries();
          }
        });
      }
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el("span", { class: "card-blank", "aria-hidden": "true", text: E.label(item.type) }));
    }
    var badge = badgeFor(item);
    if (badge) thumb.appendChild(badge);

    var node = el(
      "a",
      attrs,
      thumb,
      el("h3", { class: "card-title", text: item.title || "Untitled" }),
      item.description ? el("p", { class: "card-text", text: item.description }) : null
    );
    return node;
  }

  function audioBlock(item) {
    var player;
    if (item.type === "soundcloud") {
      player = el("iframe", {
        src: E.embedUrl({ type: "soundcloud", src: item.src, color: site.accent }),
        title: "Audio player: " + (item.title || "SoundCloud"),
        loading: "lazy",
        allow: "autoplay"
      });
    } else {
      player = el("audio", { controls: true, preload: "metadata", src: mediaPath(item.src) });
    }
    return el(
      "article",
      { class: "audio-item" },
      el(
        "div",
        null,
        el("h3", { text: item.title || "Untitled" }),
        item.description ? el("p", { text: item.description }) : null
      ),
      player
    );
  }

  function sectionPage(section) {
    var page = el("div", { class: "page wrap" });
    var items = itemsOf(section);
    page.appendChild(
      el(
        "header",
        { class: "page-head" },
        el("h1", { text: section.title }),
        section.description ? el("p", { text: section.description }) : null
      )
    );

    if (!items.length) {
      page.appendChild(el("p", { class: "empty", text: "Nothing posted here yet." }));
      return page;
    }

    /* Keep items in their saved order, gathered under their group names. */
    var groups = [];
    var byName = {};
    items.forEach(function (item) {
      var name = (item.group || "").trim();
      if (!byName.hasOwnProperty(name)) {
        byName[name] = { name: name, items: [] };
        groups.push(byName[name]);
      }
      byName[name].items.push(item);
    });

    groups.forEach(function (group) {
      var block = el("section", { class: "group" });
      if (group.name) block.appendChild(el("h2", { class: "group-title", text: group.name }));
      var gallery = null;
      group.items.forEach(function (item) {
        if (E.isAudio(item.type)) {
          gallery = null;
          block.appendChild(audioBlock(item));
          return;
        }
        if (!gallery) {
          gallery = el("div", { class: "gallery" });
          block.appendChild(gallery);
        }
        gallery.appendChild(card(section, item));
      });
      page.appendChild(block);
    });
    return page;
  }

  function contactPage() {
    var page = el("div", { class: "page wrap" });
    var body = el("div", { class: "contact" });
    page.appendChild(el("header", { class: "page-head" }, el("h1", { text: "Contact" })));
    if (site.about) body.appendChild(el("p", { class: "contact-about", text: site.about }));
    var list = el("ul", { class: "contact-list" });
    if (site.email) {
      list.appendChild(
        el(
          "li",
          null,
          el(
            "a",
            { href: safeLink(site.email) },
            el("span", null, el("span", { class: "contact-label", text: "Email" }), el("span", { class: "contact-meta", text: site.email })),
            svg(ICON.arrow, 24)
          )
        )
      );
    }
    (site.links || []).forEach(function (link) {
      var href = safeLink(link.url);
      if (!href || !link.label) return;
      var shown = href.replace(/^https?:\/\/(www\.)?/, "").replace(/^mailto:/, "").replace(/\/$/, "");
      list.appendChild(
        el(
          "li",
          null,
          el(
            "a",
            { href: href, target: "_blank", rel: "noopener" },
            el("span", null, el("span", { class: "contact-label", text: link.label }), el("span", { class: "contact-meta", text: shown })),
            svg(ICON.out, 24)
          )
        )
      );
    });
    body.appendChild(list);
    page.appendChild(body);
    return page;
  }

  function missingPage() {
    return el(
      "div",
      { class: "page wrap" },
      el(
        "header",
        { class: "page-head" },
        el("h1", { text: "Page not found" }),
        el("p", null, "That page isn't here. ", el("a", { href: "#/", text: "Go to the home page" }), ".")
      )
    );
  }

  /* Size the cards so each row of a gallery is the same height and fills the
     full width, whatever mix of wide and tall pieces it holds. */
  function layoutGalleries() {
    var galleries = main.querySelectorAll(".gallery");
    if (!galleries.length) return;
    var gap = 20;
    var plans = [];
    var fullHeights = [];

    Array.prototype.forEach.call(galleries, function (gallery) {
      var width = gallery.clientWidth;
      if (!width) return;
      var target = width < 520 ? 210 : width < 900 ? 270 : 330;
      var cards = Array.prototype.slice.call(gallery.children);
      var rows = [];
      var row = [];
      var sum = 0;

      function fill(count, total) {
        return (width - gap * (count - 1)) / total;
      }
      function close(full) {
        rows.push({ cards: row, sum: sum, height: fill(row.length, sum), full: full });
        row = [];
        sum = 0;
      }

      cards.forEach(function (node) {
        var ratio = parseFloat(node.style.getPropertyValue("--r")) || 1.5;
        if (row.length) {
          var without = fill(row.length, sum);
          var withIt = fill(row.length + 1, sum + ratio);
          if (withIt < target && Math.abs(without - target) <= Math.abs(withIt - target)) close(true);
        }
        row.push({ node: node, ratio: ratio });
        sum += ratio;
      });
      if (row.length) close(fill(row.length, sum) <= target * 1.12);

      rows.forEach(function (r) {
        if (r.full) fullHeights.push(r.height);
      });
      plans.push({ width: width, target: target, rows: rows });
    });

    fullHeights.sort(function (a, b) {
      return a - b;
    });
    var usual = fullHeights.length ? fullHeights[Math.floor(fullHeights.length / 2)] : 0;

    plans.forEach(function (plan) {
      plan.rows.forEach(function (r) {
        var height = r.full ? r.height : Math.min(usual || plan.target, r.height);
        r.cards.forEach(function (c) {
          var w = Math.min(plan.width, c.ratio * height);
          c.node.style.setProperty("--w", Math.floor(w * 100) / 100 - 0.02 + "px");
        });
      });
    });
  }

  var lastWidth = 0;
  function relayoutIfResized() {
    if (main.clientWidth === lastWidth) return;
    lastWidth = main.clientWidth;
    layoutGalleries();
  }
  if (window.ResizeObserver) new ResizeObserver(relayoutIfResized).observe(main);
  else window.addEventListener("resize", relayoutIfResized);

  /* ---------- viewer ---------- */

  var viewing = null; /* { section, list, index } */
  var openedByClick = false;

  function clearStage() {
    Array.prototype.forEach.call(stage.querySelectorAll("video"), function (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    stage.textContent = "";
  }

  function stageFor(item) {
    var ratio = Number(item.ratio) > 0 ? Number(item.ratio) : 1.7778;
    if (item.type === "image") {
      return el("img", { src: mediaPath(item.src), alt: item.title || "" });
    }
    var frame = el("div", { class: "stage-frame", style: "--r:" + ratio });
    if (item.type === "video") {
      frame.appendChild(
        el("video", {
          src: mediaPath(item.src),
          poster: mediaPath(item.thumb) || null,
          controls: true,
          autoplay: true,
          playsinline: true,
          preload: "metadata"
        })
      );
      return frame;
    }
    if (item.type === "instagram" || item.type === "tiktok") frame.className += " is-post";
    frame.appendChild(
      el("iframe", {
        src: E.embedUrl(item, true),
        title: item.title || E.label(item.type),
        allow: "autoplay; fullscreen; picture-in-picture; encrypted-media",
        allowfullscreen: true,
        referrerpolicy: "strict-origin-when-cross-origin"
      })
    );
    return frame;
  }

  function showInViewer(index) {
    var item = viewing.list[index];
    viewing.index = index;
    clearStage();
    stage.appendChild(stageFor(item));
    document.getElementById("viewer-title").textContent = item.title || "Untitled";
    document.getElementById("viewer-description").textContent = item.description || "";
    document.getElementById("viewer-count").textContent = index + 1 + " / " + viewing.list.length;
    var full = document.getElementById("viewer-full");
    if (item.type === "image") {
      full.hidden = false;
      full.href = mediaPath(item.src);
    } else {
      full.hidden = true;
      full.removeAttribute("href");
    }
    var single = viewing.list.length < 2;
    document.getElementById("viewer-prev").disabled = single;
    document.getElementById("viewer-next").disabled = single;
    document.title = (item.title || "Untitled") + " — " + (site.name || "Portfolio");
  }

  function openViewer(section, itemId) {
    var list = itemsOf(section).filter(function (item) {
      return E.opensInViewer(item.type);
    });
    var index = -1;
    list.forEach(function (item, i) {
      if (item.id === itemId) index = i;
    });
    if (index === -1) return false;
    viewing = { section: section, list: list, index: index };
    showInViewer(index);
    if (!viewer.open) {
      viewer.showModal();
      document.getElementById("viewer-close").focus();
    }
    return true;
  }

  function step(direction) {
    if (!viewing || viewing.list.length < 2) return;
    var next = (viewing.index + direction + viewing.list.length) % viewing.list.length;
    setAddress("#/" + viewing.section.id + "/" + viewing.list[next].id, true);
    showInViewer(next);
  }

  function requestClose() {
    if (!viewing) return;
    if (openedByClick && addressWorks) {
      history.back();
    } else {
      setAddress("#/" + viewing.section.id, true);
      route();
    }
  }

  function shutViewer() {
    if (viewer.open) viewer.close();
    clearStage();
    viewing = null;
    openedByClick = false;
  }

  document.getElementById("viewer-close").addEventListener("click", requestClose);
  document.getElementById("viewer-prev").addEventListener("click", function () {
    step(-1);
  });
  document.getElementById("viewer-next").addEventListener("click", function () {
    step(1);
  });
  viewer.addEventListener("cancel", function (event) {
    event.preventDefault();
    requestClose();
  });
  viewer.addEventListener("click", function (event) {
    if (event.target === stage || event.target === viewer) requestClose();
  });
  viewer.addEventListener("keydown", function (event) {
    var tag = (event.target.tagName || "").toLowerCase();
    if (tag === "video") return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });

  /* ---------- routing ---------- */

  var shownPage = null;

  /* Which page we're on. Normally this mirrors the address bar, but if the page
     is shown somewhere the address can't be changed, it still works on its own. */
  var here = location.hash || "#/";
  var addressWorks = true;

  function setAddress(hash, replace) {
    here = hash;
    if (!addressWorks) return;
    try {
      history[replace ? "replaceState" : "pushState"](null, "", hash);
      if (location.hash !== hash && !(hash === "#/" && !location.hash)) addressWorks = false;
    } catch (e) {
      addressWorks = false;
    }
  }

  function route() {
    var hash = here || "#/";
    if (hash.charAt(1) !== "/") hash = "#/";
    var parts = hash
      .slice(2)
      .split("/")
      .filter(Boolean)
      .map(function (part) {
        try {
          return decodeURIComponent(part);
        } catch (e) {
          return part;
        }
      });
    var key = parts[0] || "home";
    var section = findSection(key);
    var title = site.name || "Portfolio";

    if (key !== shownPage) {
      var page;
      if (key === "home") page = homePage();
      else if (key === "contact" && hasContact()) page = contactPage();
      else if (section) page = sectionPage(section);
      else page = missingPage();
      main.textContent = "";
      main.appendChild(page);
      layoutGalleries();
      if (shownPage !== null) {
        window.scrollTo(0, 0);
        main.focus({ preventScroll: true });
      }
      shownPage = key;
      markNav(key);
    }

    if (key === "contact") title = "Contact — " + title;
    else if (section) title = section.title + " — " + title;
    document.title = title;

    if (section && parts[1]) {
      if (!openViewer(section, parts[1])) {
        setAddress("#/" + section.id, true);
        shutViewer();
      }
    } else {
      var returnTo = viewing ? "#/" + viewing.section.id + "/" + viewing.list[viewing.index].id : "";
      shutViewer();
      if (returnTo) {
        var opener = main.querySelector('a[href="' + returnTo + '"]');
        if (opener) opener.focus({ preventScroll: true });
      }
    }
  }

  /* Links inside the site ("#/film") are handled here rather than by the browser. */
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link || link.target) return;
    var href = link.getAttribute("href");
    if (href.slice(0, 2) !== "#/") return;
    event.preventDefault();
    if (href === here) return;
    if (link.classList.contains("card")) openedByClick = true;
    setAddress(href, false);
    route();
  });

  document.getElementById("skip-link").addEventListener("click", function (event) {
    event.preventDefault();
    main.focus();
  });

  function addressChanged() {
    if (!addressWorks) return;
    here = location.hash || "#/";
    route();
  }
  window.addEventListener("popstate", addressChanged);
  window.addEventListener("hashchange", addressChanged);

  applyTheme();
  drawChrome();
  route();
})();
