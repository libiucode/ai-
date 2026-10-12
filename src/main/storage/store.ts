import Database from "better-sqlite3";
import path from "node:path";
import { migrate } from "./migrations";
import type {
  Framework,
  Issue,
  SpeechInterval,
  TranscriptSegment,
} from "../../shared/contracts";

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    migrate(this.db);
  }

  close() {
    this.db.close();
  }

  // ---- sessions ----
  createSession(s: {
    id: string;
    startedAtIso: string;
    audioSource: string;
    deviceId: string | null;
  }) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, started_at_iso, audio_source, device_id, status)
         VALUES (?, ?, ?, ?, 'active')`,
      )
      .run(s.id, s.startedAtIso, s.audioSource, s.deviceId);
  }

  updateSessionStatus(id: string, status: string, endedAtIso?: string) {
    this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at_iso = COALESCE(?, ended_at_iso) WHERE id = ?`)
      .run(status, endedAtIso ?? null, id);
  }

  getSession(id: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | { id: string; started_at_iso: string; ended_at_iso: string | null; audio_source: string; device_id: string | null; status: string }
      | undefined;
  }

  // ---- transcript ----
  insertSegment(seg: TranscriptSegment): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO transcript_segments
         (id, session_id, connection_id, source_seq, start_ms, end_ms, text, is_final, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seg.id,
        seg.sessionId,
        seg.connectionId,
        seg.sourceSeq,
        seg.startMs,
        seg.endMs,
        seg.text,
        seg.isFinal ? 1 : 0,
        seg.createdAt,
      );
    return res.changes > 0;
  }

  querySegments(opts: {
    sessionId: string;
    startMs?: number;
    endMs?: number;
    finalOnly?: boolean;
  }): TranscriptSegment[] {
    const conds = ["session_id = @sessionId"];
    if (opts.finalOnly) conds.push("is_final = 1");
    if (opts.startMs !== undefined) conds.push("end_ms > @startMs");
    if (opts.endMs !== undefined) conds.push("start_ms < @endMs");
    const rows = this.db
      .prepare(
        `SELECT * FROM transcript_segments WHERE ${conds.join(" AND ")}
         ORDER BY start_ms ASC`,
      )
      .all({
        sessionId: opts.sessionId,
        startMs: opts.startMs ?? 0,
        endMs: opts.endMs ?? Number.MAX_SAFE_INTEGER,
      }) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      sessionId: r.session_id as string,
      connectionId: r.connection_id as string,
      sourceSeq: r.source_seq as number,
      startMs: r.start_ms as number,
      endMs: r.end_ms as number,
      text: r.text as string,
      isFinal: (r.is_final as number) === 1,
      createdAt: r.created_at as string,
    }));
  }

  // ---- speech intervals ----
  insertSpeechInterval(i: SpeechInterval) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO speech_intervals (id, session_id, start_ms, end_ms) VALUES (?, ?, ?, ?)`,
      )
      .run(i.id, i.sessionId, i.startMs, i.endMs);
  }

  querySpeechIntervals(sessionId: string, startMs: number, endMs: number): SpeechInterval[] {
    return this.db
      .prepare(
        `SELECT id, session_id, start_ms, end_ms FROM speech_intervals
         WHERE session_id = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms`,
      )
      .all(sessionId, startMs, endMs) as SpeechInterval[];
  }

  // ---- frameworks ----
  saveFramework(fw: Framework) {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO frameworks (id, name, product_facts, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, product_facts=excluded.product_facts, updated_at=excluded.updated_at`,
        )
        .run(fw.id, fw.name, fw.productFacts, fw.updatedAt);
      this.db.prepare(`DELETE FROM framework_steps WHERE framework_id = ?`).run(fw.id);
      this.db.prepare(`DELETE FROM framework_rules WHERE framework_id = ?`).run(fw.id);
      const stepStmt = this.db.prepare(
        `INSERT INTO framework_steps (id, framework_id, name, priority, max_wait_ms) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const s of fw.steps) stepStmt.run(s.id, fw.id, s.name, s.priority, s.maxWaitMs);
      const ruleStmt = this.db.prepare(
        `INSERT INTO framework_rules (id, framework_id, step_id, rule_type, pattern, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const r of fw.rules)
        ruleStmt.run(r.id, fw.id, r.stepId, r.ruleType, r.pattern, r.enabled ? 1 : 0);
    });
    tx();
  }

  listFrameworks(): Framework[] {
    const fws = this.db.prepare(`SELECT * FROM frameworks`).all() as Array<Record<string, unknown>>;
    const stepStmt = this.db.prepare(`SELECT * FROM framework_steps WHERE framework_id = ?`);
    const ruleStmt = this.db.prepare(`SELECT * FROM framework_rules WHERE framework_id = ?`);
    return fws.map((f) => ({
      id: f.id as string,
      name: f.name as string,
      productFacts: f.product_facts as string,
      updatedAt: f.updated_at as string,
      steps: (stepStmt.all(f.id) as Array<Record<string, unknown>>).map((s) => ({
        id: s.id as string,
        frameworkId: s.framework_id as string,
        name: s.name as string,
        priority: s.priority as number,
        maxWaitMs: s.max_wait_ms as number,
      })),
      rules: (ruleStmt.all(f.id) as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        frameworkId: r.framework_id as string,
        stepId: (r.step_id as string) ?? null,
        ruleType: r.rule_type as "bannedWord" | "absolutization" | "unverifiedClaim" | "repetition" | "hotWord",
        pattern: r.pattern as string,
        enabled: (r.enabled as number) === 1,
      })),
    }));
  }

  // ---- analysis runs ----
  insertAnalysisRun(run: { id: string; sessionId: string; windowId: string; status: string; startedAt: string }) {
    this.db
      .prepare(
        `INSERT INTO analysis_runs (id, session_id, window_id, status, started_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.sessionId, run.windowId, run.status, run.startedAt);
  }

  finishAnalysisRun(id: string, status: string, finishedAt: string, errorMessage: string | null) {
    this.db
      .prepare(`UPDATE analysis_runs SET status=?, finished_at=?, error_message=? WHERE id=?`)
      .run(status, finishedAt, errorMessage, id);
  }

  // ---- issues ----
  upsertIssue(issue: Issue, dedupeKey: string): "created" | "updated" | "skipped" {
    const existing = this.db
      .prepare(`SELECT id, occurrence_count, first_seen_ms FROM issues WHERE session_id=? AND dedupe_key=?`)
      .get(issue.sessionId, dedupeKey) as
      | { id: string; occurrence_count: number; first_seen_ms: number }
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE issues SET analysis_run_id=?, end_ms=?, last_seen_ms=?, occurrence_count=occurrence_count+1 WHERE id=?`,
        )
        .run(issue.analysisRunId, issue.endMs, issue.endMs, existing.id);
      return "updated";
    }
    this.db
      .prepare(
        `INSERT INTO issues
         (id, session_id, analysis_run_id, type, severity, start_ms, end_ms, segment_ids, quote, basis,
          recommendation, suggested_script, confidence, needs_review, status, dedupe_key, occurrence_count, first_seen_ms, last_seen_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
      )
      .run(
        issue.id,
        issue.sessionId,
        issue.analysisRunId,
        issue.type,
        issue.severity,
        issue.startMs,
        issue.endMs,
        JSON.stringify(issue.segmentIds),
        issue.quote,
        issue.basis,
        issue.recommendation,
        issue.suggestedScript,
        issue.confidence,
        issue.needsReview ? 1 : 0,
        dedupeKey,
        issue.startMs,
        issue.endMs,
      );
    for (const segId of issue.segmentIds) {
      const seg = this.db
        .prepare(`SELECT start_ms, end_ms, text FROM transcript_segments WHERE id=?`)
        .get(segId) as { start_ms: number; end_ms: number; text: string } | undefined;
      if (!seg) continue;
      this.db
        .prepare(
          `INSERT INTO issue_evidence (id, issue_id, segment_id, quote, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`${issue.id}:${segId}`, issue.id, segId, issue.quote, seg.start_ms, seg.end_ms);
    }
    return "created";
  }

  listIssues(sessionId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM issues WHERE session_id=? ORDER BY first_seen_ms`)
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  // ---- settings ----
  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }
}
