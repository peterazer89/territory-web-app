import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'territory-rx' });
  });

  // Server-side AI fallback for ambiguous English/Arabic clinic schedules
  app.post('/api/ai/parse-schedule', async (req, res) => {
    try {
      const { rawText, clinicLabel } = req.body as {
        rawText?: string;
        clinicLabel?: string;
      };

      if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
        res.status(400).json({ error: 'Schedule text is required.' });
        return;
      }

      const ai = getGenAIClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured on the server. Configure GEMINI_API_KEY in Secrets to enable AI schedule parsing.',
        });
        return;
      }

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Parse the following clinic working schedule text (may be in English, Arabic, or mixed) for "${clinicLabel || 'Clinic'}":
"${rawText.trim()}"

Rules:
- ISO days of week: 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday.
- startMinuteOfDay and endMinuteOfDay are integers 0..1439 (e.g., 18:00 = 1080, 22:00 = 1320).
- If a time range has NO weekdays mentioned, apply it daily (all 7 days 1..7) and classify as DAILY_DEFAULT.
- If explicit weekdays are listed, output windows ONLY for those days (EXPLICIT_DAYS).
- If exclusions are mentioned (e.g., "except Friday", "ما عدا الجمعة"), exclude those days (DAILY_EXCEPT) and list them in excludedDaysCsv.
- If closing time is past midnight (e.g., 9pm-2am), set endsNextDay: true.
- If the text truly has no concrete hours (e.g., "by appointment only"), return empty windows and explain why in ambiguityReason.`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              windows: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    dayOfWeek: { type: Type.INTEGER },
                    startMinuteOfDay: { type: Type.INTEGER },
                    endMinuteOfDay: { type: Type.INTEGER },
                    endsNextDay: { type: Type.BOOLEAN },
                  },
                  required: ['dayOfWeek', 'startMinuteOfDay', 'endMinuteOfDay', 'endsNextDay'],
                },
              },
              normalizedDaysCsv: { type: Type.STRING },
              excludedDaysCsv: { type: Type.STRING },
              scheduleClassification: { type: Type.STRING },
              scheduleParseStatus: { type: Type.STRING },
              ambiguityReason: { type: Type.STRING },
            },
            required: ['windows', 'normalizedDaysCsv', 'excludedDaysCsv', 'scheduleClassification', 'scheduleParseStatus', 'ambiguityReason'],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI schedule parsing failed.';
      res.status(500).json({ error: message });
    }
  });

  // Server-side AI executive brief comparing daily Plans A/B/C
  app.post('/api/ai/route-brief', async (req, res) => {
    try {
      const { dateIso, plans, targetVisits, maxDutySpanMinutes } = req.body as {
        dateIso?: string;
        plans?: Array<{
          variantCode: string;
          variantLabel: string;
          plannedVisitsCount: number;
          totalDistanceKm: number;
          totalDrivingMinutes: number;
          totalDutySpanMinutes: number;
          totalWaitingMinutes: number;
          feasibilityStatus: string;
          zones: string[];
        }>;
        targetVisits?: number;
        maxDutySpanMinutes?: number;
      };

      if (!plans || !Array.isArray(plans) || plans.length === 0) {
        res.status(400).json({ error: 'Plans data is required.' });
        return;
      }

      const ai = getGenAIClient();
      if (!ai) {
        res.status(503).json({
          error: 'Gemini API key is not configured on the server. Configure GEMINI_API_KEY in Secrets to enable AI route briefs.',
        });
        return;
      }

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `You are a pharmaceutical field territory advisor for Territory Rx.
Date: ${dateIso || 'Today'}
Target Visits: ${targetVisits ?? 8}, Max Continuous Duty Span: ${maxDutySpanMinutes ?? 480} minutes.
Route Variants:
${JSON.stringify(plans, null, 2)}

Write a crisp, practical field recommendation (max 90 words, plain prose, no markdown headings or bullet clichés) comparing Plans A, B, and C, highlighting driving efficiency, duty span headroom, and which plan best balances coverage and travel.`,
      });

      res.json({ brief: (response.text ?? '').trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI route brief failed.';
      res.status(500).json({ error: message });
    }
  });

  const http = await import('http');
  const httpServer = http.createServer(app);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : undefined,
      },
      appType: 'spa',
    });
    if (hmrDisabled) {
      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript').send(
          `export function createHotContext() {
  return { data: {}, accept() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {} };
}
export function updateStyle(id, content) {
  let style = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(style);
  }
  style.textContent = content;
}
export function removeStyle(id) {
  const style = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (style) style.remove();
}
export function injectQuery(url) { return url; }
`
        );
      });
    }
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(3000, '0.0.0.0', () => {
    console.log('Territory Rx server listening on http://0.0.0.0:3000');
  });
}

startServer().catch((err) => {
  console.error('Failed to start Territory Rx server:', err);
  process.exit(1);
});
