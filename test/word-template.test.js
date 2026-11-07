const test = require("node:test");
const assert = require("node:assert/strict");
const { zipSync, unzipSync, strToU8, strFromU8 } = require("fflate");
const { openWordTemplate } = require("../word-template");
const { createAttachmentReader, decodeText, filledFileName } = require("../attachments");

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CHANNEL = "100000000000000004";
const FILE = "400000000000000001";
const wrap = (body) => `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
const p = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text = "") => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`;
function docx(body, extra = {}) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(wrap(body)),
    "word/styles.xml": strToU8(`<w:styles xmlns:w="${W}"><w:style w:styleId="KeepMe"/></w:styles>`),
    ...extra,
  }));
}
const xml = (bytes) => strFromU8(unzipSync(bytes)["word/document.xml"]);
const valuesFor = (template, value = "チャットで決まったこと") => Object.fromEntries(template.fields.map((field) => [field.id, value]));

test("fills split-run placeholders and blank table cells, preserving labels and styles", async () => {
  const original = docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>会議 {{概</w:t></w:r><w:r><w:t>要}} 担当 {{担当}}</w:t></w:r></w:p>'
    + `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tr><w:trPr><w:trHeight w:val="400" w:hRule="exact"/></w:trPr>${cell("決定事項")}${cell()}</w:tr></w:tbl>`);
  const template = await openWordTemplate(original);
  assert.deepEqual(template.fields.map((f) => f.kind), ["placeholder", "placeholder", "cell"]);
  const filled = template.fill({ field_1: "A & B\n改行", field_2: "山田", field_3: "11月10日に公開" });
  const output = xml(filled);
  assert.match(output, /A &amp; B/);
  assert.match(output, /w:br/);
  assert.match(output, /w:b\//);
  assert.match(output, /決定事項/);
  assert.match(output, /11月10日に公開/);
  assert.match(output, /w:hRule="atLeast"/);
  assert.ok(!output.includes("{{"));
  assert.deepEqual(unzipSync(filled)["word/styles.xml"], unzipSync(original)["word/styles.xml"]);
});

test("fills plain-text controls and empty textboxes without replacing surrounding content", async () => {
  const body = p("そのまま残す見出し") + '<w:sdt><w:sdtPr><w:alias w:val="概要"/><w:text/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>'
    + p("クリックして入力") + '</w:sdtContent></w:sdt>'
    + '<w:p><w:r><w:pict><w:txbxContent>' + p("") + '</w:txbxContent></w:pict></w:r></w:p>';
  const template = await openWordTemplate(docx(body));
  assert.deepEqual(template.fields.map((f) => f.kind), ["control", "textbox"]);
  const output = xml(template.fill(valuesFor(template, "決定済み")));
  assert.match(output, /そのまま残す見出し/);
  assert.ok(!output.includes("クリックして入力"));
  assert.ok(!output.includes("showingPlcHdr"));
  assert.equal((output.match(/決定済み/g) || []).length, 2);
});

test("preserves existing cells, decorative empty paragraphs, and unsupported controls", async () => {
  const template = await openWordTemplate(docx(p("") + `<w:tbl><w:tr>${cell("既存の回答")}</w:tr></w:tbl>`
    + '<w:sdt><w:sdtPr><w:date/></w:sdtPr><w:sdtContent>' + p("日付選択") + '</w:sdtContent></w:sdt>'));
  assert.equal(template.fields.length, 0);
  assert.match(template.text, /既存の回答/);
});

test("populated text controls and existing document text remain unchanged while empty cells are filled", async () => {
  const populated = '<w:sdt><w:sdtPr><w:alias w:val="氏名"/><w:text/></w:sdtPr><w:sdtContent>' + p("既に記入された氏名") + '</w:sdtContent></w:sdt>';
  const template = await openWordTemplate(docx(p("変更しない説明文") + populated + `<w:tbl><w:tr>${cell("レポート本文")}${cell()}</w:tr></w:tbl>`));
  assert.equal(template.fields.length, 1);
  const output = xml(template.fill({ field_1: "空欄にだけ追加する本文" }));
  assert.match(output, /変更しない説明文/);
  assert.match(output, /既に記入された氏名/);
  assert.match(output, /空欄にだけ追加する本文/);
});

test("rejects incomplete and oversized model edits before changing the document", async () => {
  const template = await openWordTemplate(docx(p("{{概要}}")));
  assert.throws(() => template.fill({ wrong_field: "改ざん" }), /不完全/);
  assert.throws(() => template.fill({ field_1: "長".repeat(801) }), /長すぎ/);
  assert.match(xml(template.fill({ field_1: "正しい記入" })), /正しい記入/);
});

test("rejects protected documents, macros, malformed XML, and DTD declarations", async () => {
  const protectedSettings = strToU8(`<w:settings xmlns:w="${W}"><w:documentProtection w:enforcement="1"/></w:settings>`);
  await assert.rejects(openWordTemplate(docx(p("{{概要}}"), { "word/settings.xml": protectedSettings })), /編集保護/);
  await assert.rejects(openWordTemplate(docx(p("{{概要}}"), { "word/vbaProject.bin": new Uint8Array([0]) })), /マクロ/);
  await assert.rejects(openWordTemplate(docx("", { "word/document.xml": strToU8('<!DOCTYPE a [<!ENTITY x "bad">]><a/>') })), /外部実体/);
  await assert.rejects(openWordTemplate(docx("", { "word/document.xml": strToU8('<w:document xmlns:w="' + W + '"><w:body></w:document>') })), /XML/);
});

test("rejects oversized ZIP entry declarations before decompression", async () => {
  const bytes = docx(p("{{概要}}"));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(30 * 1024 * 1024, central + 24);
  await assert.rejects(openWordTemplate(bytes), /上限|ZIP構造/);
});

test("recognizes placeholders in headers without changing footer bytes", async () => {
  const footer = strToU8(`<w:ftr xmlns:w="${W}">${p("固定フッター")}</w:ftr>`);
  const template = await openWordTemplate(docx(p("本文"), {
    "word/header1.xml": strToU8(`<w:hdr xmlns:w="${W}">${p("{{表題}}")}</w:hdr>`), "word/footer1.xml": footer,
  }));
  const output = unzipSync(template.fill({ field_1: "議事録" }));
  assert.match(strFromU8(output["word/header1.xml"]), /議事録/);
  assert.deepEqual(output["word/footer1.xml"], footer);
});

test("reads UTF-8, UTF-16, and Japanese Shift JIS text", () => {
  assert.equal(decodeText(Buffer.from("会議\r\n決定")).text, "会議\n決定");
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("会議", "utf16le")])).text, "会議");
  assert.equal(decodeText(Buffer.from([0x93, 0xfa, 0x96, 0x7b])).text, "日本");
  assert.throws(() => decodeText(Buffer.from([0, 1, 2])), /バイナリ/);
});

test("only downloads genuine Discord attachment URLs for the source channel", async () => {
  let downloads = 0;
  const reader = createAttachmentReader({ fetchImpl: async () => { downloads++; return new Response("議事録"); } });
  const metadata = { name: "notes.txt", size: 100 };
  for (const url of ["http://127.0.0.1/notes.txt", `https://cdn.discordapp.com.evil.test/attachments/${CHANNEL}/${FILE}/notes.txt`, `https://cdn.discordapp.com/attachments/999999999999999999/${FILE}/notes.txt`]) {
    await assert.rejects(reader.read({ ...metadata, url }, CHANNEL), /同じ参照元/);
  }
  assert.equal(downloads, 0);
  const attached = { ...metadata, url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${FILE}/notes.txt` };
  assert.equal((await reader.read(attached, CHANNEL)).text, "議事録");
  await reader.read(attached, CHANNEL);
  assert.equal(downloads, 1);
});

test("enforces actual download size even when attachment metadata lies", async () => {
  const reader = createAttachmentReader({ fetchImpl: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) });
  await assert.rejects(reader.read({ name: "notes.txt", size: 1, url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${FILE}/notes.txt` }, CHANNEL), /サイズ上限/);
});

test("produces a safe Unicode output filename", () => {
  assert.equal(filledFileName("../会議 @everyone.docx"), "___会議__everyone_記入済み.docx");
});
