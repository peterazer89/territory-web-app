import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileDown,
  FileSpreadsheet,
  FileUp,
  History,
  Lock,
  MapPin,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useTerritory } from '../context/TerritoryContext';
import { isValidLatLng } from '../utils/gpsLocationParser';
import { Clinic, ClinicWindow, Hcp, ScheduleParseStatus } from '../types/territory';
import {
  buildImportPreview,
  ColumnMapping,
  downloadSampleWorkbook,
  exportTerritoryWorkbook,
  ParsedWorkbookSheet,
  readSpreadsheetFile,
} from '../lib/excelImporter';
import {
  batchDeleteHcpsAndClinics,
  batchImportTerritoryData,
  clinicDocId,
  hcpDocId,
} from '../lib/firestoreService';
import { parseClinicScheduleDeterministic } from '../lib/scheduleParser';
import { formatCleanScheduleSingleLine } from '../utils/availabilityScheduleParser';
import {
  ImportHistoryEntry,
  loadImportHistory,
  loadLocalPrefs,
  saveImportHistory,
} from '../lib/localPrefs';

interface ImportTabProps {
  onToast: (text: string, type?: 'success' | 'error') => void;
  onBusyChange: (busy: boolean) => void;
}

type ImportDestination = 'ADD' | 'REPLACE';
type MergeStrategy = 'MERGE' | 'REPLACE_ALL' | 'ADD_NEW_ONLY' | 'REVIEW_SYNC';

interface AiParsedOverride {
  windows: ClinicWindow[];
  normalizedDaysCsv: string;
  excludedDaysCsv: string;
  scheduleClassification: string;
  scheduleParseStatus: ScheduleParseStatus;
  scheduleAmbiguityReason: string;
}

const MAPPING_FIELDS: Array<{ key: keyof ColumnMapping; label: string; required?: boolean }> = [
  { key: 'targetId', label: 'target_id', required: true },
  { key: 'hcpName', label: 'HCP Name', required: true },
  { key: 'specialty', label: 'Specialty' },
  { key: 'zone1', label: 'zone 1' },
  { key: 'zone2', label: 'zone 2 (Clinic 2)' },
  { key: 'locationGps1', label: 'location GPS (Clinic 1)' },
  { key: 'schedule1', label: 'Visiting Time Clinic 1' },
  { key: 'days1', label: 'Days Col (Clinic 1)' },
  { key: 'locationGps2', label: 'location GPS 2 (Clinic 2)' },
  { key: 'schedule2', label: 'Visiting Time Clinic 2' },
  { key: 'days2', label: 'Days Col (Clinic 2)' },
  { key: 'quarterlyTarget', label: 'Quarter Target (Frequency per Quarter)' },
  { key: 'baselineVisits', label: 'Baseline Visits' },
  { key: 'notes', label: 'Notes' },
];

function format24h(minute: number): string {
  const safe = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function summarizeWindowsReadable(windows: ClinicWindow[]): string {
  const formatted = formatCleanScheduleSingleLine(windows, true);
  return formatted || 'No parsed windows';
}

function summarizeWindows24h(windows: ClinicWindow[]): string {
  if (!windows || windows.length === 0) return 'none';
  const unique = Array.from(
    new Set(windows.map((w) => `${format24h(w.startMinuteOfDay)}–${format24h(w.endMinuteOfDay)}`))
  );
  return unique.join(' | ');
}

function windowsSignature(windows: ClinicWindow[]): string {
  return [...(windows || [])]
    .map((w) => `${w.dayOfWeek}:${w.startMinuteOfDay}-${w.endMinuteOfDay}:${w.endsNextDay ? 1 : 0}`)
    .sort()
    .join('|');
}

function formatClassificationLabel(code: string): string {
  switch (code) {
    case 'DAILY_DEFAULT':
      return 'Daily Default Hours';
    case 'DAILY_EXCEPT':
      return 'Daily With Exclusions';
    case 'EXPLICIT_DAYS':
      return 'Specific Weekdays & Hours';
    case 'OVERNIGHT':
      return 'Overnight Clinic Window';
    case 'AMBIGUOUS':
      return 'Ambiguous / Review Needed';
    case 'UNPARSED':
      return 'Unparsed Text';
    default:
      return code ? code.replace(/_/g, ' ') : 'Multiple Weekly Windows';
  }
}

function formatParsingMethodLabel(method: string, isManual: boolean): string {
  if (isManual) return 'Manual User Confirmed';
  if (method === 'GEMINI_AI') return 'AI Schedule Parser';
  if (method === 'DETERMINISTIC') return 'Direct Rule Parser';
  return method || 'Direct Rule Parser';
}

export const ImportTab: React.FC<ImportTabProps> = ({ onToast, onBusyChange }) => {
  const { user, hcps, clinics, settings } = useTerritory();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [destination, setDestination] = useState<ImportDestination>('ADD');
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('MERGE');

  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [parsedSheet, setParsedSheet] = useState<ParsedWorkbookSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [showMapping, setShowMapping] = useState(false);

  const [aiOverrides, setAiOverrides] = useState<Record<string, AiParsedOverride>>({});
  const [aiReading, setAiReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);

  // 4-Stage Schedule Audit state
  const [auditExpanded, setAuditExpanded] = useState(true);
  const [auditFilter, setAuditFilter] = useState<'ALL' | 'DISCREPANCIES'>('ALL');
  const [migrating, setMigrating] = useState(false);

  // Import history state (localStorage per user)
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.uid) {
      setHistory(loadImportHistory(user.uid));
    }
  }, [user?.uid]);

  const handleSelectDestination = (dest: ImportDestination) => {
    setDestination(dest);
    if (dest === 'REPLACE') {
      setMergeStrategy('REPLACE_ALL');
    } else if (mergeStrategy === 'REPLACE_ALL') {
      setMergeStrategy('MERGE');
    }
  };

  const handleSelectStrategy = (strategy: MergeStrategy) => {
    setMergeStrategy(strategy);
    if (strategy === 'REPLACE_ALL') {
      setDestination('REPLACE');
    } else {
      setDestination('ADD');
    }
  };

  const handleFile = async (file: File) => {
    setProgress(null);
    setAiOverrides({});
    try {
      const buf = await file.arrayBuffer();
      const parsed = readSpreadsheetFile(buf);
      setRawBuffer(buf);
      setFileName(file.name);
      setParsedSheet(parsed);
      setMapping(parsed.detectedMapping);
      if (!parsed.detectedMapping.schedule1 || !parsed.detectedMapping.hcpName) {
        setShowMapping(true);
      }
      onToast(
        parsed.detectedMapping.schedule1
          ? `Loaded ${file.name} (${parsed.rows.length} rows · Time col: "${parsed.detectedMapping.schedule1}")`
          : `Loaded ${file.name} (${parsed.rows.length} rows) — select your Visiting Time column below.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not read Excel/CSV file.', 'error');
    }
  };

  const handleSheetChange = (sheetName: string) => {
    if (!rawBuffer) return;
    const parsed = readSpreadsheetFile(rawBuffer, sheetName);
    setParsedSheet(parsed);
    setMapping(parsed.detectedMapping);
    if (!parsed.detectedMapping.schedule1 || !parsed.detectedMapping.hcpName) {
      setShowMapping(true);
    }
    setAiOverrides({});
  };

  const localPrefs = useMemo(
    () => (user?.uid ? loadLocalPrefs(user.uid) : null),
    [user?.uid]
  );

  // Build preview respecting destination, merge strategy, blankCellOverwritesVerified, and AI overrides
  const preview = useMemo(() => {
    if (!user || !parsedSheet || !mapping) return null;
    const allowBlankOverwrite = Boolean(localPrefs?.blankCellOverwritesVerified);
    const base = buildImportPreview({
      userId: user.uid,
      workbookName: fileName,
      sheetName: parsedSheet.selectedSheet,
      rows: parsedSheet.rows,
      mapping,
      existingHcps: destination === 'REPLACE' ? [] : hcps,
      existingClinics: destination === 'REPLACE' ? [] : clinics,
      currentQuarterLabel: settings.currentQuarterLabel,
      defaultVisitDurationMinutes: settings.defaultVisitDurationMinutes || 15,
      allowBlankOverwrite,
    });

    const existingClinicMap = new Map(clinics.map((c) => [c.clinicKey, c]));

    const filteredRows =
      mergeStrategy === 'ADD_NEW_ONLY' ? base.rows.filter((r) => r.isNewHcp) : base.rows;

    let highConf = 0;
    let ambig = 0;

    const enhancedRows = filteredRows.map((row) => {
      const updatedClinics = row.clinics.map((c) => {
        const override = aiOverrides[c.clinicKey];
        let nextClinic = c;

        if (override && !c.isManualUserConfirmed) {
          nextClinic = {
            ...c,
            windows: override.windows,
            normalizedDaysCsv: override.normalizedDaysCsv,
            excludedDaysCsv: override.excludedDaysCsv,
            scheduleClassification: override.scheduleClassification,
            scheduleParseStatus: override.scheduleParseStatus,
            parsingMethod: 'GEMINI_AI',
            validationStatus:
              override.windows.length > 0 && override.scheduleParseStatus !== 'AMBIGUOUS'
                ? 'VALID'
                : 'NEEDS_REVIEW',
            scheduleAmbiguityReason: override.scheduleAmbiguityReason,
          };
        } else if (
          allowBlankOverwrite &&
          destination !== 'REPLACE' &&
          !c.originalExcelScheduleText.trim()
        ) {
          const existing = existingClinicMap.get(c.clinicKey);
          if (existing && !existing.isManualUserConfirmed) {
            nextClinic = {
              ...c,
              rawScheduleText: '',
              windows: [],
              normalizedDaysCsv: '',
              excludedDaysCsv: '',
              scheduleParseStatus: 'UNPARSED',
              validationStatus: 'NEEDS_REVIEW',
              scheduleAmbiguityReason: 'Cleared by blank Excel cell (Blank Cells Overwrite enabled).',
            };
          }
        }

        if (
          nextClinic.scheduleParseStatus === 'CONFIRMED' ||
          nextClinic.scheduleParseStatus === 'PARSED_HIGH_CONFIDENCE'
        ) {
          highConf++;
        } else {
          ambig++;
        }
        return nextClinic;
      });

      return { ...row, clinics: updatedClinics };
    });

    return {
      ...base,
      rows: enhancedRows,
      totalHcps: enhancedRows.length,
      totalClinics: enhancedRows.reduce((s, r) => s + r.clinics.length, 0),
      highConfidenceSchedules: highConf,
      ambiguousSchedules: ambig,
      totalQuarterlyTarget: enhancedRows.reduce(
        (s, r) => s + (r.hcp.quarterlyTarget || 8),
        0
      ),
      defaultedQuarterlyTargetCount: enhancedRows.filter(
        (r) => r.quarterlyTargetDefaulted
      ).length,
      monthlyMultipliedCount: enhancedRows.filter(
        (r) => r.quarterlyTargetMonthlyMultiplied
      ).length,
    };
  }, [
    user,
    parsedSheet,
    mapping,
    fileName,
    destination,
    mergeStrategy,
    hcps,
    clinics,
    settings,
    aiOverrides,
    localPrefs?.blankCellOverwritesVerified,
  ]);

  const handleAiReadSheet = async () => {
    if (!preview || preview.rows.length === 0) {
      onToast('Upload a .xlsx or .csv file first to run AI schedule reading.', 'error');
      return;
    }

    const targets = preview.rows
      .flatMap((r) => r.clinics)
      .filter(
        (c) =>
          !c.isManualUserConfirmed &&
          c.rawScheduleText.trim().length > 0 &&
          (c.scheduleParseStatus === 'AMBIGUOUS' ||
            c.scheduleParseStatus === 'UNPARSED' ||
            c.windows.length === 0)
      )
      .slice(0, 20);

    if (targets.length === 0) {
      onToast('All schedules in this sheet are already parsed cleanly!');
      return;
    }

    setAiReading(true);
    onBusyChange(true);
    let parsedCount = 0;
    const nextOverrides: Record<string, AiParsedOverride> = { ...aiOverrides };

    try {
      for (const clinic of targets) {
        const resp = await fetch('/api/ai/parse-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rawText: clinic.rawScheduleText,
            clinicLabel: `${clinic.label} (${clinic.zone || clinic.hcpTargetId})`,
          }),
        });
        const data = (await resp.json()) as {
          error?: string;
          windows?: Array<{
            dayOfWeek: number;
            startMinuteOfDay: number;
            endMinuteOfDay: number;
            endsNextDay: boolean;
          }>;
          normalizedDaysCsv?: string;
          excludedDaysCsv?: string;
          scheduleClassification?: string;
          scheduleParseStatus?: ScheduleParseStatus;
          ambiguityReason?: string;
        };
        if (!resp.ok) {
          throw new Error(data.error || 'AI schedule parser unavailable.');
        }

        const windows: ClinicWindow[] = (data.windows || []).map((w) => ({
          dayOfWeek: Number(w.dayOfWeek),
          startMinuteOfDay: Number(w.startMinuteOfDay),
          endMinuteOfDay: Number(w.endMinuteOfDay),
          endsNextDay: Boolean(w.endsNextDay),
          isConfirmed: false,
        }));

        nextOverrides[clinic.clinicKey] = {
          windows,
          normalizedDaysCsv: data.normalizedDaysCsv || '',
          excludedDaysCsv: data.excludedDaysCsv || '',
          scheduleClassification: data.scheduleClassification || 'EXPLICIT_DAYS',
          scheduleParseStatus:
            windows.length > 0
              ? data.scheduleParseStatus === 'AMBIGUOUS'
                ? 'AMBIGUOUS'
                : 'PARSED_HIGH_CONFIDENCE'
              : 'AMBIGUOUS',
          scheduleAmbiguityReason: data.ambiguityReason || '',
        };
        if (windows.length > 0) parsedCount++;
      }

      setAiOverrides(nextOverrides);
      onToast(`AI read ${targets.length} clinic row(s) — resolved ${parsedCount} schedule(s).`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'AI schedule reading failed.', 'error');
    } finally {
      setAiReading(false);
      onBusyChange(false);
    }
  };

  const handleCommitImport = async () => {
    if (!user || !preview || preview.rows.length === 0) {
      onToast('Upload a valid .xlsx or .csv file before importing.', 'error');
      return;
    }

    setImporting(true);
    onBusyChange(true);
    try {
      const hcpsToWrite = preview.rows.map((r) => r.hcp);
      const clinicsToWrite = preview.rows.flatMap((r) => r.clinics);
      setProgress({ written: 0, total: hcpsToWrite.length + clinicsToWrite.length });

      // Snapshot previous state for Import History rollback
      const existingHcpMap = new Map(hcps.map((h) => [h.id, h]));
      const existingClinicMap = new Map(clinics.map((c) => [c.id, c]));

      const createdHcpIds: string[] = [];
      const createdClinicIds: string[] = [];
      const previousHcps: Hcp[] = [];
      const previousClinics: Clinic[] = [];

      if (destination === 'REPLACE') {
        previousHcps.push(...hcps);
        previousClinics.push(...clinics);
        for (const h of hcpsToWrite) {
          createdHcpIds.push(hcpDocId(h.targetId));
        }
        for (const c of clinicsToWrite) {
          createdClinicIds.push(clinicDocId(c.hcpTargetId, c.clinicIndex));
        }
        if (hcps.length > 0 || clinics.length > 0) {
          await batchDeleteHcpsAndClinics(
            user.uid,
            hcps.map((h) => h.id),
            clinics.map((c) => c.id)
          );
        }
      } else {
        for (const h of hcpsToWrite) {
          const id = hcpDocId(h.targetId);
          const prev = existingHcpMap.get(id);
          if (prev) previousHcps.push(prev);
          else createdHcpIds.push(id);
        }
        for (const c of clinicsToWrite) {
          const id = clinicDocId(c.hcpTargetId, c.clinicIndex);
          const prev = existingClinicMap.get(id);
          if (prev) previousClinics.push(prev);
          else createdClinicIds.push(id);
        }
      }

      await batchImportTerritoryData(user.uid, hcpsToWrite, clinicsToWrite, (written, total) => {
        setProgress({ written, total });
      });

      const entry: ImportHistoryEntry = {
        id: `imp_${Date.now()}`,
        timestamp: Date.now(),
        fileName: fileName || 'Workbook.xlsx',
        mode:
          destination === 'REPLACE'
            ? 'Replace Previous'
            : mergeStrategy === 'ADD_NEW_ONLY'
              ? 'Add New Only'
              : 'Add to Previous',
        hcpsImported: hcpsToWrite.length,
        clinicsImported: clinicsToWrite.length,
        createdHcpIds,
        createdClinicIds,
        previousHcps,
        previousClinics,
      };
      const nextHistory = [entry, ...history].slice(0, 12);
      setHistory(nextHistory);
      saveImportHistory(user.uid, nextHistory);

      onToast(
        `Imported ${hcpsToWrite.length} HCPs & ${clinicsToWrite.length} clinics (${preview.protectedSchedulesPreserved} schedules protected).`
      );
      setParsedSheet(null);
      setMapping(null);
      setFileName('');
      setRawBuffer(null);
      setAiOverrides({});
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Cloud import failed.', 'error');
    } finally {
      setImporting(false);
      onBusyChange(false);
    }
  };

  // 4-Stage Schedule Audit across all active clinics in Firestore
  const activeHcpMap = useMemo(() => {
    const map = new Map<string, Hcp>();
    for (const h of hcps) {
      if (!h.isDeleted && h.isActive) map.set(h.targetId, h);
    }
    return map;
  }, [hcps]);

  const auditRows = useMemo(() => {
    return clinics
      .filter((c) => c.isActive && activeHcpMap.has(c.hcpTargetId))
      .map((clinic) => {
        const hcp = activeHcpMap.get(clinic.hcpTargetId)!;
        const excelSource = (
          clinic.originalExcelScheduleText ||
          clinic.rawScheduleText ||
          ''
        ).trim();
        const parserResult = parseClinicScheduleDeterministic(excelSource);
        const dbWindows = clinic.windows || [];

        const parserSig = windowsSignature(parserResult.windows);
        const dbSig = windowsSignature(dbWindows);

        const isConfirmed = Boolean(clinic.isManualUserConfirmed || clinic.userConfirmedSchedule);
        const hasDbWindows = dbWindows.length > 0;
        const hasDiscrepancy =
          !hasDbWindows ||
          (!isConfirmed && parserResult.windows.length > 0 && parserSig !== dbSig) ||
          (!isConfirmed &&
            (clinic.scheduleParseStatus === 'AMBIGUOUS' ||
              clinic.scheduleParseStatus === 'UNPARSED'));

        const isEligibleForOptimizer =
          hasDbWindows &&
          (isConfirmed ||
            clinic.scheduleParseStatus === 'CONFIRMED' ||
            clinic.scheduleParseStatus === 'PARSED_HIGH_CONFIDENCE');

        const canSafeMigrate =
          !isConfirmed &&
          parserResult.windows.length > 0 &&
          (parserSig !== dbSig ||
            (parserResult.scheduleParseStatus === 'PARSED_HIGH_CONFIDENCE' &&
              clinic.scheduleParseStatus !== 'PARSED_HIGH_CONFIDENCE'));

        return {
          clinic,
          hcp,
          excelSource,
          parserResult,
          dbWindows,
          isConfirmed,
          hasDiscrepancy,
          isEligibleForOptimizer,
          canSafeMigrate,
        };
      })
      .sort((a, b) => a.hcp.name.localeCompare(b.hcp.name) || a.clinic.clinicIndex - b.clinic.clinicIndex);
  }, [clinics, activeHcpMap]);

  const discrepancyRows = useMemo(() => auditRows.filter((r) => r.hasDiscrepancy), [auditRows]);
  const displayedAuditRows = auditFilter === 'DISCREPANCIES' ? discrepancyRows : auditRows;

  const handleAuditSchedules = () => {
    const matched = auditRows.length - discrepancyRows.length;
    onToast(
      `Audit complete: ${matched} 4-Stage Match, ${discrepancyRows.length} Discrepanc${discrepancyRows.length === 1 ? 'y' : 'ies'}.`
    );
  };

  const handleSafeMigration = async () => {
    if (!user) return;
    const candidates = auditRows.filter((r) => r.canSafeMigrate);
    if (candidates.length === 0) {
      onToast('All unconfirmed clinics are already synchronized with the parser engine.');
      return;
    }

    setMigrating(true);
    onBusyChange(true);
    try {
      const clinicsToMigrate: Array<Omit<Clinic, 'id'>> = candidates.map((item) => {
        const { id: _ignore, ...rest } = item.clinic;
        return {
          ...rest,
          rawScheduleText: rest.rawScheduleText || item.excelSource,
          windows: item.parserResult.windows,
          normalizedDaysCsv: item.parserResult.normalizedDaysCsv,
          excludedDaysCsv: item.parserResult.excludedDaysCsv,
          scheduleParseStatus: item.parserResult.scheduleParseStatus,
          scheduleClassification: item.parserResult.scheduleClassification,
          parsingMethod: item.parserResult.parsingMethod,
          validationStatus: item.parserResult.validationStatus,
          scheduleAmbiguityReason: item.parserResult.scheduleAmbiguityReason,
        };
      });
      await batchImportTerritoryData(user.uid, [], clinicsToMigrate);
      onToast(
        `Safe Migration updated ${candidates.length} clinic schedule(s). Manual confirmations preserved.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Safe Migration failed.', 'error');
    } finally {
      setMigrating(false);
      onBusyChange(false);
    }
  };

  const handleRollbackImport = async (entry: ImportHistoryEntry) => {
    if (!user || entry.rolledBack) return;
    setRollingBackId(entry.id);
    onBusyChange(true);
    try {
      if (entry.createdHcpIds.length > 0 || entry.createdClinicIds.length > 0) {
        await batchDeleteHcpsAndClinics(user.uid, entry.createdHcpIds, entry.createdClinicIds);
      }
      if (entry.previousHcps.length > 0 || entry.previousClinics.length > 0) {
        await batchImportTerritoryData(
          user.uid,
          entry.previousHcps.map(({ id: _id, ...rest }) => rest),
          entry.previousClinics.map(({ id: _id, ...rest }) => rest)
        );
      }
      const next = history.map((h) => (h.id === entry.id ? { ...h, rolledBack: true } : h));
      setHistory(next);
      saveImportHistory(user.uid, next);
      onToast(`Rolled back import "${entry.fileName}".`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Rollback failed.', 'error');
    } finally {
      setRollingBackId(null);
      onBusyChange(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />

      {/* CARD 1: HCP Target List Importer */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3.5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
              HCP Target List Importer
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] leading-snug mt-0.5">
              Upload .xlsx or .csv doctor lists with AI schedule &amp; data parsing
            </p>
          </div>
        </div>

        {/* Choose Import Destination */}
        <div className="rounded-[16px] bg-[#F8FAFC] dark:bg-[#0F172A]/60 border border-[#E2E8F0] dark:border-[#334155] p-3 space-y-2.5">
          <p className="text-[12px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
            Choose Import Destination:
          </p>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => handleSelectDestination('ADD')}
              className={`text-left rounded-[14px] border p-3 transition-colors ${
                destination === 'ADD'
                  ? 'bg-[#DBEAFE]/70 dark:bg-[#1E3A8A]/55 border-[#2563EB] dark:border-[#60A5FA]'
                  : 'bg-white dark:bg-[#1E293B]/80 border-[#E2E8F0] dark:border-[#334155]'
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    destination === 'ADD'
                      ? 'border-[#2563EB] dark:border-[#60A5FA]'
                      : 'border-[#94A3B8] dark:border-[#64748B]'
                  }`}
                >
                  {destination === 'ADD' && (
                    <span className="w-2 h-2 rounded-full bg-[#2563EB] dark:bg-[#60A5FA]" />
                  )}
                </span>
                <span className="text-[13px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-tight">
                  Add to Previous
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-[#475569] dark:text-[#CBD5E1]">
                Keep existing doctors and add/update from this sheet
              </p>
            </button>

            <button
              type="button"
              onClick={() => handleSelectDestination('REPLACE')}
              className={`text-left rounded-[14px] border p-3 transition-colors ${
                destination === 'REPLACE'
                  ? 'bg-[#DBEAFE]/70 dark:bg-[#1E3A8A]/55 border-[#2563EB] dark:border-[#60A5FA]'
                  : 'bg-white dark:bg-[#1E293B]/80 border-[#E2E8F0] dark:border-[#334155]'
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    destination === 'REPLACE'
                      ? 'border-[#2563EB] dark:border-[#60A5FA]'
                      : 'border-[#94A3B8] dark:border-[#64748B]'
                  }`}
                >
                  {destination === 'REPLACE' && (
                    <span className="w-2 h-2 rounded-full bg-[#2563EB] dark:bg-[#60A5FA]" />
                  )}
                </span>
                <span className="text-[13px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-tight">
                  Replace Previous
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-[#475569] dark:text-[#CBD5E1]">
                Start fresh: clear previous list &amp; load this sheet only
              </p>
            </button>
          </div>
        </div>

        {/* Action Buttons Stack (1:1 Android Material Pill Buttons) */}
        <div className="flex flex-col items-start gap-2.5">
          <div className="flex flex-wrap items-center gap-2 w-full">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-[42px] px-4 rounded-[14px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 text-white dark:text-[#071633] text-[13px] font-semibold inline-flex items-center gap-2 shadow-xs"
            >
              <FileUp className="w-4 h-4" />
              <span>Upload .xlsx / .csv</span>
            </button>
            {fileName && (
              <span className="text-[12px] font-medium text-[#2563EB] dark:text-[#60A5FA] bg-[#DBEAFE]/70 dark:bg-[#1E3A8A]/45 px-2.5 py-1 rounded-lg truncate max-w-[230px]">
                {fileName}
              </span>
            )}
          </div>

          <button
            type="button"
            disabled={aiReading || !preview}
            onClick={() => void handleAiReadSheet()}
            className="h-[42px] px-4 rounded-[14px] bg-[#0F766E] dark:bg-[#0F5E58] hover:opacity-95 disabled:opacity-55 text-white dark:text-[#CCFBF1] text-[13px] font-semibold inline-flex items-center gap-2"
          >
            <Sparkles className="w-4 h-4" />
            <span>{aiReading ? 'AI Reading Schedules...' : 'AI Read Sheet & Times'}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2 w-full">
            <button
              type="button"
              disabled={importing || !preview || preview.rows.length === 0}
              onClick={() => void handleCommitImport()}
              className="h-[42px] px-5 rounded-[14px] bg-[#2563EB] dark:bg-[#60A5FA] hover:opacity-95 disabled:opacity-50 text-white dark:text-[#071633] text-[13px] font-semibold inline-flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {importing && progress
                  ? `Importing ${progress.written}/${progress.total}...`
                  : 'Import'}
              </span>
            </button>

            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => downloadSampleWorkbook()}
                className="h-[34px] px-2.5 rounded-lg border border-[#E2E8F0] dark:border-[#334155] text-[11px] font-semibold text-[#475569] dark:text-[#CBD5E1] hover:text-[#2563EB] dark:hover:text-[#60A5FA] inline-flex items-center gap-1"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Sample</span>
              </button>
              {hcps.length > 0 && (
                <button
                  type="button"
                  onClick={() => exportTerritoryWorkbook(hcps, clinics)}
                  className="h-[34px] px-2.5 rounded-lg border border-[#E2E8F0] dark:border-[#334155] text-[11px] font-semibold text-[#0F766E] dark:text-[#2DD4BF] inline-flex items-center gap-1"
                >
                  <FileDown className="w-3.5 h-3.5" />
                  <span>Export</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Re-Import & Merge Strategy */}
        <div className="space-y-2 pt-0.5">
          <p className="text-[12px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
            Re-Import &amp; Merge Strategy
          </p>
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
            {(
              [
                { id: 'MERGE', label: 'Add / Merge into Previous Data' },
                { id: 'REPLACE_ALL', label: 'Replace Previous List' },
                { id: 'ADD_NEW_ONLY', label: 'Add New Only' },
                { id: 'REVIEW_SYNC', label: 'Review & Sync' },
              ] as Array<{ id: MergeStrategy; label: string }>
            ).map((opt) => {
              const active = mergeStrategy === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectStrategy(opt.id)}
                  className={`shrink-0 h-[36px] px-3.5 rounded-full text-[12px] font-medium border transition-colors ${
                    active
                      ? 'bg-[#DBEAFE] dark:bg-[#1E3A8A]/65 border-[#2563EB] dark:border-[#60A5FA] text-[#0F172A] dark:text-[#F8FAFC]'
                      : 'bg-transparent border-[#CBD5E1] dark:border-[#475569] text-[#475569] dark:text-[#CBD5E1]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Loaded File Preview & Column Mapping */}
        {parsedSheet && mapping && preview && (
          <div className="rounded-[16px] bg-[#F8FAFC] dark:bg-[#0F172A]/65 border border-[#E2E8F0] dark:border-[#334155] p-3.5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[12px] flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-bold text-[#0F172A] dark:text-[#F8FAFC] tabular-nums">
                  {preview.totalHcps} HCPs · {preview.totalClinics} Clinics
                </span>
                <span className="px-2 py-0.5 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#93C5FD] font-bold tabular-nums">
                  Total Qtr Target: {preview.totalQuarterlyTarget} visits
                </span>
                <span className="text-[#0F766E] dark:text-[#2DD4BF] font-semibold tabular-nums">
                  {preview.highConfidenceSchedules} ready
                </span>
                {preview.ambiguousSchedules > 0 && (
                  <span className="text-[#D97706] dark:text-amber-400 font-semibold tabular-nums">
                    {preview.ambiguousSchedules} review
                  </span>
                )}
                {preview.defaultedQuarterlyTargetCount > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#D97706]/15 text-[#D97706] dark:text-amber-300 text-[11px] font-semibold tabular-nums">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>{preview.defaultedQuarterlyTargetCount} target(s) defaulted to 8</span>
                  </span>
                )}
                {preview.monthlyMultipliedCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF] text-[11px] font-semibold tabular-nums">
                    {preview.monthlyMultipliedCount} monthly ×3 → quarterly
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowMapping((v) => !v)}
                className="shrink-0 text-[11px] font-semibold text-[#2563EB] dark:text-[#60A5FA] inline-flex items-center gap-1"
              >
                <span>Columns</span>
                {showMapping ? (
                  <ChevronUp className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {/* Always-Visible Quarter Target (Frequency per Quarter) Mapping Dropdown */}
            <div className="rounded-[12px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-[#0F172A] dark:text-[#F8FAFC]">
                  Quarter Target (Frequency per Quarter) Column
                </p>
                <p className="text-[10px] text-[#475569] dark:text-[#CBD5E1]">
                  {mapping.quarterlyTarget
                    ? `Mapped to "${mapping.quarterlyTarget}" · Total: ${preview.totalQuarterlyTarget} quarterly visits`
                    : 'Not mapped — rows will default to 8 visits/quarter unless you pick a column'}
                </p>
              </div>
              <select
                aria-label="Quarter Target (Frequency per Quarter) column mapping"
                value={mapping.quarterlyTarget}
                onChange={(e) =>
                  setMapping((prev) =>
                    prev ? { ...prev, quarterlyTarget: e.target.value } : prev
                  )
                }
                className="w-full sm:w-auto sm:max-w-[230px] min-w-0 truncate h-[32px] px-2.5 rounded-lg border border-[#CBD5E1] dark:border-[#475569] bg-[#F8FAFC] dark:bg-[#0F172A] text-[11px] font-semibold text-[#0F172A] dark:text-[#F8FAFC]"
              >
                <option value="">— Default (8 visits/quarter) —</option>
                {parsedSheet.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </div>

            {/* Detected Schedule & GPS Column Indicator */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {mapping.targetId && (
                <span className="text-[#475569] dark:text-[#CBD5E1] font-medium">
                  ID Col: <strong className="font-semibold text-[#0F172A] dark:text-[#F8FAFC]">{mapping.targetId}</strong>
                </span>
              )}
              {mapping.schedule1 ? (
                <span className="text-[#0F766E] dark:text-[#2DD4BF] font-medium">
                  Clinic 1 Time: <strong className="font-semibold">{mapping.schedule1}</strong>
                </span>
              ) : (
                <span className="text-[#D97706] dark:text-amber-400 font-semibold inline-flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>Clinic 1 Time column not detected — select below</span>
                </span>
              )}
              {mapping.schedule2 && (
                <span className="text-[#0F766E] dark:text-[#2DD4BF] font-medium">
                  Clinic 2 Time: <strong className="font-semibold">{mapping.schedule2}</strong>
                </span>
              )}
              {mapping.locationGps1 && (
                <span className="text-[#2563EB] dark:text-[#60A5FA] font-medium">
                  Clinic 1 GPS: <strong className="font-semibold">{mapping.locationGps1}</strong>
                </span>
              )}
              {mapping.locationGps2 && (
                <span className="text-[#2563EB] dark:text-[#60A5FA] font-medium">
                  Clinic 2 GPS: <strong className="font-semibold">{mapping.locationGps2}</strong>
                </span>
              )}
            </div>

            {preview.protectedSchedulesPreserved > 0 || preview.protectedGpsPreserved > 0 ? (
              <div className="flex items-center gap-1.5 text-[11px] text-[#0F766E] dark:text-[#2DD4BF] font-medium">
                <Lock className="w-3.5 h-3.5 shrink-0" />
                <span>
                  Protected on re-import: {preview.protectedSchedulesPreserved} confirmed schedule(s) ·{' '}
                  {preview.protectedGpsPreserved} verified GPS pin(s)
                </span>
              </div>
            ) : null}

            {importing && progress && (
              <div className="h-1.5 w-full rounded-full bg-[#E2E8F0] dark:bg-[#334155] overflow-hidden">
                <div
                  className="h-full bg-[#0F766E] dark:bg-[#2DD4BF] transition-all"
                  style={{
                    width: `${Math.round((progress.written / Math.max(1, progress.total)) * 100)}%`,
                  }}
                />
              </div>
            )}

            {showMapping && (
              <div className="space-y-2.5 pt-2 border-t border-[#E2E8F0] dark:border-[#334155]">
                {parsedSheet.sheetNames.length > 1 && (
                  <label className="flex items-center justify-between gap-2 text-[11px] text-[#475569] dark:text-[#CBD5E1]">
                    <span className="font-semibold">Sheet:</span>
                    <select
                      value={parsedSheet.selectedSheet}
                      onChange={(e) => handleSheetChange(e.target.value)}
                      className="h-[34px] px-2.5 rounded-lg border border-[#E2E8F0] dark:border-[#334155] bg-white dark:bg-[#1E293B] text-[12px] text-[#0F172A] dark:text-[#F8FAFC]"
                    >
                      {parsedSheet.sheetNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="grid grid-cols-2 gap-2">
                  {MAPPING_FIELDS.map((field) => (
                    <label key={field.key} className="block space-y-1">
                      <span className="text-[11px] font-medium text-[#475569] dark:text-[#CBD5E1]">
                        {field.label}
                        {field.required ? ' *' : ''}
                      </span>
                      <select
                        value={mapping[field.key]}
                        onChange={(e) =>
                          setMapping((prev) =>
                            prev ? { ...prev, [field.key]: e.target.value } : prev
                          )
                        }
                        className="w-full max-w-full min-w-0 truncate h-[34px] px-2 rounded-lg border border-[#E2E8F0] dark:border-[#334155] bg-white dark:bg-[#1E293B] text-[11px] text-[#0F172A] dark:text-[#F8FAFC]"
                      >
                        <option value="">— None —</option>
                        {parsedSheet.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Compact Preview Cards */}
            <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
              {preview.rows.slice(0, 25).map((r) => (
                <div
                  key={`${r.hcp.targetId}_${r.rowNumber}`}
                  className="rounded-[12px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-2.5 text-[11px] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-bold text-[#0F172A] dark:text-[#F8FAFC] truncate" dir="auto">
                      {r.hcp.name}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        title={
                          r.quarterlyTargetNote ||
                          `Quarter Target: ${r.hcp.quarterlyTarget} visits/quarter`
                        }
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${
                          r.quarterlyTargetDefaulted
                            ? 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-300 border border-[#D97706]/30'
                            : 'bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#93C5FD]'
                        }`}
                      >
                        {r.quarterlyTargetDefaulted && (
                          <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                        )}
                        <span>Qtr Target: {r.hcp.quarterlyTarget}</span>
                      </span>
                      <span className="font-mono text-[10px] text-[#475569] dark:text-[#CBD5E1]">
                        {r.hcp.targetId} · {r.isNewHcp ? 'New' : 'Update'}
                      </span>
                    </div>
                  </div>
                  {(r.quarterlyTargetDefaulted || r.quarterlyTargetMonthlyMultiplied) &&
                    r.quarterlyTargetNote && (
                      <p
                        className={`text-[10px] font-medium ${
                          r.quarterlyTargetDefaulted
                            ? 'text-[#D97706] dark:text-amber-400'
                            : 'text-[#0F766E] dark:text-[#2DD4BF]'
                        }`}
                      >
                        {r.quarterlyTargetNote}
                      </p>
                    )}
                  {r.clinics.map((c) => {
                    const ok =
                      (c.scheduleParseStatus === 'CONFIRMED' ||
                        c.scheduleParseStatus === 'PARSED_HIGH_CONFIDENCE') &&
                      c.windows.length > 0;
                    const badgeLabel = c.isManualUserConfirmed
                      ? 'Protected'
                      : c.parsingMethod === 'GEMINI_AI'
                        ? 'AI Ready'
                        : ok
                          ? 'Valid'
                          : c.scheduleParseStatus === 'AMBIGUOUS'
                            ? 'AMBIGUOUS'
                            : 'UNPARSED';
                    const hasValidGps =
                      isValidLatLng(c.latitude, c.longitude) &&
                      (c.geocodingStatus === 'VERIFIED' || c.geocodingStatus === 'EXTRACTED_URL');
                    const gpsBadgeText = hasValidGps
                      ? c.geocodingStatus === 'EXTRACTED_URL' &&
                        /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(c.googleMapsUrl || '')
                        ? `Maps Link Resolved (${c.latitude!.toFixed(4)}, ${c.longitude!.toFixed(4)})`
                        : `${c.latitude!.toFixed(4)}, ${c.longitude!.toFixed(4)}`
                      : c.geocodingStatus === 'UNVERIFIED'
                        ? 'Unverified GPS'
                        : 'No GPS';

                    return (
                      <div key={c.clinicKey} className="space-y-1">
                        <div className="flex items-start justify-between gap-2 text-[#475569] dark:text-[#CBD5E1]">
                          <div className="min-w-0 flex-1" dir="auto">
                            <span className="font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                              {c.label}
                            </span>
                            {c.zone ? <span> ({c.zone})</span> : null}:{' '}
                            <span className={ok ? 'text-[#0F766E] dark:text-[#2DD4BF] font-medium' : ''}>
                              {c.windows.length > 0
                                ? summarizeWindowsReadable(c.windows)
                                : c.rawScheduleText || 'No visiting hours'}
                            </span>
                          </div>
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              ok
                                ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                                : 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-300'
                            }`}
                          >
                            {badgeLabel}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold font-mono tabular-nums ${
                              hasValidGps
                                ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                                : c.geocodingStatus === 'UNVERIFIED'
                                  ? 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-300'
                                  : 'bg-[#DC2626]/12 text-[#DC2626] dark:text-red-400'
                            }`}
                          >
                            <MapPin className="w-2.5 h-2.5 shrink-0" />
                            <span>{gpsBadgeText}</span>
                          </span>
                        </div>
                        {!ok && c.scheduleAmbiguityReason && (
                          <p className="text-[10px] text-[#D97706] dark:text-amber-400">
                            {c.rawScheduleText ? `"${c.rawScheduleText}" — ` : ''}
                            {c.scheduleAmbiguityReason}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {preview.rows.length > 25 && (
                <p className="text-center text-[11px] text-[#475569] dark:text-[#CBD5E1]">
                  +{preview.rows.length - 25} more rows ready for cloud import
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* CARD 2: 4-Stage Schedule Audit */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3">
        <div className="flex items-start justify-between gap-2.5">
          <div className="min-w-0">
            <h2 className="text-[16px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug tabular-nums">
              4-Stage Schedule Audit ({auditRows.length} Clinics)
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] mt-0.5 leading-snug">
              Excel → Parser → Database → Optimizer discrepancy detector
            </p>
          </div>

          <button
            type="button"
            onClick={() => setAuditExpanded((v) => !v)}
            className="shrink-0 h-[36px] px-3.5 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] text-[12px] font-semibold text-[#2563EB] dark:text-[#60A5FA] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/50"
          >
            {auditExpanded ? 'Collapse' : 'Expand'}
          </button>
        </div>

        {auditExpanded && (
          <div className="space-y-3">
            {/* Filter & Action Pills matching Screenshot 3 */}
            <div className="flex flex-col items-start gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAuditFilter('ALL')}
                  className={`h-[34px] px-3.5 rounded-[10px] text-[12px] font-semibold border transition-colors tabular-nums ${
                    auditFilter === 'ALL'
                      ? 'bg-[#0F766E] dark:bg-[#0F5E58] border-[#0F766E] text-white dark:text-[#CCFBF1]'
                      : 'bg-transparent border-[#CBD5E1] dark:border-[#475569] text-[#0F172A] dark:text-[#F8FAFC]'
                  }`}
                >
                  All Clinics ({auditRows.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAuditFilter('DISCREPANCIES')}
                  className={`h-[34px] px-3.5 rounded-[10px] text-[12px] font-semibold border transition-colors tabular-nums ${
                    auditFilter === 'DISCREPANCIES'
                      ? 'bg-[#0F766E] dark:bg-[#0F5E58] border-[#0F766E] text-white dark:text-[#CCFBF1]'
                      : 'bg-transparent border-[#CBD5E1] dark:border-[#475569] text-[#0F172A] dark:text-[#F8FAFC]'
                  }`}
                >
                  Discrepancies ({discrepancyRows.length})
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAuditSchedules}
                  className="h-[38px] px-4 rounded-[12px] bg-[#0F766E] dark:bg-[#0F5E58] hover:opacity-95 text-white dark:text-[#CCFBF1] text-[12px] font-semibold inline-flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Audit Schedules</span>
                </button>

                <button
                  type="button"
                  disabled={migrating}
                  onClick={() => void handleSafeMigration()}
                  className="h-[38px] px-4 rounded-[12px] border border-[#CBD5E1] dark:border-[#475569] hover:bg-[#F1F5F9] dark:hover:bg-[#334155]/60 disabled:opacity-50 text-[#2563EB] dark:text-[#60A5FA] text-[12px] font-semibold inline-flex items-center gap-1.5"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{migrating ? 'Migrating...' : 'Safe Migration'}</span>
                </button>
              </div>
            </div>

            {/* 4-Stage Audit List */}
            {displayedAuditRows.length === 0 ? (
              <div className="rounded-[16px] bg-[#F8FAFC] dark:bg-[#0F172A]/55 border border-[#E2E8F0] dark:border-[#334155] p-5 text-center text-[12px] text-[#475569] dark:text-[#CBD5E1]">
                {auditRows.length === 0
                  ? 'No clinics imported yet. Upload a .xlsx or .csv file above to begin auditing.'
                  : 'Zero schedule discrepancies found across all clinics.'}
              </div>
            ) : (
              <div className="space-y-2.5">
                {displayedAuditRows.map((item) => {
                  const {
                    clinic,
                    hcp,
                    excelSource,
                    parserResult,
                    dbWindows,
                    isConfirmed,
                    hasDiscrepancy,
                    isEligibleForOptimizer,
                  } = item;

                  const parserReadable = summarizeWindowsReadable(parserResult.windows);
                  const dbReadable = summarizeWindowsReadable(dbWindows);
                  const db24h = summarizeWindows24h(dbWindows);
                  const methodLabel = formatParsingMethodLabel(clinic.parsingMethod, isConfirmed);

                  return (
                    <article
                      key={clinic.id}
                      className="rounded-[16px] bg-[#F8FAFC] dark:bg-[#0F172A]/55 border border-[#E2E8F0] dark:border-[#334155] p-3.5 space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3
                          className="text-[13px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug"
                          dir="auto"
                        >
                          {hcp.name} • {clinic.label}
                          {clinic.zone ? ` (${clinic.zone})` : ''}
                        </h3>
                        <span
                          className={`shrink-0 px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                            !hasDiscrepancy
                              ? 'bg-[#0F766E]/15 text-[#0F766E] dark:text-[#2DD4BF]'
                              : 'bg-[#D97706]/15 text-[#D97706] dark:text-amber-300'
                          }`}
                        >
                          {!hasDiscrepancy ? '4-Stage Match' : 'Discrepancy'}
                        </span>
                      </div>

                      <div className="text-[12px] leading-relaxed space-y-1 text-[#334155] dark:text-[#CBD5E1]">
                        <p dir="auto">
                          <span className="font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                            1. Excel Source:
                          </span>{' '}
                          {excelSource ? `"${excelSource}"` : '"(Blank / Manual Entry)"'}
                        </p>
                        <p>
                          <span className="font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                            2. Parser Engine:
                          </span>{' '}
                          {parserReadable} ({formatClassificationLabel(parserResult.scheduleClassification)})
                        </p>
                        <p>
                          <span className="font-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                            3. Database Stored:
                          </span>{' '}
                          {dbReadable} ({db24h} • {methodLabel})
                        </p>
                        <p
                          className={
                            isEligibleForOptimizer
                              ? 'text-[#0F766E] dark:text-[#2DD4BF] font-medium'
                              : 'text-[#D97706] dark:text-amber-400 font-medium flex items-start gap-1'
                          }
                        >
                          {!isEligibleForOptimizer && (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          )}
                          <span>
                            4. Optimizer Status:{' '}
                            {isEligibleForOptimizer
                              ? `Eligible from DB (${dbReadable})`
                              : clinic.scheduleAmbiguityReason ||
                                'Needs review/confirmation in HCP Directory before route optimization'}
                          </span>
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* CARD 3: Import History */}
      <section className="rounded-[22px] bg-white dark:bg-[#1E293B] border border-[#E2E8F0] dark:border-[#334155] p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[#DBEAFE] dark:bg-[#1E3A8A]/70 text-[#2563EB] dark:text-[#60A5FA] flex items-center justify-center shrink-0">
            <History className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-[#0F172A] dark:text-[#F8FAFC] leading-snug">
              Import History
            </h2>
            <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] mt-0.5">
              Recent workbook imports &amp; one-tap rollback
            </p>
          </div>
        </div>

        {history.length === 0 ? (
          <p className="text-[12px] text-[#475569] dark:text-[#CBD5E1] rounded-[14px] bg-[#F8FAFC] dark:bg-[#0F172A]/50 border border-[#E2E8F0] dark:border-[#334155] px-3.5 py-3">
            No workbook imports recorded on this device yet.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((entry) => (
              <div
                key={entry.id}
                className="rounded-[14px] bg-[#F8FAFC] dark:bg-[#0F172A]/55 border border-[#E2E8F0] dark:border-[#334155] p-3 flex items-center justify-between gap-2.5"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[#0F172A] dark:text-[#F8FAFC] truncate">
                    {entry.fileName}
                  </p>
                  <p className="text-[11px] text-[#475569] dark:text-[#CBD5E1] tabular-nums">
                    {new Date(entry.timestamp).toLocaleString()} · {entry.mode} ·{' '}
                    {entry.hcpsImported} HCPs / {entry.clinicsImported} Clinics
                  </p>
                </div>

                {entry.rolledBack ? (
                  <span className="shrink-0 px-2.5 py-1 rounded-lg bg-[#E2E8F0] dark:bg-[#334155] text-[11px] font-semibold text-[#475569] dark:text-[#CBD5E1]">
                    Rolled Back
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={rollingBackId === entry.id}
                    onClick={() => void handleRollbackImport(entry)}
                    className="shrink-0 h-[34px] px-3 rounded-[10px] border border-[#DC2626]/40 text-[#DC2626] dark:text-red-400 hover:bg-[#DC2626]/10 disabled:opacity-50 text-[11px] font-semibold inline-flex items-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{rollingBackId === entry.id ? 'Restoring...' : 'Rollback'}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
