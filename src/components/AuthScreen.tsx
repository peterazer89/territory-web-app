import React from 'react';
import { useTerritory } from '../context/TerritoryContext';
import { TerritoryRxIcon } from './BrandMark';

const OPENING_POSTER_URL = '/assets/aistudio/photo_2026-11-19_21-13-36_e375b724.jpg';

export const AuthScreen: React.FC = () => {
  const { signInWithGoogle, signingIn, authError } = useTerritory();

  return (
    <div
      className="min-h-[100dvh] w-full relative overflow-hidden flex items-center justify-center"
      style={{
        background:
          'linear-gradient(180deg, #EAF1F9 0%, #DAE7F5 36%, #0B2559 78%, #05132E 100%)',
      }}
    >
      {/* Subtle ambient backdrop on wide desktop screens */}
      <img
        src={OPENING_POSTER_URL}
        alt=""
        aria-hidden="true"
        className="hidden sm:block absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-45 pointer-events-none select-none"
      />

      {/* Exact-aspect Territory Rx frame matching the Opening Page 1-to-1 */}
      <div
        className="relative z-10 w-full sm:rounded-[28px] sm:shadow-2xl sm:border sm:border-white/25 overflow-hidden select-none"
        style={{
          width: 'min(100vw, calc(100dvh * 1080 / 2280), 460px)',
          aspectRatio: '1080 / 2280',
          containerType: 'inline-size',
        }}
      >
        <img
          src={OPENING_POSTER_URL}
          alt="Territory Rx — Smarter planning. More visits. Greater impact."
          className="w-full h-full object-cover object-center block"
        />

        {/* Solid top-sky band completely covering the baked-in status bar, pin/swoosh, and ghost text */}
        <div
          aria-hidden="true"
          className="absolute top-0 left-0 right-0 h-[14.4%] pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, #E2F3FB 0%, #E3F3FA 60%, #E4F3FA 92%, rgba(228,243,250,0) 100%)',
          }}
        />

        {/* Crisp Header Brand Row (no shadow) */}
        <div
          aria-hidden="true"
          className="absolute top-[5.8%] left-0 right-0 flex items-center justify-center pointer-events-none"
          style={{ gap: '3.2cqw' }}
        >
          <TerritoryRxIcon size="12.2cqw" />
          <span
            className="leading-none font-semibold tracking-tight text-[#0B2559]"
            style={{ fontSize: '8.2cqw' }}
          >
            Territory <span className="text-[#2563EB]">Rx</span>
          </span>
        </div>

        {/* Auth Error Notice (if Google sign-in fails) */}
        {authError && (
          <div
            role="alert"
            className="absolute left-[6.2%] right-[6.2%] bottom-[12.2%] rounded-2xl border border-[#DC2626]/40 bg-[#05132E]/95 backdrop-blur-md px-3.5 py-2.5 text-xs font-medium text-red-200 shadow-lg"
          >
            {authError}
          </div>
        )}

        {/* Google Sign-In CTA matching the exact bottom button slot */}
        <button
          type="button"
          disabled={signingIn}
          onClick={() => void signInWithGoogle()}
          className="absolute left-[6.2%] right-[6.2%] bottom-[3.6%] h-[6.5%] rounded-[18px] bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.985] disabled:opacity-70 text-white font-semibold text-sm sm:text-base inline-flex items-center justify-center gap-2.5 shadow-lg shadow-[#2563EB]/35 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38E5FF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#05132E]"
        >
          <span className="w-6 h-6 rounded-full bg-white inline-flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
              />
            </svg>
          </span>
          <span>{signingIn ? 'Signing in...' : 'Sign in with Google'}</span>
        </button>
      </div>
    </div>
  );
};
