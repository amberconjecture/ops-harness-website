ALTER TABLE {{database}}.`identity_session_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`event_dedup_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`tracking_event_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`operation_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`activity_fact_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`runtime_fact_versions` MODIFY TTL physical_delete_at DELETE;
ALTER TABLE {{database}}.`user_day_versions` MODIFY TTL physical_delete_at DELETE;
