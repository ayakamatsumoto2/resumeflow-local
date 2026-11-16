/**
 * ResumeFLOW Local Edition — 各本地处理器共用的工具。
 * 逻辑移植自原版后端 backend/app（utils/date_utils.py、resume_analysis_freshness.py 等）。
 */
import { nowIso, save, table, type Row } from '../store';

export const LOCAL_USER_ID = 'local-user';

const PRESENT_DATE_MARKERS = new Set([
  'present', 'current', 'now', 'ongoing', '至今', '当前', '现在', '目前',
]);

export const isBlankOrPresentDate = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  const text = String(value).trim();
  return !text || PRESENT_DATE_MARKERS.has(text.toLowerCase());
};

/** 统一成 YYYY-MM-01；无法识别时返回 null。 */
export const normalizeMonthDate = (value: unknown): string | null => {
  if (isBlankOrPresentDate(value)) return null;
  const normalized = String(value).trim()
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace(/\s+/g, '')
    .replace(/-+$/, '');
  const match = /^(\d{4})(?:-(\d{1,2})(?:-\d{1,2})?)?$/.exec(normalized);
  if (!match) return null;
  const month = Number(match[2] || '1');
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-01`;
};

export const isPlainObject = (value: unknown): value is Row => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const pickDefined = (source: Row, keys: string[]): Row => {
  const result: Row = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
};

/**
 * 经历库/技能/证书变化后，把已保存的 JD 分析与六维评估标记为过期。
 * 对应原版 invalidate_user_resume_analyses。
 */
export const invalidateResumeAnalyses = (options: { invalidateMatch?: boolean } = {}): boolean => {
  const invalidateMatch = options.invalidateMatch !== false;
  const updatedAt = nowIso();
  let changed = false;
  for (const resume of table('resumes')) {
    const analysis = resume.config?.jdAnalysis;
    if (!isPlainObject(analysis)) continue;
    const needsMatch = invalidateMatch && analysis.isOutdated !== true;
    const needsEvaluation = analysis.evaluationIsOutdated !== true;
    if (!needsMatch && !needsEvaluation) continue;
    resume.config = {
      ...resume.config,
      jdAnalysis: {
        ...analysis,
        ...(invalidateMatch ? { isOutdated: true } : {}),
        evaluationIsOutdated: true,
      },
    };
    resume.updated_at = updatedAt;
    changed = true;
  }
  return changed;
};

export const saveResumesIf = async (changed: boolean) => {
  if (changed) {
    await save('resumes');
  }
};
