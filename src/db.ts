import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;
export const DEMO_ORG = 'org-cypress';
export const OTHER_ORG = 'org-other';

export function createDB(filename = ':memory:'): DB {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), {recursive:true});
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY,name TEXT NOT NULL,is_demo INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),entity_id TEXT NOT NULL REFERENCES entities(id),address TEXT NOT NULL,bbl TEXT);
  CREATE TABLE IF NOT EXISTS external_accounts (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),property_id TEXT NOT NULL REFERENCES properties(id),source_system TEXT NOT NULL,account_ref TEXT NOT NULL,UNIQUE(org_id,source_system,account_ref));
  CREATE TABLE IF NOT EXISTS aliases (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),property_id TEXT NOT NULL REFERENCES properties(id),alias TEXT NOT NULL,reviewed INTEGER NOT NULL DEFAULT 1,UNIQUE(org_id,alias));
  CREATE TABLE IF NOT EXISTS source_reports (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),kind TEXT NOT NULL CHECK(kind IN ('obligation','payment')),source_system TEXT NOT NULL,filename TEXT NOT NULL,as_of TEXT NOT NULL,currency TEXT NOT NULL,raw_sha TEXT NOT NULL,uploaded_at TEXT NOT NULL,raw_csv TEXT NOT NULL,UNIQUE(org_id,kind,source_system,raw_sha,as_of));
  CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),report_id TEXT NOT NULL REFERENCES source_reports(id),created_at TEXT NOT NULL,total INTEGER NOT NULL,imported INTEGER NOT NULL,duplicates INTEGER NOT NULL,errors INTEGER NOT NULL,conflicts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS source_rows (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),report_id TEXT NOT NULL REFERENCES source_reports(id),row_index INTEGER NOT NULL,source_key TEXT,kind TEXT NOT NULL,raw_json TEXT NOT NULL,normalized_json TEXT NOT NULL,row_fingerprint TEXT NOT NULL,validation_error TEXT,UNIQUE(report_id,row_index));
  CREATE TABLE IF NOT EXISTS obligations (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),property_id TEXT NOT NULL REFERENCES properties(id),source_system TEXT NOT NULL,source_key TEXT NOT NULL,invoice_ref TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),reported_due_minor INTEGER NOT NULL CHECK(reported_due_minor>=0),currency TEXT NOT NULL,due_date TEXT NOT NULL,report_id TEXT NOT NULL REFERENCES source_reports(id),source_row_id TEXT NOT NULL REFERENCES source_rows(id),content_sha TEXT NOT NULL,UNIQUE(org_id,source_system,source_key));
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),property_id TEXT NOT NULL REFERENCES properties(id),source_system TEXT NOT NULL,source_key TEXT NOT NULL,invoice_ref TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,transaction_date TEXT NOT NULL,posted_date TEXT NOT NULL,payment_type TEXT NOT NULL CHECK(payment_type IN ('payment','credit')),report_id TEXT NOT NULL REFERENCES source_reports(id),source_row_id TEXT NOT NULL REFERENCES source_rows(id),content_sha TEXT NOT NULL,UNIQUE(org_id,source_system,source_key));
  CREATE TABLE IF NOT EXISTS allocations (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),payment_id TEXT NOT NULL REFERENCES payments(id),obligation_id TEXT NOT NULL REFERENCES obligations(id),amount_minor INTEGER NOT NULL CHECK(amount_minor>0),created_at TEXT NOT NULL,created_by TEXT NOT NULL,UNIQUE(org_id,payment_id,obligation_id));
  CREATE TABLE IF NOT EXISTS import_conflicts (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),kind TEXT NOT NULL,source_row_id TEXT NOT NULL REFERENCES source_rows(id),current_record_id TEXT NOT NULL,source_key TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),created_at TEXT NOT NULL,decided_at TEXT,reviewer TEXT);
  CREATE TABLE IF NOT EXISTS reconciliation_runs (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),rule_version TEXT NOT NULL,created_at TEXT NOT NULL,as_of TEXT NOT NULL,obligation_count INTEGER NOT NULL,payment_count INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT PRIMARY KEY REFERENCES reconciliation_runs(id),org_id TEXT NOT NULL REFERENCES organizations(id),snapshot_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS match_candidates (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),run_id TEXT NOT NULL REFERENCES reconciliation_runs(id),obligation_id TEXT NOT NULL REFERENCES obligations(id),payment_id TEXT NOT NULL REFERENCES payments(id),basis TEXT NOT NULL,strength TEXT NOT NULL CHECK(strength IN ('explicit','suggested')),evidence_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected')),UNIQUE(run_id,obligation_id,payment_id));
  CREATE TABLE IF NOT EXISTS match_decisions (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),candidate_id TEXT NOT NULL REFERENCES match_candidates(id),decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),allocation_minor INTEGER NOT NULL DEFAULT 0,reviewer TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS exceptions (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),run_id TEXT NOT NULL REFERENCES reconciliation_runs(id),issue_key TEXT NOT NULL,kind TEXT NOT NULL,obligation_id TEXT REFERENCES obligations(id),payment_id TEXT REFERENCES payments(id),source_row_id TEXT REFERENCES source_rows(id),amount_minor INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,basis_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','reviewed','info_requested')),owner TEXT NOT NULL DEFAULT 'Unassigned',note TEXT NOT NULL DEFAULT '',reopened_from TEXT,created_at TEXT NOT NULL,UNIQUE(run_id,issue_key));
  CREATE TABLE IF NOT EXISTS resolutions (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),exception_id TEXT NOT NULL REFERENCES exceptions(id),state TEXT NOT NULL CHECK(state IN ('open','reviewed','info_requested')),reviewer TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),actor TEXT NOT NULL,action TEXT NOT NULL,object_type TEXT NOT NULL,object_id TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_exceptions_run ON exceptions(org_id,run_id,status);
  CREATE INDEX IF NOT EXISTS idx_rows_report ON source_rows(report_id);
  CREATE INDEX IF NOT EXISTS idx_alloc_payment ON allocations(payment_id);
  CREATE INDEX IF NOT EXISTS idx_alloc_obligation ON allocations(obligation_id);
  CREATE TRIGGER IF NOT EXISTS safe_allocation_insert BEFORE INSERT ON allocations BEGIN
    SELECT RAISE(ABORT,'allocation cross-organization or cross-property') WHERE NOT EXISTS(
      SELECT 1 FROM payments p JOIN obligations o ON p.property_id=o.property_id AND p.org_id=o.org_id
      WHERE p.id=NEW.payment_id AND o.id=NEW.obligation_id AND p.org_id=NEW.org_id AND p.currency=o.currency);
    SELECT RAISE(ABORT,'payment over-allocation') WHERE NEW.amount_minor+(SELECT COALESCE(SUM(amount_minor),0) FROM allocations WHERE payment_id=NEW.payment_id)>(SELECT amount_minor FROM payments WHERE id=NEW.payment_id);
    SELECT RAISE(ABORT,'obligation over-allocation') WHERE NEW.amount_minor+(SELECT COALESCE(SUM(amount_minor),0) FROM allocations WHERE obligation_id=NEW.obligation_id)>(SELECT amount_minor FROM obligations WHERE id=NEW.obligation_id);
  END;
  CREATE TRIGGER IF NOT EXISTS safe_allocation_update BEFORE UPDATE ON allocations BEGIN
    SELECT RAISE(ABORT,'allocation cross-organization or cross-property') WHERE NOT EXISTS(
      SELECT 1 FROM payments p JOIN obligations o ON p.property_id=o.property_id AND p.org_id=o.org_id
      WHERE p.id=NEW.payment_id AND o.id=NEW.obligation_id AND p.org_id=NEW.org_id AND p.currency=o.currency);
    SELECT RAISE(ABORT,'payment over-allocation') WHERE NEW.amount_minor+(SELECT COALESCE(SUM(amount_minor),0) FROM allocations WHERE payment_id=NEW.payment_id AND id<>OLD.id)>(SELECT amount_minor FROM payments WHERE id=NEW.payment_id);
    SELECT RAISE(ABORT,'obligation over-allocation') WHERE NEW.amount_minor+(SELECT COALESCE(SUM(amount_minor),0) FROM allocations WHERE obligation_id=NEW.obligation_id AND id<>OLD.id)>(SELECT amount_minor FROM obligations WHERE id=NEW.obligation_id);
  END;
  `);
  return db;
}

export const rows = (db:DB,sql:string,...p:any[]): any[] => db.prepare(sql).all(...p);
export const one = (db:DB,sql:string,...p:any[]): any => db.prepare(sql).get(...p);
export const run = (db:DB,sql:string,...p:any[]) => db.prepare(sql).run(...p);
export const now = () => new Date().toISOString();
export const id = (prefix:string) => `${prefix}_${crypto.randomUUID()}`;
import crypto from 'node:crypto';
export const sha = (s:string) => crypto.createHash('sha256').update(s).digest('hex');
export function transaction<T>(db:DB,fn:()=>T):T { db.exec('BEGIN IMMEDIATE');try {const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;} }