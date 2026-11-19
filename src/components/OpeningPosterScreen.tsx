import React, { useState } from 'react';
import { ArrowRight, Calendar, MapPin, Sparkles, Target } from 'lucide-react';
import { TerritoryRxPinLogo } from './BrandMark';

import posterImageUrl from '../assets/images/territory_rx_poster_1795111468529.jpg';

interface OpeningPosterScreenProps {
  onStart: () => void;
}

export const OpeningPosterScreen: React.FC<OpeningPosterScreenProps> = ({ onStart }) => {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="min-h-screen w-full bg-[#071633] text-white relative overflow-hidden flex flex-col items-center justify-between">
      {/* Hero Medical-Route Backdrop */}
      {!imgFailed && (
        <img
          src={posterImageUrl}
          alt="Territory Rx medical route network"
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 w-full h-full object-cover opacity-80"
        />
      )}

      {/* Top readability veil + exact Android bottom navy gradient: transparent -> #CC04122B -> #F5030E22 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(180deg, rgba(7,22,51,0.72) 0%, rgba(7,22,51,0.32) 34%, rgba(4,18,43,0.18) 54%, rgba(4,18,43,0.80) 76%, rgba(3,14,34,0.96) 100%)',
        }}
      />

      {/* Centered Mobile-Proportioned Poster Content */}
      <div className="relative z-10 w-full max-w-[460px] min-h-screen px-6 pt-12 pb-10 flex flex-col justify-between">
        {/* Top Center Brand Block */}
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center justify-center gap-3">
            <TerritoryRxPinLogo className="w-[54px] h-[58px] drop-shadow-md" />
            <h1 className="text-[34px] leading-none font-extrabold tracking-tight">
              <span className="text-white">Territory </span>
              <span className="text-[#0A6BFF] dark:text-[#38BDF8]">Rx</span>
            </h1>
          </div>

          <p className="mt-5 text-[18px] leading-snug font-medium text-slate-100 whitespace-pre-line">
            {'Smarter planning. More visits.\nGreater impact.'}
          </p>

          {/* Pill Badge: ✨ Powered by AI */}
          <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-[#E6F4FF] border border-[#90CAF9] px-4 py-1.5 text-sm font-semibold text-[#071B42] shadow-sm">
            <Sparkles className="w-4 h-4 text-[#0A6BFF]" />
            <span>Powered by AI</span>
          </div>
        </div>

        {/* Bottom Section: 3-Column Feature Row + Full-Width CTA */}
        <div className="space-y-6">
          <div className="grid grid-cols-3 items-center text-center pt-4">
            <div className="flex flex-col items-center gap-2 px-2">
              <Calendar className="w-6 h-6 text-[#38E5FF]" />
              <span className="text-sm font-semibold text-white">Plan</span>
            </div>

            <div className="flex flex-col items-center gap-2 px-2 border-x border-white/25">
              <MapPin className="w-6 h-6 text-[#38E5FF]" />
              <span className="text-sm font-semibold text-white">Visit</span>
            </div>

            <div className="flex flex-col items-center gap-2 px-2">
              <Target className="w-6 h-6 text-[#38E5FF]" />
              <span className="text-sm font-semibold text-white">Achieve</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onStart}
            className="w-full h-[52px] rounded-2xl bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.99] text-white text-base font-semibold inline-flex items-center justify-center gap-2.5 shadow-lg shadow-[#2563EB]/30 transition-all"
          >
            <Sparkles className="w-5 h-5 text-[#38E5FF]" />
            <span>Start AI Route Planning</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
