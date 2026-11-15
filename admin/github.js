/* A small helper for saving files to a GitHub repository from the browser.
   The editor uses it when the site is live on GitHub Pages: there is no
   server there, so every change is saved straight into the site's files. */
(function () {
  "use strict";

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function problem(code, message, status) {
    var error = new Error(message);
    error.code = code;
    error.status = status || 0;
    return error;
  }

  function GitHub(options) {
    this.api = String(options.api || "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token || "";
    this.owner = options.owner || "";
    this.repo = options.repo || "";
    this.branch = options.branch || "main";
    this.onWait = options.onWait || function () {};
  }

  GitHub.prototype.repoPath = function () {
    return "/repos/" + encodeURIComponent(this.owner) + "/" + encodeURIComponent(this.repo);
  };

  /* One request to GitHub, with patience: retries dropped connections and
     waits when GitHub asks us to slow down. */
  GitHub.prototype.request = function (method, path, body, options) {
    var self = this;
    options = options || {};
    var headers = {
      Accept: options.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: "Bearer " + self.token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    var payload = body === undefined ? undefined : JSON.stringify(body);

    function attempt(n) {
      return fetch(self.api + path, { method: method, headers: headers, body: payload, cache: "no-store" }).then(
        function (reply) {
          if (reply.ok) {
            if (reply.status === 204) return null;
            return options.raw ? reply.text() : reply.json();
          }
          return reply
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              var message = String(data.message || "");
              var retryAfter = Number(reply.headers.get("retry-after")) || 0;
              var limited =
                (reply.status === 403 || reply.status === 429) && (retryAfter > 0 || /rate limit|secondary|abuse/i.test(message));
              if (limited && n < 4) {
                var wait = Math.min(Math.max(retryAfter, 20), 180);
                self.onWait(wait);
                return sleep(wait * 1000).then(function () {
                  return attempt(n + 1);
                });
              }
              if (reply.status >= 500 && n < 3) {
                return sleep(2000 * (n + 1)).then(function () {
                  return attempt(n + 1);
                });
              }
              if (reply.status === 401) {
                throw problem("auth", "GitHub didn't accept that key. It may have expired or been copied incompletely.", 401);
              }
              if (reply.status === 403) {
                throw problem("forbidden", "That key isn't allowed to do this. Make a new key with the “repo” box ticked.", 403);
              }
              if (reply.status === 404) throw problem("missing", "GitHub couldn't find that. " + message, 404);
              if (reply.status === 409) throw problem("conflict", message || "GitHub is busy with this site. Try again in a moment.", 409);
              if (reply.status === 422) throw problem("invalid", message || "GitHub couldn't accept that change.", 422);
              throw problem("failed", "GitHub returned an error (" + reply.status + "). " + message, reply.status);
            });
        },
        function () {
          if (n < 3) {
            return sleep(1500 * (n + 1)).then(function () {
              return attempt(n + 1);
            });
          }
          throw problem("network", "Couldn't reach GitHub. Check your internet connection, then try again.");
        }
      );
    }
    return attempt(0);
  };

  GitHub.prototype.user = function () {
    return this.request("GET", "/user");
  };

  GitHub.prototype.repoInfo = function () {
    return this.request("GET", this.repoPath());
  };

  GitHub.prototype.createRepo = function (name, description) {
    return this.request("POST", "/user/repos", {
      name: name,
      description: description || "",
      private: false,
      auto_init: true,
      has_issues: false,
      has_projects: false,
      has_wiki: false
    });
  };

  /* The newest saved version: { commit, tree }. */
  GitHub.prototype.head = function () {
    var self = this;
    return self.request("GET", self.repoPath() + "/git/ref/heads/" + encodeURIComponent(self.branch)).then(function (ref) {
      return self.request("GET", self.repoPath() + "/git/commits/" + ref.object.sha).then(function (commit) {
        return { commit: ref.object.sha, tree: commit.tree.sha };
      });
    });
  };

  GitHub.prototype.readText = function (path) {
    var encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request("GET", this.repoPath() + "/contents/" + encoded + "?ref=" + encodeURIComponent(this.branch), undefined, {
      raw: true
    });
  };

  /* Every file in the site: [{ path, sha, size }]. */
  GitHub.prototype.listFiles = function () {
    var self = this;
    return self.head().then(function (head) {
      return self.request("GET", self.repoPath() + "/git/trees/" + head.tree + "?recursive=1").then(function (tree) {
        return (tree.tree || []).filter(function (entry) {
          return entry.type === "blob";
        });
      });
    });
  };

  GitHub.prototype.createBlob = function (content, encoding) {
    return this.request("POST", this.repoPath() + "/git/blobs", { content: content, encoding: encoding || "base64" }).then(
      function (blob) {
        return blob.sha;
      }
    );
  };

  /* Upload one file, reporting progress as it goes. Resolves with the id GitHub gave it. */
  GitHub.prototype.uploadFile = function (file, onProgress) {
    var self = this;
    function send(base64, attempt) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", self.api + self.repoPath() + "/git/blobs");
        xhr.setRequestHeader("Accept", "application/vnd.github+json");
        xhr.setRequestHeader("Authorization", "Bearer " + self.token);
        xhr.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.upload.onprogress = function (event) {
          if (onProgress && event.lengthComputable && event.total) onProgress(event.loaded / event.total);
        };
        xhr.onload = function () {
          var data = {};
          try {
            data = JSON.parse(xhr.responseText);
          } catch (e) {
            data = {};
          }
          if (xhr.status >= 200 && xhr.status < 300 && data.sha) return resolve(data.sha);
          if (xhr.status === 401) return reject(problem("auth", "GitHub didn't accept your editing key. It may have expired.", 401));
          if (xhr.status === 413 || xhr.status === 422) {
            return reject(problem("too-big", "That file is too big to store on the site. Upload it to YouTube or Vimeo and add the link instead.", xhr.status));
          }
          if ((xhr.status >= 500 || xhr.status === 403 || xhr.status === 429) && attempt < 2) {
            return sleep(xhr.status >= 500 ? 3000 : 30000).then(function () {
              return send(base64, attempt + 1);
            }).then(resolve, reject);
          }
          reject(problem("failed", "The upload didn't go through (" + xhr.status + "). Please try again.", xhr.status));
        };
        xhr.onerror = function () {
          if (attempt < 2) {
            return sleep(2000 * (attempt + 1)).then(function () {
              return send(base64, attempt + 1);
            }).then(resolve, reject);
          }
          reject(problem("network", "The upload was interrupted. Check your internet connection, then try again."));
        };
        xhr.send('{"encoding":"base64","content":"' + base64 + '"}');
      });
    }
    return GitHub.toBase64(file).then(function (base64) {
      return send(base64, 0);
    });
  };

  /* Save a set of changes as one step.
     changes: { path, sha } (an uploaded file), { path, text } or { path, remove: true }.
     options.replaceAll: the site becomes exactly these files and nothing else. */
  GitHub.prototype.commit = function (message, changes, options) {
    var self = this;
    options = options || {};

    var ready = changes.reduce(function (chain, change) {
      return chain.then(function (list) {
        if (change.remove) return list.concat([{ path: change.path, mode: "100644", type: "blob", sha: null }]);
        if (change.sha) return list.concat([{ path: change.path, mode: "100644", type: "blob", sha: change.sha }]);
        return self.createBlob(change.text, "utf-8").then(function (sha) {
          return list.concat([{ path: change.path, mode: "100644", type: "blob", sha: sha }]);
        });
      });
    }, Promise.resolve([]));

    function tryOnce(entries, n) {
      return self.head().then(function (head) {
        var treeBody = { tree: entries };
        if (!options.replaceAll) treeBody.base_tree = head.tree;
        return self.request("POST", self.repoPath() + "/git/trees", treeBody).then(function (tree) {
          if (tree.sha === head.tree) return head.commit;
          return self
            .request("POST", self.repoPath() + "/git/commits", { message: message, tree: tree.sha, parents: [head.commit] })
            .then(function (commit) {
              return self
                .request("PATCH", self.repoPath() + "/git/refs/heads/" + encodeURIComponent(self.branch), { sha: commit.sha })
                .then(
                  function () {
                    return commit.sha;
                  },
                  function (error) {
                    /* Someone (another tab) saved in between: start again from the newest version. */
                    if ((error.status === 422 || error.status === 409) && n < 2) return tryOnce(entries, n + 1);
                    throw error;
                  }
                );
            });
        });
      });
    }

    return ready.then(function (entries) {
      if (!entries.length) return null;
      return tryOnce(entries, 0);
    });
  };

  GitHub.prototype.enablePages = function () {
    var self = this;
    return self
      .request("POST", self.repoPath() + "/pages", { source: { branch: self.branch, path: "/" } })
      .catch(function (error) {
        if (error.status === 409 || error.status === 422) return null; /* already switched on */
        throw error;
      });
  };

  GitHub.prototype.pages = function () {
    return this.request("GET", this.repoPath() + "/pages");
  };

  GitHub.prototype.latestBuild = function () {
    return this.request("GET", this.repoPath() + "/pages/builds/latest");
  };

  /* Turn a File/Blob into the base64 text GitHub expects. */
  GitHub.toBase64 = function (blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        resolve(text.slice(text.indexOf(",") + 1));
      };
      reader.onerror = function () {
        reject(problem("read", "That file couldn't be read."));
      };
      reader.readAsDataURL(blob);
    });
  };

  GitHub.sleep = sleep;
  GitHub.KEY_URL = "https://github.com/settings/tokens/new?scopes=repo&description=Portfolio%20editor";

  window.PortfolioGitHub = GitHub;
})();
