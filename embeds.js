/* Works out what kind of media a pasted link is, and how to embed it.
   Shared by the public site (app.js) and the editor (admin). */
(function () {
  "use strict";

  function toUrl(value) {
    try {
      return new URL(String(value).trim());
    } catch (e) {
      return null;
    }
  }

  function host(u) {
    return u.hostname.replace(/^(www|m|mobile)\./, "").toLowerCase();
  }

  function youtubeId(u) {
    var h = host(u);
    var m;
    if (h === "youtu.be") {
      m = u.pathname.match(/^\/([\w-]{6,})/);
      return m ? { id: m[1], short: false } : null;
    }
    if (h === "youtube.com" || h === "music.youtube.com" || h === "youtube-nocookie.com") {
      if (u.pathname === "/watch" && u.searchParams.get("v")) {
        return { id: u.searchParams.get("v"), short: false };
      }
      m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return { id: m[2], short: m[1] === "shorts" };
    }
    return null;
  }

  function vimeoId(u) {
    var h = host(u);
    if (h !== "vimeo.com" && h !== "player.vimeo.com") return null;
    var m = u.pathname.match(/\/(\d{6,})(?:\/([0-9a-f]+))?/);
    if (!m) return null;
    return { id: m[1], hash: m[2] || u.searchParams.get("h") || "" };
  }

  function instagramCode(u) {
    if (host(u) !== "instagram.com") return null;
    var m = u.pathname.match(/\/(p|reel|reels|tv)\/([\w-]+)/);
    if (!m) return null;
    return { kind: m[1] === "p" ? "p" : "reel", code: m[2] };
  }

  function tiktokId(u) {
    if (!/(^|\.)tiktok\.com$/.test(host(u))) return null;
    var m = u.pathname.match(/\/(?:video|v|embed\/v2)\/(\d+)/);
    return m ? m[1] : null;
  }

  function extension(u) {
    var m = u.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return m ? m[1] : "";
  }

  var IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"];
  var VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv"];
  var AUDIO_EXT = ["mp3", "m4a", "wav", "ogg", "oga", "aac", "flac"];

  /* Takes whatever was pasted (a link, or a block of <iframe> embed code)
     and returns { type, src, ratio, thumb } or null if it is not a link. */
  function detect(input) {
    var text = String(input || "").trim();
    var frame = text.match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
    var fromEmbedCode = false;
    if (frame) {
      text = frame[1].replace(/&amp;/g, "&");
      fromEmbedCode = true;
    }
    if (/^\/\//.test(text)) text = "https:" + text;
    if (!/^https?:\/\//i.test(text) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(text)) text = "https://" + text;
    var u = toUrl(text);
    if (!u || !/^https?:$/.test(u.protocol)) return null;

    var yt = youtubeId(u);
    if (yt) {
      return {
        type: "youtube",
        src: u.href,
        ratio: yt.short ? 0.5625 : 1.7778,
        thumb: "https://i.ytimg.com/vi/" + yt.id + "/hqdefault.jpg"
      };
    }
    if (vimeoId(u)) return { type: "vimeo", src: u.href, ratio: 1.7778, thumb: "" };
    if (host(u) === "soundcloud.com" || host(u) === "api.soundcloud.com" || host(u) === "on.soundcloud.com") {
      return { type: "soundcloud", src: u.href, ratio: 0, thumb: "" };
    }
    if (host(u) === "w.soundcloud.com" && u.searchParams.get("url")) {
      return { type: "soundcloud", src: u.searchParams.get("url"), ratio: 0, thumb: "" };
    }
    if (instagramCode(u)) return { type: "instagram", src: u.href, ratio: 0.8, thumb: "" };
    if (tiktokId(u)) return { type: "tiktok", src: u.href, ratio: 0.5625, thumb: "" };

    var ext = extension(u);
    if (IMAGE_EXT.indexOf(ext) !== -1) return { type: "image", src: u.href, ratio: 0, thumb: u.href };
    if (VIDEO_EXT.indexOf(ext) !== -1) return { type: "video", src: u.href, ratio: 1.7778, thumb: "" };
    if (AUDIO_EXT.indexOf(ext) !== -1) return { type: "audio", src: u.href, ratio: 0, thumb: "" };
    if (ext === "pdf") return { type: "pdf", src: u.href, ratio: 0, thumb: "" };

    if (fromEmbedCode) return { type: "embed", src: u.href, ratio: 1.7778, thumb: "" };
    return { type: "link", src: u.href, ratio: 0, thumb: "" };
  }

  /* The address to load inside an <iframe> for this item, or "" if it has none. */
  function embedUrl(item, autoplay) {
    var u = toUrl(item.src);
    if (!u) return "";
    var play = autoplay ? "1" : "0";
    if (item.type === "youtube") {
      var yt = youtubeId(u);
      if (!yt) return "";
      var start = u.searchParams.get("t") || u.searchParams.get("start") || "";
      var seconds = parseInt(start, 10);
      return (
        "https://www.youtube-nocookie.com/embed/" + yt.id +
        "?rel=0&playsinline=1&autoplay=" + play +
        (seconds > 0 ? "&start=" + seconds : "")
      );
    }
    if (item.type === "vimeo") {
      var v = vimeoId(u);
      if (!v) return "";
      return (
        "https://player.vimeo.com/video/" + v.id +
        "?autoplay=" + play + "&dnt=1" + (v.hash ? "&h=" + v.hash : "")
      );
    }
    if (item.type === "soundcloud") {
      return (
        "https://w.soundcloud.com/player/?url=" + encodeURIComponent(u.href) +
        "&color=%23" + String(item.color || "0e627f").replace("#", "") +
        "&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false"
      );
    }
    if (item.type === "instagram") {
      var ig = instagramCode(u);
      return ig ? "https://www.instagram.com/" + ig.kind + "/" + ig.code + "/embed/" : "";
    }
    if (item.type === "tiktok") {
      var tk = tiktokId(u);
      return tk ? "https://www.tiktok.com/embed/v2/" + tk : "";
    }
    if (item.type === "embed") return u.href;
    return "";
  }

  var LABELS = {
    image: "Image",
    video: "Video",
    audio: "Audio",
    pdf: "PDF",
    youtube: "YouTube",
    vimeo: "Vimeo",
    soundcloud: "SoundCloud",
    instagram: "Instagram",
    tiktok: "TikTok",
    embed: "Embedded player",
    link: "Link"
  };

  window.PortfolioEmbeds = {
    detect: detect,
    embedUrl: embedUrl,
    label: function (type) {
      return LABELS[type] || "Media";
    },
    /* Opens in the on-page viewer (true) or is shown / linked another way (false). */
    opensInViewer: function (type) {
      return ["image", "video", "youtube", "vimeo", "instagram", "tiktok", "embed"].indexOf(type) !== -1;
    },
    isMoving: function (type) {
      return ["video", "youtube", "vimeo", "tiktok", "embed"].indexOf(type) !== -1;
    },
    isAudio: function (type) {
      return type === "audio" || type === "soundcloud";
    }
  };
})();
