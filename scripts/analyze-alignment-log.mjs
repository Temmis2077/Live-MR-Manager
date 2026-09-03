import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { attachMissingSegmentIds, gateAlignmentLines } from '../src/js/alignment-quality.js';

// alignment-queue.js exports the production post-processing functions but also
// imports browser-facing state. Minimal inert globals let this CLI reuse the
// exact implementation without invoking Tauri or touching application state.
globalThis.window ??= {};
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document ??= { getElementById: () => null, createElement: () => ({}) };

const {
  enforceAiTimelineOrder,
  buildFinalEstimateGroups,
  estimateUnsyncedTimings,
  applyEstimatedTimings,
  markRejectedEstimateGroups,
  collectGateLexicalEvidence,
} = await import('../src/js/alignment-queue.js');
const { mergeAlignmentResult, parseMarkers, getSyncText } = await import('../src/js/lrc-parser.js');

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function reasonCounts(rejected) {
  const counts = {};
  for (const item of rejected || []) {
    for (const reason of item.reasons || []) counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function summarizeGate(stage, gate, requestedIds) {
  const returnedIds = new Set([
    ...(gate.accepted || []).map((line) => line.segment_id),
    ...(gate.rejected || []).map(({ line }) => line?.segment_id).filter(Boolean),
  ]);
  return {
    stage,
    requested: requestedIds.length,
    returned: returnedIds.size,
    missingIds: requestedIds.filter((id) => !returnedIds.has(id)),
    accepted: gate.accepted.length,
    softAccepted: gate.softAccepted.length,
    rejected: gate.rejected.length,
    confidenceFloor: gate.confidenceFloor,
    reasonCounts: reasonCounts(gate.rejected),
    softIds: gate.softAccepted.map((line) => line.segment_id),
    nonLexicalRegions: gate.nonLexicalVocalRegions,
  };
}

function mergeRegions(regions) {
  const sorted = (regions || [])
    .filter((region) => Number.isFinite(region?.startMs)
      && Number.isFinite(region?.endMs) && region.endMs > region.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  const merged = [];
  for (const region of sorted) {
    const previous = merged.at(-1);
    if (previous && region.startMs - previous.endMs <= 200) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
      previous.activity = Math.max(Number(previous.activity) || 0, Number(region.activity) || 0);
      previous.segmentIds = [...new Set([...(previous.segmentIds || []), ...(region.segmentIds || [])])];
    } else {
      merged.push({ ...region, reason: 'non_lexical_vocal_region' });
    }
  }
  return merged;
}

function hasTiming(segment) {
  return !!segment && (Number(segment.start) > 0 || Number(segment.end) > 0);
}

function auditSegments(original, final, entries) {
  const entryIndices = new Set((entries || []).map((entry) => entry.segmentIndex));
  const unsyncedIds = [];
  const reversePairs = [];
  const overlapPairs = [];
  let textChangedCount = 0;
  let previous = null;
  for (let index = 0; index < final.length; index++) {
    const segment = final[index] || {};
    const originalSegment = original[index] || {};
    if (String(segment.original ?? segment.text ?? '')
      !== String(originalSegment.original ?? originalSegment.text ?? '')) textChangedCount++;
    if (entryIndices.has(index) && !hasTiming(segment)) unsyncedIds.push(`segment:${index}`);
    if (!hasTiming(segment)) continue;
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) || 0;
    if (previous && start < previous.start - 0.08) {
      reversePairs.push({ previousId: previous.id, id: `segment:${index}`, previousStart: previous.start, start });
    }
    if (previous && previous.end > previous.start && start < previous.end - 0.08) {
      overlapPairs.push({ previousId: previous.id, id: `segment:${index}`, previousEnd: previous.end, start });
    }
    previous = { id: `segment:${index}`, start, end };
  }
  return { unsyncedIds, reversePairs, overlapPairs, textChangedCount };
}

const inputPath = process.argv[2];
const compact = process.argv.includes('--compact');
if (!inputPath) {
  fail('사용법: npm run analyze:alignment-log -- <alignment-debug.jsonl>');
} else {
  const absolutePath = resolve(inputPath);
  const text = await readFile(absolutePath, 'utf8');
  const records = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`${index + 1}번째 JSONL 레코드 파싱 실패: ${error.message}`);
    }
  });
  const input = records.find((record) => record.stage === 'input_prepared')?.payload || {};
  const allEntries = input.alignmentEntries || [];
  const summaries = [];

  for (const record of records) {
    const payload = record.payload || {};
    if (record.stage === 'primary_model_result') {
      const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], allEntries);
      const gate = gateAlignmentLines(rawLines, allEntries);
      summaries.push(summarizeGate('primary', gate, allEntries.map((entry) => entry.id)));
    }
    if (record.stage === 'english_fallback') {
      const entries = payload.entries || [];
      const window = payload.window || {};
      const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], entries);
      const gate = gateAlignmentLines(rawLines, entries, {
        windowStartMs: window.windowStartMs,
        windowEndMs: window.windowEndMs,
        confidenceScale: 0.25,
      });
      summaries.push(summarizeGate('english_fallback', gate, entries.map((entry) => entry.id)));
    }
    if (record.stage === 'second_pass_rescue') {
      const entries = payload.window?.entries || [];
      const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], entries);
      const gate = gateAlignmentLines(rawLines, entries, {
        windowStartMs: payload.window?.windowStartMs,
        windowEndMs: payload.window?.windowEndMs,
        confidenceScale: payload.language === 'en' ? 0.30 : 0.50,
      });
      summaries.push(summarizeGate(`second_pass_${payload.language || 'unknown'}`, gate, entries.map((entry) => entry.id)));
    }
  }

  const beforeSave = records.find((record) => record.stage === 'before_save')?.payload || {};
  const audit = beforeSave.timingAudit || null;
  const originalSegments = structuredClone(input.originalSegments || []);
  const workingSegments = structuredClone(input.temporaryAlignmentSegments || input.originalSegments || []);
  const lexicalEvidence = new Map();
  const nonLexicalRegions = [];
  let primaryDiagnostics = null;
  const replayDrops = { initial: [], rescue: [], final: [] };

  const primaryRecord = records.find((record) => record.stage === 'primary_model_result');
  if (primaryRecord) {
    const payload = primaryRecord.payload || {};
    const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], allEntries);
    const gate = gateAlignmentLines(rawLines, allEntries);
    collectGateLexicalEvidence(gate, lexicalEvidence, nonLexicalRegions);
    mergeAlignmentResult(workingSegments, gate.accepted, allEntries);
    primaryDiagnostics = payload.diagnostics || null;
  }
  for (const record of records.filter((item) => item.stage === 'english_fallback')) {
    const payload = record.payload || {};
    const entries = payload.entries || [];
    const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], entries);
    const gate = gateAlignmentLines(rawLines, entries, {
      windowStartMs: payload.window?.windowStartMs,
      windowEndMs: payload.window?.windowEndMs,
      confidenceScale: 0.25,
    });
    collectGateLexicalEvidence(gate, lexicalEvidence, nonLexicalRegions);
    mergeAlignmentResult(workingSegments, gate.accepted, entries);
    if (!primaryDiagnostics) primaryDiagnostics = payload.diagnostics || null;
  }
  replayDrops.initial = enforceAiTimelineOrder(workingSegments);

  for (const record of records.filter((item) => item.stage === 'second_pass_rescue')) {
    const payload = record.payload || {};
    const entries = payload.window?.entries || [];
    const rawLines = attachMissingSegmentIds(payload.rawResultLines || [], entries);
    const gate = gateAlignmentLines(rawLines, entries, {
      windowStartMs: payload.window?.windowStartMs,
      windowEndMs: payload.window?.windowEndMs,
      confidenceScale: payload.language === 'en' ? 0.30 : 0.50,
    });
    collectGateLexicalEvidence(gate, lexicalEvidence, nonLexicalRegions);
    mergeAlignmentResult(workingSegments, gate.accepted, entries);
  }
  replayDrops.rescue = enforceAiTimelineOrder(workingSegments);

  const mergedNonLexicalRegions = mergeRegions(nonLexicalRegions);
  const replayDiagnostics = {
    ...(primaryDiagnostics || {}),
    lexical_evidence_by_id: Object.fromEntries(lexicalEvidence),
    non_lexical_vocal_regions: mergedNonLexicalRegions,
  };
  const estimateGroups = buildFinalEstimateGroups(
    workingSegments,
    allEntries,
    parseMarkers(input.originalLrc || ''),
  );
  const estimateResult = estimateUnsyncedTimings(estimateGroups, replayDiagnostics);
  const estimatedAppliedCount = applyEstimatedTimings(workingSegments, estimateResult.estimates);
  const unsyncedReviewIds = markRejectedEstimateGroups(workingSegments, estimateResult.rejectedGroups);
  replayDrops.final = enforceAiTimelineOrder(workingSegments);
  const replayAudit = auditSegments(originalSegments, workingSegments, allEntries);
  const report = {
    file: absolutePath,
    schemaVersion: records[0]?.schemaVersion ?? null,
    appVersion: records[0]?.appVersion ?? null,
    alignmentEngineRevision: records[0]?.alignmentEngineRevision ?? null,
    alignmentPipelineRevision: input.alignmentPipelineRevision ?? null,
    stages: records.map((record) => record.stage),
    source: {
      segmentCount: input.originalSegments?.length ?? null,
      alignmentEntryCount: allEntries.length,
      repeatedIds: input.repeatedLyricIds || [],
      primarySkippedIds: input.primarySkippedSegmentIds || [],
    },
    provenance: {
      metadataRestore: input.metadataRestore || null,
      automaticTimingsReset: input.automaticTimingsReset || [],
      automaticTimingsResetCount: input.automaticTimingsReset?.length || 0,
      manualAnchors: input.manualAnchors || [],
    },
    replayedPasses: summaries,
    totals: summaries.reduce((totals, summary) => {
      totals.accepted += summary.accepted;
      totals.softAccepted += summary.softAccepted;
      totals.rejected += summary.rejected;
      totals.missingIds += summary.missingIds.length;
      return totals;
    }, { accepted: 0, softAccepted: 0, rejected: 0, missingIds: 0 }),
    final: {
      appliedCount: beforeSave.appliedCount ?? null,
      finalUnsyncedCount: beforeSave.finalUnsyncedCount ?? null,
      finalUnsyncedIds: beforeSave.finalUnsyncedIds || [],
      unavailableEnglishModelIds: beforeSave.unavailableEnglishModelIds || [],
      sourceTextOrderPreserved: audit?.sourceTextOrderPreserved ?? null,
      monotonicOrderPreserved: audit?.monotonicOrderPreserved ?? null,
      durationSanityPreserved: audit?.durationSanityPreserved ?? null,
      textChangedCount: audit?.textChangedCount ?? null,
      reversePairs: audit?.reversePairs || [],
      overlapPairs: audit?.overlapPairs || [],
      implausibleDurations: audit?.implausibleDurations || [],
    },
    replayedCurrentPipeline: {
      estimatedAppliedCount,
      estimates: estimateResult.estimates.map((estimate) => ({
        segmentId: estimate.segment_id,
        startMs: estimate.start_ms,
        endMs: estimate.end_ms,
        method: estimate.method,
        lexicalSimilarity: estimate.lexicalEligibility?.similarity ?? null,
        lexicalRequiredSimilarity: estimate.lexicalEligibility?.requiredSimilarity ?? null,
        lexicalEvidenceStartMs: estimate.lexicalEligibility?.selectedEvidenceStartMs ?? null,
        lexicalEvidenceEndMs: estimate.lexicalEligibility?.selectedEvidenceEndMs ?? null,
        evidenceAcceptedByGate: estimate.lexicalEligibility?.selectedEvidenceAccepted ?? null,
        evidenceRejectedReasons: estimate.lexicalEligibility?.selectedEvidenceRejectedReasons ?? [],
        lineKind: estimate.lexicalEligibility?.lineKind ?? null,
      })),
      estimateRejectedGroups: estimateResult.rejectedGroups.map((group) => ({
        segmentIds: group.segmentIds,
        rejectedReason: group.rejectedReason,
        availableDurationMs: group.availableDurationMs,
        requiredDurationMs: group.requiredDurationMs,
      })),
      unsyncedReviewIds,
      finalUnsyncedCount: replayAudit.unsyncedIds.length,
      finalUnsyncedIds: replayAudit.unsyncedIds,
      textChangedCount: replayAudit.textChangedCount,
      reversePairs: replayAudit.reversePairs,
      overlapPairs: replayAudit.overlapPairs,
      timelineDrops: replayDrops,
      differsFromRecordedUnsyncedIds: JSON.stringify(replayAudit.unsyncedIds)
        !== JSON.stringify(beforeSave.finalUnsyncedIds || []),
      sourceTexts: workingSegments.map((segment) => getSyncText(segment)),
    },
  };
  const output = compact ? {
    file: report.file,
    schemaVersion: report.schemaVersion,
    appVersion: report.appVersion,
    alignmentEngineRevision: report.alignmentEngineRevision,
    alignmentPipelineRevision: report.alignmentPipelineRevision,
    source: report.source,
    provenance: report.provenance,
    totals: report.totals,
    recordedFinal: report.final,
    replayedCurrentPipeline: {
      ...report.replayedCurrentPipeline,
      sourceTexts: undefined,
    },
  } : report;
  console.log(JSON.stringify(output, null, 2));
}
