'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Link, { useLinkStatus } from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowUpRight, CalendarClock, Command, Gavel, History, LayoutDashboard, LogOut, Menu, Package, ShieldCheck, UsersRound, X } from 'lucide-react';
import Dialog from './Dialog';
import RoleBadge, { RoleIcon } from './RoleBadge';
import { clearClientData, getData, notifyDkpChanged } from '@/lib/client/api';

function NavigationHint() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`navigation-hint ${pending ? 'is-pending' : ''}`} />;
}

function canWarmInBackground() {
  if (navigator.onLine === false) return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

function warmResources(resources: string[], imports: Promise<unknown>[] = []) {
  if (!canWarmInBackground()) return () => undefined;
  let cancelled = false;
  const warm = async () => {
    await Promise.all(imports);
    for (const resource of resources) {
      if (cancelled) return;
      await getData(resource, { maxAgeMs: 15_000 }).catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  let cancelIdle: () => void;
  if ('requestIdleCallback' in window) {
    const idleId = window.requestIdleCallback(() => void warm(), { timeout: 2_000 });
    cancelIdle = () => window.cancelIdleCallback(idleId);
  } else {
    const timeoutId = setTimeout(() => void warm(), 1_000);
    cancelIdle = () => clearTimeout(timeoutId);
  }
  return () => {
    cancelled = true;
    cancelIdle();
  };
}

// Warm the rest of the workspace after the first screen is usable. Responses
// land in the same client cache used by each page, so navigation can render
// immediately without delaying the initial roster request.
function warmWorkspace(user: SessionUser) {
  const resources = ['/api/auction', '/api/admin/boss-history', '/api/role-changes'];
  const imports: Promise<unknown>[] = [import('./AuctionHousePanel'), import('./BossHistoryPanel')];
  if (['chief', 'general', 'guardian'].includes(user.role)) {
    resources.push('/api/auction/items');
    imports.push(import('./AuctionItemsPanel'));
  }
  if (['chief', 'general'].includes(user.role)) resources.push('/api/admin/requests', '/api/admin/requests?section=archives');
  return warmResources(resources, imports);
}

function warmDestination(href: string) {
  if (!canWarmInBackground()) return;
  const url = new URL(href, window.location.origin);
  const view = url.searchParams.get('view');
  let resource: string;
  if (url.pathname === '/dashboard') {
    if (view === 'auction') { resource = '/api/auction'; void import('./AuctionHousePanel').catch(() => undefined); }
    else if (view === 'boss-history') { resource = '/api/admin/boss-history'; void import('./BossHistoryPanel').catch(() => undefined); }
    else if (view === 'items') { resource = '/api/auction/items'; void import('./AuctionItemsPanel').catch(() => undefined); }
    else resource = '/api/dkp';
  } else if (url.pathname === '/admin/requests') resource = '/api/admin/requests';
  else if (url.pathname === '/admin/role-changes') resource = '/api/role-changes';
  else return;
  void getData(resource, { maxAgeMs: 15_000 }).catch(() => undefined);
}

function WorkspaceLink({ children, href, ...props }: React.ComponentProps<typeof Link> & { href: string }) {
  const [intent, setIntent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelWarmup = () => clearTimeout(timer.current);
  useEffect(() => cancelWarmup, []);
  const warm = () => {
    cancelWarmup();
    timer.current = setTimeout(() => { setIntent(true); warmDestination(href); }, 100);
  };
  return <Link {...props} href={href} prefetch={intent ? null : false} onPointerEnter={warm} onPointerLeave={cancelWarmup} onFocus={warm} onBlur={cancelWarmup}>{children}<NavigationHint /></Link>;
}

export interface SessionUser { id?: string; nickname: string; role: string; sheetRecordRows: number[] }
const SessionContext = createContext<SessionUser | null>(null);
export const useSessionUser = () => useContext(SessionContext);

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const userRef = useRef<SessionUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentView, setCurrentView] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const publicPage = pathname === '/login' || pathname === '/';

  useEffect(() => { setMenuOpen(false); setCurrentView(new URLSearchParams(window.location.search).get('view') ?? ''); }, [pathname]);
  useEffect(() => {
    const sync = () => setCurrentView(new URLSearchParams(window.location.search).get('view') ?? '');
    window.addEventListener('centuri:view-changed', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('centuri:view-changed', sync); window.removeEventListener('popstate', sync); };
  }, []);
  useEffect(() => {
    if (publicPage) { setUser(null); userRef.current=null; return; }
    let active = true;
    let lastCheckedAt = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now()-lastCheckedAt < 30_000) return;
      lastCheckedAt=Date.now();
      void getData<{user:SessionUser}>('/api/auth/session').then((result) => {
        if (!active) return;
        const previous=userRef.current;
        const changed=previous && (previous.id !== result.user.id || previous.role !== result.user.role || JSON.stringify(previous.sheetRecordRows) !== JSON.stringify(result.user.sheetRecordRows));
        userRef.current=result.user; setUser(result.user); setError('');
        if (changed) {
          clearClientData();
          notifyDkpChanged();
          window.dispatchEvent(new Event('centuri:session-updated'));
        }
      }).catch((cause) => {
        if (!active) return;
        if (cause?.status === 401) { clearClientData(); userRef.current=null; setUser(null); router.replace('/login'); }
        else setError('Session checks are delayed. Retrying automatically.');
      });
    };
    check();
    window.addEventListener('focus',check);
    document.addEventListener('visibilitychange',check);
    return () => { active=false; window.removeEventListener('focus',check); document.removeEventListener('visibilitychange',check); };
  }, [publicPage, router]);
  useEffect(() => {
    if (!user) return;
    return warmWorkspace(user);
  }, [user?.id, user?.role]);
  useEffect(() => {
    const onSignOut = (event: StorageEvent) => {
      if (event.key === 'centuri:logout') { clearClientData(); setUser(null); userRef.current=null; router.replace('/login'); }
    };
    window.addEventListener('storage', onSignOut);
    return () => window.removeEventListener('storage', onSignOut);
  }, [router]);

  const signOut = async () => {
    setSigningOut(true); setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      clearClientData(); setUser(null); userRef.current=null;
      try { localStorage.setItem('centuri:logout', String(Date.now())); } catch { /* Storage is optional. */ }
      router.replace('/login'); router.refresh();
    } catch { setError('Sign out did not complete. Please try again.'); }
    finally { setSigningOut(false); }
  };

  const canManage = ['chief', 'general', 'guardian'].includes(user?.role ?? '');
  const canAdmin = ['chief', 'general'].includes(user?.role ?? '');
  const isRoster = pathname === '/dashboard' && !['auction', 'items', 'boss-history'].includes(currentView);
  const isAuction = pathname === '/dashboard' && currentView === 'auction';
  const isHistory = pathname === '/admin/boss-history' || pathname === '/dashboard' && currentView === 'boss-history';
  const isCatalog = pathname === '/dashboard' && currentView === 'items';
  const isAdministration = pathname.startsWith('/admin/requests');
  const isRoleChanges = pathname.startsWith('/admin/role-changes');
  const currentLabel = isAdministration ? 'Clan administration' : isRoleChanges ? (user?.role === 'general' ? 'Role request review' : 'My role changes') : isHistory ? 'Kill history' : isAuction ? 'Auction house' : isCatalog ? 'Item catalog' : isRoster ? 'Roster' : 'Page not found';
  useEffect(() => {
    document.title = `${publicPage ? 'Sign in' : pathname === '/dashboard' || pathname.startsWith('/admin/') ? currentLabel : 'Page not found'} · Centuri DKP`;
  }, [publicPage, pathname, currentLabel]);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (publicPage) return <>{children}</>;
  const navClick = (event: React.MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const link=(event.target as HTMLElement).closest('a');
    if (link) {
      const url=new URL(link.href);
      if (pathname === '/dashboard' && url.pathname === '/dashboard') {
        event.preventDefault();
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (nextUrl !== currentUrl) window.history.pushState(null, '', nextUrl);
      }
      setCurrentView(url.searchParams.get('view') ?? '');
      setMenuOpen(false);
    }
  };
  const nav = <>
    <p className="nav-group-label">Workspace</p>
    <WorkspaceLink className={`shell-nav-link ${isRoster ? 'is-active' : ''}`} aria-current={isRoster ? 'page' : undefined} href="/dashboard"><LayoutDashboard /><span>Roster</span></WorkspaceLink>
    <WorkspaceLink className={`shell-nav-link ${isAuction ? 'is-active' : ''}`} aria-current={isAuction ? 'page' : undefined} href="/dashboard?view=auction"><Gavel /><span>Auction house</span><ArrowUpRight className="nav-end" /></WorkspaceLink>
    <WorkspaceLink className={`shell-nav-link ${isHistory ? 'is-active' : ''}`} aria-current={isHistory ? 'page' : undefined} href="/dashboard?view=boss-history"><History /><span>Kill history</span></WorkspaceLink>
    {canManage && <><p className="nav-group-label mt-7">Management</p><WorkspaceLink className={`shell-nav-link ${isCatalog ? 'is-active' : ''}`} aria-current={isCatalog ? 'page' : undefined} href="/dashboard?view=items"><Package /><span>Item catalog</span></WorkspaceLink></>}
    {user && <WorkspaceLink className={`shell-nav-link ${isRoleChanges ? 'is-active' : ''}`} aria-current={isRoleChanges ? 'page' : undefined} href="/admin/role-changes"><CalendarClock /><span>{user.role === 'general' ? 'Role request review' : 'My role changes'}</span></WorkspaceLink>}
    {canAdmin && <WorkspaceLink className={`shell-nav-link ${isAdministration ? 'is-active' : ''}`} aria-current={isAdministration ? 'page' : undefined} href="/admin/requests"><UsersRound /><span>Members & access</span></WorkspaceLink>}
  </>;
  return <SessionContext.Provider value={user}><div className="workspace">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="desktop-sidebar">
      <Link href="/dashboard" className="brand"><span className="brand-mark"><Command size={23} strokeWidth={1.7} /></span><span>CENTURI<span className="brand-subtitle">CLAN COMMAND</span></span></Link>
      <nav aria-label="Main navigation" className="mt-10" onClickCapture={navClick}>{nav}</nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck className="h-4 w-4 text-indigo-300" /><p>Every raid.<br /><span>Every reward. Together.</span></p></div><div className="profile-card"><span className={`profile-avatar ${user?.role === 'chief' ? 'text-amber-300' : 'text-indigo-300'}`}><RoleIcon role={user?.role} className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-white">{user?.nickname || 'Clan member'}</p><p className="mt-1 text-xs capitalize text-slate-400">{user?.role || 'Checking session'}</p></div><button type="button" onClick={() => void signOut()} disabled={signingOut} className="icon-button" aria-label="Sign out" title="Sign out"><LogOut size={16} /></button></div></div>
    </aside>
    <div className="workspace-body"><header className="workspace-header"><div className="flex min-w-0 items-center gap-3"><button className="icon-button lg:hidden" type="button" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen}><Menu size={20} /></button><span className="text-xs text-slate-500">Centuri</span><span className="text-slate-700">/</span><span className="truncate text-xs font-medium text-slate-200">{currentLabel}</span></div><div className="flex items-center gap-3"><span className="hidden text-xs text-slate-500 sm:block">Celtic Heroes</span>{user && <RoleBadge role={user.role} />}</div></header>
      {error && <p role="alert" className="mx-5 mt-4 rounded-xl border border-rose-400/20 bg-rose-400/5 px-4 py-3 text-sm text-rose-200">{error}</p>}
      {offline && <p role="status" className="connection-notice">You’re offline. Showing the last loaded data. Reconnect before saving changes or placing bids.</p>}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{currentLabel}</p>
      <main id="main-content" tabIndex={-1} className="workspace-content">{children}</main>
    </div>
    {menuOpen && <Dialog labelledBy="mobile-nav-title" onClose={() => setMenuOpen(false)} className="mobile-nav-dialog"><aside className="mobile-sidebar" aria-label="Mobile navigation"><h2 id="mobile-nav-title" className="sr-only">Clan navigation</h2><div className="flex items-center justify-between"><Link href="/dashboard" className="brand"><span className="brand-mark"><Command size={22} /></span>CENTURI</Link><button className="icon-button" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={19} /></button></div><nav className="mt-8" onClickCapture={navClick}>{nav}</nav><div className="mt-auto border-t border-white/10 pt-5">{error && <p role="alert" className="mb-4 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-xs leading-5 text-rose-200">{error}</p>}<RoleBadge role={user?.role} /><p className="my-4 text-sm text-white">{user?.nickname}</p><button className="secondary-button w-full" disabled={signingOut} onClick={() => void signOut()}><LogOut size={16} /> Sign out</button></div></aside></Dialog>}
  </div></SessionContext.Provider>;
}
