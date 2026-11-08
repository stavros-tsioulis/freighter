/** Append-only list; index + 1 is the schema version. Never edit an applied migration. */
export const migrations: string[] = [
  `
  CREATE TABLE apps (
    name TEXT PRIMARY KEY,
    manifest_text TEXT,
    current_release TEXT,
    previous_release TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    synced_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE services (
    app TEXT NOT NULL REFERENCES apps(name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    port INTEGER,
    hostnames TEXT NOT NULL DEFAULT '[]',
    active_state TEXT NOT NULL,
    sub_state TEXT NOT NULL,
    restarts INTEGER NOT NULL DEFAULT 0,
    memory_bytes INTEGER,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (app, name)
  );
  CREATE TABLE deployments (
    id TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('deploy','rollback')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','success','failed')),
    release_id TEXT,
    previous_release TEXT,
    source TEXT NOT NULL CHECK (source IN ('api','host')),
    requested_by TEXT,
    artifact_sha256 TEXT,
    error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    history_at TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (app, history_at)
  );
  CREATE INDEX deployments_app_created ON deployments (app, created_at DESC);
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','deployer','admin')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    token_id TEXT,
    action TEXT NOT NULL,
    app TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  `,
  `
  CREATE TABLE metrics_samples (
    app TEXT NOT NULL,
    service TEXT NOT NULL,
    unit TEXT NOT NULL,
    at TEXT NOT NULL,
    active TEXT NOT NULL,
    memory_bytes INTEGER,
    cpu_nanos INTEGER,
    restarts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX metrics_app_service_at ON metrics_samples (app, service, at);
  `,
  `
  CREATE TABLE servers (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local','remote')),
    address TEXT,
    status TEXT NOT NULL CHECK (status IN ('online','offline','pending','error')),
    agent_version TEXT,
    hostname TEXT,
    host_json TEXT,
    last_seen_at TEXT,
    last_error TEXT,
    cert_fingerprint TEXT,
    cert_expires_at TEXT,
    enroll_token_hash TEXT UNIQUE,
    enroll_expires_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'online', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  ALTER TABLE apps ADD COLUMN server TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE deployments ADD COLUMN server TEXT NOT NULL DEFAULT 'local';
  `,
  `
  CREATE TABLE git_links (
    app TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','other')),
    repository TEXT NOT NULL,
    branch TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    auto_deploy INTEGER NOT NULL DEFAULT 1,
    webhook_secret TEXT NOT NULL,
    public_key TEXT NOT NULL,
    key_fingerprint TEXT NOT NULL DEFAULT '',
    last_delivery_at TEXT,
    last_delivery_result TEXT,
    created_at TEXT NOT NULL
  );
  ALTER TABLE deployments ADD COLUMN commit_sha TEXT;
  ALTER TABLE deployments ADD COLUMN commit_subject TEXT;
  ALTER TABLE deployments ADD COLUMN commit_author TEXT;
  ALTER TABLE deployments ADD COLUMN trigger TEXT NOT NULL DEFAULT 'upload';
  ALTER TABLE deployments ADD COLUMN log TEXT;
  `,
  `
  CREATE TABLE integrations (
    provider TEXT PRIMARY KEY CHECK (provider IN ('github','gitlab')),
    public_json TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('github','gitlab')),
    external_id TEXT NOT NULL,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    account_type TEXT NOT NULL,
    web_url TEXT,
    secret_enc TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (provider, external_id)
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    principal_id TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    expires_at TEXT NOT NULL
  );
  ALTER TABLE git_links ADD COLUMN connection_id TEXT;
  ALTER TABLE git_links ADD COLUMN repo_ref TEXT;
  ALTER TABLE git_links ADD COLUMN repo_name TEXT;
  ALTER TABLE git_links ADD COLUMN auth TEXT NOT NULL DEFAULT 'deploy-key';
  ALTER TABLE git_links ADD COLUMN remote_key_id TEXT;
  ALTER TABLE git_links ADD COLUMN remote_hook_id TEXT;
  `,
  `
  -- The GitHub/GitLab account integration was removed; drop what it created (a no-op for databases that never had it).
  DROP TABLE IF EXISTS integrations;
  DROP TABLE IF EXISTS connections;
  DROP TABLE IF EXISTS oauth_states;
  ALTER TABLE git_links DROP COLUMN connection_id;
  ALTER TABLE git_links DROP COLUMN repo_ref;
  ALTER TABLE git_links DROP COLUMN repo_name;
  ALTER TABLE git_links DROP COLUMN auth;
  ALTER TABLE git_links DROP COLUMN remote_key_id;
  ALTER TABLE git_links DROP COLUMN remote_hook_id;

  -- SSH keys imported in settings; the private half is encrypted at rest.
  CREATE TABLE ssh_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    key_type TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    comment TEXT,
    private_enc TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  ALTER TABLE git_links ADD COLUMN ssh_key_id TEXT;
  `,
  `
  ALTER TABLE git_links ADD COLUMN settings_json TEXT;
  `,
  `
  CREATE TABLE pending_domains (
    hostname TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    service TEXT NOT NULL,
    tls TEXT NOT NULL CHECK (tls IN ('auto','off')),
    created_at TEXT NOT NULL,
    checked_at TEXT,
    last_error TEXT
  );
  `,
  `
  -- Control-plane settings changed from the dashboard (they win over config.yaml, environment variables win over them).
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];
