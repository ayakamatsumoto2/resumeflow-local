/**
 * 本地版不再需要的线上能力（额度/支付/反馈/Agent 插件）的最小替身，
 * 仅用于让原有界面逻辑正常运转，不产生任何网络请求。
 */
import { HttpError, route } from '../http';
import { LOCAL_USER_ID } from './shared';

const REMOVED_MESSAGE = '本地版已移除该线上功能。';

const unlimitedSummary = () => ({
  user_id: LOCAL_USER_ID,
  token_limit: 0,
  remaining_tokens: 0,
  used_tokens: 0,
  remaining_percent: 100,
  is_unlimited: true,
  unlimited_expires_at: '2099-12-31T00:00:00Z',
  unlimited_plan_name: '本地版（使用自己的 API Key）',
  last_purchase_tokens: 0,
  last_purchase_at: null,
  updated_at: null,
});

route('GET', '/api/billing/summary', () => ({ json: unlimitedSummary() }));
route('GET', '/api/billing/usage', () => ({
  json: { events: [], usage_by_day: [], usage_by_entrypoint: [] },
}));
route('GET', '/api/billing/products', () => ({
  json: { products: [], catalog_version: 'local', payment_enabled: false },
}));
route('GET', '/api/billing/payment-orders', () => ({ json: { orders: [], next_cursor: null } }));
route('GET', '/api/billing/payment-orders/purchase-context', () => {
  throw new HttpError(410, REMOVED_MESSAGE);
});
route('POST', '/api/billing/payment-orders', () => {
  throw new HttpError(410, REMOVED_MESSAGE);
});
route('POST', '/api/billing/redemptions', () => {
  throw new HttpError(410, REMOVED_MESSAGE);
});
route('POST', '/feedback', () => {
  throw new HttpError(410, '本地版不收集反馈，可到项目仓库提交 issue。');
});
route('GET', '/agent/config', () => ({
  json: {
    selected_template_id: 'modern-slate',
    polish_before_output: true,
    polish_level: '标准',
    force_one_page: true,
    updated_at: null,
  },
}));
route('PUT', '/agent/config', () => {
  throw new HttpError(410, REMOVED_MESSAGE);
});
route('GET', '/agent/api-keys', () => ({ json: [] }));
route('POST', '/agent/api-keys', () => {
  throw new HttpError(410, REMOVED_MESSAGE);
});
