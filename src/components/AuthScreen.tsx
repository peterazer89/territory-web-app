import React, { useState } from 'react';
import { useTerritory } from '../context/TerritoryContext';
import { TerritoryRxIcon } from './BrandMark';

import posterImageUrl from '../assets/images/territory_rx_poster_1795111468529.jpg';

export const AuthScreen: React.FC = () => {
  const { signInWithGoogle, signingIn, authError } = useTerritory();
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="min-h-screen w-full bg-[#071633] text-white relative overflow-hidden flex flex-col items-center justify-end p-4 sm:p-6">
      {/* Same Midnight Wave Hero Backdrop */}
      {!imgFailed && (
        <img
          src={posterImageUrl}
          alt="Territory Rx backdrop"
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 w-full h-full object-cover opacity-80"
        />
      )}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(7,22,51,0.45) 0%, rgba(4,18,43,0.75) 55%, rgba(3,14,34,0.96) 100%)',
        }}
      />

      {/* Top Branding Hint */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center text-center py-8">
        <TerritoryRxIcon size={76} rounded={17} className="shadow-2xl ring-1 ring-white/25" />
      </div>

      {/* Bottom-Aligned Rounded-[26px] Card (95% opaque surface, 1px primary border) */}
      <section className="relative z-10 w-full max-w-[460px] rounded-[26px] bg-white/95 dark:bg-[#1E293B]/95 border border-[#2563EB]/45 dark:border-[#60A5FA]/45 p-6 sm:p-7 shadow-2xl text-[#0F172A] dark:text-[#F8FAFC] mb-2">
        <div className="text-center">
          <h1 className="text-2xl font-extrabold tracking-tight text-[#0F172A] dark:text-[#F8FAFC]">
            Territory <span className="text-[#2563EB] dark:text-[#60A5FA]">Rx</span>
          </h1>
          <p className="mt-2 text-sm text-[#475569] dark:text-[#CBD5E1]">
            Smarter planning. More visits. Greater impact.
          </p>
        </div>

        {authError && (
          <div className="mt-4 rounded-2xl border border-[#DC2626]/30 bg-[#DC2626]/12 px-4 py-3 text-xs text-[#DC2626] dark:text-red-300">
            {authError}
          </div>
        )}

        <button
          type="button"
          disabled={signingIn}
          onClick={() => void signInWithGoogle()}
          className="mt-6 w-full h-[54px] rounded-2xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-60 text-white font-semibold text-base inline-flex items-center justify-center gap-3 shadow-md shadow-[#2563EB]/25 transition-colors"
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
      </section>
    </div>
  );
};
