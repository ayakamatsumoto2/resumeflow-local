import React from 'react';
import { useLogto } from '@logto/react';
import { FolderOpen, Database, Wand2, LogOut, MessageSquare, LogIn, Bot, CreditCard, UserCog, Gauge } from 'lucide-react';
import { ViewState } from '../types';
import { useProfile } from '../hooks/useProfile';
import { markUserSignInStarted, markUserSignOutStarted } from '../services/authFlowState';
import { resolveAvatarInitial, resolveDisplayName } from '../utils/profileDisplay';
import { trackLoginStart } from '../utils/analyticsTracker';
import { formatDateTime, formatTokenAmount } from '../utils/quotaDisplay';
import type { TokenQuotaSummary } from '../services/billingService';

interface GlobalSidebarProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
  onOpenFeedback: () => void;
  onOpenAgentPluginConfig: () => void;
  quotaSummary?: TokenQuotaSummary | null;
  onOpenTokenQuota: (returnFocusElement?: HTMLElement | null) => void;
  onOpenTokenPurchase: (returnFocusElement?: HTMLElement | null) => void;
}

const DEFAULT_PROFILE_NAME = '即刻开始';
const DEFAULT_AVATAR_PLACEHOLDER = '?';
const TOKEN_RING_CIRCUMFERENCE = 138;

const GlobalSidebar: React.FC<GlobalSidebarProps> = ({
  currentView,
  setView,
  onOpenFeedback,
  onOpenAgentPluginConfig,
  quotaSummary,
  onOpenTokenQuota,
  onOpenTokenPurchase,
}) => {
  const { signOut, signIn, isAuthenticated } = useLogto();
  const { profile } = useProfile();
  const accountCenterUrl = import.meta.env.VITE_LOGTO_ACCOUNT_CENTER_URL?.trim();
  const mobileAvatarButtonRef = React.useRef<HTMLButtonElement>(null);
  const desktopAvatarButtonRef = React.useRef<HTMLButtonElement>(null);
  const [isAvatarMenuOpen, setIsAvatarMenuOpen] = React.useState(false);
  const mobileAvatarMenuRef = React.useRef<HTMLDivElement | null>(null);
  const desktopAvatarMenuRef = React.useRef<HTMLDivElement | null>(null);
  const displayName = resolveDisplayName(profile?.full_name, DEFAULT_PROFILE_NAME);
  const avatarInitial = resolveAvatarInitial(profile?.full_name, DEFAULT_AVATAR_PLACEHOLDER);
  const isUnlimitedQuota = Boolean(quotaSummary?.is_unlimited);
  const quotaPercent = isUnlimitedQuota ? 100 : Math.max(0, Math.min(quotaSummary?.remaining_percent ?? 0, 100));
  const quotaDash = Math.round((quotaPercent / 100) * TOKEN_RING_CIRCUMFERENCE);
  const quotaRingClass = 'text-emerald-600';
  const quotaTooltipTextClass = 'text-emerald-200';
  // Local Edition：本地版没有额度概念，头像入口改为「本地设置」。
  const quotaTitle = '本地设置';

  const getButtonClass = (view: ViewState) => {
    const baseClass = "flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 py-2 transition-all relative group md:p-3";
    if (currentView === view) {
      if (view === ViewState.AI_ASSISTANT) {
        return `${baseClass} ai-active-gradient text-white shadow-md shadow-emerald-900/15`;
      }
      return `${baseClass} bg-primary text-white shadow-md shadow-primary/20`;
    }
    return `${baseClass} text-slate-500 hover:text-emerald-700 hover:bg-emerald-50`;
  };

  const mobileTabButtonClass = (view: ViewState) => {
    const baseClass = "flex h-11 items-center justify-center rounded-2xl transition-all duration-300 ease-in-out overflow-hidden";
    if (currentView === view) {
      if (view === ViewState.AI_ASSISTANT) {
        return `${baseClass} ai-active-gradient text-white shadow-md shadow-emerald-900/15 flex-1 px-3 gap-2`;
      }
      return `${baseClass} bg-primary text-white shadow-md shadow-primary/20 flex-1 px-3 gap-2`;
    }
    return `${baseClass} bg-slate-100 text-slate-500 hover:bg-emerald-50 hover:text-emerald-700 w-12 px-0 gap-0`;
  };

  const mobileTabs = [
    { view: ViewState.DASHBOARD, icon: FolderOpen, label: '我的简历' },
    { view: ViewState.EXPERIENCE_BANK, icon: Database, label: '经历库' },
    { view: ViewState.EDITOR, icon: Wand2, label: '简历工厂' },
    { view: ViewState.AI_ASSISTANT, icon: Bot, label: 'AI助理' },
  ];
  const handleSignOut = async () => {
    // 注销并跳转回首页(登录页)
    // 注意: 需要在 Logto 控制台将 http://localhost:5173 添加到 "Post Sign-out Redirect URI"
    setIsAvatarMenuOpen(false);
    markUserSignOutStarted();
    await signOut(window.location.origin);
  };

  const handleSignIn = async () => {
    setIsAvatarMenuOpen(false);
    markUserSignInStarted();
    await trackLoginStart('sidebar');
    await signIn(import.meta.env.VITE_LOGTO_REDIRECT_URI || window.location.href);
  };

  React.useEffect(() => {
    if (!isAvatarMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node;
      const isInsideMenu = Boolean(
        mobileAvatarMenuRef.current?.contains(targetNode)
        || desktopAvatarMenuRef.current?.contains(targetNode)
      );

      if (!isInsideMenu) {
        setIsAvatarMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAvatarMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAvatarMenuOpen]);

  const handleAvatarClick = () => {
    setIsAvatarMenuOpen((open) => !open);
  };

  const handleOpenFeedback = () => {
    setIsAvatarMenuOpen(false);
    onOpenFeedback();
  };

  const handleOpenTokenPurchase = (returnFocusElement?: HTMLElement | null) => {
    setIsAvatarMenuOpen(false);
    onOpenTokenPurchase(returnFocusElement);
  };

  const handleOpenAgentPluginConfig = () => {
    setIsAvatarMenuOpen(false);
    onOpenAgentPluginConfig();
  };

  const handleOpenTokenQuota = (returnFocusElement?: HTMLElement | null) => {
    setIsAvatarMenuOpen(false);
    onOpenTokenQuota(returnFocusElement);
  };

  const handleOpenAccountManagement = () => {
    setIsAvatarMenuOpen(false);
    if (accountCenterUrl) {
      window.open(accountCenterUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleSetView = (view: ViewState) => {
    setIsAvatarMenuOpen(false);
    setView(view);
  };

  const renderAvatarMenu = (placement: 'mobile' | 'desktop') => (
    <div
      className={`absolute z-[60] min-w-[208px] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/95 p-2 shadow-xl shadow-slate-900/10 backdrop-blur ${
        placement === 'mobile' ? 'left-0 top-full mt-3' : 'left-full top-0 ml-3'
      }`}
      role="menu"
      aria-label="头像工具栏"
    >
      <div className="border-b border-slate-200 px-3 pb-2 pt-1">
        <div className="font-serif text-base text-slate-900">{displayName}</div>
        <div className="text-xs text-slate-500">本地版 · 数据只保存在本机</div>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <button
          className="flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-emerald-50 hover:text-emerald-700"
          onClick={() => handleOpenTokenQuota(
            placement === 'mobile' ? mobileAvatarButtonRef.current : desktopAvatarButtonRef.current
          )}
          type="button"
          role="menuitem"
        >
          <Gauge className="h-4 w-4" />
          <span>本地设置（AI 接口 / 数据备份）</span>
        </button>
      </div>
    </div>
  );

  return (
    <nav aria-label="主导航" className="w-full shrink-0 border-b border-slate-200 bg-slate-50/90 backdrop-blur z-50 md:flex md:h-full md:w-[72px] md:flex-col md:items-center md:border-b-0 md:border-r">
      <div className="px-3 py-3 md:hidden">
        <div className="flex items-center gap-3">
          <div ref={mobileAvatarMenuRef} className="relative shrink-0">
            <button
              ref={mobileAvatarButtonRef}
              className="group relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-emerald-600 to-emerald-800 text-base font-bold text-white shadow-lg ring-2 ring-slate-50 transition-all hover:ring-emerald-100"
              onClick={handleAvatarClick}
              type="button"
              data-token-quota-focus-return
              aria-label="打开头像工具栏"
              aria-expanded={isAvatarMenuOpen}
              aria-haspopup="menu"
              title={quotaTitle}
            >
              <svg className="pointer-events-none absolute -inset-1 h-14 w-14 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="3" className="text-slate-200" />
                <circle
                cx="24"
                cy="24"
                r="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className={`${quotaRingClass} transition-all`}
                strokeDasharray={`${quotaDash} ${TOKEN_RING_CIRCUMFERENCE}`}
              />
              </svg>
              {avatarInitial}
            </button>
            {isAvatarMenuOpen ? renderAvatarMenu('mobile') : null}
          </div>

          <div className="flex min-w-0 flex-1 gap-2">
            {mobileTabs.map(tab => {
              const isActive = currentView === tab.view;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.view}
                  aria-label={tab.label}
                  aria-current={isActive ? "page" : undefined}
                  data-agent-action="navigate"
                  data-agent-view={tab.view}
                  className={mobileTabButtonClass(tab.view)}
                  onClick={() => handleSetView(tab.view)}
                  type="button"
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span
                    className={`truncate text-xs font-medium transition-all duration-300 ease-in-out ${
                      isActive ? 'max-w-[5rem] opacity-100 ml-1' : 'max-w-0 opacity-0 ml-0'
                    }`}
                  >
                    {tab.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="hidden h-full w-full flex-col items-center px-0 py-6 md:flex">
        <div ref={desktopAvatarMenuRef} className="relative">
          <button
            ref={desktopAvatarButtonRef}
            className="group relative flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-emerald-600 to-emerald-800 text-white font-bold shadow-lg ring-2 ring-slate-50 transition-all hover:ring-emerald-100"
            aria-label="当前用户头像"
            aria-expanded={isAvatarMenuOpen}
            aria-haspopup="menu"
            data-token-quota-focus-return
            onClick={handleAvatarClick}
            title={`${displayName} · ${quotaTitle}`}
            type="button"
          >
            <svg className="pointer-events-none absolute -inset-1 h-12 w-12 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="3" className="text-slate-200" />
              <circle
                cx="24"
                cy="24"
                r="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className={`${quotaRingClass} transition-all`}
                strokeDasharray={`${quotaDash} ${TOKEN_RING_CIRCUMFERENCE}`}
              />
            </svg>
            {avatarInitial}
            <div className="nav-tooltip hidden md:block">
              <div>{displayName}</div>
              <div className={`mt-1 text-[10px] font-medium ${quotaTooltipTextClass}`}>{quotaTitle}</div>
            </div>
          </button>
          {isAvatarMenuOpen ? renderAvatarMenu('desktop') : null}
        </div>

        <div className="mt-8 flex w-full flex-1 flex-col items-center gap-6">
          <button
            aria-label="我的简历"
            aria-current={currentView === ViewState.DASHBOARD ? 'page' : undefined}
            data-agent-action="navigate" data-agent-view={ViewState.DASHBOARD}
            className={getButtonClass(ViewState.DASHBOARD)}
            onClick={() => handleSetView(ViewState.DASHBOARD)}
            type="button"
          >
            <FolderOpen className="w-6 h-6" />
            <span className="text-xs font-medium md:hidden">我的简历</span>
            <div className="nav-tooltip hidden md:block">我的简历</div>
          </button>

          <button
            aria-label="经历库"
            aria-current={currentView === ViewState.EXPERIENCE_BANK ? 'page' : undefined}
            data-agent-action="navigate" data-agent-view={ViewState.EXPERIENCE_BANK}
            className={getButtonClass(ViewState.EXPERIENCE_BANK)}
            onClick={() => handleSetView(ViewState.EXPERIENCE_BANK)}
            type="button"
          >
            <Database className="w-6 h-6" />
            <span className="text-xs font-medium md:hidden">经历库</span>
            <div className="nav-tooltip hidden md:block">经历库</div>
          </button>

          <button
            aria-label="简历工厂"
            aria-current={currentView === ViewState.EDITOR ? 'page' : undefined}
            data-agent-action="navigate" data-agent-view={ViewState.EDITOR}
            className={getButtonClass(ViewState.EDITOR)}
            onClick={() => handleSetView(ViewState.EDITOR)}
            type="button"
          >
            <Wand2 className="w-6 h-6" />
            <span className="text-xs font-medium md:hidden">简历工厂</span>
            <div className="nav-tooltip hidden md:block">简历工厂</div>
          </button>

          <button
            aria-label="AI助理"
            aria-current={currentView === ViewState.AI_ASSISTANT ? 'page' : undefined}
            data-agent-action="navigate" data-agent-view={ViewState.AI_ASSISTANT}
            className={getButtonClass(ViewState.AI_ASSISTANT)}
            onClick={() => handleSetView(ViewState.AI_ASSISTANT)}
            type="button"
          >
            <Bot className="w-6 h-6" />
            <span className="text-xs font-medium md:hidden">AI助理</span>
            <div className="nav-tooltip hidden md:block">AI助理</div>
          </button>
        </div>

        <div className="mt-auto flex w-full flex-col items-center gap-4 pb-2">


        </div>
      </div>
    </nav>
  );
};

export default GlobalSidebar;
