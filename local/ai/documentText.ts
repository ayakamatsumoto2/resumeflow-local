/**
 * ResumeFLOW Local Edition — 在本机从附件中提取文字（PDF / DOCX / 纯文本）。
 * 取代原版后端的 pypdf / python-docx 解析；文件不会离开本机。
 */
import { HttpError } from '../http';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'text']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const extensionOf = (file: File) => (file.name.split('.').pop() || '').toLowerCase();

const extractPdfText = async (data: ArrayBuffer): Promise<string> => {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let currentLine = '';
      let lastY: number | null = null;
      for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && currentLine.trim()) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        currentLine += item.str;
        if (item.hasEOL) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        if (y !== null) lastY = y;
      }
      if (currentLine.trim()) lines.push(currentLine.trim());
      pages.push(lines.filter(Boolean).join('\n'));
    }
  } finally {
    await document.destroy();
  }
  return pages.join('\n\n');
};

const extractDocxText = async (data: ArrayBuffer): Promise<string> => {
  const { unzipSync, strFromU8 } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(data), {
      filter: (file) => file.name === 'word/document.xml',
    });
  } catch {
    throw new HttpError(400, '无法读取这个 Word 文件，请确认它是 .docx 格式。');
  }
  const xml = entries['word/document.xml'];
  if (!xml) throw new HttpError(400, '无法读取这个 Word 文件，请确认它是 .docx 格式。');
  const dom = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
  const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs: string[] = [];
  for (const paragraph of Array.from(dom.getElementsByTagNameNS(WORD_NS, 'p'))) {
    let text = '';
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        if (child.namespaceURI === WORD_NS) {
          if (child.localName === 't') text += child.textContent || '';
          else if (child.localName === 'tab') text += '\t';
          else if (child.localName === 'br' || child.localName === 'cr') text += '\n';
        }
        walk(child);
      }
    };
    walk(paragraph);
    if (text.trim()) paragraphs.push(text.trim());
  }
  return paragraphs.join('\n');
};

export const isImageFile = (file: File) => (
  file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extensionOf(file))
);

export const extractAttachmentText = async (
  file: File,
  options: { purpose?: string; maxChars?: number } = {},
): Promise<string> => {
  const label = options.purpose || '附件';
  if (file.size > MAX_FILE_BYTES) {
    throw new HttpError(400, `${label}文件过大（上限 20MB）。`);
  }
  const extension = extensionOf(file);
  if (isImageFile(file)) {
    throw new HttpError(
      400,
      `本地版暂不支持图片${label}（DeepSeek 等文本模型无法识别图片）。请改为粘贴文字，或上传 PDF / Word。`,
    );
  }
  let text: string;
  if (extension === 'pdf' || file.type === 'application/pdf') {
    text = await extractPdfText(await file.arrayBuffer());
  } else if (extension === 'docx' || file.type.includes('wordprocessingml')) {
    text = await extractDocxText(await file.arrayBuffer());
  } else if (TEXT_EXTENSIONS.has(extension) || file.type.startsWith('text/')) {
    text = await file.text();
  } else if (extension === 'doc') {
    throw new HttpError(400, '暂不支持旧版 .doc 文件，请另存为 .docx 或 PDF 后再上传。');
  } else {
    throw new HttpError(400, `不支持的${label}格式，请上传 PDF、Word（.docx）或纯文本。`);
  }
  const cleaned = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) {
    throw new HttpError(400, `没有从${label}中读到文字。扫描件/图片型 PDF 需要先做文字识别。`);
  }
  const maxChars = options.maxChars ?? 50_000;
  if (cleaned.length > maxChars) {
    throw new HttpError(400, `${label}内容过长，请控制在 ${maxChars} 字符以内。`);
  }
  return cleaned;
};
