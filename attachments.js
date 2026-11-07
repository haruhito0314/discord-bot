const { openWordTemplate, AttachmentError, MAX_DOCX_BYTES } = require("./word-template");

const MAX_TXT_BYTES = 256 * 1024;
const MAX_FILES = 4;

function decodeText(buffer) {
  let encoding = "utf-8";
  if (buffer[0] === 0xff && buffer[1] === 0xfe) encoding = "utf-16le";
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) encoding = "utf-16be";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
  catch {
    try { encoding = "shift_jis"; text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { throw new AttachmentError("txtの文字コードを読み取れません。UTF-8で保存してください。"); }
  }
  if (text.includes("\0")) throw new AttachmentError("txtにバイナリデータが含まれています。テキストファイルを添付してください。");
  return { text: text.replace(/\r\n?/g, "\n"), encoding };
}

function createAttachmentReader({ fetchImpl = fetch, signal } = {}) {
  const cache = new Map();
  async function read(attachment, channelId) {
    const name = attachment.name || "file";
    const kind = /\.docx$/i.test(name) ? "docx" : /\.txt$/i.test(name) ? "txt" : null;
    if (!kind) throw new AttachmentError("読み込める添付は.docxと.txtです。");
    const limit = kind === "txt" ? MAX_TXT_BYTES : MAX_DOCX_BYTES;
    if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > limit) {
      throw new AttachmentError(kind === "txt" ? "txtは256KB以下にしてください。" : "Wordは8MB以下にしてください。");
    }
    let url;
    try { url = new URL(attachment.url); } catch { throw new AttachmentError("添付ファイルのURLが不正です。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
      || !url.pathname.startsWith(`/attachments/${channelId}/`)
      || !/^\/attachments\/\d{17,20}\/\d{17,20}\//.test(url.pathname)) {
      throw new AttachmentError("同じ参照元チャンネルのDiscord添付ファイルだけを読み込めます。");
    }
    const cacheKey = url.origin + url.pathname;
    if (cache.has(cacheKey)) {
      if (!cache.get(cacheKey)) throw new AttachmentError("この添付ファイルは読み込めませんでした。再添付してください。");
      return cache.get(cacheKey);
    }
    if (cache.size >= MAX_FILES) throw new AttachmentError("1回の質問で読み込める添付は合計4個までです。");
    cache.set(cacheKey, null);
    let response;
    try { response = await fetchImpl(url.href, { signal, redirect: "error" }); }
    catch { throw new AttachmentError("添付ファイルを取得できませんでした。再添付してお試しください。"); }
    if (!response.ok || !response.body) throw new AttachmentError("添付ファイルの有効期限またはアクセス権を確認してください。");
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > limit) {
      await response.body.cancel().catch(() => {});
      throw new AttachmentError("添付ファイルがサイズ上限を超えています。");
    }
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limit) throw new AttachmentError("添付ファイルがサイズ上限を超えています。");
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("添付ファイルの読み込みが中断されました。");
    }
    const buffer = Buffer.concat(chunks);
    const result = kind === "txt" ? { kind, name, ...decodeText(buffer) }
      : { kind, name, template: await openWordTemplate(buffer, { signal }) };
    cache.set(cacheKey, result);
    return result;
  }
  return { read };
}

function filledFileName(original) {
  const base = original.replace(/\.docx$/i, "").replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 60) || "document";
  return `${base}_記入済み.docx`;
}

module.exports = { createAttachmentReader, decodeText, filledFileName, AttachmentError };
