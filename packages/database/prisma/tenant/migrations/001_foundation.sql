CREATE TABLE IF NOT EXISTS school_config (
    id UUID PRIMARY KEY,
    config_key TEXT NOT NULL UNIQUE,
    config_value JSONB NOT NULL DEFAULT '{}',
    description TEXT,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS school_feature_flags (
    id UUID PRIMARY KEY,
    flag_key TEXT NOT NULL UNIQUE,
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    config JSONB DEFAULT '{}',
    enabled_by UUID,
    enabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS grading_scales (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    scale_type TEXT NOT NULL DEFAULT 'PERCENTAGE',
    is_default BOOLEAN NOT NULL DEFAULT false,
    grades JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id UUID PRIMARY KEY,
    entity_type TEXT NOT NULL,
    field_name TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'TEXT',
    is_required BOOLEAN NOT NULL DEFAULT false,
    options JSONB DEFAULT '[]',
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(entity_type, field_name)
);
CREATE TABLE IF NOT EXISTS custom_field_values (
    id UUID PRIMARY KEY,
    definition_id UUID NOT NULL REFERENCES custom_field_definitions(id),
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    field_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
