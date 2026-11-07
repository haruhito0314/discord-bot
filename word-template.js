const yauzl = require("yauzl");
const { zipSync } = require("fflate");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const XML = "http://www.w3.org/XML/1998/namespace";
const MAX_DOCX_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_FIELDS = 40;

class AttachmentError extends Error {}

async function readArchive(buffer, signal) {
  if (buffer.length > MAX_DOCX_BYTES) throw new AttachmentError("Wordファイルは8MB以下にしてください。");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(new AttachmentError("Wordファイルを開けません。.docx形式か確認してください。"));
      const entries = new Map();
      let total = 0;
      let count = 0;
      let settled = false;
      let currentStream;
      const finish = (failure) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", aborted);
        if (failure) { currentStream?.destroy(); zip.close(); reject(failure); }
        else resolve(entries);
      };
      const aborted = () => finish(new AttachmentError("添付ファイルの処理が時間上限に達しました。"));
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) return aborted();
      zip.on("error", () => finish(new AttachmentError("WordファイルのZIP構造が不正です。")));
      zip.on("entry", (entry) => {
        if (settled) return;
        count++;
        total += entry.uncompressedSize;
        const name = entry.fileName;
        if (count > 512 || total > MAX_EXPANDED_BYTES || entry.uncompressedSize > 10 * 1024 * 1024
          || (entry.generalPurposeBitFlag & 1) || entries.has(name)
          || /(?:^|\/)\.\.(?:\/|$)|^\/|\\/.test(name)
          || entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 1000)) {
          return finish(new AttachmentError("Wordファイルの展開サイズ・構造が上限を超えています。"));
        }
        if (name.endsWith("/")) { entries.set(name, Buffer.alloc(0)); zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return finish(new AttachmentError("Wordファイルを展開できませんでした。"));
          if (settled) { stream.destroy(); return; }
          currentStream = stream;
          const chunks = [];
          let bytes = 0;
          stream.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > entry.uncompressedSize || bytes > 10 * 1024 * 1024) {
              finish(new AttachmentError("Wordファイルの展開サイズが不正です。"));
            } else chunks.push(chunk);
          });
          stream.on("error", () => finish(new AttachmentError("Wordファイルが破損しています。")));
          stream.on("end", () => {
            if (settled) return;
            entries.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => finish());
      zip.readEntry();
    });
  });
}

function parseXml(buffer) {
  if (buffer.length > 2 * 1024 * 1024) throw new AttachmentError("Wordの本文が大きすぎます。テンプレートを分割してください。");
  const text = buffer.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AttachmentError("外部実体を含むWordファイルには対応していません。");
  let doc;
  try {
    doc = new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(text, "application/xml");
  } catch { throw new AttachmentError("Word内のXMLが不正です。Wordで保存し直してください。"); }
  const stack = [[doc.documentElement, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++nodes > 80000 || depth > 100) throw new AttachmentError("Wordの構造が複雑すぎます。テンプレートを分割してください。");
    for (let child = node?.firstChild; child; child = child.nextSibling) stack.push([child, depth + 1]);
  }
  return doc;
}

const descendants = (node, name) => Array.from(node.getElementsByTagNameNS(W, name));
const children = (node, name) => Array.from(node.childNodes || []).filter((n) => n.namespaceURI === W && n.localName === name);
const isWithin = (node, parent) => { for (let n = node; n; n = n.parentNode) if (n === parent) return true; return false; };
const ancestor = (node, name) => { for (let n = node.parentNode; n; n = n.parentNode) if (n.namespaceURI === W && n.localName === name) return n; return null; };
const visibleText = (node) => descendants(node, "t").filter((n) => !ancestor(n, "del")).map((n) => n.textContent).join("");
const safeText = (text) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "").toWellFormed();

function wordElement(doc, name) { return doc.createElementNS(W, `w:${name}`); }

function addText(run, value) {
  value.split(/\r?\n/).forEach((line, i) => {
    if (i) run.appendChild(wordElement(run.ownerDocument, "br"));
    const text = wordElement(run.ownerDocument, "t");
    text.setAttributeNS(XML, "xml:space", "preserve");
    text.textContent = line;
    run.appendChild(text);
  });
}

function setContainerText(root, value) {
  const doc = root.ownerDocument;
  const firstRun = descendants(root, "r")[0];
  const runProperties = firstRun && children(firstRun, "rPr")[0];
  const savedProperties = runProperties?.cloneNode(true);
  let paragraph = root.localName === "p" ? root : descendants(root, "p")[0];
  // Inline content controls contain runs directly, not paragraphs.
  const inline = root.localName === "sdtContent" && !paragraph && ancestor(root, "p");
  if (!paragraph && !inline) { paragraph = wordElement(doc, "p"); root.appendChild(paragraph); }
  for (const name of ["t", "br", "tab"]) {
    for (const node of descendants(root, name)) node.parentNode.removeChild(node);
  }
  const run = wordElement(doc, "r");
  if (savedProperties) run.appendChild(savedProperties);
  addText(run, value);
  (inline ? root : paragraph).appendChild(run);
}

function replaceRange(paragraph, start, end, value) {
  const texts = descendants(paragraph, "t").filter((node) => ancestor(node, "p") === paragraph && !ancestor(node, "del"));
  let offset = 0;
  let inserted = false;
  for (const node of texts) {
    const original = node.textContent;
    const nodeStart = offset;
    offset += original.length;
    if (offset <= start || nodeStart >= end) continue;
    const prefix = original.slice(0, Math.max(0, start - nodeStart));
    const suffix = original.slice(Math.min(original.length, end - nodeStart));
    node.textContent = prefix + (inserted ? "" : value) + suffix;
    node.setAttributeNS(XML, "xml:space", "preserve");
    inserted = true;
  }
}

function materializeLineBreaks(doc) {
  for (const node of descendants(doc, "t")) {
    if (!node.textContent.includes("\n")) continue;
    const lines = node.textContent.split(/\r?\n/);
    node.textContent = lines.shift();
    let previous = node;
    for (const line of lines) {
      const br = wordElement(doc, "br");
      node.parentNode.insertBefore(br, previous.nextSibling);
      const text = wordElement(doc, "t");
      text.setAttributeNS(XML, "xml:space", "preserve");
      text.textContent = line;
      node.parentNode.insertBefore(text, br.nextSibling);
      previous = text;
    }
  }
}

async function openWordTemplate(buffer, { signal } = {}) {
  const entries = await readArchive(buffer, signal);
  if (!entries.has("word/document.xml") || !entries.has("[Content_Types].xml")) {
    throw new AttachmentError(".docx形式のWordファイルを添付してください。");
  }
  const contentTypes = parseXml(entries.get("[Content_Types].xml"));
  if (!Array.from(contentTypes.getElementsByTagNameNS("*", "Override")).some((n) =>
    n.getAttribute("PartName") === "/word/document.xml"
    && n.getAttribute("ContentType") === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")
    || [...entries.keys()].some((name) => /vbaProject|_xmlsignatures/i.test(name))) {
    throw new AttachmentError("マクロ付き・署名付きのWordには対応していません。通常の.docxで保存してください。");
  }
  if (entries.has("word/settings.xml")) {
    const settings = parseXml(entries.get("word/settings.xml"));
    if (descendants(settings, "documentProtection").some((node) => ["1", "true", "on"].includes(node.getAttributeNS(W, "enforcement")))) {
      throw new AttachmentError("編集保護されたWordには入力できません。編集可能なテンプレートを添付してください。");
    }
  }
  const parts = new Map();
  const slots = [];
  const textParts = [];
  const add = (part, node, kind, label, extra = {}) => {
    if (slots.length >= MAX_FIELDS) throw new AttachmentError("Wordの入力欄は40個までです。テンプレートを分割してください。");
    const maxChars = ancestor(node, "txbxContent") || node.localName === "txbxContent" ? 160 : 800;
    slots.push({ id: `field_${slots.length + 1}`, part, node, kind, label: label.slice(0, 200), maxChars, ...extra });
  };
  for (const [part, data] of entries) {
    if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/.test(part)) continue;
    const doc = parseXml(data);
    parts.set(part, doc);
    const paragraphs = descendants(doc, "p");
    textParts.push(paragraphs.map((p) => descendants(p, "t").filter((t) => ancestor(t, "p") === p && !ancestor(t, "del")).map((t) => t.textContent).join("")).join("\n"));
    const claimed = [];
    const covered = (node) => claimed.some((root) => isWithin(node, root));
    for (const control of descendants(doc, "sdt")) {
      if (covered(control) || ancestor(control, "del")) continue;
      const props = children(control, "sdtPr")[0];
      const content = children(control, "sdtContent")[0];
      if (!props || !content || ["lock", "dataBinding", "checkbox", "date", "dropDownList", "comboBox", "picture", "repeatingSection"].some((name) =>
        Array.from(props.getElementsByTagName("*")).some((n) => n.localName === name))
        || descendants(content, "tbl").length || descendants(content, "drawing").length) continue;
      const label = (children(props, "alias")[0] || children(props, "tag")[0])?.getAttributeNS(W, "val") || visibleText(content) || "テキスト入力欄";
      add(part, content, "control", label, { control });
      claimed.push(control);
    }
    for (const paragraph of paragraphs) {
      if (covered(paragraph) || ancestor(paragraph, "del") || ancestor(paragraph, "sdt")) continue;
      const text = descendants(paragraph, "t").filter((t) => ancestor(t, "p") === paragraph && !ancestor(t, "del")).map((t) => t.textContent).join("");
      let matched = false;
      for (const match of text.matchAll(/\{\{([^{}\n]{1,100})\}\}/g)) {
        add(part, paragraph, "placeholder", match[1].trim(), { start: match.index, end: match.index + match[0].length });
        matched = true;
      }
      if (matched) claimed.push(paragraph);
    }
    for (const cell of descendants(doc, "tc")) {
      if (covered(cell) || ancestor(cell, "del") || descendants(cell, "sdt").length || descendants(cell, "tbl").length
        || descendants(cell, "drawing").length || descendants(cell, "pict").length || visibleText(cell).trim()) continue;
      const merge = descendants(cell, "vMerge")[0];
      if (merge && merge.getAttributeNS(W, "val") !== "restart") continue;
      const row = ancestor(cell, "tr");
      const table = ancestor(row, "tbl");
      const cells = children(row, "tc");
      const index = cells.indexOf(cell);
      const rows = children(table, "tr");
      const left = cells.slice(0, index).map(visibleText).filter((text) => text.trim()).at(-1);
      const header = rows.slice(0, rows.indexOf(row)).map((r) => children(r, "tc")[index]).filter(Boolean).map(visibleText).filter((text) => text.trim()).at(-1);
      add(part, cell, "cell", [left, header].filter(Boolean).join(" / ") || `表の${rows.indexOf(row) + 1}行${index + 1}列`);
      claimed.push(cell);
    }
    for (const box of descendants(doc, "txbxContent")) {
      if (covered(box) || claimed.some((root) => isWithin(root, box)) || visibleText(box).trim() || ancestor(box, "del") || descendants(box, "sdt").length) continue;
      const enclosingParagraph = ancestor(box, "p");
      const priorLabel = paragraphs.slice(0, paragraphs.indexOf(enclosingParagraph)).map(visibleText).filter((text) => text.trim()).at(-1);
      add(part, box, "textbox", priorLabel || "空のテキストボックス");
      claimed.push(box);
    }
  }
  const fields = slots.map(({ id, kind, label, maxChars }) => ({ id, kind, label, maxChars }));
  return {
    text: textParts.join("\n").slice(0, 20000), fields,
    fill(values) {
      if (!values || typeof values !== "object" || Array.isArray(values)
        || Object.keys(values).length !== slots.length || slots.some((slot) => !Object.hasOwn(values, slot.id))) {
        throw new AttachmentError("AIの入力欄データが不完全です。Wordは変更せずに終了しました。");
      }
      // Validate every value before mutating any XML.
      for (const slot of slots) {
        if (typeof values[slot.id] !== "string" || values[slot.id].length > slot.maxChars) throw new AttachmentError("入力欄の文章が長すぎます。短めに記入するよう依頼してください。");
      }
      for (const slot of [...slots].reverse()) {
        const value = safeText(values[slot.id]) || "（会話内に情報なし）";
        if (slot.kind === "placeholder") replaceRange(slot.node, slot.start, slot.end, value);
        else setContainerText(slot.node, value);
        if (slot.control) for (const node of descendants(slot.control, "showingPlcHdr")) node.parentNode.removeChild(node);
        const row = ancestor(slot.node, "tr");
        if (row) for (const height of descendants(row, "trHeight")) {
          if (height.getAttributeNS(W, "hRule") === "exact") height.setAttributeNS(W, "w:hRule", "atLeast");
        }
      }
      const changed = new Set(slots.map((slot) => slot.part));
      for (const part of changed) {
        materializeLineBreaks(parts.get(part));
        entries.set(part, Buffer.from(new XMLSerializer().serializeToString(parts.get(part))));
      }
      const archive = Object.create(null);
      for (const [name, bytes] of entries) archive[name] = bytes;
      const output = Buffer.from(zipSync(archive, { level: 6 }));
      if (output.length > MAX_DOCX_BYTES) throw new AttachmentError("完成したWordが8MBを超えました。画像などを減らして再度お試しください。");
      return output;
    },
  };
}

module.exports = { openWordTemplate, AttachmentError, MAX_DOCX_BYTES };
