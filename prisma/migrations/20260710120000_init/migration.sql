-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'OPERATOR', 'RESPONDER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('DEPARTMENT', 'MACHINE_GROUP', 'MACHINE');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'ARRIVED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PARTIAL', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertEventType" AS ENUM ('CREATED', 'NOTE', 'ACKNOWLEDGED', 'ARRIVED', 'RESOLVED', 'CANCELLED', 'COMMAND_CREATED', 'DUPLICATE_MERGED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CommunicationChannelType" AS ENUM ('DEPARTMENT', 'MACHINE_GROUP', 'MACHINE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CommunicationMemberRole" AS ENUM ('MEMBER', 'MODERATOR', 'OWNER');

-- CreateEnum
CREATE TYPE "CommunicationMessageType" AS ENUM ('TEXT', 'SYSTEM');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "work_id" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_scopes" (
    "id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_groups" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machine_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "machine_group_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "radius_machine_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_types" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_templates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "button_label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'bell',
    "color" TEXT NOT NULL DEFAULT '#ef4444',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "command_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_template_targets" (
    "id" TEXT NOT NULL,
    "command_template_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "issue_type_id" TEXT NOT NULL,
    "target_message" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_template_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "andon_commands" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "command_template_id" TEXT,
    "command_label" TEXT NOT NULL,
    "operator_user_id" TEXT,
    "operator_name_text" TEXT,
    "shared_note" TEXT,
    "client_request_id" TEXT,
    "status" "CommandStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "andon_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "andon_alerts" (
    "id" TEXT NOT NULL,
    "command_id" TEXT,
    "company_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "issue_type_id" TEXT,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "operator_note" TEXT,
    "display_message" TEXT,
    "created_by_user_id" TEXT,
    "acknowledged_by_user_id" TEXT,
    "arrived_by_user_id" TEXT,
    "resolved_by_user_id" TEXT,
    "cancelled_by_user_id" TEXT,
    "responder_name_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "andon_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "event_type" "AlertEventType" NOT NULL,
    "actor_user_id" TEXT,
    "actor_name_text" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pager_devices" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_fingerprint" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pager_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_channels" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "canonical_key" TEXT NOT NULL,
    "type" "CommunicationChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" TEXT,
    "machine_group_id" TEXT,
    "machine_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "last_message_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_channel_members" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "CommunicationMemberRole" NOT NULL DEFAULT 'MEMBER',
    "can_read" BOOLEAN NOT NULL DEFAULT true,
    "can_write" BOOLEAN NOT NULL DEFAULT true,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_channel_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_messages" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "message_type" "CommunicationMessageType" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL,
    "client_message_id" TEXT,
    "alert_id" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "memberships_company_id_role_idx" ON "memberships"("company_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_company_id_key" ON "memberships"("user_id", "company_id");

-- CreateIndex
CREATE INDEX "membership_scopes_scope_type_scope_id_idx" ON "membership_scopes"("scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_scopes_membership_id_scope_type_scope_id_key" ON "membership_scopes"("membership_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "machine_groups_company_id_active_idx" ON "machine_groups"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "machine_groups_company_id_name_key" ON "machine_groups"("company_id", "name");

-- CreateIndex
CREATE INDEX "machines_company_id_active_idx" ON "machines"("company_id", "active");

-- CreateIndex
CREATE INDEX "machines_machine_group_id_active_idx" ON "machines"("machine_group_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "machines_company_id_code_key" ON "machines"("company_id", "code");

-- CreateIndex
CREATE INDEX "departments_company_id_active_idx" ON "departments"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "departments_company_id_name_key" ON "departments"("company_id", "name");

-- CreateIndex
CREATE INDEX "issue_types_company_id_active_idx" ON "issue_types"("company_id", "active");

-- CreateIndex
CREATE INDEX "issue_types_department_id_active_idx" ON "issue_types"("department_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "issue_types_department_id_name_key" ON "issue_types"("department_id", "name");

-- CreateIndex
CREATE INDEX "command_templates_company_id_active_idx" ON "command_templates"("company_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "command_templates_company_id_name_key" ON "command_templates"("company_id", "name");

-- CreateIndex
CREATE INDEX "command_template_targets_department_id_idx" ON "command_template_targets"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "command_template_targets_command_template_id_department_id_key" ON "command_template_targets"("command_template_id", "department_id");

-- CreateIndex
CREATE INDEX "andon_commands_company_id_status_idx" ON "andon_commands"("company_id", "status");

-- CreateIndex
CREATE INDEX "andon_commands_machine_id_status_idx" ON "andon_commands"("machine_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "andon_commands_company_id_client_request_id_key" ON "andon_commands"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "andon_alerts_company_id_status_idx" ON "andon_alerts"("company_id", "status");

-- CreateIndex
CREATE INDEX "andon_alerts_department_id_status_idx" ON "andon_alerts"("department_id", "status");

-- CreateIndex
CREATE INDEX "andon_alerts_machine_id_status_idx" ON "andon_alerts"("machine_id", "status");

-- CreateIndex
CREATE INDEX "andon_alerts_command_id_idx" ON "andon_alerts"("command_id");

-- CreateIndex
CREATE INDEX "alert_events_alert_id_created_at_idx" ON "alert_events"("alert_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pager_devices_token_hash_key" ON "pager_devices"("token_hash");

-- CreateIndex
CREATE INDEX "pager_devices_company_id_department_id_active_idx" ON "pager_devices"("company_id", "department_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_company_id_key_key" ON "user_preferences"("user_id", "company_id", "key");

-- CreateIndex
CREATE INDEX "communication_channels_company_id_type_active_idx" ON "communication_channels"("company_id", "type", "active");

-- CreateIndex
CREATE INDEX "communication_channels_department_id_idx" ON "communication_channels"("department_id");

-- CreateIndex
CREATE INDEX "communication_channels_machine_group_id_idx" ON "communication_channels"("machine_group_id");

-- CreateIndex
CREATE INDEX "communication_channels_machine_id_idx" ON "communication_channels"("machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_channels_company_id_canonical_key_key" ON "communication_channels"("company_id", "canonical_key");

-- CreateIndex
CREATE INDEX "communication_channel_members_company_id_user_id_idx" ON "communication_channel_members"("company_id", "user_id");

-- CreateIndex
CREATE INDEX "communication_channel_members_company_id_channel_id_idx" ON "communication_channel_members"("company_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_channel_members_channel_id_user_id_key" ON "communication_channel_members"("channel_id", "user_id");

-- CreateIndex
CREATE INDEX "communication_messages_company_id_channel_id_seq_idx" ON "communication_messages"("company_id", "channel_id", "seq");

-- CreateIndex
CREATE INDEX "communication_messages_company_id_alert_id_seq_idx" ON "communication_messages"("company_id", "alert_id", "seq");

-- CreateIndex
CREATE INDEX "communication_messages_company_id_user_id_created_at_idx" ON "communication_messages"("company_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "communication_messages_channel_id_seq_key" ON "communication_messages"("channel_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "communication_messages_channel_id_user_id_client_message_id_key" ON "communication_messages"("channel_id", "user_id", "client_message_id");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_scopes" ADD CONSTRAINT "membership_scopes_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_groups" ADD CONSTRAINT "machine_groups_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_machine_group_id_fkey" FOREIGN KEY ("machine_group_id") REFERENCES "machine_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_types" ADD CONSTRAINT "issue_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_types" ADD CONSTRAINT "issue_types_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_templates" ADD CONSTRAINT "command_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_template_targets" ADD CONSTRAINT "command_template_targets_command_template_id_fkey" FOREIGN KEY ("command_template_id") REFERENCES "command_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_template_targets" ADD CONSTRAINT "command_template_targets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_template_targets" ADD CONSTRAINT "command_template_targets_issue_type_id_fkey" FOREIGN KEY ("issue_type_id") REFERENCES "issue_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_commands" ADD CONSTRAINT "andon_commands_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_commands" ADD CONSTRAINT "andon_commands_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_commands" ADD CONSTRAINT "andon_commands_command_template_id_fkey" FOREIGN KEY ("command_template_id") REFERENCES "command_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_commands" ADD CONSTRAINT "andon_commands_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "andon_commands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_issue_type_id_fkey" FOREIGN KEY ("issue_type_id") REFERENCES "issue_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_arrived_by_user_id_fkey" FOREIGN KEY ("arrived_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "andon_alerts" ADD CONSTRAINT "andon_alerts_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "andon_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pager_devices" ADD CONSTRAINT "pager_devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pager_devices" ADD CONSTRAINT "pager_devices_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channels" ADD CONSTRAINT "communication_channels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channels" ADD CONSTRAINT "communication_channels_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channels" ADD CONSTRAINT "communication_channels_machine_group_id_fkey" FOREIGN KEY ("machine_group_id") REFERENCES "machine_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channels" ADD CONSTRAINT "communication_channels_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channel_members" ADD CONSTRAINT "communication_channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "communication_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_channel_members" ADD CONSTRAINT "communication_channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "communication_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "andon_alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prevent duplicate active department alerts for the same machine while still
-- allowing historical resolved/cancelled alerts to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "andon_alert_active_machine_department_idx"
ON "andon_alerts" ("machine_id", "department_id")
WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'ARRIVED');
