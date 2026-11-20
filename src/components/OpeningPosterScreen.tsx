import React from 'react';
import { TerritoryRxIcon } from './BrandMark';

const OPENING_POSTER_URL = '/assets/aistudio/photo_2026-11-19_21-13-36_e375b724.jpg';

interface OpeningPosterScreenProps {
  onStart: () => void;
}

export const OpeningPosterScreen: React.FC<OpeningPosterScreenProps> = ({ onStart }) => {
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

      {/* Exact-aspect Territory Rx opening poster frame */}
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
          alt="Territory Rx — Smarter planning. More visits. Greater impact. Powered by AI. Plan, Visit, Achieve."
          className="w-full h-full object-cover object-center block"
        />

        {/* Smooth top-sky band masking the baked-in status bar and old pin/swoosh cleanly */}
        <div
          aria-hidden="true"
          className="absolute top-0 left-0 right-0 h-[14.2%] pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, #EDF3FA 0%, #E9F1FA 68%, rgba(233,241,250,0.92) 84%, rgba(233,241,250,0) 100%)',
          }}
        />

        {/* Crisp Opening Poster Header Brand Row */}
        <div
          aria-hidden="true"
          className="absolute top-[5.2%] left-0 right-0 flex items-center justify-center pointer-events-none"
          style={{ gap: '3.2cqw' }}
        >
          <TerritoryRxIcon size="12.2cqw" className="shadow-md ring-1 ring-[#0A3D62]/15" />
          <span
            className="leading-none font-semibold tracking-tight text-[#0B2559]"
            style={{ fontSize: '8.2cqw' }}
          >
            Territory <span className="text-[#2563EB]">Rx</span>
          </span>
        </div>

        {/* Interactive CTA aligned directly over "Start AI Route Planning →" */}
        <button
          type="button"
          onClick={onStart}
          aria-label="Start AI Route Planning"
          className="group absolute left-[6.2%] right-[6.2%] bottom-[3.6%] h-[6.5%] rounded-[18px] cursor-pointer transition-all hover:bg-white/10 active:bg-black/15 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#38E5FF] focus-visible:ring-offset-2 focus-visible:ring-offset-[#05132E]"
        >
          <span className="sr-only">Start AI Route Planning</span>
        </button>
      </div>
    </div>
  );
};

