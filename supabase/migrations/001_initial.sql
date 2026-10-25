CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE whatsapp_instances (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id), name text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'disconnected', phone text, last_connected_at timestamptz,
 next_send_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz,
 settings jsonb NOT NULL DEFAULT '{"minInterval":15,"maxInterval":50,"startHour":8,"endHour":20,"hourlyLimit":30,"dailyLimit":100,"frequencyDays":7,"maxAttempts":3,"timezone":"America/Sao_Paulo"}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contacts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, phone text NOT NULL CHECK(phone ~ '^55[1-9][0-9]{9,10}$'),
 funnel_status text NOT NULL DEFAULT '', product text NOT NULL DEFAULT '', cart_url text NOT NULL DEFAULT '', abandoned_at timestamptz, order_id text NOT NULL DEFAULT '',
 purchased_at timestamptz, purchase_source text, blocked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,phone)
);
CREATE TABLE contact_consents (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 granted boolean NOT NULL, source text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz
);
CREATE TABLE contact_suppressions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), phone text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,phone)
);
CREATE TABLE imports (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), filename text NOT NULL, mapping jsonb NOT NULL,
 summary jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_rows (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), import_id uuid NOT NULL REFERENCES imports(id), row_number integer NOT NULL,
 status text NOT NULL, error text, contact_id uuid REFERENCES contacts(id), UNIQUE(import_id,row_number)
);
CREATE TABLE message_templates (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), slot integer NOT NULL CHECK(slot BETWEEN 1 AND 4),
 content text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,slot)
);
CREATE TABLE campaigns (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','cancelled','completed')),
 simulation boolean NOT NULL DEFAULT true, min_interval integer NOT NULL CHECK(min_interval BETWEEN 1 AND 3600),
 max_interval integer NOT NULL CHECK(max_interval BETWEEN min_interval AND 3600), pause_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_contacts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), campaign_id uuid NOT NULL REFERENCES campaigns(id),
 contact_id uuid NOT NULL REFERENCES contacts(id), UNIQUE(campaign_id,contact_id)
);
CREATE TABLE message_jobs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), campaign_id uuid NOT NULL REFERENCES campaigns(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 template_id uuid NOT NULL REFERENCES message_templates(id), template_slot integer NOT NULL, content text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','requested','sent','delivered','read','replied','failed','unknown','cancelled','skipped','simulated')),
 attempts integer NOT NULL DEFAULT 0, next_run_at timestamptz NOT NULL DEFAULT now(), processing_at timestamptz, processed_at timestamptz,
 provider_id text, error text, simulation boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,contact_id), UNIQUE(user_id,provider_id)
);
CREATE TABLE message_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), job_id uuid REFERENCES message_jobs(id), event_key text NOT NULL UNIQUE,
 type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_replies (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), contact_id uuid REFERENCES contacts(id), job_id uuid REFERENCES message_jobs(id),
 provider_id text NOT NULL, content text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,provider_id)
);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, entity_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON message_jobs(state,next_run_at);
CREATE INDEX jobs_owner_campaign ON message_jobs(user_id,campaign_id);
CREATE INDEX contacts_owner ON contacts(user_id);
CREATE INDEX consent_latest ON contact_consents(contact_id,recorded_at DESC);
CREATE INDEX events_job ON message_events(job_id);
CREATE INDEX jobs_frequency ON message_jobs(user_id,contact_id,processed_at);
CREATE INDEX replies_contact ON customer_replies(user_id,contact_id,received_at);
CREATE INDEX audit_owner ON audit_logs(user_id,created_at);
CREATE VIEW campaign_statistics WITH (security_invoker=true) AS
 SELECT c.id AS campaign_id,c.user_id,c.name,c.status,c.simulation,
 count(j.id)::integer AS total,
 count(j.id) FILTER (WHERE j.state IN ('sent','delivered','read','replied'))::integer AS sent,
 count(j.id) FILTER (WHERE j.state IN ('delivered','read','replied'))::integer AS delivered,
 count(j.id) FILTER (WHERE j.state='replied')::integer AS replied,
 count(j.id) FILTER (WHERE j.state='failed')::integer AS failed,
 count(j.id) FILTER (WHERE j.state IN ('pending','sending'))::integer AS pending,
 count(j.id) FILTER (WHERE j.state='simulated')::integer AS simulated,
 count(j.id) FILTER (WHERE j.state='unknown')::integer AS unknown,
 count(j.id) FILTER (WHERE j.state='requested')::integer AS requested,
 count(j.id) FILTER (WHERE ct.purchased_at IS NOT NULL AND ct.purchase_source IS NOT NULL AND j.processed_at < ct.purchased_at AND NOT j.simulation AND j.state IN ('sent','delivered','read','replied'))::integer AS recovered
 FROM campaigns c LEFT JOIN message_jobs j ON j.campaign_id=c.id LEFT JOIN contacts ct ON ct.id=j.contact_id GROUP BY c.id;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['users','whatsapp_instances','contacts','contact_consents','contact_suppressions','imports','import_rows','message_templates','campaigns','campaign_contacts','message_jobs','message_events','customer_replies','audit_logs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 IF t='users' THEN
 EXECUTE format('CREATE POLICY owner_policy ON %I FOR SELECT USING (id = COALESCE(nullif(current_setting(''request.jwt.claim.sub'',true),''''),nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'')::uuid)',t);
 ELSE
 EXECUTE format('CREATE POLICY owner_policy ON %I FOR SELECT USING (user_id = COALESCE(nullif(current_setting(''request.jwt.claim.sub'',true),''''),nullif(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'')::uuid)',t);
 END IF;
 END LOOP;
END $$;
