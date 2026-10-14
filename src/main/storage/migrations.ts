import Database from "better-sqlite3";

/**
 * 当前 schema 版本。每次加迁移都要同步抬高，并在 MIGRATIONS 里补一条。
 *
 * 背景：这个文件原先只有 `INSERT OR IGNORE schema_version VALUES(1)`，
 * 没有任何升级路径——老库上新增列不会生效，用户升级后一读新列就直接报错。
 * 下面把「建表」和「升级」分开：建表语句保持幂等作为基线，升级走版本递进的迁移。
 */
export const CURRENT_SCHEMA_VERSION = 4;

/** 按需加列。SQLite 的 ALTER TABLE ADD COLUMN 加可空列不需要重建表，成本最低。 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * 版本递进的迁移表。每条只负责「上一个版本 → 自己」这一步。
 * 必须是幂等的可重入写法（加列前先查），避免半途失败后重跑报错。
 */
const MIGRATIONS: Array<{ version: number; apply: (db: Database.Database) => void }> = [
  {
    // v2：会话记录使用的话术框架 id。用于历史会话导出时还原当时用的框架
    // （内存里的 activeFramework 重启即失，无法支撑事后复盘）。
    version: 2,
    apply: (db) => addColumnIfMissing(db, "sessions", "framework_id", "TEXT"),
  },
  {
    // v3：主播标识。speaker_id 做稳定聚合（改名不断），speaker_name 存当次快照
    // （历史报告显示当时的名字，是有意的可追溯性）。
    version: 3,
    apply: (db) => {
      addColumnIfMissing(db, "sessions", "speaker_id", "TEXT");
      addColumnIfMissing(db, "sessions", "speaker_name", "TEXT");
    },
  },
  {
    // v4：结束原因。历史事故：用户看到一场「正常结束」的空会话，无法区分是
    // 软件故障、自己忘关、还是排期到点——三种都写 status='stopped' + ended_at。
    // 自动结束（排期/无音频/残留收尾）必须写明原因，否则事后无法复盘。
    version: 4,
    apply: (db) => addColumnIfMissing(db, "sessions", "end_reason", "TEXT"),
  },
];

export function migrate(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at_iso TEXT NOT NULL,
  ended_at_iso TEXT,
  audio_source TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  connection_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(connection_id, source_seq, is_final)
);
CREATE INDEX IF NOT EXISTS idx_segments_session_time
  ON transcript_segments(session_id, start_ms, is_final);

CREATE TABLE IF NOT EXISTS speech_intervals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speech_session ON speech_intervals(session_id, start_ms);

CREATE TABLE IF NOT EXISTS frameworks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product_facts TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS framework_steps (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  max_wait_ms INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS framework_rules (
  id TEXT PRIMARY KEY,
  framework_id TEXT NOT NULL REFERENCES frameworks(id) ON DELETE CASCADE,
  step_id TEXT,
  rule_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  window_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  analysis_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  segment_ids TEXT NOT NULL,
  quote TEXT NOT NULL,
  basis TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  suggested_script TEXT,
  confidence REAL NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  dedupe_key TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issues_session ON issues(session_id, type, dedupe_key);

CREATE TABLE IF NOT EXISTS issue_evidence (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
  `);

  // 版本递进迁移。整体放在一个事务里：中途失败就整体回滚，
  // 不会留下「版本号已抬高但列没加全」的半升级状态。
  const current = readVersion(db);
  if (current < CURRENT_SCHEMA_VERSION) {
    const run = db.transaction(() => {
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        m.apply(db);
        db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(m.version);
      }
    });
    run();
  }
}

/** 读取当前 schema 版本。空库或异常时视为 1（与基线建表语句一致）。 */
export function readVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) AS v FROM schema_version")
      .get() as { v: number | null } | undefined;
    return row?.v ?? 1;
  } catch {
    return 1;
  }
}
