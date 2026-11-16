/**
 * ResumeFLOW Local Edition — 用系统打印对话框导出 PDF。
 * 在隐藏的同源 iframe 里打开原版的打印页，等排版就绪后调用 print()，
 * 用户在对话框里选择「另存为 PDF / Microsoft Print to PDF」即可。
 */

const READY_TIMEOUT_MS = 45_000;
const CLEANUP_DELAY_MS = 120_000;

export const isLocalPrintUrl = (url: string): boolean => {
  try {
    return new URL(url, window.location.href).pathname.startsWith('/print/');
  } catch {
    return false;
  }
};

export const printLocalExport = (url: string, fileName?: string): Promise<void> => new Promise((resolve, reject) => {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // 需要真实的 A4 版面宽度才能正确测量分页，因此放到屏幕外而不是 display:none。
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;';
  let settled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    frame.remove();
  };
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new Error(message));
  };
  const startedAt = Date.now();

  frame.addEventListener('load', () => {
    pollTimer = setInterval(() => {
      if (settled) return;
      const body = frame.contentDocument?.body;
      if (!body) return;
      if (body.dataset.rfExportError) {
        fail(body.dataset.rfExportError);
        return;
      }
      if (body.dataset.rfExportReady === 'true') {
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        const target = frame.contentWindow;
        if (!target) {
          cleanup();
          reject(new Error('无法打开打印窗口。'));
          return;
        }
        // 浏览器用文档标题作为「另存为 PDF」的默认文件名。
        const title = (fileName || '').replace(/\.pdf$/i, '').trim();
        const previousTitle = document.title;
        if (title && frame.contentDocument) frame.contentDocument.title = title;
        if (title) document.title = title;
        const restore = () => {
          document.title = previousTitle;
          setTimeout(cleanup, 1_000);
        };
        target.addEventListener('afterprint', restore, { once: true });
        setTimeout(restore, CLEANUP_DELAY_MS);
        try {
          target.focus();
          target.print();
          resolve();
        } catch {
          restore();
          reject(new Error('无法调用系统打印，请重试。'));
        }
        return;
      }
      if (Date.now() - startedAt > READY_TIMEOUT_MS) {
        fail('PDF 排版超时，请稍后重试。');
      }
    }, 150);
  }, { once: true });
  frame.addEventListener('error', () => fail('打印页面加载失败。'), { once: true });
  frame.src = url;
  document.body.appendChild(frame);
});
