/* Portfolio runtime
 * ---------------------------------------------------------------------------
 * 1. projects.json  -> which projects exist, the global order and the
 *                      link-check settings (the single control file)
 * 2. localStorage   -> per-visitor show/hide choices
 * 3. live link check -> a card whose site does not answer is removed
 *
 * The hosted apps keep running either way - hiding a card only affects this
 * listing, never the deployed application itself.
 */
(function () {
    "use strict";

    /* ------------------------------------------------------------------ *
     * configuration
     * ------------------------------------------------------------------ */
    var STORAGE_KEY = "portfolio:hidden-projects";

    var manifest = {
        projects: [],          // ids that belong on the page (empty = all cards)
        checkIds: [],          // ids that are probed for being online
        hidden: [],            // ids hidden for every visitor
        order: [],             // display order of the ids
        checkLinks: true,      // probe every visible site before showing it
        proxy: "https://r.jina.ai/",  // fallback probe (adds CORS + status)
        timeoutMs: 20000,      // per-request timeout
        proxyTimeoutMs: 30000  // the proxy is slower, it gets more time
    };

    /* ------------------------------------------------------------------ *
     * state
     * ------------------------------------------------------------------ */
    var cards = [];
    var countEl = null;
    var statusEl = null;
    var toggleAllBtn = null;
    var tray = null;
    var list = null;

    var globalHidden = [];   // hidden for every visitor (projects.json)
    var localHidden = [];    // hidden by this visitor (localStorage)
    var offlineIds = [];     // removed because the live site did not answer
    var sectionLabels = [];  // the section headings that group the cards

    /* ------------------------------------------------------------------ *
     * small helpers
     * ------------------------------------------------------------------ */
    function idOf(card) { return card.getAttribute("data-id"); }

    function titleOf(card) { return card.getAttribute("data-title") || idOf(card); }

    function urlOf(card) {
        var link = card.querySelector("a[href]");
        return link ? link.href : "";
    }

    function uniq(arr) {
        var out = [];
        (arr || []).forEach(function (item) {
            if (typeof item === "string" && item && out.indexOf(item) === -1) {
                out.push(item);
            }
        });
        return out;
    }

    /* ------------------------------------------------------------------ *
     * storage
     * ------------------------------------------------------------------ */
    function readLocal() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            var parsed = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function saveLocal() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(localHidden));
        } catch (e) { /* storage unavailable - ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * visibility rules
     * ------------------------------------------------------------------ */
    function isOffline(id) {
        return offlineIds.indexOf(id) !== -1;
    }

    // A card the visitor (or the owner) hid on purpose. A site that could
    // not be reached is not "hidden" - it stays in place and is dimmed,
    // so a temporary network problem never makes a project disappear.
    function isHidden(id) {
        return globalHidden.indexOf(id) !== -1 ||
            localHidden.indexOf(id) !== -1;
    }

    // Only projects listed in the manifest may be shown. When the manifest
    // cannot be read the data-live attribute in index.html is used instead.
    function isAllowed(id) {
        if (!manifest.projects.length) return true;
        return manifest.projects.indexOf(id) !== -1;
    }

    // Only these projects are probed. An empty list means "probe them all".
    function isChecked(id) {
        if (!manifest.checkIds.length) return true;
        return manifest.checkIds.indexOf(id) !== -1;
    }

    // Fallback for a missing / broken projects.json: the cards that carry
    // data-live="true" in index.html are the ones that belong on the page.
    function liveFromMarkup() {
        return cards
            .filter(function (card) { return card.getAttribute("data-live") === "true"; })
            .map(idOf);
    }

    /* ------------------------------------------------------------------ *
     * manifest
     * ------------------------------------------------------------------ */
    function applyManifest(data) {
        if (!data || typeof data !== "object") return;

        // projects.json uses "_liveSites" so the control file can carry
        // "_comment" keys as well.
        var projects = data.projects || data._liveSites || data.liveSites || data.live;
        if (Array.isArray(projects)) manifest.projects = uniq(projects);

        // The ids that are probed. Defaults to the projects on the page.
        var check = data.check || data._checkSites || data.checkSites;
        if (Array.isArray(check)) manifest.checkIds = uniq(check);

        if (Array.isArray(data.hidden)) globalHidden = uniq(data.hidden);
        if (Array.isArray(data.order)) manifest.order = uniq(data.order);
        if (typeof data.checkLinks === "boolean") manifest.checkLinks = data.checkLinks;
        if (typeof data.proxy === "string" && data.proxy) manifest.proxy = data.proxy;
        if (typeof data.timeoutMs === "number" && data.timeoutMs > 0) manifest.timeoutMs = data.timeoutMs;
        if (typeof data.proxyTimeoutMs === "number" && data.proxyTimeoutMs > 0) {
            manifest.proxyTimeoutMs = data.proxyTimeoutMs;
        }
    }

    function loadManifest() {
        if (typeof fetch !== "function") return Promise.resolve();

        return fetch("projects.json", { cache: "no-cache" })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (data) applyManifest(data);
            })
            .catch(function () { /* manifest unavailable - fall back to the markup */ });
    }

    /* ------------------------------------------------------------------ *
     * live link check
     *
     * The three hosted apps (Coolify) do not send CORS headers, so a plain
     * cross-origin fetch() would report them as offline. The probes are
     * therefore layered:
     *
     *  1. CORS probe  - used when the server allows cross-origin reads
     *     (GitHub Pages sends "Access-Control-Allow-Origin: *"). The real
     *     HTTP status is visible, so a 404 is detected immediately.
     *
     *  2. no-cors probe - reachability only. The browser hides the status
     *     code, but the promise resolves for any reachable host and only
     *     rejects on DNS / TCP / TLS failure.
     *
     *  3. CORS proxy - last resort. r.jina.ai answers with HTTP 200 even for
     *     an upstream 404, so the body has to be inspected for warnings.
     *     An unresolvable host is answered with HTTP 422.
     * ------------------------------------------------------------------ */
    function fetchWithTimeout(url, options, ms) {
        return new Promise(function (resolve, reject) {
            var settled = false;

            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error("timeout"));
            }, ms);

            fetch(url, options).then(function (res) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(res);
            }, function (err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    // Probe 1 - full CORS request. Decisive when the server allows it.
    function probeCors(url) {
        return fetchWithTimeout(url, { mode: "cors", cache: "no-store", redirect: "follow" }, manifest.timeoutMs)
            .then(function (res) {
                return { up: res.ok, status: res.status, via: "cors" };
            })
            .catch(function (err) {
                if (err && err.message === "timeout") {
                    return { up: false, status: 0, via: "cors", reason: "timeout" };
                }
                // A CORS failure does not mean the site is down, it only
                // means we are not allowed to read the response.
                return { up: null, status: 0, via: "cors", reason: "cors-blocked" };
            });
    }

    // Probe 2 - reachability only, works without any CORS support.
    function probeNoCors(url) {
        return fetchWithTimeout(url, { mode: "no-cors", cache: "no-store", redirect: "follow" }, manifest.timeoutMs)
            .then(function () { return { up: true, status: 0, via: "no-cors" }; })
            .catch(function (err) {
                var reason = err && err.message === "timeout" ? "timeout" : "unreachable";
                return { up: false, status: 0, via: "no-cors", reason: reason };
            });
    }

    // Probe 3 - read the page through the CORS proxy and inspect the body.
    function probeProxy(url) {
        var target = manifest.proxy + url;
        return fetchWithTimeout(target, { mode: "cors", cache: "no-store", redirect: "follow" }, manifest.proxyTimeoutMs)
            .then(function (res) {
                // 422 - the proxy could not resolve the host at all.
                if (res.status === 422) {
                    return { up: false, status: res.status, via: "proxy", reason: "unreachable" };
                }
                // 401 / 403 / 429 - the proxy itself refused the request
                // (rate limit, missing key, blocked target). That says
                // nothing about the website, so it is not an outage.
                if (res.status === 401 || res.status === 403 || res.status === 429) {
                    return { up: null, status: res.status, via: "proxy", reason: "proxy-blocked" };
                }
                return res.text().then(function (text) {
                    if (!res.ok) {
                        return { up: false, status: res.status, via: "proxy", reason: "http-" + res.status };
                    }
                    if (isUpstreamError(text)) {
                        return { up: false, status: 0, via: "proxy", reason: "upstream-error" };
                    }
                    return { up: true, status: res.status, via: "proxy" };
                });
            })
            .catch(function (err) {
                var reason = err && err.message === "timeout" ? "timeout" : "unreachable";
                return { up: false, status: 0, via: "proxy", reason: reason };
            });
    }

    // The proxy answers HTTP 200 even for an upstream error, but the body
    // carries "Warning: Target URL returned error 404: Not Found" and similar.
    // A cached-snapshot note ("Warning: This is a cached snapshot ...") is
    // harmless and must not be treated as a failure.
    function isUpstreamError(text) {
        if (!text) return false;

        // The error the proxy reports for a failing target.
        if (/Target URL returned error/i.test(text)) return true;
        if (/returned error \d{3}/i.test(text)) return true;

        // Any other warning is only an error when it does not talk about a
        // harmless cached snapshot.
        var warnings = text.match(/^\s*Warning:.*$/gim);
        if (!warnings) return false;

        return warnings.some(function (line) {
            if (/cached snapshot/i.test(line)) return false;
            return /\b(error|failed|failure|unreachable|cannot|unable|timeout|timed out|refused|not found)\b/i.test(line);
        });
    }

    // Runs the probes for one card and decides whether the site is up.
    function checkCard(card) {
        var id = idOf(card);
        var url = urlOf(card);

        if (!url) {
            return Promise.resolve({ id: id, up: false, reason: "no-url" });
        }

        // The two cheap probes run at the same time. The CORS one is the
        // decisive answer when the server allows it, the no-cors one only
        // proves that the host answers. One after the other the visitor would
        // wait for the timeouts twice.
        return Promise.all([probeCors(url), probeNoCors(url)]).then(function (results) {
            var first = results[0];   // cors
            var second = results[1];  // no-cors

            if (first.up === true) {
                return { id: id, up: true, via: first.via, status: first.status };
            }
            if (first.up === false) {
                // The server answered with an error status - that is decisive,
                // no need for the slower probes.
                return { id: id, up: false, via: first.via, reason: first.reason || ("http-" + first.status) };
            }

            // CORS was blocked. The reachability probe decides.
            if (second.up === true) {
                return { id: id, up: true, via: second.via };
            }
            if (second.reason === "timeout") {
                return { id: id, up: false, via: second.via, reason: "timeout" };
            }

            // Not reachable without CORS either - ask the proxy for a
            // status code to tell "down" apart from "just no CORS".
            return probeProxy(url).then(function (third) {
                return {
                    id: id,
                    up: third.up,
                    via: third.via,
                    status: third.status,
                    reason: third.reason
                };
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * status text
     * ------------------------------------------------------------------ */
    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    /* ------------------------------------------------------------------ *
     * rendering
     * ------------------------------------------------------------------ */
    function render() {
        var visible = 0;

        cards.forEach(function (card) {
            var id = idOf(card);
            var title = titleOf(card);
            var btn = card.querySelector(".hide-btn");

            // A project that is not part of the portfolio is removed from the
            // page completely - it is not offered in the tray either.
            if (!isAllowed(id)) {
                card.classList.add("is-hidden");
                card.classList.remove("is-offline");
                card.removeAttribute("data-offline");
                card.setAttribute("aria-hidden", "true");
                if (btn) {
                    btn.innerHTML = '<i class="fas fa-eye"></i>';
                    btn.setAttribute("aria-label", "Unhide " + title);
                    btn.title = "Unhide " + title;
                }
                return;
            }

            if (isHidden(id)) {
                card.classList.add("is-hidden");
                card.removeAttribute("aria-hidden");
                if (btn) {
                    btn.innerHTML = '<i class="fas fa-eye"></i>';
                    btn.setAttribute("aria-label", "Unhide " + title);
                    btn.title = "Unhide " + title;
                }
                return;
            }

            card.classList.remove("is-hidden");
            card.removeAttribute("aria-hidden");
            visible++;

            if (isOffline(id)) {
                // The site did not answer: it stays on the page but is
                // dimmed and marked, so the visitor can still open it.
                card.classList.add("is-offline");
                card.setAttribute("data-offline", "true");
            } else {
                card.classList.remove("is-offline");
                card.removeAttribute("data-offline");
            }

            if (btn) {
                btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
                btn.setAttribute("aria-label", "Hide " + title);
                btn.title = "Hide " + title;
            }
        });

        if (countEl) {
            countEl.textContent = visible === 1 ? "1 website" : visible + " websites";
        }

        // "Hide all" turns into "Show all" once every card is hidden
        var allHidden = visible === 0;
        if (toggleAllBtn) {
            toggleAllBtn.querySelector("span").textContent = allHidden ? "Show all websites" : "Hide all websites";
            toggleAllBtn.querySelector("i").className = allHidden ? "fas fa-eye" : "fas fa-eye-slash";
        }

        renderTray();
    }

    // Lists the hidden projects, with a button to bring each one back.
    function renderTray() {
        if (!tray || !list) return;

        var hiddenCards = cards.filter(function (c) {
            var id = idOf(c);
            // Every hidden card in the DOM is offered in the tray so the
            // visitor can bring it back - even projects that are not in
            // _liveSites (those are hidden by default via projects.json).
            return isHidden(id);
        });

        if (hiddenCards.length === 0) {
            tray.hidden = true;
            list.innerHTML = "";
            return;
        }

        tray.hidden = false;
        list.innerHTML = "";

        hiddenCards.forEach(function (card) {
            var id = idOf(card);
            var title = titleOf(card);

            var li = document.createElement("li");
            li.className = "hidden-item";

            var name = document.createElement("span");
            name.className = "hidden-item-name";
            name.textContent = title;

            var restore = document.createElement("button");
            restore.type = "button";
            restore.className = "hidden-item-btn";
            restore.innerHTML = '<i class="fas fa-eye"></i> Unhide';
            restore.setAttribute("aria-label", "Unhide " + title);
            restore.addEventListener("click", function () {
                localHidden = localHidden.filter(function (x) { return x !== id; });
                globalHidden = globalHidden.filter(function (x) { return x !== id; });
                offlineIds = offlineIds.filter(function (x) { return x !== id; });
                saveLocal();
                render();
            });

            li.appendChild(name);
            li.appendChild(restore);
            list.appendChild(li);
        });
    }

    /* ------------------------------------------------------------------ *
     * ordering
     *
     * The ids listed in the manifest come first, in that order. The cards
     * are re-placed into the slots the cards already occupy, so the section
     * labels between them stay exactly where they are.
     * ------------------------------------------------------------------ */
    function applyOrder() {
        if (!manifest.order.length) return;

        var rank = {};
        manifest.order.forEach(function (id, i) { rank[id] = i; });

        var sorted = cards.slice().sort(function (a, b) {
            var ra = Object.prototype.hasOwnProperty.call(rank, idOf(a)) ? rank[idOf(a)] : Infinity;
            var rb = Object.prototype.hasOwnProperty.call(rank, idOf(b)) ? rank[idOf(b)] : Infinity;
            if (ra === rb) return 0;
            return ra - rb;
        });

        // Split the markup into groups. A group is an optional section
        // label plus the cards that follow it, so the label always describes
        // the same cards no matter how the cards are re-ordered.
        var parent = cards.length ? cards[0].parentNode : null;
        if (!parent) return;

        var groups = [];
        var current = { label: null, cards: [] };

        Array.prototype.forEach.call(parent.children, function (node) {
            if (!node.classList) return;
            if (node.classList.contains("section-label")) {
                groups.push(current);
                current = { label: node, cards: [] };
            } else if (node.classList.contains("project-card")) {
                current.cards.push(node);
            }
        });
        groups.push(current);

        // Which label belongs to which card?
        sectionLabels = groups
            .filter(function (g) { return g.label; })
            .map(function (g) {
                return { el: g.label, ids: g.cards.map(idOf) };
            });

        // A marker in front of every card marks the slot the card occupies
        // right now. Moving the cards into those slots keeps the distance
        // between them (and therefore the layout) intact.
        var markers = cards.map(function (c) {
            var marker = document.createComment("slot");
            c.parentNode.insertBefore(marker, c);
            return marker;
        });

        sorted.forEach(function (c, i) {
            var marker = markers[i];
            if (marker && marker.parentNode) {
                marker.parentNode.insertBefore(c, marker);
            }
        });

        // A label follows its group: it is placed right in front of the
        // first card of that group in the new order.
        sectionLabels.forEach(function (group) {
            var first = null;
            for (var i = 0; i < sorted.length && !first; i++) {
                if (group.ids.indexOf(idOf(sorted[i])) !== -1) first = sorted[i];
            }
            if (first && first.parentNode) {
                first.parentNode.insertBefore(group.el, first);
            }
        });

        markers.forEach(function (m) {
            if (m.parentNode) m.parentNode.removeChild(m);
        });

        cards = sorted;
    }

    /* ------------------------------------------------------------------ *
     * events
     * ------------------------------------------------------------------ */
    function bindEvents() {
        // Per-card hide / unhide button
        cards.forEach(function (card) {
            var btn = card.querySelector(".hide-btn");
            if (!btn) return;

            btn.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();

                var id = idOf(card);

                if (isHidden(id)) {
                    // Always honour the visitor's choice: unhide immediately,
                    // even if the site is currently offline. The card stays
                    // listed (dimmed as offline) so nothing is lost.
                    localHidden = localHidden.filter(function (x) { return x !== id; });
                    globalHidden = globalHidden.filter(function (x) { return x !== id; });
                } else {
                    localHidden.push(id);
                }

                saveLocal();
                render();
            });
        });

        // Hide / show every website at once
        if (toggleAllBtn) {
            toggleAllBtn.addEventListener("click", function () {
                var anyVisible = cards.some(function (c) {
                    var id = idOf(c);
                    return isAllowed(id) && !isHidden(id);
                });

                cards.forEach(function (c) {
                    var id = idOf(c);
                    if (!isAllowed(id)) return;

                    if (anyVisible) {
                        if (localHidden.indexOf(id) === -1) localHidden.push(id);
                    } else {
                        localHidden = localHidden.filter(function (x) { return x !== id; });
                    }
                });

                saveLocal();
                render();
            });
        }
    }

    /* ------------------------------------------------------------------ *
     * start
     * ------------------------------------------------------------------ */
    function init() {
        cards = Array.prototype.slice.call(document.querySelectorAll(".project-card"));
        countEl = document.getElementById("projects-count");
        statusEl = document.getElementById("projects-status");
        toggleAllBtn = document.getElementById("toggle-all-projects");
        tray = document.getElementById("hidden-tray");
        list = document.getElementById("hidden-list");

        var yearEl = document.getElementById("year");
        if (yearEl) yearEl.textContent = new Date().getFullYear();

        loadManifest()
            .then(function () {
                // Without a manifest we cannot know which projects belong on
                // the page, so the markup decides.
                if (!manifest.projects.length) {
                    manifest.projects = liveFromMarkup();
                }

                // The projects that are not on the page are not probed either.
                if (!manifest.checkIds.length) {
                    manifest.checkIds = manifest.projects.slice();
                }

                localHidden = readLocal();

                // Forget ids for projects that are no longer on the page.
                var currentIds = cards.map(idOf);
                localHidden = localHidden.filter(function (id) {
                    return currentIds.indexOf(id) !== -1;
                });
                saveLocal();

                applyOrder();
                bindEvents();
                render();

                if (!manifest.checkLinks) {
                    setStatus("");
                    return;
                }

                setStatus("Checking that the websites are online...");

                // Only the projects that are on the page and are meant to be
                // checked are probed.
                var targets = cards.filter(function (c) {
                    var id = idOf(c);
                    return isAllowed(id) && isChecked(id) && !isHidden(id);
                });

                if (!targets.length) {
                    setStatus("");
                    return;
                }

                // The cards being probed are dimmed until the answer is in.
                targets.forEach(function (c) {
                    c.classList.add("is-checking");
                });

                return Promise.all(targets.map(checkCard)).then(function (results) {
                    // A project is only marked offline when the check really
                    // proved that the site is not answering. An unknown
                    // result (up === null) keeps the card as it is.
                    var down = results.filter(function (r) { return r && r.up === false; });

                    down.forEach(function (r) {
                        var card = cards.filter(function (c) { return idOf(c) === r.id; })[0];
                        if (!card) return;

                        if (offlineIds.indexOf(r.id) === -1) offlineIds.push(r.id);
                    });

                    targets.forEach(function (c) {
                        c.classList.remove("is-checking");
                    });

                    render();

                    if (down.length) {
                        setStatus(down.length + (down.length === 1 ? " website did not answer" : " websites did not answer") + " and " + (down.length === 1 ? "is" : "are") + " marked as offline.");
                    } else {
                        setStatus("All " + targets.length + " websites are online.");
                    }
                });
            })
            .catch(function (err) {
                // A failing check must never break the page.
                setStatus("");
                // The dimmed state must not survive a failed check.
                cards.forEach(function (c) {
                    c.classList.remove("is-checking");
                });
                if (window.console && console.warn) {
                    console.warn("[portfolio] link check failed:", err);
                }
            });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
