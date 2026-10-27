import { MAX_PREVIEW_BYTES, PREVIEW_EDGE, PREVIEW_TYPE } from "../domain/upload-link.js";

/**
 * The page behind an upload link (routes/upload.ts). It is static: the token
 * is in the URL fragment, which the browser never sends, so the script reads
 * it and sends it back as a bearer token. Everything about the wedding comes
 * from GET /upload/link, and every name is set as text, never as markup.
 *
 * For each photo the browser makes the preview Claude will look at: a JPEG
 * PREVIEW_EDGE pixels on its long edge, halved in steps (one big jump down
 * aliases in some browsers), on white so a transparent PNG does not turn
 * black. A photo whose preview cannot be made is still added; it shows up
 * in review_photos without one until the backfill script makes it.
 */

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fff}
.drop{display:block;border:2px dashed #888;border-radius:8px;padding:2rem 1rem;text-align:center;cursor:pointer;margin:1rem 0}
.drop.over{border-color:#222;background:#f4f4f4}.drop:focus-within{outline:2px solid #222}
.drop input{position:absolute;width:1px;height:1px;opacity:0}
ol{padding-left:1.25rem}li{margin:.25rem 0;overflow-wrap:anywhere}.state{color:#555}.bad .state,.error{color:#a00}
button{font:inherit;padding:.5rem 1rem}`;

// Plain ES2017, no template literals inside: it is itself one.
const SCRIPT = `"use strict";
var EDGE = ${PREVIEW_EDGE}, PREVIEW_TYPE = "${PREVIEW_TYPE}", MAX_PREVIEW = ${MAX_PREVIEW_BYTES};
var TYPES = ["image/jpeg", "image/png", "image/webp"];
var STOPPED = "This link has stopped working. Ask Claude for a new one.";
var token = location.hash.slice(1);
var state = { maxBytes: 0, inPool: 0, added: 0, busy: false, stopped: false };

function el(id) { return document.getElementById(id); }
function say(id, text) { el(id).textContent = text; }

function api(method, path, body, type, name) {
  var headers = { authorization: "Bearer " + token };
  if (type) headers["content-type"] = type;
  if (name) headers["x-file-name"] = encodeURIComponent(name);
  return fetch(path, { method: method, headers: headers, body: body }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { ok: res.ok, status: res.status, data: data };
    });
  }, function () {
    return { ok: false, status: 0, data: { message: "Could not reach the studio. Check your connection and try again." } };
  });
}

function stop(text) {
  state.stopped = true;
  el("picker").hidden = true;
  el("lead").hidden = true;
  el("status").hidden = false;
  say("status", text);
}

function summary() {
  var parts = [];
  if (state.added > 0) parts.push(state.added === 1 ? "1 photo added here." : state.added + " photos added here.");
  parts.push(state.inPool === 1 ? "This wedding has 1 photo." : "This wedding has " + state.inPool + " photos.");
  say("summary", parts.join(" "));
}

function draw(source, w, h, white) {
  var canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  var g = canvas.getContext("2d");
  if (white) {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, w, h);
  return canvas;
}

async function shrink(file) {
  var bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  var w = bitmap.width, h = bitmap.height;
  var scale = Math.min(1, EDGE / Math.max(w, h));
  var tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  var source = bitmap;
  while (w / 2 > tw) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    source = draw(source, w, h, false);
  }
  var canvas = draw(source, tw, th, true);
  if (bitmap.close) bitmap.close();
  var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, PREVIEW_TYPE, 0.8); });
  if (blob === null || blob.type !== PREVIEW_TYPE || blob.size > MAX_PREVIEW) throw new Error("no preview");
  return blob;
}

function mark(line, text, bad) {
  line.querySelector(".state").textContent = text;
  line.className = bad ? "bad" : "";
}

async function addOne(file, line) {
  if (TYPES.indexOf(file.type) < 0) return mark(line, "Skipped: use JPEG, PNG or WebP.", true);
  if (file.size > state.maxBytes) return mark(line, "Skipped: larger than 12 MB. Export it at web size and add it again.", true);
  mark(line, "Adding", false);
  var small = null;
  try { small = await shrink(file); } catch (error) { small = null; }
  var stored = await api("POST", "/upload/photos", file, file.type, file.name);
  if (!stored.ok) {
    mark(line, stored.data.message || "Could not add this one.", true);
    if (stored.status === 401 || stored.status === 403 || stored.status === 409) stop(stored.data.message || STOPPED);
    return;
  }
  state.added += 1;
  state.inPool += 1;
  summary();
  var previewed = small !== null && (await api("PUT", "/upload/photos/" + stored.data.photo + "/preview", small, PREVIEW_TYPE)).ok;
  mark(line, previewed ? "Added" : "Added, without a preview", false);
}

function busy(on) {
  state.busy = on;
  el("done").disabled = on;
  el("files").disabled = on;
}

async function addAll(files) {
  if (state.busy || state.stopped || files.length === 0) return;
  busy(true);
  var queue = Array.prototype.map.call(files, function (file) {
    var line = document.createElement("li");
    var name = document.createElement("span");
    name.textContent = file.name;
    var status = document.createElement("span");
    status.className = "state";
    status.textContent = "Waiting";
    line.append(name, " ", status);
    el("list").append(line);
    return { file: file, line: line };
  });
  async function worker() {
    while (queue.length > 0 && !state.stopped) {
      var next = queue.shift();
      await addOne(next.file, next.line);
    }
  }
  await Promise.all([worker(), worker()]);
  queue.forEach(function (left) { mark(left.line, "Not added", true); });
  el("files").value = "";
  busy(false);
}

async function finish() {
  el("done").disabled = true;
  var closed = await api("POST", "/upload/done");
  if (!closed.ok && closed.status !== 401) {
    el("done").disabled = false;
    say("message", closed.data.message || "Could not finish. Try again.");
    return;
  }
  stop((state.inPool === 1 ? "All set: this wedding has 1 photo." : "All set: this wedding has " + state.inPool + " photos.")
    + " Go back to Claude and say the photos are in.");
}

async function start() {
  if (token === "") return stop("This page needs the link from Claude. Ask Claude for a new one.");
  var link = await api("GET", "/upload/link");
  if (!link.ok) return stop(link.data.message || STOPPED);
  state.maxBytes = link.data.maxBytes;
  state.inPool = link.data.photos;
  say("heading", "Add photos for " + link.data.couple);
  el("status").hidden = true;
  el("lead").hidden = false;
  el("picker").hidden = false;
  summary();
}

var drop = el("drop");
["dragenter", "dragover"].forEach(function (type) {
  drop.addEventListener(type, function (event) { event.preventDefault(); drop.classList.add("over"); });
});
["dragleave", "drop"].forEach(function (type) {
  drop.addEventListener(type, function () { drop.classList.remove("over"); });
});
drop.addEventListener("drop", function (event) { event.preventDefault(); addAll(event.dataTransfer.files); });
// A photo dropped beside the box must not open in this tab and lose the page.
window.addEventListener("dragover", function (event) { event.preventDefault(); });
window.addEventListener("drop", function (event) { event.preventDefault(); });
window.addEventListener("beforeunload", function (event) {
  if (state.busy) { event.preventDefault(); event.returnValue = ""; }
});
// A new link opened in this same tab changes only the fragment, which does
// not load the page again; without this it would keep the old link's token.
window.addEventListener("hashchange", function () { location.reload(); });
el("files").addEventListener("change", function () { addAll(el("files").files); });
el("done").addEventListener("click", finish);
start();`;

export function uploadPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add photos</title>
<style nonce="${nonce}">${STYLE}</style>
<h1 id="heading">Add photos</h1>
<p id="status">Checking this link...</p>
<p id="lead" hidden>Drag in your web-size exports, or choose them. JPEG, PNG or WebP, up to 12 MB each. Each one gets a small preview so Claude can look through them with you.</p>
<section id="picker" hidden>
  <label class="drop" id="drop"><input id="files" type="file" multiple accept="image/jpeg,image/png,image/webp">Drop photos here, or click to choose them.</label>
  <p id="summary"></p>
  <ol id="list"></ol>
  <p><button id="done" type="button">I'm finished</button></p>
</section>
<p id="message" class="error" role="alert"></p>
<script nonce="${nonce}">${SCRIPT}</script>
</html>`;
}

/** Only this page's own script and style run, and it talks only to this Worker. */
export function uploadPagePolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
