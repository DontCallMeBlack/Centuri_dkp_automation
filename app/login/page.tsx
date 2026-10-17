'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Command, Eye, EyeOff, Gavel, LoaderCircle, LockKeyhole, ShieldCheck, Swords, UserRound } from 'lucide-react';
import { ApiError, clearClientData, readResponse } from '@/lib/client/api';

export default function LoginPage() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setError(''); setMessage('');
    if (isSignUp && (new TextEncoder().encode(password).length > 72 || password.length < 8)) { setError('Choose a password with at least 8 characters and no more than 72 UTF-8 bytes.'); return; }
    setLoading(true);
    try {
      const data = await readResponse<{message:string}>(await fetch('/api/auth', { method:'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ action:isSignUp ? 'signup' : 'signin',nickname:isSignUp ? nickname.trim() : nickname,password,bootstrapToken:isSignUp && needsSetup ? bootstrapToken : undefined }) }));
      setBootstrapToken(''); setNeedsSetup(false);
      if (isSignUp) { setMessage(data.message); setIsSignUp(false); setPassword(''); }
      else { clearClientData(); router.replace('/dashboard'); router.refresh(); }
    } catch (cause) {
      if (isSignUp && cause instanceof ApiError && cause.details?.needsSetup === true) setNeedsSetup(true);
      setError(cause instanceof Error ? cause.message : 'Unable to sign in. Please try again.');
    }
    finally { setLoading(false); }
  };
  return <main className="auth-grid">
    <section className="auth-story" aria-label="Centuri clan"><div className="auth-orbit" /><div className="brand"><span className="brand-mark"><Command size={23} /></span><span>CENTURI<span className="brand-subtitle">CLAN COMMAND</span></span></div>
      <div className="relative my-auto py-16"><span className="inline-flex items-center gap-2 rounded-full border border-indigo-400/15 bg-indigo-400/5 px-3 py-1.5 text-[9px] font-medium tracking-wider text-indigo-200"><span className="h-1.5 w-1.5 rounded-full bg-indigo-300" /> CELTIC HEROES</span><h1 className="mt-7 max-w-lg text-[clamp(36px,4vw,58px)] font-semibold leading-[1.14] tracking-[-.055em] text-slate-100">Stronger together.<br /><span className="text-[#9690ec]">Rewarded fairly.</span></h1><p className="mt-6 max-w-sm text-sm leading-7 text-slate-500">A home for every raid, every reward, and every member of Centuri.</p><div className="mt-10 space-y-5">{[[Swords,'Every contribution counts','Track boss attendance and the DKP you earn.'],[Gavel,'Your next upgrade awaits','Bid on clan loot with your linked characters.'],[ShieldCheck,'Your clan, connected','One place for your roster and raid history.']].map(([Icon,title,text]) => { const I = Icon as typeof Swords; return <div key={String(title)} className="flex items-start gap-4"><span className="mt-0.5 rounded-xl border border-white/5 bg-white/[.025] p-2.5 text-indigo-300/80"><I size={17} strokeWidth={1.6} /></span><div><p className="text-xs font-medium text-slate-300">{String(title)}</p><p className="mt-2 text-[11px] text-slate-500">{String(text)}</p></div></div>; })}</div></div><p className="relative text-[10px] text-slate-600">Built for the clan. Ready for the next raid.</p>
    </section>
    <section className="auth-form-side"><div className="w-full max-w-[350px]"><div className="brand mb-12 md:hidden"><span className="brand-mark"><Command size={22} /></span>CENTURI</div><p className="page-kicker">{isSignUp ? 'Join the clan' : 'Your clan awaits'}</p><h2 className="mt-3 text-[30px] font-semibold tracking-[-.04em] text-slate-100">{isSignUp ? 'Make yourself at home.' : 'Welcome back.'}</h2><p className="mt-3 text-xs leading-6 text-slate-500">{isSignUp ? 'Create an account. Clan leadership will approve your access and link your toons.' : 'Sign in to your Centuri clan account.'}</p>
      {error && <p role="alert" id="auth-error" className="mt-6 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3.5 text-xs leading-5 text-rose-200">{error}</p>}
      {message && <p role="status" className="mt-6 flex items-start gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3.5 text-xs leading-5 text-emerald-200"><Check size={16} />{message}</p>}
      <form onSubmit={handleSubmit} className="mt-8 space-y-5"><div><label htmlFor="nickname" className="mb-2 block text-[11px] font-medium text-slate-300">In-game nickname</label><div className="relative"><UserRound className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-slate-600" /><input id="nickname" name="nickname" className="auth-input" type="text" required autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={isSignUp ? 2 : undefined} maxLength={isSignUp ? 40 : 100} placeholder="Your clan nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={loading} aria-describedby={error ? 'auth-error' : undefined} /></div></div><div><label htmlFor="password" className="mb-2 block text-[11px] font-medium text-slate-300">Password</label><div className="relative"><LockKeyhole className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-slate-600" /><input id="password" name="password" className="auth-input" required type={visible ? 'text' : 'password'} autoComplete={isSignUp ? 'new-password' : 'current-password'} minLength={isSignUp ? 8 : undefined} placeholder={isSignUp ? 'At least 8 characters' : 'Enter your password'} value={password} onChange={(event) => setPassword(event.target.value)} disabled={loading} aria-describedby={isSignUp ? 'password-help' : undefined} /><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} className="icon-button absolute right-1.5 top-1.5" onClick={() => setVisible((current) => !current)}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{isSignUp && <p id="password-help" className="mt-2 text-[10px] text-slate-500">At least 8 characters; up to 72 UTF-8 bytes.</p>}</div>{isSignUp && needsSetup && <div><label htmlFor="bootstrap-token" className="mb-2 block text-[11px] font-medium text-slate-300">First Chief setup code</label><div className="relative"><ShieldCheck className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-slate-600" /><input id="bootstrap-token" name="bootstrapToken" type="password" className="auth-input" autoComplete="off" required disabled={loading} value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} aria-describedby="auth-error" /></div></div>}<button type="submit" disabled={loading} className="primary-button !mt-7 !h-11 w-full !text-xs">{loading ? <><LoaderCircle size={15} className="animate-spin" />{isSignUp ? 'Creating your account...' : 'Signing you in...'}</> : <>{isSignUp ? 'Create account' : 'Sign in'}<ArrowRight size={15} /></>}</button></form>
      <div className="mt-7 border-t border-white/5 pt-6 text-center"><p className="text-[11px] text-slate-500">{isSignUp ? 'Already a member?' : 'New to Centuri?'} <button type="button" disabled={loading} className="ml-1 font-medium text-indigo-300 transition hover:text-indigo-200" onClick={() => { setIsSignUp((current) => !current); setError(''); setPassword(''); setNeedsSetup(false); setBootstrapToken(''); }}>{isSignUp ? 'Sign in' : 'Request access'}</button></p></div><p className="mt-10 flex items-center justify-center gap-2 text-[9px] text-slate-600"><ShieldCheck size={13} /> Access managed by Centuri clan leadership</p>
    </div></section>
  </main>;
}
