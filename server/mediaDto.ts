export function serializeMedia(row: any) {
  return {
    id: row.id,
    post_id: row.post_id,
    media_type: row.media_type,
    url: row.url,
    provider: row.provider ?? null,
    original_url: row.original_url ?? null,
    mime_type: row.mime_type ?? null,
    file_size_bytes: row.file_size_bytes ?? null,
    asset_id: row.asset_id ?? null,
    alt_text: row.alt_text ?? '',
  };
}
