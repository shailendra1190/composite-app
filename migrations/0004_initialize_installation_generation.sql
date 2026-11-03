UPDATE shops
   SET installation_generation_at = UTC_TIMESTAMP(6)
 WHERE installation_generation_at IS NULL;
